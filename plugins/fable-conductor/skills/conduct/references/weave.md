# Weave — capability detection and handoff

Normative reference for Phase R (Route) and every phase that follows. Read this before deciding whether to delegate a phase or run the conductor's built-in fallback.

## Principle

Detection is capability-probing, never assumption. Ask the user nothing a probe can answer — if a probe can determine whether superpowers, speculator, beads, the Workflow tool, or fable-mode is available, run the probe; do not ask "do you have superpowers installed?"

Weave is **INVOKE-ONLY**. fable-conductor never writes into another plugin's files, state, or conventions — no editing speculator's spec files directly, no hand-authoring beads JSONL, no reaching into superpowers' skill internals. It calls their commands and skills (`/sdlc start`, `superpowers:brainstorming`, `bd create`, etc.) and consumes their outputs (spec ids, plan docs, issue ids) as pointers recorded in `stream.md`. If a weave target doesn't expose an invocable surface for what the conductor needs, that's a signal to fall back to the built-in path — not a license to write into the target plugin's territory.

## Probes

Run every probe once, at Phase R. Each probe is a fact-check against the current session, not a guess from memory. A probe that errors or returns ambiguous evidence counts as absent — the conductor never treats an inconclusive probe as a green light; it falls back to the built-in path and can re-probe on resume if the ambiguity was transient.

### superpowers

Probe: are the skill names `superpowers:brainstorming` and `superpowers:writing-plans` present in the available-skills list surfaced to this session? Check both independently — a partial superpowers install (one skill present, the other missing) is possible and each weave decision (Phase 1 vs Phase 3) depends on its own skill being present.

### speculator

Probe: is the skill name `speculator:sdlc` (or any of the `/sdlc` family — `speculator:spec-create`, `speculator:gate-check`, `speculator:sdlc-close`, etc.) present in the available-skills list? Presence of the umbrella `speculator:sdlc` skill is sufficient to treat the whole `/sdlc` surface as available, since `sdlc` routes to the sub-skills internally.

### beads

Probe: does `bd --version` (or `bd prime`) succeed when run in the target repo? A non-zero exit or "command not found" means beads is absent for this stream — don't assume presence from CLAUDE.md mentioning beads; the binary or the repo's `.beads/` init may not actually be there.

### Workflow tool

Probe: is `Workflow` present in the session's tool list? This is a session-level capability, not a plugin — some Claude Code surfaces expose it, others don't. Probe the tool list directly rather than assuming based on which model or client is running.

### fable-mode

Probe: is the skill `fable-mode:fable-mode` present in the available-skills list? Note this is orthogonal to "is this session Fable" — fable-mode being installed doesn't mean the conductor session invoked it, only that its gate vocabulary is available to cite by name.

### Probe summary

Quick reference for Phase R — the mechanical check behind each capability, in one line:

| Capability | Concrete check |
|---|---|
| superpowers | `superpowers:brainstorming` and `superpowers:writing-plans` in available-skills list |
| speculator | `speculator:sdlc` (or any `speculator:*` sub-skill) in available-skills list |
| beads | `bd --version` exits 0 in the target repo |
| Workflow tool | `Workflow` in the session's tool list |
| fable-mode | `fable-mode:fable-mode` in available-skills list |

## Handoff table

Reproduces and elaborates the design table. The fourth column states what the conductor records for that capability in `stream.md`'s `weave` frontmatter field, following `contracts.md`'s normative convention: `weave` is a **map of capability → binding** (per `contracts.md` §stream.md, e.g. `speculator: <spec-id>`, `beads: <epic-id>`, `superpowers: loaded`) — a flat set of capability-named keys, never phase-named keys like `phase1_owner` or `spec_owner`. Every weave decision must be traceable in the stream file, not just implied by which agents ran.

