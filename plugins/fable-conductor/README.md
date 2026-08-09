# fable-conductor

**Fable-maximised orchestration of entire work streams — from idea to shipped.**

One frontier-tier "conductor" session owns everything that actually needs judgment: shaping the idea, writing the spec, slicing the plan, adjudicating escalations, and the final whole-branch review. Everything mechanical in between — implementing, verifying, reviewing, testing — runs on autonomous opus/sonnet/haiku agent waves that are **adversarial by construction** and coordinated entirely through **durable file contracts**, never through agent memory.

The conductor re-enters at exactly two seams: escalations and final review. That's the whole idea — maximise the expensive model where judgment lives, and spend it nowhere else.

## Install

```
/plugin marketplace add DMokong/claude-plugins
/plugin install fable-conductor@dmokong-plugins
```

## Usage

```
/conduct <raw idea>              # start a new stream from an idea
/conduct path/to/spec.md         # enter mid-arc at Phase 3 (plan)
/conduct path/to/plan.md         # enter mid-arc at Phase 4 (execute)
/conduct docs/fable-streams/...  # resume an existing stream
/conduct                         # scan for an in-flight stream to resume
```

The skill also triggers proactively when a request describes a multi-task feature arc (idea → spec → plan → implement → test → review → ship), especially on a frontier/judgment-tier session.

## The phase model

| Phase | Name | Who runs it | What happens |
|---|---|---|---|
| R | Route | Conductor | Detect entry point (resume / mid-arc / raw idea), probe capabilities once, record weave bindings |
| 1 | Shape | Conductor (interactive) | Brainstorm → sectioned design doc → explicit human approval |
| 2 | Spec | Conductor | Spec with **numbered, testable acceptance criteria** — every later adversarial stage keys off them |
| 3 | Plan | Conductor | Per-task briefs, dependency-sliced waves, model-tier assignments. **Last mandatory human touchpoint** |
| 4 | Execute | Autonomous waves | test-author → implementer → verifier → adversarial-reviewer per task, bounded fix loops, structured escalation |
| — | Escalation loop | Conductor | The designed path back to judgment, not a failure mode |
| 5 | Finalize | Conductor | Blinded audit + refute panel as triage, then the conductor's own whole-branch final review and calibrated report |

## The model ladder

Tasks map onto `fable → opus → sonnet → haiku`:

- **`judgment` tier** → opus implementer + reviewer (design-heavy, normative, architectural tasks)
- **`standard` tier** → sonnet implementer + reviewer
- **Verifier is always haiku** — its job is mechanical, and the tier spread costs it nothing

You escalate a *task's* tier, never a role's — the checkpoint design never changes.

### Conductor tiers

The conductor role transfers to weaker models; Fable's judgment does not:

- **Fable** — full protocol as written.
- **Opus — emulation mode.** fable-mode's five-gate discipline is required as a judgment prosthetic; refute panel raised to 5; defer-to-Fable available for precedent-setting or design-intent deadlocks; conductor tier disclosed in every report.
- **Sonnet — structure-only mode.** Workers become peers, but the structure still pays (adversarial two-stage review, file contracts, fresh-context workers, parallel fan-out are model-independent wins). Dispatching workers *above* the conductor's tier is correct and encouraged.
- **Finalize handoff** — any conductor can run Phases 1–4 and hand the judgment seams to a Fable session via the stream directory. The file contracts make this free: everything Fable needs is already on disk.

## Agents

| Agent | Role | Model |
|---|---|---|
| `implementer` | Executes exactly one task brief within its file scope; appends evidence to the task report | sonnet (opus for judgment-tier) |
| `verifier` | Runs the brief's verification commands **verbatim**, records exit codes + output tails; never interprets, diagnoses, or fixes | haiku, always |
| `adversarial-reviewer` | Tries to refute "done" before a task is accepted — reads brief → report → diff, re-runs cheap done-checks itself | sonnet (opus for judgment-tier) |
| `test-author` | Writes behavioral tests from the ACs before implementation (red baseline), hardens after test-breaker rounds | sonnet |
| `test-breaker` | Writes N deliberately-wrong implementations that try to sneak past the suite; survivors expose sensitivity gaps | sonnet |
| `spec-auditor` | **Blinded** cold-read of the whole diff against the spec's ACs — no task reports, no implementer reasoning, ever | opus |

## Workflow templates

Three deterministic orchestration scripts under `skills/conduct/references/workflows/`, dispatched via Claude Code's `Workflow` tool:

