---
name: conduct
description: >-
  This skill should be used when the user says "/conduct", "conduct this", "run a work stream",
  "orchestrate this feature end to end", "fable conductor", "build this with agent workflows",
  or "take this from idea to shipped" — and PROACTIVELY when a request describes a multi-task
  feature arc (idea to spec to plan to implement to test to review to ship), especially on a
  frontier/judgment-tier session. Runs a full work stream with conductor judgment at
  shape/spec/plan/escalations/final-review and autonomous opus/sonnet/haiku adversarial waves for
  everything mechanical in between. Non-Fable sessions conduct too: opus in emulation mode, sonnet
  in structure-only mode, either handing Phase 5 to a Fable session (see Conductor tiers).
  fable-mode disciplines a single session; this skill orchestrates many — they stack.
---

# Conduct — the fable-conductor operating manual

You are the conductor session. This is the manual you follow to run one work stream from idea to shipped. Follow it stepwise; it is normative.

## What this is

Maximise the expensive model where judgment actually lives — shaping, spec, planning, escalation adjudication, and the final whole-branch review — and spend it nowhere else. Everything mechanical between plan approval and final review runs on opus/sonnet/haiku agents dispatched through Workflow templates, coordinated entirely through durable file contracts, never through agent memory. Every dispatched agent reads its own brief and appends its own evidence; you read the ledger and the escalations, not the transcripts. The waves are adversarial by construction: an implementer produces, a verifier runs the checks verbatim, a reviewer tries to refute "done," and fix loops are fresh dispatches carrying brief + diff + findings. You re-enter at exactly two seams — escalations and final review. Relationship to fable-mode: fable-mode disciplines how a *single* session works; this skill orchestrates *many* sessions across the model ladder. They stack — run this on a Fable session that also honours the fable-mode gates.

## When NOT to use

- **Single-task work** — one file, one change, one review. Use `fable-mode` alone; the orchestration overhead buys nothing when there is no dependency graph to slice.
- **Trivial edits** — a rename, a typo, a config bump. Just do it; do not spin up a stream directory for a two-minute change.
- **Haiku sessions** — no leverage over any worker tier and thin judgment for adjudication. Do the work directly, or ask the user to relaunch on a stronger model if the arc genuinely warrants conducting.

A non-Fable session is NOT automatically disqualified — see **Conductor tiers** below. Opus conducts in emulation mode; sonnet conducts in structure-only mode; both can hand Phase 5 to a Fable session.

## Conductor tiers — emulation and handoff

The conductor role transfers to weaker models; Fable's judgment does not. Detect which model this session runs, record it as `conductor_model` in `stream.md` at Phase R, and apply the matching mode:

- **Fable** — full protocol as written. Everything below is inapplicable.
- **Opus — emulation mode.** The five-gate discipline is the prosthetic that closes part of the judgment gap: invoke `fable-mode` before conducting (in emulation it is REQUIRED, not recommended — if it is not installed, warn the user and inline its gate rules from `references/weave.md` before proceeding). Compensate at the weak seams: raise `final-audit.js`'s `panelSize` to 5, and prefer the **defer-to-Fable** escalation move (see `references/escalation.md`) over ruling a hard deadlock at opus tier. The Gate-5 report MUST disclose the conductor tier ("adjudicated and reviewed at opus tier") — never let the report imply Fable-grade review it didn't get.
- **Sonnet — structure-only mode.** The model-leverage premise inverts (workers are peers), but the structure still pays: adversarial two-stage review, file contracts, fresh-context workers, and parallel fan-out are model-independent wins. State this trade-off to the user in one line before Phase 1. Judgment-tier tasks still map to opus — dispatching workers ABOVE the conductor's tier is correct and encouraged. Treat defer-to-Fable as the default for any non-trivial escalation, raise `panelSize` to 5, and strongly prefer the finalize handoff below over conducting Phase 5 yourself. Disclose the tier in every report.

