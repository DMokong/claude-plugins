# herdr-jutsu

A skill for raising a **crew** inside Herdr (the terminal multiplexer for coding agents): extra
terminal panes and full agent sessions (Claude, Codex) that are long-lived, visible,
individually steerable, and replaceable when their context fills up.

This README is for the human. `SKILL.md` is what the agent reads.

## When it's the right tool

| Use a crew member when… | Use a plain subagent when… |
|---|---|
| the job is long-lived, or outlives the parent's context | it's a quick lookup or a one-shot task |
| you want to *watch* or *steer* it yourself | you only want the conclusion |
| you want a different engine or profile (Codex, Haiku scout, plan-mode reviewer) | the default is fine |
| two things must write to the same repo at once (→ separate worktrees) | nothing runs in parallel |

## Requirements

- `herdr` ≥ 0.8.2, and the session must be running **inside** a herdr pane (`HERDR_ENV=1`).
  Outside herdr the skill refuses to act.
- `jq`, `git`, and `bash` 3.2 or newer (the stock macOS `/bin/bash` is enough).
- `claude` and/or `codex` on `PATH` for the agent kinds you want to spawn.
- Optional: Claude Code with `SendMessage`. A Claude parent briefs a Claude member with it,
  and that member may use it back for a blocking question or an early warning. Reports are
  never sent: parents wait on a literal pane id and pull the result.
- **From a Codex session, one more thing:** Codex runs a command outside its sandbox only
  when the command matches an allow rule in *your* Codex rules, and inside the sandbox
  herdr's socket is unreachable. So a Codex parent can read this skill but cannot drive
  herdr unless you have allowed the relevant `herdr …` commands (and, to use the script,
  its own path) to run outside the
  sandbox. That is your security decision: the skill describes what it would need and never
  edits a user rules file. The launcher does install a child-only project deny policy in a
  Codex member's cwd. A **Claude** parent driving Codex members needs nothing extra for
  spawning, briefing and pulling — the parent is the one talking to herdr.

## Works from a Claude Code or a Codex parent

The parent sends one brief, waits on the literal pane id from the trusted spawn line, then
pulls the member's FINAL response. Two reference files translate that into each surface:

- **Claude Code parent** (`references/parent-claude.md`): briefs a Claude member with
  SendMessage, runs `herdr agent wait <literal-pane-id> …` as a background Bash task, and is
  re-invoked when it exits without terminal-input injection.
- **Codex parent** (`references/parent-codex.md`): may block its current turn on the same
  wait or pull later. No background completion is known to wake an idle Codex parent.

## Using it

You don't run anything — you ask. The skill triggers on requests like:

> "Spin up a Codex reviewer on this diff, read-only, and tell me what it finds."
>
> "Start two parallel streams for PROJ-123 — a Sonnet implementer and a Codex implementer —
> that can't step on each other, and tail the app log next to the first one."
>
> "inbox-impl is nearly out of context — hand its work off to a fresh session."
>
> "What crew do I have running for the inbox stream?"

or name the skill explicitly (in Claude Code, `/herdr-jutsu`).

What you'll see in herdr: new panes/tabs/workspaces labelled `<stream>-<role>`
(`inbox-impl`, `inbox-review-cdx`, `inbox-logs`). Focus stays where you are — background
work is always spawned `--no-focus`.

### The one convention worth knowing

**One name.** `inbox-impl` is the herdr agent name *and* the pane label — so what you see in
herdr's sidebar and what the parent types at `herdr agent prompt` are the same string. For a
**Claude** member it is also the Claude session name, so `ListAgents`/`SendMessage` address
it too; **Codex has no `--name`**, so a Codex member is reachable by herdr name or pane id
only. If you `/rename` a crew member by hand, the two namespaces drift apart; ask the parent
to rename it instead.

### Permissions