- **`execute-wave.js`** — runs ONE dependency-free wave through the per-task pipeline (optional test-author → implementer → verifier → adversarial-reviewer) with bounded fix loops (default 3 rounds total) and structured escalation. The conductor owns the dependency graph; the template only ever sees one wave.
- **`test-adversary.js`** — N parallel test-breakers attack the authored suite; survivors drive one hardening round by the test-author; anything still passing after hardening is "residue" the conductor must escalate.
- **`final-audit.js`** — blinded spec-auditor cold-read plus a per-AC haiku refute panel. Returns **triage for the conductor's final review, never a substitute verdict**.

No `Workflow` tool in the session? The skill degrades gracefully to Agent-tool parallel batches — same briefs, same contracts, same fix-loop rules — and notes the degradation in the stream.

## File contracts

All coordination is durable files, never agent memory. Every stream lives at `docs/fable-streams/<YYYY-MM-DD-slug>/` in the target repo, committed as project history:

```
docs/fable-streams/<YYYY-MM-DD-slug>/
├── stream.md          # frontmatter + task ledger (the stream's control surface)
├── design.md          # Phase 1 output (or a pointer)
├── spec.md            # Phase 2 output (or a pointer to a speculator spec)
├── plan.md            # Phase 3 output — task graph + wave structure
├── escalations.md     # append-only escalation log
└── tasks/NN-slug/
    ├── brief.md       # the per-task contract (immutable except by conductor amendment)
    └── report.md      # append-only evidence log; each agent appends one stamped section
```

Key invariants (normative detail in `skills/conduct/references/contracts.md`):

- **Pointers, never copies** — artifacts owned by other systems are referenced by path/id, never duplicated.
- **Append-only reports** — each agent stamps `## <role> — round <N>`; nobody edits a prior section; evidence is command-output tails adjacent to every claim; provenance wins (verifier tails beat implementer self-report).
- **Working-directory contract** — every brief and worker prompt names the absolute target checkout and branch, guarded by `git rev-parse`. Workers inherit the dispatcher's cwd, which is often the *wrong* repo; this contract exists because of a real field defect.
- **Escalation triggers** — `fix_exhaustion | evidence_deadlock | plan_invalidating_discovery | scope_breach | broken_harness`. Each escalation is self-contained: the conductor reads the brief + report it points at and rules without re-deriving the task. The adjudication playbook runs cheapest-first: amend the brief → adjudicate the deadlock → defer to Fable → pull into session (last resort, always recorded) → replan the subgraph → bundle genuine product decisions for the human.

## Weave — plays well with others

At Phase R the conductor probes the live session (never assumes) and binds what it finds. Weave is **invoke-only**: fable-conductor calls other plugins' commands and consumes their outputs as pointers — it never writes into their files or conventions.

| Capability | Present → | Absent → |
|---|---|---|
| `superpowers` | brainstorming owns Phase 1; writing-plans owns the Phase 3 plan doc | Built-in condensed protocols |
| `speculator` | `/sdlc start` + `score` own Phase 2; `/sdlc gate` + `close` own delivery | Conductor-authored `spec.md`, PR/merge options |
| `beads` | Epic + per-task issues mirror the ledger | `stream.md` ledger is the only tracker |
| `Workflow` tool | Templates run as designed | Agent-tool batch degrade |
| `fable-mode` | Gates cited by name in prompts and reports | The two load-bearing rules inlined |

Regardless of what's woven in, the conductor always owns: task briefs, wave composition, escalation adjudication, the final whole-branch review, and the calibrated closing report. No weave target ever assumes these.

## When NOT to use

- **Single-task work** — one file, one change. Use `fable-mode` alone; orchestration buys nothing without a dependency graph.
- **Trivial edits** — a rename, a typo, a config bump. Just do it.
- **Haiku sessions** — no leverage over any worker tier and thin judgment for adjudication.

**Relationship to fable-mode:** fable-mode disciplines how a *single* session works; fable-conductor orchestrates *many* sessions across the model ladder. They stack — the recommended setup is this skill running on a Fable session that also honours the fable-mode gates.

## Layout

```
fable-conductor/
├── .claude-plugin/plugin.json
├── agents/                        # the six worker agents
├── commands/conduct.md            # /conduct
└── skills/conduct/
    ├── SKILL.md                   # the conductor's operating manual
    └── references/
        ├── contracts.md           # normative file formats
        ├── escalation.md          # triggers + adjudication playbook
        ├── weave.md               # capability probes + handoff table
        └── workflows/             # execute-wave.js, test-adversary.js, final-audit.js
```

## Version history

- **1.1.3** — socket-aware conducting (conductor-to-conductor messaging; sockets carry pointers and wake-ups only, file state remains authoritative) + Claude-5-era prompt economy
- **1.1.2** — blinded-review findings on the v1.1.1 working-directory contract
- **1.1.1** — working-directory contract in all worker prompts and briefs
- **1.1.0** — conductor emulation modes, defer-to-Fable, finalize handoff
- **1.0.0** — initial release

## License

MIT © Dustin Cheng