**Finalize handoff (cross-session tiering).** Any conductor may run Phases 1–4 and hand the judgment seams to a Fable session: finish the last wave, park unresolved escalations in `escalations.md` with outcome `deferred (awaiting fable-tier conductor)`, set `phase: finalize` in `stream.md`, append a `## Handoff` section to its body (one paragraph per `references/contracts.md`: what's done, what's parked, where the evidence lives), and tell the user to resume with `/conduct` on a Fable session. The resuming Fable conductor re-probes capabilities (per `references/weave.md`), adjudicates the deferred escalations first, then runs Phase 5 as written. The file contracts make this free — everything Fable needs is already in the stream directory. When a stream changes conductors, extend `conductor_model` rather than overwriting it (e.g. `sonnet (phases 1-4), fable (phase 5)`).

## Phase R — Route

Detect before you ask. Ask the user nothing detection can answer. Run detection in this order and enter at the first match:

1. **Resume.** If `$ARGUMENTS` is a path to an existing stream directory, OR `docs/fable-streams/` in the target repo holds a stream whose `stream.md` frontmatter `phase` is not `done`, resume that stream at its recorded `phase`. On resume, re-probe capabilities (a new session may have a different capability set — see the re-probe policy in `references/weave.md`).
2. **Enter mid-arc.** If `$ARGUMENTS` points at a spec file / speculator spec dir, or a plan file, enter at the phase *after* the newest existing artifact (a spec present but no plan → Phase 3; a plan present → Phase 4). Record the detected `entry` in `stream.md`.
3. **Raw idea.** Otherwise treat the request (or `$ARGUMENTS`, when invoked via `/conduct`) as a raw idea and enter Phase 1. If there is no idea at all — empty `$ARGUMENTS`, no in-flight stream — ask once for the idea to conduct.

Then run the capability probes per `references/weave.md` (superpowers, speculator, beads, Workflow tool, fable-mode) — once, here at Phase R. Record every probe result and the resulting weave bindings in `stream.md`'s `weave` map. Detection is capability-probing against the live session, never assumption.

## Phase 1 — Shape (interactive)

Weave per `references/weave.md`: if `superpowers:brainstorming` is present, delegate the shaping to it and consume its output as `design.md`; else run the built-in condensed protocol — context first, one question at a time, present 2–3 approaches, produce a sectioned design doc, get explicit human approval before Phase 2.

At the **first artifact** you write, create the stream directory per `references/contracts.md`: `docs/fable-streams/<YYYY-MM-DD-slug>/`, with `stream.md` (frontmatter + empty ledger). Write the Phase 1 output to `design.md` (or a pointer if the brainstorm doc lives elsewhere — pointers, never copies). Set `phase: shape` then advance it as you go.

## Phase 2 — Spec

Weave per `references/weave.md`:

- **Speculator present** → `/sdlc start` (worktree, beads epic, spec scaffold), then `/sdlc score` until Gate 1 passes. Record the spec id and worktree path as a pointer in `stream.md`'s `weave` map — never duplicate spec content into the stream.
- **Absent** → write `spec.md` yourself with **numbered, testable acceptance criteria**, then self-review it for placeholders, contradictions, ambiguity, and scope.

ACs are load-bearing: every later adversarial stage keys off them — the reviewer checks the diff AC-by-AC, the spec-auditor cold-reads against them, the refute panel votes per AC. Enforce that every AC is numbered and independently testable. A vague AC becomes an unfalsifiable audit downstream.

## Phase 3 — Plan

Weave the plan *doc* per `references/weave.md` (`superpowers:writing-plans` if present, else built-in dependency-sliced decomposition). Then discharge the conductor's **own non-delegable duty** — no weave target ever produces these:

- **Per-task briefs.** For each task write `tasks/NN-slug/brief.md` in the exact format `references/contracts.md` fixes (H2 sections: Goal, Done-check, File scope, Required content, Inputs, Verification commands, Report obligation, Out of scope). The Done-check must be a runnable check, not a vibe. Every File scope opens with the **working-directory contract** — the absolute target-checkout path (worktree when used), expected branch, and the cd + `git rev-parse` guard (see `references/contracts.md`). Workers inherit YOUR session's cwd; a brief that says "the repo you are in" dispatches work into the wrong checkout.
- **Dependency-sliced waves.** Slice by dependency, not by category — each wave is a dependency-free batch. Later waves consume earlier waves' outputs.
- **`parallel_safe`** — set `true` only when a task's file scope is *provably disjoint* from every wave sibling's. v1 has no worktree-merge machinery; disjoint scopes are what make concurrency safe. When in doubt, `false`.
- **`testable`** — set `true` for tasks with a behavioral surface; it triggers the test-author dispatch inside the wave.
- **`tier`** per task on the ladder `fable → opus → sonnet → haiku`: `judgment` → opus implementer + reviewer for design-heavy, normative, or architectural tasks; `standard` → sonnet implementer + reviewer. The verifier is **always haiku** regardless of tier. You escalate a *task's* tier, never a role's — the checkpoint design is unchanged.

