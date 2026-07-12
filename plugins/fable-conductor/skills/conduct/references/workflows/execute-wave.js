// execute-wave.js — fable-conductor workflow template (task 08-wf-execute)
//
// Runs ONE dependency-free wave of tasks through the per-task pipeline:
// optional test-author -> implementer -> verifier -> adversarial reviewer,
// with bounded fix loops and structured escalation. The CALLER (conductor
// session) computes the dependency graph and hands this template exactly
// one wave whose tasks have no dependencies on each other.
//
// This file doubles as documentation for conductors adapting it — the
// CONTRACT comments below are normative (args shape, return shape,
// escalation-trigger semantics). Don't drift without updating the brief.

export const meta = {
  name: 'execute-wave',
  description: 'Executes one wave of tasks: optional test-author, then implementer/verifier/reviewer with bounded fix loops and escalation.',
  whenToUse: 'Call once per wave after the conductor session has computed a dependency-free batch of tasks to run.',
  phases: [{ title: 'Execute', detail: 'Dispatch test-author/implementer/verifier/reviewer per task — parallel-safe tasks first (concurrent), then serial tasks.' }]
}

// args may arrive as a JSON-encoded string depending on caller encoding — normalize before use.
const A = typeof args === 'string' ? JSON.parse(args) : args

// CONTRACT: args shape (consumed verbatim — never mutated, never re-derived)
//   args = {
//     streamDir,      // absolute path to the stream directory (reserved; unused in v1)
//     repoRoot,       // absolute path to the target repo (reserved; unused in v1)
//     specPath,       // absolute path to spec (reviewer reads this for AC checks)
//     agentTypes: { implementer, verifier, reviewer, testAuthor }, // registry
//                     // names resolved by the CALLER — never hardcode plugin-
//                     // prefixed agent names, prefixes vary by install.
//     tasks: [{ id, briefPath, reportPath, parallelSafe, testable, tier }],
//     maxFixLoops     // ADDITIONAL rounds allowed after round 1; default 2
//                     // (so 3 total rounds max) when absent.
//   }
// tier is 'standard' | 'judgment' (default 'standard'); only feeds modelFor().
const maxLoops = A.maxFixLoops ?? 2

// Model mapping — defined once. judgment tier gets opus where judgment
// matters (implementer, reviewer); test-author is always sonnet; verifier
// is always haiku (mechanical check only).
const modelFor = (t) => (t.tier === 'judgment' ? 'opus' : 'sonnet')

// CONTRACT: VERDICT schema — verbatim from workflow-api.md §Structured output
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { enum: ['pass', 'findings', 'escalate'] },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { enum: ['blocker', 'major', 'minor'] },
      summary: { type: 'string' },
      evidence: { type: 'string' } }, required: ['severity', 'summary', 'evidence'] } },
    escalation: { type: ['object', 'null'], properties: {
      trigger: { enum: ['fix_exhaustion', 'evidence_deadlock', 'plan_invalidating_discovery', 'scope_breach', 'broken_harness'] },
      detail: { type: 'string' } } }
  },
  required: ['verdict', 'findings']
}

// ---- prompt builders ----
// Every prompt: (1) names files to Read first, (2) states the append-to-
// report obligation with a stamped "## <role> — round <N>" section and
// <=30-line evidence tails, (3) states file-scope bounds.

function testAuthorPrompt(task) {
  return [
    `You are the TEST-AUTHOR for task ${task.id} (pre-implementation, round 1).`,
    `Read FIRST: the brief at ${task.briefPath} (your contract) and the spec at ${A.specPath} (acceptance criteria).`,
    `Write failing-first tests that encode the brief's acceptance criteria, per your role's conventions.`,
    `Append a "## test-author — round 1" section to ${task.reportPath} (create if missing): what you wrote and why, evidence tails <=30 lines.`,
    `File scope: stay inside the brief's declared File scope plus the test files it implies. Do not touch other tasks' files.`
  ].join('\n')
}

function implementerPrompt(task, round, findings) {
  const lines = [
    `You are the IMPLEMENTER for task ${task.id}, round ${round}.`,
    `Read FIRST: the brief at ${task.briefPath} — it is your contract.`,
    `Also read ${task.reportPath} if it exists, for context from prior rounds.`
  ]
  if (round === 1) {
    lines.push(`Execute the brief exactly. Its File scope is a HARD boundary.`)
  } else {
    lines.push(`This is a FIX round (fresh dispatch — get full context from the files above). The reviewer raised these findings last round; address them:`)
    lines.push(JSON.stringify(findings, null, 2))
    lines.push(`Stay inside the brief's File scope while fixing.`)
  }
  lines.push(`Run the brief's Verification commands yourself before declaring done.`)
  lines.push(`Append a "## implementer — round ${round}" section to ${task.reportPath} (create if missing): what you changed and why, verification tails <=30 lines.`)
  return lines.join('\n')
}

