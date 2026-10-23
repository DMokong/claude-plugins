"""The sidekick guard, run as the worker runs it: a PreToolUse hook reading the call as JSON.

python3 -m unittest discover -s tests   (from plugins/sidekick)
"""
import json
import os
import subprocess
import unittest

GUARD = os.path.join(os.path.dirname(__file__), "..", "bin", "sidekick-guard")
HOME = os.path.expanduser("~")


def run(tool_input, tool="Bash", profile="investigate", session="s-own"):
    argv = ["python3", GUARD] + ([profile] if profile else [])
    event = {"tool_name": tool, "tool_input": tool_input, "session_id": session}
    done = subprocess.run(argv, input=json.dumps(event), capture_output=True, text=True)
    return done.returncode, done.stderr


def bash(command, profile="investigate"):
    return run({"command": command}, profile=profile)


# One refused command and, where it matters, the allowed neighbour beside it.
REFUSED = [
    # files
    "rm -f notes.txt",
    "rmdir old",
    "unlink x",
    "shred f",
    "truncate -s 0 logs/acme.log",
    "find . -name '*.log' -delete",
    "find . -name '*.log' -exec rm {} +",
    "dd if=/dev/zero of=disk.img",
    "echo hi > notes.txt",
    "echo hi >> notes.txt",
    "echo hi>notes.txt",
    "ls &> out.txt",
    "cat a | tee out.txt",
    "sed -i s/a/b/ f",
    "sed -i.bak s/a/b/ f",
    "perl -pi -e s/a/b/ f",
    "mv a b",
    "cp a b",
    "ln -sf a b",
    "touch f",
    "chmod 600 f",
    "sort -o f f",
    "rsync -a a/ b/",
    "tar xzf a.tgz",
    "unzip a.zip",
    # containers
    "docker rm acme",
    "docker rmi acme:latest",
    "docker volume rm data",
    "docker system prune -f",
    "docker container prune",
    "docker stop acme",
    "docker kill acme",
    "docker run --rm -v /:/host alpine rm -rf /host/x",
    "docker compose down -v",
    "docker compose up -d --force-recreate",
    "docker exec acme rm -rf /data",
    # jobs and processes
    "launchctl bootout gui/501/com.example.worker",
    "launchctl unload ~/Library/LaunchAgents/com.example.worker.plist",
    "launchctl load ~/Library/LaunchAgents/com.example.worker.plist",
    "launchctl bootstrap gui/501 x.plist",
    "launchctl remove com.example.worker",
    "launchctl disable gui/501/com.example.worker",
    "launchctl kill TERM gui/501/com.example.worker",
    "brew services stop acme",
    "kill 123",
    "kill -9 123",
    "pkill acme",
    "killall -9 node",
    "crontab -r",
    # data
    'psql -c "DROP TABLE t"',
    'psql -d app -c "delete from t"',
    'sqlite3 app.db "DELETE FROM t"',
    "sqlite3 app.db",
    "dropdb app",
    "redis-cli FLUSHALL",
    "redis-cli -n 2 del k",
    # network writes
    "curl -X POST https://example.com/hook",
    "curl -d a=1 https://example.com",
    "curl --data-binary @f https://example.com",
    "curl -F f=@x https://example.com",
    "curl -o page.html https://example.com",
    "curl -O https://example.com/x.tgz",
    "wget https://example.com/x.tgz",
    # privilege, interpreters, installs
    "sudo ls",
    'python3 -c "print(1)"',
    "python3 -",
    "node -e 1",
    "perl -e 1",
    "ruby -e 1",
    "osascript -e 'tell app \"Finder\" to quit'",
    "npm install left-pad",
    "pip install x",
    "brew upgrade",
    "npx something",
    "defaults write com.example x 1",
    # hidden inside something else
    "bash -c 'rm -rf /tmp/x'",
    "sh -c \"kill 1\"",
    "echo $(rm x)",
    'echo "$(rm x)"',
    "echo `rm x`",
    "ls | xargs rm",
    "ls | xargs -n 1 rm -f",
    "env FOO=1 rm x",
    "nohup kill 1",
    "cd logs && rm old.log",
    "tail logs/a.log; rm logs/a.log",
    "eval 'rm x'",
    "watch -n 2 rm x",
    "parallel rm ::: a",
    "\\rm x",
    "/bin/rm x",
    "cat > out <<EOF\nx\nEOF",
    "ssh host uptime",
    # git, in an investigation: reads only
    "git stash",
    "git pull",
    "git checkout main",
    "git commit -m x",
    "git -C /r push",
    # can't be read, so can't be trusted
    'echo "unterminated',
]

