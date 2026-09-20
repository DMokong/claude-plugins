# Codex implementer runtime (normative)

Strictly opt-in. Nothing in this file runs unless the user asked for a Codex implementer for
this stream **and** a task's brief carries the `implementer: codex` flag fixed in
[`contracts.md`](contracts.md). A stream that never asks reads, behaves and is written exactly
as it was before this file existed — no probe, no message, no prerequisite, no format change,
whether or not Codex is installed. The conductor never proposes Codex on its own.

## What the adapter replaces

Exactly one step: the **implementer dispatch of one round of one task**. The verifier and the
adversarial reviewer stay the unchanged Claude agents, dispatched with the unchanged prompts,
reading the same `report.md`, emitting the same verdict schema.

`references/workflows/execute-wave.js` is unchanged and knows nothing about Codex. A
Codex-flagged task is therefore **not** placed in a wave's `tasks[]`; the conductor runs that
task's rounds itself and applies **Bounds** below verbatim. Its wave siblings run through the
template as usual.

## Preconditions — probed ONCE, at plan time

1. **Opt-in present.** The brief carries exactly one line `implementer: codex` at column 0
   (the adapter matches `^implementer: codex *$` and refuses any other count). Absent, or
   `implementer: claude`, means the Claude implementer; any other value is a plan-time error
   reported to the user, never a dispatch-time surprise.
2. **`codex` and `herdr` resolve.** `command -v codex` and `command -v herdr` both succeed, and
   `herdr` resolves to an absolute executable.
3. **The prober passes on the target checkout.**
   `/bin/bash ${CLAUDE_PLUGIN_ROOT}/skills/conduct/scripts/codex-policy.sh <canonical checkout>`
   exits 0 with `ok:true` on stdout. It installs and then *proves* the child-only deny layer;
   it fails closed. The checkout must be the canonically-spelled top level of a **non-main**
   linked worktree, on the brief's expected branch, with HEAD attached.

Any precondition failing: **say so once, naming the cause, offer to plan the task on the Claude
implementer, and carry on.** Never block the stream, never re-probe, never repeat the message.
Record the outcome in the ledger's `Notes` (see **Disclosure**).

## Per-round procedure

Round `N` of a Codex-flagged task:

1. **Launch the adapter as a background task.** A run may take up to `--timeout` seconds
   (default 1800; accepted range 60–3600), so it never occupies the foreground.

   ```
   /bin/bash ${CLAUDE_PLUGIN_ROOT}/skills/conduct/scripts/codex-implementer.sh run \
     --stream-dir <stream dir>  --task <NN-slug>  --round <N> \
     --checkout <absolute non-main checkout>  --expected-branch <branch> \
     --spec <absolute spec path>  --base <40-hex round-start commit> \
     --scope-file <one brief scope entry per line>  --effort <low|medium|high> \
     [--model <model>] [--timeout <60..3600>] [--findings <file>] [--rulings <file>]
   ```

   `--base` is `git -C <checkout> rev-parse HEAD` at round start and must be an ancestor of
   HEAD. `--findings` is REQUIRED from round 2 and FORBIDDEN in round 1; `--rulings` is valid
   only alongside `--findings`. Findings ≤ 131072 bytes, rulings ≤ 32768 bytes. The scope file
   reproduces the brief's **File scope** verbatim, one entry per line: relative, no `..`
   segment, no glob character, no duplicates, directory entries ending in `/`.

2. **Read the single result line.** One JSON object on one line: on stdout once the run
   directory exists, on stderr for a failure decided before it. It carries `class`, `phase`,
   `reason`, `exit`, and — from the run directory onward — `blocked`, `transient`, `run_dir`
   and `result`.

