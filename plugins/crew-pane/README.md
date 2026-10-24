# crew-pane

A Claude Code mod for sessions that raise a crew inside Herdr with the `herdr-jutsu` plugin
from this marketplace: a `/crew` pane (and, optionally, a status line) showing each member's status, name,
where Herdr shows it, kind, issue, directory and age, plus the `fable-conductor` stream the
session is conducting.

- A member that blocks or finishes raises a toast; optionally it is spoken aloud.
- `/crew` opens the pane.

It is read-only. It runs three Herdr listings (`agent list`, `tab list`, `workspace list`) and
reads two kinds of file. It sends nothing to any pane.

## Needs

- Claude Code with mod support (early access; tested on 2.1.291).
- Running inside a Herdr pane (`HERDR_ENV=1`). Outside one it draws "Not inside herdr" and polls
  nothing.
- For member names and issues: the `herdr-jutsu` registry, found through `$JUTSU_STATE_DIR`, then
  `$XDG_STATE_HOME/herdr-jutsu`, then `<cwd>/.jutsu/state`. Without it "My crew" is
  empty; the "All" view still lists every live agent Herdr reports.
- For the stream table: `docs/fable-streams/*/stream.md` under the session's directory, as
  `fable-conductor` writes it. Without it the table is absent.

## Options

In `/config`:

- `Crew pane` (default `on`): poll Herdr and show this session's crew.
- `Speak when a member blocks` (default `off`): say it aloud as well as showing a toast.
- `Status line` (default `off`): also show the crew in the status line. The pane always shows it.
  While off, the mod never sets status-line text, and clears any line an earlier version set.

## Turning it off

- The `Crew pane` option in `/config`.
- `DMOKONG_MODS=0` in the environment silences every mod from this marketplace for that process.
- `claude plugin disable crew-pane@dmokong-plugins`.

Headless runs (`claude -p`) poll nothing.

## Working on it

    claude plugin validate plugins/crew-pane
    claude plugin test plugins/crew-pane
    claude --plugin-dir plugins/crew-pane

If the plugin is also installed, `--plugin-dir` overrides the installed copy for that session.
