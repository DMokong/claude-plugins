# File Contracts

Normative. Agents follow this file literally. It fixes the stream directory layout and the exact format of every artifact the conductor and its workflow agents exchange. Two independent agents producing or consuming the same artifact MUST NOT be able to diverge on its shape.

## Stream directory

Every stream lives at `docs/fable-streams/<YYYY-MM-DD-slug>/` in the target repo:

```
docs/fable-streams/<YYYY-MM-DD-slug>/
├── stream.md          # frontmatter + task ledger (the stream's control surface)
├── design.md          # Phase 1 (Shape) output — or a POINTER if it lives elsewhere
├── spec.md            # Phase 2 (Spec) output — or a POINTER to a speculator spec
├── plan.md            # Phase 3 (Plan) output — task graph + wave structure
├── escalations.md     # append-only escalation log
└── tasks/NN-slug/
    ├── brief.md       # the per-task contract (immutable except by Fable amendment)
    └── report.md      # append-only evidence log; each agent appends one stamped section
```

- `NN` is a zero-padded two-digit task index (`01`, `02`, …); `slug` is kebab-case.
- **Pointers, never copies.** An artifact produced by another system (a speculator spec, a `superpowers` brainstorm doc, a beads epic) MUST be referenced by path/id in the stream file, never duplicated into it. Copies rot; pointers stay true.
- **Streams are committed project history**, not scratch. Every file here is committed to the repo like any other doc. Never `.gitignore` a stream.

## stream.md

YAML frontmatter — exactly these fields:

| Field | Value |
|---|---|
| `stream` | the `<YYYY-MM-DD-slug>` id |
| `phase` | one of `route \| shape \| spec \| plan \| execute \| finalize \| done` |
| `entry` | detected entry point: `idea \| spec \| plan` |
| `conductor_model` | the model(s) that conducted — extend on cross-session handoff, never overwrite (e.g. `sonnet (phases 1-4), fable (phase 5)`) |
| `weave` | map of capability → binding (e.g. `speculator: <spec-id>`, `beads: <epic-id>`, `superpowers: loaded`) |
| `target_repo` | absolute path to the repo the stream mutates |

Body — the **task ledger**, a single table, the stream's source of truth for progress — plus, optionally, one `## Handoff` section (a single paragraph written at a finalize handoff: what's done, what's parked as deferred, where the evidence lives). No other body content is permitted:

```
| Task | Wave | Status | Fix rounds | Notes |
|---|---|---|---|---|
| 02-contracts | 1 | done | 0 | |
```

`Status` is one of `pending | running | done | escalated | blocked`. `Fix rounds` is the integer count of adversarial fix loops consumed by that task. The conductor updates the ledger; workflow scripts never write `stream.md`.

## brief.md format

A brief is the complete, self-contained contract for one task. Required H2 sections, in this order:

- **Goal** — one paragraph: what artifact this task produces and why.
- **Done-check** — a runnable check (a command or grep), never a vibe. If it passes, the task is done.
- **File scope** — explicit create/modify paths or globs. Scope is a HARD boundary: an agent that cannot finish inside it MUST escalate `scope_breach`, never widen the scope.
- **Required content** — the exact structure the artifact MUST have (sections, fields, ordering).
- **Inputs** — paths the agent MUST Read before acting.
- **Verification commands** — copy-paste runnable; the verifier runs these verbatim.
- **Report obligation** — what the agent appends to `report.md`.
- **Out of scope** — what this task must NOT do (usually owned by a sibling task).

Flags — set in frontmatter or inline, exactly these:

- `parallel_safe: true | false` — `true` only when this task's file scope is disjoint from every wave sibling's, so it may fan out concurrently.
- `testable: true | false` — `true` triggers the test-author dispatch for this task inside the wave. (test-breaker runs only at stream level via `test-adversary.js`, gated on a test-suite AC — never per task.)
- `tier: standard | judgment` — `standard` binds implementer + reviewer to **sonnet**; `judgment` binds them to **opus** for design-heavy or normative artifacts. The verifier is ALWAYS **haiku**, regardless of tier. Full model ladder: `fable → opus → sonnet → haiku`.

## report.md format

Append-only. Each agent appends **exactly one** stamped section per round, headed literally `## <role> — round <N>` — an H2 at column 0, with an em dash between role and round.

`role` ∈ `implementer | verifier | adversarial-reviewer | test-author | test-breaker | spec-auditor | fable`. `N` is the fix-loop round (starts at 1). `fable` is the CONDUCTOR's fixed adjudication-stamp token regardless of the conductor's actual tier — tier truth lives in `stream.md`'s `conductor_model` and the Gate-5 report's mandatory disclosure, never in the stamp.

- Every claim MUST sit adjacent to the command output that supports it.
- Evidence is command-output **tails** — at most 30 lines per command, never full logs.
- Reviewers (`adversarial-reviewer`, `spec-auditor`) MUST record their verdict object verbatim as a fenced ```json block.
- **Nobody edits or deletes a prior section.** A dispute is a new section, never a rewrite of someone else's.

## Verdict schema

Reviewers emit exactly this object:

```json
{
  "verdict": "pass | findings | escalate",
  "findings": [
    { "severity": "blocker | major | minor", "summary": "...", "evidence": "..." }
  ],
  "escalation": { "trigger": "...", "detail": "..." }
}
```

- `verdict` ∈ `pass | findings | escalate`.
- `findings` is `[]` when `verdict` is `pass`. Each finding's `severity` ∈ `blocker | major | minor`; `summary` and `evidence` are strings.
- `escalation` is `null` unless `verdict` is `escalate`, in which case `trigger` ∈ `fix_exhaustion | evidence_deadlock | plan_invalidating_discovery | scope_breach | broken_harness` and `detail` is a string.
- Finding nothing is a legitimate result — reviewers MUST NOT manufacture findings to look thorough.

## escalations.md format

Append-only log. One entry per escalation, exactly these fields:

| Field | Source |
|---|---|
| timestamp | supplied by the conductor — NEVER generated by a workflow script |
| task id | the `NN-slug` that escalated |
| trigger | one of the five trigger enum values |
| evidence pointer | `report.md` path + the section header that holds the evidence (not an inline copy) |
| adjudication | the playbook move the conductor chose (recorded whatever the conductor's tier) |
| outcome | what happened after adjudication (resumed, replanned, pulled into session, closed, deferred (awaiting fable-tier conductor)) |

Entries are never edited; a superseded adjudication is a new appended entry.

## Evidence rules

Three laws, in force everywhere:

1. **Adjacency.** Every claim sits next to the command output that supports it. A claim with no adjacent evidence is unsupported and MUST be treated as false.
2. **Tails, not logs.** Evidence is output tails (≤30 lines per command). Never paste a full log; excerpt the load-bearing tail.
3. **Provenance wins.** Evidence you did not generate beats evidence you did. When a verifier's tails contradict an implementer's self-report, the verifier tails are authoritative.