ALLOWED = [
    "ls -la logs",
    "tail -n 50 logs/acme.log",
    "sed -n 1,40p scripts/health.sh",
    "grep -c ERROR logs/acme.log",
    "grep -c ERROR logs/acme.log > /dev/null 2>&1",
    "ls missing 2>/dev/null",
    "ps -p 900 -o pid,lstart,command",
    "ps aux | grep -i acme | grep -v grep",
    "pgrep -fl 'dist/index.js'",
    "lsof -i :8080",
    "launchctl list",
    "launchctl print gui/501/com.example.worker",
    "launchctl kickstart -k gui/501/com.example.worker",
    "docker ps -a",
    "docker logs --tail 50 acme",
    "docker inspect acme",
    "docker restart acme",
    "docker start acme",
    "docker compose ps",
    "docker compose restart acme",
    "docker exec acme-db psql -c 'select 1'",
    "brew services list",
    "brew services restart acme",
    "curl -s https://example.com/health",
    "curl -sS -o /dev/null -w '%{http_code}' https://example.com/health",
    "dscacheutil -q host -a name example.com",
    "log show --last 10m --predicate 'process == \"acme\"'",
    "stat -f %m logs/acme.log",
    "wc -l logs/acme.log",
    "find logs -name '*.log' -mtime -1",
    'psql -d app -c "select count(*) from t"',
    "redis-cli ping",
    "scripts/health-check.sh",
    "bash scripts/health-check.sh",
    "npm run diagnostics",
    "date",
    "watch -n 5 docker ps",
    "git log -5 --oneline",
    "git status",
    "git -C /r diff --stat",
    "git show HEAD:README.md",
]


class GuardRefuses(unittest.TestCase):
    def test_destructive_commands_are_refused_in_an_investigation(self):
        for command in REFUSED:
            with self.subTest(command=command):
                code, said = bash(command)
                self.assertEqual(code, 2, f"not refused: {command}")
                self.assertIn("sidekick guard: refused", said)

    def test_reads_and_restarts_are_allowed_in_an_investigation(self):
        for command in ALLOWED:
            with self.subTest(command=command):
                code, said = bash(command)
                self.assertEqual(code, 0, f"refused: {command}: {said}")

    def test_the_destructive_line_holds_for_chores_too(self):
        for command in ["rm -f x", "docker rm acme", "bash -c 'kill 1'", "echo hi > notes.txt"]:
            with self.subTest(command=command):
                self.assertEqual(bash(command, profile="chore")[0], 2)

    def test_chores_keep_their_git(self):
        for command in ["git pull", "git stash", "git commit -m 'fix: a > b'", "git push", "git checkout -b topic"]:
            for profile in ("chore", None):
                with self.subTest(command=command, profile=profile):
                    self.assertEqual(bash(command, profile=profile)[0], 0)
        self.assertEqual(bash("git push --force", profile="chore")[0], 2)

    def test_other_sessions_files_are_refused_but_the_workers_own_saved_output_is_not(self):
        other = f"{HOME}/.claude/projects/p/other-session.jsonl"
        own = f"{HOME}/.claude/projects/p/s-own/tool-results/out.txt"
        theirs = f"{HOME}/.claude/projects/p/s-other/tool-results/out.txt"
        self.assertEqual(run({"file_path": other}, tool="Read")[0], 2)
        self.assertEqual(run({"file_path": theirs}, tool="Read")[0], 2)
        self.assertEqual(run({"file_path": own}, tool="Read")[0], 0)
        self.assertEqual(run({"pattern": "x", "path": "~/.claude/projects/p"}, tool="Grep")[0], 2)
        self.assertEqual(bash(f"cat {other}")[0], 2)
        self.assertEqual(run({"file_path": "/repo/logs/acme.log"}, tool="Read")[0], 0)

    def test_credentials_stay_refused(self):
        self.assertEqual(bash("cat .env")[0], 2)
        self.assertEqual(run({"file_path": "/repo/.mcp.json"}, tool="Read")[0], 2)
        self.assertEqual(bash("cat .env.example")[0], 0)


if __name__ == "__main__":
    unittest.main()