The parent picks a launch profile per role (`references/launch-presets.md`) and will not
launch a child in a broader permission mode than its own unless you say so. Dangerous
Claude's dangerous agent flags are refused unless `--allow-dangerous-agent-flags` is
passed, which is always your call, never the parent's. Isolated Codex instead accepts only
the documented safe argument allowlist; `--no-isolation` is its only explicit opt-out.

When a child stops on a permission prompt, the parent may answer it only if **both** hold:
the prompt visible in the pane is verbatim a command the parent put in the brief, **and**
it is something the parent's own permission settings would run without asking. Otherwise it
comes to you with the pane id. Startup dialogs (update, trust, login) get only the
do-nothing option, never an acceptance.

## Running the script yourself

The agent uses `scripts/jutsu-spawn.sh`; you can too, from any herdr pane:

```bash
# installed as a Claude Code plugin
J="$(ls -d ~/.claude/plugins/cache/dmokong-plugins/herdr-jutsu/*/ | sort -V | tail -1)skills/herdr-jutsu/scripts/jutsu-spawn.sh"
# installed as a Codex plugin (CODEX_HOME defaults to ~/.codex)
J="$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/dmokong-plugins/herdr-jutsu/*/ | sort -V | tail -1)skills/herdr-jutsu/scripts/jutsu-spawn.sh"
$J --help

# check the environment without creating anything
$J --preflight --name inbox-impl --kind claude --cwd "$PWD"

# read-only Codex reviewer beside you
$J --name inbox-review-cdx --kind codex -- -s read-only -a never

# Sonnet implementer in its own git worktree + herdr workspace
$J --name inbox-impl --kind claude --worktree inbox-drain -- \
   --model sonnet --effort medium --permission-mode acceptEdits

# a log tail next to that implementer
$J --name inbox-logs --kind shell --beside inbox-impl --cmd "tail -f $PWD/logs/app.log"
```

Each call prints one JSON line (`name`, `pane_id`, `workspace_id`, `cwd`, `worktree`,
`session_id`, `status`, plus `registry`, `registry_path`, `agent_args`,
`effective_agent_args`, `resume_args`,
`outbound_isolation`, `isolation_detail`) and
appends it to the registry. Errors, warnings and recovery records are one JSON line each on
stderr.

Exit codes: `0` ok · `2` usage error · `3` the member was created and registered but is not
ready (it is sitting on a startup dialog) · `4` a preflight check failed and **nothing was
created** · `5` refused before placement (a dangerous or isolation-breaking agent flag, a
pane that is not an idle shell, an unsafe registry/policy path) — also nothing created · `1`
anything else, including an isolation failure discovered after placement. A failure *after*
creation closes a pane the script itself made; a worktree it made is never auto-removed — you get a
`{"recovery":{"status":"orphaned",...}}` line with the cleanup command, so nothing is
deleted behind your back.

`--preflight` checks `HERDR_ENV=1`, `jq`/`git`/`herdr`, `herdr --version` ≥ 0.8.2, the
argument values, that the registry is writable, and that herdr actually **answers this
session** — and creates nothing, not even an empty registry file. If herdr does not answer it
prints `{"ok":false,"code":"herdr_unreachable",...}` on stdout **and** the matching
`{"error":...}` line on stderr, then exits 4, rather than reporting a cheerful `ok` with an
empty result; both result lines carry `"sandbox"` (`$CODEX_SANDBOX`, or empty). Every other
preflight failure is the stderr error line only, with nothing on stdout.