function verifierPrompt(task, round) {
  return [
    `You are the VERIFIER for task ${task.id}, round ${round}.`,
    `Read FIRST: the brief at ${task.briefPath} for its Verification commands, and ${task.reportPath} for the implementer's claims.`,
    `Run the brief's verification commands VERBATIM — do not invent new checks.`,
    `Append a "## verifier — round ${round}" section to ${task.reportPath}: command tails <=30 lines, plain pass/fail per command.`,
    `File scope: read-only except for the report append — do not modify source files.`
  ].join('\n')
}

function reviewerPrompt(task, round) {
  return [
    `You are the ADVERSARIAL REVIEWER for task ${task.id}, round ${round}.`,
    `Read FIRST: the brief at ${task.briefPath}, the full report at ${task.reportPath}, the spec at ${A.specPath} (acceptance criteria), and the changed files inside the brief's File scope.`,
    `Refute-then-steelman: try hard to break the implementer's claim first, then judge fairly.`,
    `Finding nothing wrong is a legitimate result — never manufacture findings.`,
    `Append a "## adversarial-reviewer — round ${round}" section to ${task.reportPath}: verdict and evidence tails <=30 lines.`,
    `Return ONLY the structured verdict via the provided schema.`
  ].join('\n')
}

// CONTRACT: escalation object shape (pushed into returned escalations[])
//   { taskId, trigger, detail, reportPath, briefPath, roundsCompleted }
// trigger enum: fix_exhaustion | evidence_deadlock | plan_invalidating_discovery
//             | scope_breach | broken_harness
// This script raises fix_exhaustion / evidence_deadlock / broken_harness
// directly; plan_invalidating_discovery / scope_breach are agent-declared —
// they arrive via the reviewer's verdict.escalation and are passed through.
function esc(task, trigger, detail, roundsCompleted) {
  return { taskId: task.id, trigger, detail, reportPath: task.reportPath, briefPath: task.briefPath, roundsCompleted }
}

function brokenHarness(task, round, role) {
  log(`[${task.id}] round ${round}: ${role} agent returned null — broken_harness`)
  return { taskId: task.id, outcome: 'escalated', escalation: esc(task, 'broken_harness', `agent died: ${role}`, round - 1) }
}

// Per-task pipeline: test-author (optional) -> [implementer -> verifier ->
// reviewer] repeated up to maxLoops+1 rounds, with fix-loop / deadlock /
// exhaustion escalation semantics.
async function runTask(task) {
  if (task.testable && A.agentTypes.testAuthor) {
    const testResult = await agent(testAuthorPrompt(task), {
      phase: 'Execute', label: `test-author:${task.id}`, model: 'sonnet', agentType: A.agentTypes.testAuthor
    })
    if (testResult === null) return brokenHarness(task, 1, 'test-author')
  }

  let previousFindings = null

  for (let round = 1; round <= maxLoops + 1; round++) {
    if (round > 1 && typeof budget !== 'undefined' && budget && budget.total && budget.remaining() < 30000) {
      log(`[${task.id}] budget warning: remaining()=${budget.remaining()} < 30000 before starting fix loop round ${round}`)
    }

    const implResult = await agent(implementerPrompt(task, round, previousFindings), {
      phase: 'Execute', label: `implementer:${task.id}:r${round}`, model: modelFor(task), agentType: A.agentTypes.implementer
    })
    if (implResult === null) return brokenHarness(task, round, 'implementer')

    const verifyResult = await agent(verifierPrompt(task, round), {
      phase: 'Execute', label: `verifier:${task.id}:r${round}`, model: 'haiku', effort: 'low', agentType: A.agentTypes.verifier
    })
    if (verifyResult === null) return brokenHarness(task, round, 'verifier')

    const reviewResult = await agent(reviewerPrompt(task, round), {
      phase: 'Execute', label: `reviewer:${task.id}:r${round}`, model: modelFor(task), agentType: A.agentTypes.reviewer, schema: VERDICT
    })
    if (reviewResult === null) return brokenHarness(task, round, 'reviewer')

    if (reviewResult.verdict === 'pass') {
      log(`[${task.id}] round ${round}: PASS`)
      return { taskId: task.id, outcome: 'completed' }
    }

    if (reviewResult.verdict === 'escalate') {
      const r = reviewResult.escalation || { trigger: 'plan_invalidating_discovery', detail: 'reviewer escalated without a detail field' }
      log(`[${task.id}] round ${round}: reviewer self-escalated -> ${r.trigger}`)
      return { taskId: task.id, outcome: 'escalated', escalation: esc(task, r.trigger, r.detail, round) }
    }

    // verdict === 'findings' from here.
    const findings = reviewResult.findings || []

    // Deadlock guard (v1, pragmatic): identical finding summary to the
    // immediately prior round, still present after a fix attempt, means
    // the loop isn't converging.
    if (previousFindings && findings.some((f) => previousFindings.some((pf) => pf.summary === f.summary))) {
      log(`[${task.id}] round ${round}: evidence_deadlock — repeated finding across rounds`)
      return { taskId: task.id, outcome: 'escalated', escalation: esc(task, 'evidence_deadlock', 'reviewer repeated an identical finding summary from the prior round after a fix attempt', round) }
    }

    if (round === maxLoops + 1) {
      log(`[${task.id}] round ${round}: fix_exhaustion — maxFixLoops (${maxLoops}) exhausted with unresolved findings`)
      return { taskId: task.id, outcome: 'escalated', escalation: esc(task, 'fix_exhaustion', `exhausted ${maxLoops} fix loop(s) with findings still open`, round) }
    }

    log(`[${task.id}] round ${round}: ${findings.length} finding(s) — starting fix loop`)
    previousFindings = findings
  }

  // Unreachable given the bounded for-loop above; kept for return-shape stability.
  return { taskId: task.id, outcome: 'escalated', escalation: esc(task, 'fix_exhaustion', 'fix loop exited unexpectedly', maxLoops + 1) }
}