| Capability | Present → | Absent → | Recorded in `stream.md` weave map |
|---|---|---|---|
| `superpowers:brainstorming` | Delegate Phase 1 (Shape) to it — the conductor invokes the skill and consumes `design.md` (or its pointer) as the phase output. | Built-in condensed protocol: context first, one question at a time, 2–3 approaches presented, sectioned design doc, explicit human approval before Phase 2. | Under the `superpowers` key, e.g. `superpowers: loaded (brainstorming used for phase 1)` when present; the row below shares this same key. |
| `superpowers:writing-plans` | Delegate the Phase 3 plan doc to it; the conductor then derives per-task `brief.md` files from the resulting plan (dependency slicing, file scopes, verification commands per `contracts.md`). | Built-in: conductor produces dependency-sliced tasks and briefs directly per `contracts.md` conventions — no separate plan-doc weave step. | Same `superpowers` key, value extended as sub-skills fire: `superpowers: loaded (brainstorming + writing-plans used for phases 1,3)`. `superpowers: absent` when neither probe passes. |
| `speculator /sdlc` | Phase 2 = `/sdlc start` + `/sdlc score` until Gate 1 passes; Phase 5 delivery = `/sdlc gate` + `/sdlc close`. `stream.md` binds the spec id and worktree path instead of duplicating spec content. | Conductor writes `spec.md` with numbered ACs + self-review (placeholders, contradictions, ambiguity, scope); delivery is PR/merge options via `finishing-a-development-branch`-style choices. | `speculator: <spec-id> (worktree: <path>)` when bound; `speculator: loaded but not bound (<reason>)` or `speculator: absent — built-in spec.md` otherwise. |
| `beads` | Epic + per-task issues mirror the task ledger; `bd` issue ids are recorded in the ledger's Notes column alongside each task's status. | Ledger in `stream.md` is the only tracker — no external issue ids to reconcile. | `beads: <epic-id>` when present; `beads: absent — stream-ledger-only` otherwise. |
| `Workflow tool` | Phases 4–5 run the workflow templates (`execute-wave.js`, `test-adversary.js`, `final-audit.js`) as designed. | Degrade to Agent-tool parallel batches per wave — same briefs, same contracts, same fix-loop rules, but orchestrated via direct Agent-tool dispatch instead of a Workflow script; the degradation is noted in `stream.md` and in the affected reports. | `workflow_tool: available` when present; `workflow_tool: absent — agent-batch degrade` otherwise. |
| `fable-mode` | Cite gates by name (Gate 3 refute-then-steelman, finding-nothing-is-legitimate, etc.) in dispatched prompts and the final report — shorter prompts, shared vocabulary. | Inline the two load-bearing rules directly into prompts: refute-then-steelman, and finding-nothing-is-legitimate. No gate-name shorthand available. | `fable_mode: loaded — gate citations` when present; `fable_mode: absent — inlined rules` otherwise. |

## Conflict rules

When both superpowers and speculator can plausibly own a phase, ownership resolves by phase, not by capability precedence:

- **Phase 2 (spec)** and **Phase 5 (delivery)** → speculator wins when present, regardless of superpowers presence. Speculator owns the spec-and-gate lifecycle; the conductor does not duplicate it.
- **Phase 1 (shape)** and **Phase 3 (plan-doc authoring)** → superpowers wins when present, regardless of speculator presence. Speculator has no shape or plan-doc primitive to compete with.

Regardless of what's woven in, the conductor always owns: task briefs, wave composition and dispatch, escalation adjudication, the Phase 5 whole-branch final review, and the Gate-5 report. No weave target ever assumes these — they are the judgment core the conductor exists to protect.

Concretely: even when speculator owns Phase 2, the conductor still authors task briefs from the resulting spec's ACs — speculator is never asked to produce `brief.md` files. Even when superpowers owns Phase 1, the conductor still decides wave structure and model tiering at Phase 3 — superpowers' plan doc feeds that decision but doesn't make it.

## Re-probe policy

Probe once, at Phase R, for a given stream. Record every probe result in `stream.md`'s weave-bindings block at that point — presence/absence per capability, not just the resulting owner assignments — so a later session can see what was actually detected versus what was inferred.

Re-probe only when **resuming** a stream in a new session (a fresh `claude` invocation picking up an existing `stream.md`). Mid-stream, within a single continuous session, capabilities are treated as fixed — do not re-probe between phases or between waves; a capability appearing or disappearing mid-session (e.g. a plugin installed by another process) is not expected to change an in-flight stream's weave bindings.