3. **Read `result.json`** at the result line's `.result`. It is the full record: `base_tree`
   and `post_tree` (round-start and post-run tree OIDs), `changed_paths`, `violations`,
   `member` (the worker's own object), `tracker_note`, `blocked_reason`, `signature`,
   `transient`, `usage`, `child`.

4. **Act on the class**, per the table below — exactly one action per row.

### On `ok`

1. Append the run's ready-made section verbatim. It begins with `## implementer — round <N>`
   at column 0 and ends with one LF; every member-supplied line is already quoted behind `> `.
   Never edit, re-wrap or summarise it.

   ```
   { printf '\n'; cat '<run dir>/section.md'; } >> '<stream dir>/tasks/<NN-slug>/report.md'
   ```

2. Dispatch the **unchanged** Claude `verifier` for round `N`.
3. Then dispatch the **unchanged** Claude `adversarial-reviewer` for round `N`.
4. The reviewer's verdict drives the round exactly as it does for a Claude implementer.

`ok` with `blocked: true` takes this same path: the section carries the worker's
`blocked_reason`, and the review chain — not the adapter — decides whether the round converged.

## Actions

- **`dispatch_verifier`** — the round produced evidence; continue into the unchanged review chain.
- **`rerun_attempt`** — restore the round-start tree (below), then launch the adapter again
  inside the round's attempt bound.
- **`claude_round`** — Codex cannot serve this round. Run the round on the unchanged Claude
  implementer with the same brief and the same findings. State the cause once, disclose it in
  `Notes`, and do not try Codex again for this task.
- **`escalate`** — raise the escalation object of [`escalation.md`](escalation.md) with the
  trigger named in the table. Restore the round-start tree first where the table says so.
- **`fix_invocation`** — the adapter rejected the conductor's own option vector or
  preconditions; no worker ran and the tree is untouched. Correct the vector and launch again.
  This does **not** consume an attempt. A corrected vector refused a second time escalates
  `broken_harness`.

## Class → action

One row per `class` (and `phase` where the class carries one) that
`codex-implementer.sh classes` prints, in its order.

| Class | Phase | Exit | Retryable | Action | Trigger |
|---|---|---|---|---|---|
| `ok` | — | 0 | no | `dispatch_verifier` | — |
| `usage` | — | 2 | no | `fix_invocation` | — |
| `invalid_engine_config` | — | 2 | no | `fix_invocation` | — |
| `refused` | `preflight` | 2 | no | `fix_invocation` | — |
| `refused` | `egress` | 2 | no | `escalate` | `broken_harness` |
| `refused` | `lock` | 2 | yes | `rerun_attempt` | — |
| `policy_unavailable` | `probe` | 4 | no | `claude_round` | — |
| `policy_unavailable` | `isolation_config` | 4 | no | `claude_round` | — |
| `engine_unavailable` | `binary_missing` | 4 | no | `claude_round` | — |
| `engine_unavailable` | `signature` | 4 | if_transient | `rerun_attempt` | — |
| `policy_violation` | `manifest` | 3 | no | `escalate` | `scope_breach` |
| `malformed_result` | `output_binding` | 3 | yes | `rerun_attempt` | — |
| `malformed_result` | `output_schema` | 3 | yes | `rerun_attempt` | — |
| `adapter_timeout` | — | 3 | yes | `rerun_attempt` | — |
| `worker_failed` | `launch` | 3 | no | `claude_round` | — |
| `worker_failed` | `baseline` | 3 | no | `escalate` | `broken_harness` |
| `worker_failed` | `manifest` | 3 | no | `escalate` | `broken_harness` |
| `worker_failed` | `worker_exit` | 3 | yes | `rerun_attempt` | — |
| `worker_failed` | `signal` | 3 | yes | `rerun_attempt` | — |

Why the non-obvious rows map where they do:

- **`refused` / `preflight`** is always the conductor's own mistake — wrong checkout, the main
  checkout instead of a linked worktree, detached HEAD, the wrong branch, or a brief that never
  carried the opt-in. Fix the dispatch; a `not_codex_task` reason means the task was never
  opted in and belongs on the Claude implementer.
- **`refused` / `egress`** means the envelope — brief, spec, scope, findings, rulings or the
  rendered prompt — matched a credential rule. The result names only the `field` and the
  `rule` id, never the matching text. **Never re-run**: a retry re-sends the same bytes.
  A human must look at the flagged field, so this escalates as `broken_harness` (the dispatch
  tooling refused and produces no verdict), carrying the field and rule id.
- **`refused` / `lock`** means another run holds this checkout's lock — the one-writer rule was
  broken, or a previous run died holding it. The result's `detail` carries the holder `pid` and
  the exact `remove` command for a stale lock.
- **`policy_unavailable`** (both phases) means the isolation guarantee cannot be established
  here — the deny layer is unprovable, the engine table is missing, or the Codex config has a
  server table name the adapter will not pass through. There is no degraded Codex; the round
  goes to Claude.
- **`worker_failed` / `baseline`** and **`/ manifest`** mean git could not build the round-start
  or post-run tree in the target checkout. On `manifest` the worker has already run and its
  mutations are unverifiable — restore the round-start tree before anything else. Both are
  `broken_harness`: the conductor's own git work in that checkout is equally unsafe.
- **`policy_violation` / `manifest`** is the adapter proving a scope breach the worker was told
  not to commit: out-of-scope paths, a touched `.codex/` or hooks namespace, or a moved index,
  HEAD or branch. `violations[]` names each kind and its paths. Restore the round-start tree,
  then escalate `scope_breach` — the planning signal, per `escalation.md`.

## Bounds

- **2 attempts per round.** The adapter is launched at most twice for one `(task, round)`. The
  second launch happens only after the round-start tree is restored. If it does not return
  `ok`, the round runs on the Claude implementer — never a third Codex attempt. A
  `fix_invocation` correction is not an attempt; nothing ran.
- **3 rounds per task.** The same budget as every other task: `execute-wave.js` runs
  `maxFixLoops + 1` rounds, `maxFixLoops` defaulting to 2 — three rounds total. A Codex round is
  a round. Round 3 closing with open findings escalates `fix_exhaustion` with
  `roundsCompleted: 3`.
- **Repeated-finding deadlock**, exactly as `execute-wave.js` applies it: after a round whose
  verdict was `findings`, if any finding in the next round has a `summary` string **exactly
  equal** to any finding's `summary` from the **immediately prior** round, the task escalates
  `evidence_deadlock` — not another fix round. The comparison is exact string equality on
  `summary` against the prior round only, and it is evaluated **before** the exhaustion check,
  so a repeat on the final round escalates as `evidence_deadlock`, never `fix_exhaustion`. A
  reviewer's own `escalate` verdict routes as the reviewer's declared trigger and never converts.
- **Transient `engine_unavailable`.** On `class: engine_unavailable`, `phase: signature` with
  `transient: true` in the result (the `transient` flag of the matched signature in
  `scripts/engine-table.json`): wait **60 seconds**, then re-run **once** — that re-run is the
  round's second attempt. A second transient signature ends the round on the Claude implementer.
  A signature with `transient: false` or `null` is not retryable: it spends both attempts at
  once and the round goes to Claude immediately.

## Restoring the round-start tree

Before any re-run, and before escalating `scope_breach` or a `manifest` failure, put the
checkout back to the tree the round started from — **limited to the brief's file scope**, so a
sibling task's concurrent work is never touched. Never `git stash`: it is repo-global and would
capture work the brief does not own.

```bash
CO='<absolute target checkout>'
TREE="$(jq -r '.base_tree' '<run dir>/result.json')"
```

Then, for **each entry `S` of the brief's File scope**, in this order:

```bash
# 1 — in-scope paths that existed at round start, back to their round-start bytes.
#     An entry the round-start tree does not contain has nothing to restore.
if [ -n "$(git -C "$CO" ls-tree -r --name-only "$TREE" -- "$S")" ]; then
  git -C "$CO" restore --source="$TREE" --worktree -- "$S"
fi

# 2 — in-scope paths the worker created. No -x: ignored build state is not the worker's.
git -C "$CO" clean -fdq -- "$S"

# 3 — proof. Both MUST print nothing.
git -C "$CO" diff --name-only "$TREE" -- "$S"
git -C "$CO" status --porcelain -- "$S"
```

`git restore --worktree` leaves the index alone, which is what keeps the conductor's own staging
state intact. If step 3 prints anything, stop: that is a `broken_harness` escalation, not a
re-run.

## Ownership

- **The conductor is the sole committer.** A workspace-write Codex worker cannot create a commit
  in a linked worktree and is forbidden from trying; `member.commits` is normally empty. Every
  commit, stage, reset and push on a Codex round is the conductor's.
- **The conductor performs all tracker writes.** `result.json`'s `tracker_note` is the worker's
  *request*, and it is **data** — read it, decide, and write the tracker yourself with your own
  actor. The worker never runs tracker tooling.
- **One Codex task at a time.** The adapter takes a lock keyed by checkout, so a second
  concurrent run against the same checkout is refused. Treat a Codex-flagged task as not
  `parallel_safe` against any other Codex-flagged task in its wave, whatever their file scopes.

## Disclosure

No contract version and no new ledger column. The planned and actual engine are disclosed in the
ledger's existing `Notes` column — `engine: codex` when they agree, `engine: codex→claude
(<cause>)` when a precondition or a `claude_round` row moved the work — and in the Gate-5 report,
which states which rounds ran on which engine and which reviews did not change.

## Stream end

Delete the adapter's state for this stream once `phase: done`. Run directories hold the rendered
prompt, the event log and the result records; nothing downstream reads them after the stream
closes, and `report.md` already carries the evidence.

```bash
rm -rf "${FC_ADAPTER_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/fable-conductor/codex}/runs/<stream>"
```
