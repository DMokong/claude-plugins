# Escalation protocol (normative)

File formats — brief, report, ledger, evidence-tail rules — live in [`contracts.md`](contracts.md); this
document defines only *when* to escalate, *who* fires it, *what* it carries, and *how* Fable adjudicates.

## Principle

Escalation is the designed path back to Fable — the seam where a cheap, stateless model hands judgment
up the ladder, not a failure mode. A haiku verifier or sonnet reviewer that escalates early, with
evidence, beats one that guesses to look unstuck. The tiering (fable → opus → sonnet → haiku) only pays
off if cheap tiers stop the instant they hit something needing judgment, not manufacture an answer.

But escalation is cheap only if *self-contained*. Every escalation must carry enough file context —
brief, report, rounds already run — that Fable adjudicates **without re-deriving the task**: read two or
three files and rule, not reconstruct what the task was. The unit of context is the *path*, not a
paraphrase — point at the files, never restate them into `detail`.

## Triggers

Any one trigger fires exactly one escalation object (below). Firing blocks the task's dependents;
independent tasks in the wave continue.

### fix_exhaustion

**Fires when:** the adversarial reviewer returns `findings` after `maxFixLoops` fix rounds have already
run (default `maxFixLoops: 2`). The counter counts *completed* fix dispatches; the escalation fires on
the reviewer verdict following the last allowed round. (A final-round `escalate` verdict routes as the
reviewer's own declared trigger instead — it never converts to `fix_exhaustion`.)

**Detected by:** the workflow script, via its loop counter. The script owns the count — no agent
self-reports exhaustion.

### evidence_deadlock

**Fires when** either holds:
- Verifier evidence and reviewer verdict **materially contradict**: the brief's verification commands
  exited clean with passing tails, yet the reviewer cites blocker-severity contrary evidence (or the
  inverse — commands fail, reviewer passes anyway).
- An implementer fix-round **disputes a finding with evidence** and the reviewer **re-raises the same
  finding without new evidence** — a stalemate more fix rounds cannot break.

The bar is *material* contradiction over the same claim, not two agents disagreeing on tone.

**Detected by:** reviewer self-declaration (a reviewer re-raising a disputed finding with no new
evidence returns `escalate` with this trigger rather than looping) and, script-side, a pragmatic v1
heuristic: `execute-wave.js` fires this trigger when an identical finding summary survives from the
immediately prior round after a fix attempt. The script does NOT itself compare verifier tails against
reviewer verdicts — a material verifier-vs-reviewer contradiction reaches Fable via the reviewer's
self-declaration or via Fable reading both evidence sets at adjudication, not via script parsing.

### plan_invalidating_discovery

**Fires when:** any agent finds a brief assumption false, a required dependency missing, or an
architectural surprise that changes the *shape* of the plan (not merely one task's difficulty). The
test: would the discovery have changed the plan had it been known at Phase 3.

**Detected by:** the discovering agent itself — any role (implementer, reviewer, verifier, test author).
It stops work and returns an `escalate` verdict carrying this trigger and the evidence.

### scope_breach

**Fires when:** the task cannot be completed inside its brief's declared file scope — the work genuinely
requires touching a file the brief does not grant.

**Detected by:** the implementer. It **MUST stop and escalate rather than touch an out-of-scope file.**
Silent scope-widening is never permitted; the file scope is a hard boundary, and a breach is a planning
signal, not an obstacle to route around.

### broken_harness

**Fires when:** the brief's verification commands **cannot run at all** — missing binary, unresolvable
dependency, broken build, environment or tooling failure. Distinct from a *test failure*: a command that
runs and reports red is normal signal; the harness is broken only when the command never produces a
verdict.

**Detected by:** the verifier, distinguishing "ran and failed" (record the tail, no escalation) from
"could not run" (escalate with this trigger and the error tail).

## Escalation object

A single escalation is:

```
{ taskId, trigger, detail, reportPath, briefPath, roundsCompleted }
```

- `taskId` — the ledger id of the escalating task.
- `trigger` — one of the five ids above, verbatim.
- `detail` — one or two sentences: what fired, pointing at evidence by path/section, not a restatement.
- `reportPath`, `briefPath` — the two files Fable reads to adjudicate; they make it self-contained.
- `roundsCompleted` — fix rounds already run, so Fable knows how much budget is spent.

The workflow returns a wave's escalations in `escalations[]`. Tasks that **depend on** an escalated task
move to `blocked[]`; **independent** tasks continue and complete. The wave never blocks globally on one.

## Fable adjudication playbook

Fable works these moves **in order**, taking the first that fits — cheapest resolution first, own hands last.

### 1. Amend the brief

Most common, and the default suspicion. The brief was wrong, incomplete, or ambiguous → Fable edits it
to fix the real defect, resets the fix counter, and redispatches next wave. Covers `scope_breach` (widen
the scope), one-brief `plan_invalidating_discovery`, and `fix_exhaustion` where the reviewer was right
and the brief under-specified the target.

### 2. Adjudicate the deadlock

For `evidence_deadlock` and stubborn `fix_exhaustion`: Fable reads **both** evidence sets — the
verifier's tails and the reviewer's cited evidence — and rules which is correct, appending a `## fable —
round <N>` ruling to the report (per `contracts.md`), then redispatching with the ruling embedded so the
next round inherits it as settled fact.

### 3. Pull into session

The expensive last resort for one task: Fable implements it directly in the conductor session. Reserved
for work needing Fable's judgment to produce at all, not merely adjudicate. Fable **records why** (report
and `escalations.md`) so the audit trail shows a deliberate escalation of *tier*, not a silent takeover.

### 4. Replan the subgraph

When a `plan_invalidating_discovery` invalidates more than one brief — the graph's shape is wrong —
Fable returns to Phase 3 for the **affected subgraph only**; untouched tasks keep their state and
evidence, and only the invalidated region is re-briefed.

### 5. Bundle a human question

**Only** for decisions the human genuinely owns — product scope, irreversible external actions, anything
Fable cannot legitimately decide alone. Fable **batches every pending human question into one
interaction** and never drips them. A trigger Fable can resolve with moves 1–4 never becomes one.

## Resume semantics

- Every adjudication is appended to `escalations.md` (append-only; the conductor supplies timestamps —
  agents and Fable do not stamp their own). It is the history the Phase 5 report cites.
- The next wave's `args` carry **only unfinished tasks**; blocked dependents re-enter once their blocker
  is adjudicated.
- **Fix counters reset only on brief amendment (move 1) or an embedded ruling (move 2).** A simple retry
  does **not** reset the counter — that would let a task loop forever.
- Ledger statuses in `stream.md` are updated to reflect the adjudication **before** redispatch, so the
  wave's view of task state is current when it fans out.

## Anti-patterns

- **Escalating without reading your own report first.** An agent firing an escalation must first read
  the report it points Fable at; a dangling `reportPath` is worse than no escalation.
- **Retrying the identical dispatch hoping for different output.** The same brief + diff + findings
  yields the same result. Change the inputs (amend brief, embed ruling) or the tier — never re-roll.
- **Fable silently fixing without recording the adjudication.** Ruling a deadlock or pulling a task in
  without an `escalations.md` entry and report section breaks the audit trail — the final report can no
  longer distinguish verified from adjudicated.
- **Treating `escalate` as shameful.** It is the protocol working as designed. A wave that never
  escalates on genuinely hard work is more suspicious than one that does.
