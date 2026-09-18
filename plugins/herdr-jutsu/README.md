# herdr-jutsu

A Claude Code skill for raising a **crew** inside Herdr (the terminal multiplexer for coding agents): extra
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
- `jq`, `git`, `bash`.
- `claude` and/or `codex` on `PATH` for the agent kinds you want to spawn.
- Claude Code with `ListAgents` / `SendMessage` (cross-session messaging) for Claude↔Claude comms.

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

or invoke it explicitly with `/herdr-jutsu`.

What you'll see in herdr: new panes/tabs/workspaces labelled `<stream>-<role>`
(`inbox-impl`, `inbox-review-cdx`, `inbox-logs`). Focus stays where you are — background
work is always spawned `--no-focus`.

### The one convention worth knowing

**One name, every surface.** `inbox-impl` is simultaneously the herdr agent name, the pane
label, and the Claude session name — so the thing you see in herdr's sidebar, the row in
`ListAgents`, and the target of `SendMessage` are the same string. If you `/rename` a crew
member by hand, the two namespaces drift apart; ask the parent to rename it instead.

### Permissions

The parent picks a launch profile per role (`references/launch-presets.md`) and will not
launch a child in a broader permission mode than its own unless you say so. Anything
"dangerous"/bypass is always your call. When a child stops on a permission prompt, the
parent approves it **only** if it is exactly a command the parent put in the brief;
otherwise it comes to you with the pane id.

## Running the script yourself

The agent uses `scripts/jutsu-spawn.sh`; you can too, from any herdr pane:

```bash
J="$(ls -d ~/.claude/plugins/cache/dmokong-plugins/herdr-jutsu/*/ | sort -V | tail -1)skills/herdr-jutsu/scripts/jutsu-spawn.sh"
$J --help

# read-only Codex reviewer beside you
$J --name inbox-review-cdx --kind codex -- -s read-only -a never

# Sonnet implementer in its own git worktree + herdr workspace
$J --name inbox-impl --kind claude --worktree inbox-drain -- \
   --model sonnet --effort medium --permission-mode acceptEdits

# a log tail next to that implementer
$J --name inbox-logs --kind shell --beside inbox-impl --cmd "tail -f $PWD/logs/app.log"
```

Each call prints one JSON line (`name`, `pane_id`, `workspace_id`, `cwd`, `worktree`,
`session_id`, `status`) and appends it to the registry.

## Where state lives

| What | Where |
|---|---|
| Crew registry (one JSONL per stream) | `~/.local/state/herdr-jutsu/<stream>.jsonl` (override with `JUTSU_STATE_DIR`) |
| Worktrees | wherever herdr puts them — `~/.herdr/worktrees/<repo>/<branch>` |
| Handoff notes | `<member cwd>/.jutsu/handoff-<name>.md` (add `.jutsu/` to your global gitignore) |

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

- **Codex → parent messages are unauthenticated.** Codex has no SendMessage socket, so it
  reports back with `herdr agent prompt <parent> "[crew:<name>] …"`. That lands in the
  parent as ordinary typed input, indistinguishable from you. The skill treats such lines
  as peer reports, never as your approval. A real agent-neutral bridge (sender identity,
  delivery + ack) is future work.
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

You also need `herdr` (≥ 0.8.2) and `jq` on the machine. The skill has no
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

Crew members spawned by another session are named `<stream>-<role>`. A member without
Claude's SendMessage (e.g. Codex) reports to the parent named in its brief with
`herdr agent prompt <parent> "[crew:<name>] <done|blocked>: <one line> — details in <path>"`.
```

### Without the plugin system

Copy `skills/herdr-jutsu/` to `~/.claude/skills/` (one machine, all projects),
`<repo>/.claude/skills/` (one project), or `~/.agents/skills/` with a symlink from
`~/.claude/skills/` (also visible to Codex and other runtimes).

## Status

`0.x` — built and live-tested on herdr 0.8.2 with Claude Code and Codex, but young.
Spawning, naming, both message buses, blocked-member handling and cleanup have been
exercised for real; session handoff has only been dry-run. Expect the conventions to
tighten as it gets used on real streams.