Present for approval: the task graph, the wave structure, the tier assignments, and an estimated agent count. **This is the last mandatory human touchpoint.** Between approval here and the final review in Phase 5, the waves run fully autonomous. Say so when you present, and make sure the plan is one you can stand behind unattended.

## Phase 4 — Execute (autonomous)

Run the plan wave by wave. You own the dependency graph; the workflow template only ever sees one dependency-free wave.

**Resolve agent registry names at runtime.** The plugin's agents appear in the available-agents list with an installation-dependent prefix — never hardcode a prefixed name. Look up the exact registry name for each and map into the `agentTypes` object the template expects. The mapping from `agentTypes` key to agent `name:`:

| `agentTypes` key | agent `name:` |
|---|---|
| `implementer` | `implementer` |
| `verifier` | `verifier` |
| `reviewer` | `adversarial-reviewer` |
| `testAuthor` | `test-author` |

**Build `args` for `execute-wave.js`** (schema copied verbatim from the template header; consumed as-is, never mutated):

```
args = {
  streamDir,      // absolute path to the stream directory
  repoRoot,       // REQUIRED: absolute path to the target repo CHECKOUT (the worktree when
                  // the stream uses one) — injected into every worker prompt as the
                  // working-directory contract; the template throws without it
  expectedBranch, // optional but pass it for any branch/worktree stream: workers verify
                  // `git rev-parse --abbrev-ref HEAD` matches before writing
  specPath,       // absolute path to the spec (reviewer reads it for AC checks)
  agentTypes: { implementer, verifier, reviewer, testAuthor }, // runtime-resolved registry names
  tasks: [{ id, briefPath, reportPath, parallelSafe, testable, tier }], // this wave only
  maxFixLoops     // ADDITIONAL rounds after round 1; default 2 (3 rounds total)
}
```

**Dispatch:** invoke the `Workflow` tool with `scriptPath = ${CLAUDE_PLUGIN_ROOT}/skills/conduct/references/workflows/execute-wave.js` and the `args` above. The template runs the per-task pipeline — optional test-author → implementer → verifier → adversarial-reviewer, bounded fix loops, structured escalation — and returns `{ completed[], escalations[], blocked[] }` (`blocked` arrives empty; *you* fill it from the graph).

**On completion:** update the `stream.md` ledger (status + fix rounds per task). Route every entry in `escalations[]` to the **Escalation loop** below and move that task's dependents to `blocked`. Then compose the next dependency-free wave from remaining tasks and dispatch again.

**Test-adversary** — if the spec carries a test-suite AC, run `test-adversary.js` after the wave that lands the suite. Invoke `Workflow` with `scriptPath = ${CLAUDE_PLUGIN_ROOT}/skills/conduct/references/workflows/test-adversary.js` and `args = { repoRoot, expectedBranch, specPath, briefPath, reportPath, scratchDir, suiteCommand, breakers, agentTypes: { testBreaker, testAuthor } }` (`repoRoot` REQUIRED — same working-directory contract as execute-wave) (`testBreaker` → `test-breaker` agent, `testAuthor` → `test-author` agent; `breakers` defaults to 3). It returns `{ gaps, hardened, residue }`; **non-empty `residue` is yours to escalate** — the template does not construct the escalation object.

**Workflow tool absent** → degrade per `references/weave.md`: run each wave as Agent-tool parallel batches — same briefs, same contracts, same fix-loop rules, orchestrated via direct Agent-tool dispatch — and note the degradation in `stream.md` and the affected reports.

## Escalation loop

An escalation is the designed path back to you, not a failure. Read `references/escalation.md` and adjudicate per its playbook — work the moves in order, cheapest first, your own hands last: **amend the brief** → **adjudicate the deadlock** from both evidence sets → **defer to Fable** (non-Fable conductors: park it rather than force a weak ruling) → **pull the task into session** (last resort) → **replan the affected subgraph** → **bundle a genuine product decision for the human** (only decisions the human owns; batched, never dripped one at a time).

