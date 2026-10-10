# bd-issue-band

A Claude Code mod: a one-line band above the prompt showing the [bd (beads)](https://github.com/steveyegge/beads)
issue this session holds and how long since anyone commented on it.

- Claim an issue (`bd update <id> --claim`, or a Beads MCP `claim`) and the band shows its id,
  its title and the minutes since its last comment.
- After 30 minutes of work with no comment the band turns to a warning and says so once.
- Edit a file with nothing claimed and it says so.
- `/issue` shows the band again. `/issue <id>` follows an issue claimed in an earlier session.

It only observes. It never blocks a tool call.

## Needs

- Claude Code with mod support (early access; tested on 2.1.291).
- The `bd` CLI on PATH, in a project that has a bd tracker. Where `bd where` finds no tracker
  the mod is dormant: no band and no nudge. A claim it sees wakes it.

## Turning it off

- The `Issue band` option in `/config`.
- `DMOKONG_MODS=0` in the environment silences every mod from this marketplace for that process.
- `claude plugin disable bd-issue-band@dmokong-plugins`.

Headless runs (`claude -p`) are always ignored.

## Working on it

    claude plugin validate plugins/bd-issue-band
    claude plugin test plugins/bd-issue-band
    claude --plugin-dir plugins/bd-issue-band

If the plugin is also installed, `--plugin-dir` overrides the installed copy for that session.