// Reconciles a pipeline()/serial-loop result array with its source task
// list: pipeline() resolves a throwing stage to null, so we convert any
// such drop into a broken_harness escalation instead of silently losing it.
function attributeDrops(taskList, resultList) {
  return resultList.map((result, i) => {
    if (result) return result
    const task = taskList[i]
    log(`[${task.id}] dropped mid-pipeline (uncaught error) — broken_harness`)
    return { taskId: task.id, outcome: 'escalated', escalation: esc(task, 'broken_harness', 'agent died (uncaught error mid-pipeline)', 0) }
  })
}

// Wave orchestration: parallelSafe tasks run concurrently via pipeline()
// first, then the remaining (non-parallel-safe) tasks run sequentially with
// the SAME per-task function. Splitting is logged per the brief.
const tasks = A.tasks || []
const parallelTasks = tasks.filter((t) => t.parallelSafe)
const serialTasks = tasks.filter((t) => !t.parallelSafe)

log(`wave start: ${tasks.length} task(s) — ${parallelTasks.length} parallel-safe, ${serialTasks.length} serial`)

// pipeline() has NO barrier between items — items run concurrently up to the runtime's
// agent cap, so parallel-safe tasks genuinely fan out here (it is not a serial map).
const parallelRaw = parallelTasks.length ? await pipeline(parallelTasks, (prev, task) => runTask(task)) : []
const parallelResults = attributeDrops(parallelTasks, parallelRaw)

const serialResults = []
for (const task of serialTasks) {
  try {
    serialResults.push(await runTask(task))
  } catch (err) {
    log(`[${task.id}] runTask threw (${err && err.message}) — broken_harness`)
    serialResults.push({ taskId: task.id, outcome: 'escalated', escalation: esc(task, 'broken_harness', `agent died: ${err && err.message}`, 0) })
  }
}

// CONTRACT: return shape
//   { completed: [taskIds...], escalations: [{taskId, trigger, detail,
//     reportPath, briefPath, roundsCompleted}], blocked: [] }
// `blocked` is always [] here — the CALLER fills it from the dependency
// graph; this template only ever sees one dependency-free wave, but the
// field is still returned for shape stability across callers.
const completed = []
const escalations = []

for (const result of [...parallelResults, ...serialResults]) {
  if (result.outcome === 'completed') {
    completed.push(result.taskId)
    log(`[${result.taskId}] completed`)
  } else {
    escalations.push(result.escalation)
    log(`[${result.escalation.taskId}] escalated -> ${result.escalation.trigger}`)
  }
}

log(`wave end: ${completed.length} completed, ${escalations.length} escalated (of ${tasks.length} total)`)

return { completed, escalations, blocked: [] }
