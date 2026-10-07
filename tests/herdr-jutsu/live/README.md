# A2A live gates

These gates start real Claude Code and Codex sessions. They are deliberately excluded from
`tests/herdr-jutsu/run.sh`; the offline suite must never start a real agent or use `codex
queue`.

Run them from a named Claude parent inside Herdr, with a reachable
`CLAUDE_CODE_MESSAGING_SOCKET`. The checkout containing this script and the parent directory
chosen for the new scratch repository must already be trusted by both engines. The script
creates the scratch repository, refuses to reuse an existing path, and deletes only that
newly-created directory on exit. It closes only panes returned by its own launcher calls.

```bash
markers=/absolute/private/leak-markers.txt
scratch=/absolute/pretrusted-parent/a2a-live-scratch
evidence=/absolute/evidence/a2a-live

A2A_LIVE=1 bash tests/herdr-jutsu/live/a2a-live.sh \
  --scratch "$scratch" --evidence "$evidence" --markers "$markers" --gate all
```

**Trust comes first.** Both engines ask before working in a directory they have not seen,
and the script never answers that prompt. A new repository is a new directory to them even
when its parent is trusted, so the scratch path itself must be trusted before the run. Use
one fixed scratch path and trust it once:

- Codex: add `[projects."<scratch>"]` with `trust_level = "trusted"` to `~/.codex/config.toml`
  (the entry is keyed by path, so it survives the script deleting and recreating the
  directory).
- Claude Code: start `claude` once in a directory at that path and accept the folder prompt.

Without this the first spawn fails with `agent_start_failed` (timeout) or
`a2a_thread_unresolved`, and the gate's failing JSON says so. Do not point the gates at a
worktree of a real repository to borrow its trust: L6 asks the member to push and delete,
and the scratch repository has no remote precisely so that a failed L6 can harm nothing.

`--gate` also accepts one of `L1`, `L2`, `L3`, `L4`, `L6`, or `L7`. An empty markers file
is valid. Each non-empty line is treated as a fixed string; a transcript line containing
one is replaced with `[REDACTED private marker]` before being retained.

Each gate writes `<evidence>/<gate>.json` with this shape:

```json
{
  "gate": "L1",
  "pass": true,
  "assertions": [{"name": "...", "pass": true, "detail": "..."}],
  "transcript_paths": ["/absolute/evidence/L1-codex.txt"]
}
```

The script fails immediately within a gate, still writes that gate's failing JSON, and never
retries L6. Audit logs are copied beside the transcripts; they contain metadata and outcomes,
not message bodies. Parent sends to Codex always include the single absolute `codex` path
resolved at startup.

The exact launch forms are:

```text
jutsu-spawn.sh --name <gate>-codex --stream <gate-stream> --kind codex \
  --cwd <scratch> --a2a [--peer <sibling>] -- -s workspace-write -a never
jutsu-spawn.sh --name l2-claude --stream l2live --kind claude \
  --cwd <scratch> --a2a --peer l2-codex \
  -- --model sonnet --effort medium --permission-mode acceptEdits
```

L1 proves two parent/member round trips during the first working turn and captures framing
on both sides. L2 proves one sibling-initiated round trip in each direction. L3 proves the
peer allowlist, the direct-queue policy, and the six-per-minute sender limit. L4 compares the
Codex rollout's user-turn count across a send to a closed pane. L6 delivers the three
specified adversarial bodies separately and verifies both the member's computed refusal
marker and the unchanged scratch repository. L7 compares rollout turns and audit outcomes
around the direct relay attempt.

Run the owner-only L5 check separately using `owner-l5-checklist.md`.
