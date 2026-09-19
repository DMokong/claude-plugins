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
- Optional: Claude Code with `ListAgents` / `SendMessage`. Claude↔Claude messaging uses it
  when it is there; everything else runs over herdr.
- **From a Codex session, one more thing:** Codex runs a command outside its sandbox only
  when the command matches an allow rule in *your* Codex rules, and inside the sandbox
  herdr's socket is unreachable. So a Codex session can read this skill but cannot drive
  herdr — as a parent *or* as a crew member reporting back — unless you have allowed the
  relevant `herdr …` commands (and, to use the script, its own path) to run outside the
  sandbox. That is your security decision: the skill describes what it would need and never
  edits a rules file. A **Claude** parent driving Codex members needs nothing extra for
  spawning, briefing and pulling — the parent is the one talking to herdr.

## Works from a Claude Code or a Codex parent

The skill's shared text names *actions* and assumes the weakest transport — the herdr bus,
which carries no sender identity and arrives as typed input. Two reference files translate
that into each parent's own tools:

- **Claude Code parent** (`references/parent-claude.md`): briefs Claude members over
  SendMessage, which adds sender identity and queued delivery, and uses the herdr bus for
  everything else.
- **Codex parent** (`references/parent-codex.md`): no ListAgents, no SendMessage, and
  Codex's own subagent tools cannot see a herdr pane — so the herdr bus is used in both
  directions, with no added guarantees. It also only works at all where your Codex rules let
  herdr commands run outside the sandbox, and the reference file starts with exactly what
  that means. **It has passed a live end-to-end test once:** a Codex parent under a
  `workspace-write` sandbox, on a machine where the `herdr agent` and `herdr pane` prefixes
  were already allowed, placed a Claude child by hand, briefed it, got its wake signal and
  pulled the evidence. Still unexercised: driving `jutsu-spawn.sh` itself from Codex (that
  needs a rule for the script's own path), tab/workspace/worktree placement from Codex, and
  anything at all on a machine with no herdr rules. A young path with one pass, not a
  settled one.

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
launch a child in a broader permission mode than its own unless you say so. Bypass and
full-access flags are not merely discouraged — the script **refuses** them (exit 5,
nothing created) unless `--allow-dangerous-agent-flags` is passed, which is always your
call, never the parent's.

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
`session_id`, `status`, plus `registry`, `registry_path`, `agent_args`, `resume_args`) and
appends it to the registry. Errors, warnings and recovery records are one JSON line each on
stderr.

Exit codes: `0` ok · `2` usage error · `3` the member was created and registered but is not
ready (it is sitting on a startup dialog) · `4` a preflight check failed and **nothing was
created** · `5` refused (a dangerous agent flag, a pane that is not an idle shell, an unsafe
registry path) — also nothing created · `1` anything else. A failure *after* creation closes
a pane the script itself made; a worktree it made is never auto-removed — you get a
`{"recovery":{"status":"orphaned",...}}` line with the cleanup command, so nothing is
deleted behind your back.

`--preflight` checks `HERDR_ENV=1`, `jq`/`git`/`herdr`, `herdr --version` ≥ 0.8.2, the
argument values, that the registry is writable, and that herdr actually **answers this
session** — and creates nothing, not even an empty registry file. If herdr does not answer it
prints `{"ok":false,"code":"herdr_unreachable",...}` on stdout **and** the matching
`{"error":...}` line on stderr, then exits 4, rather than reporting a cheerful `ok` with an
empty result; both result lines carry `"sandbox"` (`$CODEX_SANDBOX`, or empty). Every other
preflight failure is the stderr error line only, with nothing on stdout.

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

- **Messages over the herdr bus are unauthenticated.** A member without SendMessage reports
  back with `herdr agent prompt <parent> "[crew:<name>] …"`. That lands in the parent as
  ordinary typed input, indistinguishable from you — and it can splice into a line you are
  half-way through typing and be submitted as part of your message. The skill treats such a
  line as a **wake signal only**: it never acts on the body, it pulls the evidence from the
  member's pane or report file. A real agent-neutral bridge (sender identity, delivery +
  ack) is future work.
- **A Codex parent is a young path with exactly one live pass.** It works over the herdr bus
  in both directions, with none of the guarantees a Claude parent gets from SendMessage — and
  only where your Codex rules allow those commands outside the sandbox. What has been run end
  to end is the **manual placement** route in `references/parent-codex.md`: a Codex parent
  raised, briefed and pulled from a Claude child by issuing the `herdr pane` / `herdr agent`
  calls itself. Driving `jutsu-spawn.sh` from Codex, tab/workspace/worktree placement from
  Codex, and a machine with no herdr rules at all are all still unexercised.
- **A Codex crew member cannot always reply.** Its `[crew:…]` push needs the same rules. The
  skill therefore treats a push as a wake signal and an optimisation, and makes the parent's
  own pull (`herdr agent read`, or the report file) the contract.
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

Crew members spawned by another session are named `<stream>-<role>`. A member without
Claude's SendMessage (e.g. Codex) reports to the parent named in its brief with
`herdr agent prompt <parent> "[crew:<name>] <done|blocked>: <one line> — details in <path>"`.
```

### Without the plugin system

Copy `skills/herdr-jutsu/` to `~/.claude/skills/` (one machine, all projects),
`<repo>/.claude/skills/` (one project), or `~/.agents/skills/` with a symlink from
`~/.claude/skills/` (also visible to Codex and other runtimes).

## Status

`0.x` — built and live-tested on herdr 0.8.2, but young. Spawning, naming, both message
buses, blocked-member handling, Codex resume and cleanup have been exercised for real from a
**Claude** parent; session handoff has only been dry-run; the **Codex-parent** path has
passed a live end-to-end run once, by manual placement, on a machine with the `herdr agent`
and `herdr pane` prefixes already allowed — with the script route, non-pane placements and
rule-less machines still untried. Expect the conventions to tighten as it gets used on real
streams.

0.2.0 reworked the skill text around a hardened `jutsu-spawn.sh`: `[crew:]` lines are wake
signals, the permission-prompt rule is stricter, parent instructions split per surface, and
the script enforces what the text used to only advise.