Outbound isolation is on by default. A Codex member gets `-a never` plus a child-only
`.codex/rules/herdr-jutsu-deny.rules` in its actual cwd; the layer is git-excluded and the
spawn reports `enforced_if_trusted` because Codex ignores project rules for an untrusted
repo. Policy installation is serialized per cwd through agent start. A symlinked git
`info/` or `info/exclude` is never followed or replaced; isolation remains active and
`isolation_detail` discloses that the exclude entry was not added. An isolated Codex member is also
launched without the tools that live outside the sandbox: `--disable` for connected apps, browser and
computer use, plugins, image generation and related features, `-c mcp_servers.<name>.enabled=false` for
each server declared in the user's `config.toml`, and web search off. The user config itself stays
loaded, because it holds the trust record that makes the project rules apply — `--ignore-user-config`
would drop the deny rules while the user's own allow rules kept loading. A config server whose name
the launcher cannot override safely refuses the spawn (`isolation_unsupported_mcp_server`). A Claude member gets a
merged `--disallowedTools` deny for `Bash(*herdr*)` and `ListAgents`, reported honestly as
`partial`: it cannot drive herdr or discover sessions, but keeps `SendMessage` for the
sessions its brief names. `--strict-isolation` denies `SendMessage` as well, for a member
that handles untrusted content; `isolation_detail` says which applies. Shell members are
`none`.
`--no-isolation` is only for a nested parent that must drive herdr and requires a user
decision. Under isolation, Codex accepts only safe sandbox/approval/model/profile/add-dir
forms, four model-related config keys, and a final `resume` pair. Every other token is
refused; profiles require an explicit safe `-s` value.

`--record-session --name <member> [--session-id <id>]` records a session id for a member that
already exists — the case where it started behind a startup dialog, or was itself revived by
resume, so nothing was captured. It creates no pane, starts nothing, and appends one row;
the registry is append-only and the latest row for a name is the current one. The new row's
`status` is the member's current herdr status when herdr reports one, else the literal
`recorded` — never the spawn-time status, since a recorded session means the member got past
its startup dialog.

## Where state lives

| What | Where |
|---|---|
| Crew registry (one JSONL per stream) | first writable of `$JUTSU_STATE_DIR` → `${XDG_STATE_HOME:-~/.local/state}/herdr-jutsu/<stream>.jsonl` → `<repo>/.jutsu/state/<stream>.jsonl` → nowhere |
| Worktrees | wherever herdr puts them — `~/.herdr/worktrees/<repo>/<branch>` |
| Handoff notes | `<member cwd>/.jutsu/handoff-<name>.md` (add `.jutsu/` to your global gitignore) |

The state directory is created `0700` and the registry file `0600`, and a symlinked one is
refused outright. Under a sandbox that allows no writes at all the spawn still goes ahead
and reports `"registry":"none"` with a warning — nothing is recorded, so the parent keeps
the spawn line itself. Each line carries the path it used as `registry_path`; read that
rather than assuming a location.

The registry is a hint for a resuming parent; live `herdr agent list` always wins. It is
safe to delete.

## Cleaning up

Ask the parent to retire the crew, or by hand:

```bash
herdr pane close <pane_id>                          # a member or helper
git -C <worktree> status --short                    # look before removing
herdr worktree remove --workspace <workspace_id>    # a worktree stream
git branch -d <branch>                              # herdr leaves the branch behind
```

## Known limits

- **Reports are pulled, never pushed.** The parent waits on the literal pane id and pulls.
  A `[crew:…]` line has no protocol meaning and is ignored. Only a Claude member of a Claude
  parent has a channel back (SendMessage, for a blocking question or an early warning);
  Codex members and `--strict-isolation` members have none, and can only say so in FINAL.
- **Pulled output is untrusted prose.** Pane reads are line-capped; report files are read
  only from the path named in the brief and at a byte cap. Any requested action is checked
  against the brief and the parent's permissions.
- **Isolation has explicit limits.** Codex needs a trusted repo and `-a never`; Claude's
  string match is only partial; shell members are not isolated. The threat boundary is peer
  agents and accidents, not root or a hostile same-user process.
- **A Codex parent has no autonomous background wake.** It may block its current turn on
  `herdr agent wait`, or pull later on its own schedule. Parent commands still require the
  user's Codex rules to allow the relevant literal command outside the sandbox.
