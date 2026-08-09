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
//     repoRoot,       // REQUIRED: absolute path to the target repo CHECKOUT (the
//                     // worktree when the stream uses one). Injected into every
//                     // worker prompt as the working-directory contract — workers
//                     // inherit the conductor session's cwd, which is often a
//                     // DIFFERENT repo (field defect 2026-07-16: wave-1 work
//                     // committed to the target's main checkout, not its worktree).
//     expectedBranch, // optional: branch name workers must verify before writing
//                     // (pass it whenever the stream works on a branch/worktree)
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

// Working-directory contract (v1.1.3): the full rule text lives in each
// agent's role definition — slim dispatch prompts carry only the values plus
// a one-line imperative (CWD_LINE). Exception: test-author keeps the long
// form (claw-6smt micro-test: 5-dispatch parity runs per seat shipped slim
// prompts for implementer/verifier/reviewer at 5/5 on stamp/commands/
// exit-codes/append-only; the test-author seat missed the report-write
// criterion under BOTH arms in the test rig, so per the any-miss rule that
// seat keeps its long-form builder verbatim).
if (!A.repoRoot) throw new Error('args.repoRoot is required: every worker prompt carries the working-directory contract')
const CWD_LINE = `Working directory: ${A.repoRoot}${A.expectedBranch ? ` (expected branch: ${A.expectedBranch})` : ''} — cd there and verify per your working-directory contract before any write.`
const CWD_CONTRACT = [
  `WORKING-DIRECTORY CONTRACT: all repo work happens in ${A.repoRoot} — cd there before anything else.`,
  `You inherit the dispatching session's cwd, which may be a different repo or the wrong checkout of this one; never trust it.`,
  `After cd, and before ANY file write or git commit, verify: \`git rev-parse --show-toplevel\` resolves to the same directory as ${A.repoRoot} (compare after resolving symlinks and ignoring trailing slashes — a cosmetic path difference is NOT a mismatch)` +
    (A.expectedBranch ? ` AND \`git rev-parse --abbrev-ref HEAD\` prints ${A.expectedBranch}` : '') + `.`,
  `On any mismatch: STOP, write nothing, and record a broken_harness escalation in your report section.`,
  `Only the report file (at its absolute path) may be written outside ${A.repoRoot}.`
].join(' ')

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
// Slim builders (v1.1.3): each worker is dispatched with agentType, so the
// agent file's full role rules (read order, report stamp, append-only,
// <=30-line tails, scope bounds, escalation enum) are ALWAYS in its context.
// The dispatch prompt carries per-dispatch data only: role+task+round, the
// working-directory values, file paths, and (fix rounds) the findings JSON.
// Restating role rules here was a paid second copy and a live drift surface.
// test-author is the exception — long form kept per the micro-test record.

function testAuthorPrompt(task) {
  return [
    `You are the TEST-AUTHOR for task ${task.id} (pre-implementation, round 1).`,
    CWD_CONTRACT,
    `Read FIRST: the brief at ${task.briefPath} (your contract) and the spec at ${A.specPath} (acceptance criteria).`,
    `Write failing-first tests that encode the brief's acceptance criteria, per your role's conventions.`,
    `Append a "## test-author — round 1" section to ${task.reportPath} (create if missing): what you wrote and why, evidence tails <=30 lines.`,
    `File scope: stay inside the brief's declared File scope plus the test files it implies. Do not touch other tasks' files.`
  ].join('\n')
}

function implementerPrompt(task, round, findings) {
  const lines = [
    `IMPLEMENTER dispatch — task ${task.id}, round ${round}.`,
    CWD_LINE,
    `Brief: ${task.briefPath}. Report: ${task.reportPath}.`
  ]
  if (round > 1) {
    lines.push(`FIX round. Reviewer findings to address or dispute:`)
    lines.push(JSON.stringify(findings, null, 2))
  }
  return lines.join('\n')
}

function verifierPrompt(task, round) {
  return [
    `VERIFIER dispatch — task ${task.id}, round ${round}.`,
    CWD_LINE,
    `Brief: ${task.briefPath}. Report: ${task.reportPath}.`
  ].join('\n')
}

function reviewerPrompt(task, round) {
  return [
    `ADVERSARIAL-REVIEWER dispatch — task ${task.id}, round ${round}.`,
    CWD_LINE,
    `Brief: ${task.briefPath}. Report: ${task.reportPath}. Spec: ${A.specPath}.`,
    `Changed files: inside the brief's File scope at ${A.repoRoot}.`
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
