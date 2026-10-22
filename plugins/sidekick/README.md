# sidekick

A Claude Code mod that keeps the main session from spending turns on chores. Once you turn it
on for a session, a cheap **judge** reads each message you type. If it is a mechanical chore a
fresh agent could do from what is on disk ("commit and push", "pull main", "git status",
"close the bd issue"), a separate **worker** session does it. You get the outcome as one line
in the chat, and the main session gets a short handoff note so it knows what happened.
Everything else reaches the main session untouched.

- **Per session, opt-in.** Every session starts off. `/sidekick auto` turns it on for that
  session only, in whatever project the session is in.
- **Judge while you type.** When typing pauses, the judge runs on the draft, so by the time you
  press Enter the verdict is usually ready. A submit never waits more than 1.8 s, and a judge
  that is slow or fails lets the message through to the main session (it fails open).
- **The data-loss line.** The worker may commit, push, pull, branch, stash, tag and use `bd`.
  It may not force-push, `reset --hard`, `clean`, force-delete branches, discard uncommitted
  changes or rewrite pushed commits. That is enforced in the tool layer by deny rules plus a
  guard hook (`bin/sidekick-guard`), not just by asking. On a conflict it aborts its own
  operation and hands back a clean tree.
- **A lean worker.** `claude -p` on the worker model with no MCP servers, skills, settings
  hooks or CLAUDE.md, and only Bash/Read/Glob/Grep: about 10k tokens a run. Every assist starts
  with a fresh context.
- **Queued by default.** While an assist runs, messages for the main session are held and sent
  in order when it finishes (`send now` in the pane skips the wait). Parallel assists are
  experimental: they lock per repository or tracker.

## Using it

    /sidekick auto      hand chores to the worker in this session
    /sidekick shadow    judge and log only; everything still goes to the main session
    /sidekick off
    /sidekick           open the pane

The pane lists every judgment and assist, with `edit`, `watch`, `stop`, `revert`,
`give to main` and `should've been sidekick` (which records the miss for tuning).

A message the sidekick takes is dropped before it reaches the main session, so it shows in the
transcript as `❯ <your words> → sidekick (…)` but is **not** in the up-arrow prompt history (the
mod API has no way to add to it). Use `edit` in the pane to put it back in the prompt box. A band above the prompt shows
what is running, and a notification arrives when an assist finishes or needs you.

## Options (`/config`)

- `Judge model` and `Worker model`: any model alias or id (default `haiku` for both). The two
  slots are separate so either can be swapped later.
- `Parallel assists (experimental)`: 1 to 4 (default 1).
- `Sidekick`: off disables the command everywhere.

`DMOKONG_MODS=0` silences every mod from this marketplace for that process.

## Needs

- Claude Code 2.1.308 or later with mod support.
- `claude` on `PATH` (the worker is a headless Claude Code session) and `python3` (the guard).

## Working on it

    claude plugin validate plugins/sidekick
    claude plugin test plugins/sidekick
    claude --plugin-dir plugins/sidekick