- **herdr's agent status is evidence, not truth.** It can show a stale `blocked`, or `idle`
  for an agent sitting on a dialog it doesn't recognise. The skill looks at the pane before
  the first prompt to any herdr-driven member.
- **Fresh worktrees are clean checkouts** — no `logs/`, `.env`, `node_modules/`, and none of
  your uncommitted changes.
- Agents can stall at launch on their own dialogs (e.g. Codex's self-update offer). The
  parent takes only the do-nothing option and tells you.
- Launch presets cover `claude` and `codex`. The script passes any herdr agent kind
  through, but nothing else has been tried.
- Session handoff is designed and dry-run tested, not yet exercised on a real long job.

## Install

```
/plugin marketplace add DMokong/claude-plugins
/plugin install herdr-jutsu@dmokong-plugins
```

or from a shell: `claude plugin marketplace add DMokong/claude-plugins && claude plugin install herdr-jutsu@dmokong-plugins`.
Restart any open Claude Code session afterwards — skills are cached per session.

For Codex, from a local clone: `codex plugin marketplace add <path to this repo>`, then
`codex plugin add herdr-jutsu@dmokong-plugins`, then start a new thread.

You also need `herdr` (≥ 0.8.2), `jq`, `git` and bash 3.2+ on the machine. The skill has no
machine-specific paths and finds its own script relative to where it is installed.

### Optional: make every session herdr-aware

The skill loads when a task calls for it. If you also want sessions to know herdr's
capabilities up front, add this to a project's `CLAUDE.md` (and `AGENTS.md` for Codex):

```markdown
### Session Start: Herdr

If `HERDR_ENV=1`, run `herdr --skill` once at session start and read the whole output — it
is herdr's own, version-matched reference. If `HERDR_ENV` is unset, skip it silently and
never drive a herdr session from outside one. Its safety rules always hold: `--no-focus`
for background work, explicit pane IDs or agent names, never close what you didn't create,
never `herdr server stop`.

Crew members spawned by another session are named `<stream>-<role>`. Members do not message
other panes or sessions. The parent records their literal pane ids, waits, and pulls their
FINAL responses.
```

### Without the plugin system

Copy `skills/herdr-jutsu/` to `~/.claude/skills/` (one machine, all projects),
`<repo>/.claude/skills/` (one project), or `~/.agents/skills/` with a symlink from
`~/.claude/skills/` (also visible to Codex and other runtimes).

## Status

`0.x` — built and live-tested on herdr 0.8.2, but young. Spawning, naming, both message
buses, blocked-member handling, Codex resume and cleanup have been exercised for real from a
**Claude** parent; session handoff has run for real once (a Claude lead handing to a successor session); the **Codex-parent** path has
passed a live end-to-end run once, by manual placement, on a machine with the `herdr agent`
and `herdr pane` prefixes already allowed — with the script route, non-pane placements and
rule-less machines still untried. Expect the conventions to tighten as it gets used on real
streams.

0.3.0 replaces member pushes with a literal-pane completion rendezvous, installs child
outbound isolation, treats pulled prose as evidence rather than instructions, and requires
a visible-pane check before every key send. Verified live after release: a Codex member
is refused herdr by rule and by sandbox and cannot delete its deny rules; Codex accepts the
attached and `=` flag spellings the allowlist accepts; text left unsent in a Claude parent's
input box survives a background-wait wake.

0.4.0 closes a gap found by a live probe: an "isolated" Codex member still carried the account's
connected apps, the user's MCP servers and web tools — all outside the sandbox and the herdr deny
rule. Isolated members are now launched without them; `--no-isolation` is unchanged. Codex's own
sub-agent tools and built-in skills remain, and run inside the same sandbox and rules.

0.3.1 stops calling a Claude member's permission mode "effective": the launcher sees launch
args, not the member's settings, so it names the mode only when an arg set it and otherwise
warns that the settings decide and the string-pattern deny may be the only barrier.