Each escalation object carries `{ taskId, trigger, detail, reportPath, briefPath, roundsCompleted }` — read the two files it points at and rule without re-deriving the task. Record every adjudication in `escalations.md` (you supply the timestamp — no agent stamps its own) *and* append a `## fable — round <N>` section to the task's `report.md` when your ruling becomes settled fact the next round must inherit. Update ledger statuses **before** redispatch. Redispatch via a new wave carrying **only unfinished tasks**; blocked dependents re-enter once their blocker is cleared. Fix counters reset only on brief amendment or an embedded ruling — never on a bare retry. **Never pull a task into the session without recording why** — a silent takeover breaks the audit trail that lets the final report separate verified from adjudicated.

## Phase 5 — Finalize

Extract the numbered ACs from the spec. Run `final-audit.js` first — invoke `Workflow` with `scriptPath = ${CLAUDE_PLUGIN_ROOT}/skills/conduct/references/workflows/final-audit.js` and:

```
args = {
  streamDir, repoRoot,
  specPath,
  diffRef,          // e.g. 'main...HEAD' — what the auditor cold-reads
  acs: [{ id, text }],   // the numbered ACs you extracted
  auditReportPath,  // append-only audit evidence file
  agentTypes: { specAuditor },  // 'specAuditor' -> spec-auditor agent
  panelSize         // haiku voters per AC; default 3 (5 for non-Fable conductors — see Conductor tiers)
}
```

It returns `{ acVerdicts, findings, surplus, deficit, auditReportPath }`. **This is triage, not a verdict.** The audit is a blinded cold-read plus a per-AC refute panel; a finding means "worth your eyes," never an automatic fail.

Then do the whole-branch final review yourself with Gate 3 + Gate 4 discipline: refute-then-steelman the *branch*, verify each claim at the layer of the claim (if the claim is "output correct," look at the output — exit code 0 only proves the layer below). Audit findings get first attention, but your review is not limited to them — surplus/deficit flags and anything the audit missed are still yours to catch.

Delivery weave per `references/weave.md`: speculator-bound stream → `/sdlc gate` + `/sdlc close`; else present `finishing-a-development-branch`-style options (merge / PR / keep). Close with a Gate-5 calibrated report: verified vs assumed with evidence citations (file paths, commands, numbers you actually saw), the escalation history (including any deferred adjudications and who ultimately ruled them), the conductor tier(s) that reviewed the work (mandatory disclosure for non-Fable conductors), what the audit found vs what *you* found, and the stream directory itself as the standing audit trail. Set `stream.md` `phase: done`.

## Contracts quick-card

The invariants a conductor needs without opening `references/`. For anything else — the full brief anatomy, escalation trigger definitions, the adjudication playbook, the weave probe table — read the references.

- **Stream layout:** `docs/fable-streams/<YYYY-MM-DD-slug>/{stream.md, design.md, spec.md, plan.md, escalations.md, tasks/NN-slug/{brief.md, report.md}}`. Committed project history, never gitignored. Pointers, never copies.
- **stream.md frontmatter:** `stream, phase (route|shape|spec|plan|execute|finalize|done), entry (idea|spec|plan), conductor_model, weave (capability→binding map), target_repo`. Body = the task ledger table (`Task | Wave | Status | Fix rounds | Notes`; status ∈ `pending|running|done|escalated|blocked`). Only you write `stream.md`; workflow scripts never do.
- **brief required H2s (this order):** Goal · Done-check · File scope · Required content · Inputs · Verification commands · Report obligation · Out of scope. Flags: `parallel_safe`, `testable`, `tier: standard|judgment`.
- **report stamp:** `## <role> — round <N>` (H2 at column 0, em dash). role ∈ `implementer | verifier | adversarial-reviewer | test-author | test-breaker | spec-auditor | fable`. Append-only; nobody edits a prior section; evidence is command-output *tails* (≤30 lines) adjacent to every claim; provenance wins (verifier tails beat implementer self-report).
- **verdict schema:** `{ verdict: pass|findings|escalate, findings: [{severity: blocker|major|minor, summary, evidence}], escalation: null | {trigger, detail} }`.
- **trigger enum:** `fix_exhaustion | evidence_deadlock | plan_invalidating_discovery | scope_breach | broken_harness`.
