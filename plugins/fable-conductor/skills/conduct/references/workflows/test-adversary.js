// test-adversary.js — test-sensitivity workflow template.
//
// N parallel test-breakers each craft deliberately-wrong implementations
// that try to slip past the authored suite. Survivors (wrong code the
// suite failed to catch) are collated behind a barrier, then drive one
// hardening round by the test-author. A single re-check re-runs only the
// previously-surviving variants against the hardened suite. Any variant
// still passing after hardening is "residue" — this template does NOT
// construct escalation objects for residue; per contract, the CALLER
// (conductor session) decides how to escalate non-empty residue.
export const meta = {
  name: 'test-adversary',
  description: 'Attacks an authored test suite with parallel wrong-implementation breakers, then hardens against survivors.',
  whenToUse: 'After a test suite is authored for a spec, to measure and improve its sensitivity to bugs.',
  phases: [{ title: 'Break' }, { title: 'Harden' }]
}

// args may arrive as a JSON-encoded string depending on caller encoding — normalize before use.
const A = typeof args === 'string' ? JSON.parse(args) : args

// Working-directory contract — workers inherit the conductor session's cwd,
// which is often a different repo; every prompt names the target checkout.
// (Same fix family as execute-wave.js; field defect 2026-07-16.)
if (!A.repoRoot) throw new Error('args.repoRoot is required: every worker prompt carries the working-directory contract')
const CWD_CONTRACT = `WORKING-DIRECTORY CONTRACT: the target repo checkout is ${A.repoRoot} — cd there first and run ${'`git rev-parse --show-toplevel`'} to confirm it resolves to the same directory as ${A.repoRoot} (compare after resolving symlinks and ignoring trailing slashes)${A.expectedBranch ? `, and \`git rev-parse --abbrev-ref HEAD\` prints ${A.expectedBranch}` : ''}, before any write. You inherit the dispatching session's cwd — never trust it. Run the suite command FROM ${A.repoRoot}. Writes are allowed in exactly two places OUTSIDE ${A.repoRoot}: your assigned scratch area${A.scratchDir ? ` (${A.scratchDir})` : ''} and the report file at its absolute path — nothing else. On mismatch: stop, write nothing, record a broken_harness note in your report section.`

// Breaker structured-output schema — required by the brief (per-breaker call).
const BREAKER_SCHEMA = {
  type: 'object',
  properties: {
    survivors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          variant: { type: 'string' },
          violatedAC: { type: 'string' },
          howItPasses: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['variant', 'violatedAC', 'howItPasses', 'evidence']
      }
    },
    caught: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          variant: { type: 'string' },
          violatedAC: { type: 'string' }
        },
        required: ['variant', 'violatedAC']
      }
    }
  },
  required: ['survivors', 'caught']
}

const breakers = A.breakers || 3

phase('Break')
log(`Break phase: fanning out ${breakers} test-breaker(s) against ${A.specPath}`)

const breakResults = await parallel(
  Array.from({ length: breakers }, (_, i) => async () => {
    const prompt = `${CWD_CONTRACT}
Read FIRST: ${A.briefPath}, then ${A.reportPath} if it exists, then ${A.specPath} and the test suite it targets.
You are test-breaker #${i} of ${breakers}. Diversity heuristic: focus on acceptance criteria where
(acceptance-criterion index) % ${breakers} === ${i} — this spreads coverage across breakers instead of
duplicating effort on the same ACs. Craft deliberately-wrong implementations that violate your targeted
ACs while still trying to pass the test suite. Build each variant under ${A.scratchDir}/breaker-${i}/.
Run this command against each variant: ${A.suiteCommand}
Report which variants survive (pass despite being wrong) and which are caught (fail as expected).
File scope: only write inside ${A.scratchDir}/breaker-${i}/. Clean up your scratch variants after
running and recording results — do not leave built artifacts behind.
Append a section titled "## test-breaker — round 1" to ${A.reportPath} (create if missing) describing
what you built, per-variant results, and command-output evidence tails of at most 30 lines each.`
    return agent(prompt, {
      label: `test-breaker-${i}`,
      phase: 'Break',
      model: 'sonnet',
      agentType: A.agentTypes.testBreaker,
      schema: BREAKER_SCHEMA
    })
  })
)

// Barrier is correct here: hardening needs the FULL survivor set collated
// before the test-author can address every violated AC in one pass.
const survivorLists = breakResults.filter(Boolean).map((r) => r.survivors || [])
const allSurvivors = survivorLists.flat()

const seen = new Set()
const survivors = []
for (const s of allSurvivors) {
  const key = `${s.violatedAC}::${s.howItPasses}`
  if (!seen.has(key)) {
    seen.add(key)
    survivors.push(s)
  }
}

log(`Break phase complete: ${breakers} breaker(s) dispatched, ${survivors.length} deduped survivor(s) of ${allSurvivors.length} raw`)

if (survivors.length === 0) {
  log('Zero survivors — suite demonstrated sensitive, skipping Harden phase')
  return { gaps: [], hardened: false, residue: [] }
}

phase('Harden')

const hardenPrompt = `${CWD_CONTRACT}
Read FIRST: ${A.briefPath}, then ${A.reportPath}, then ${A.specPath} and the current test suite.
The following wrong-implementation variants survived the suite unexpectedly (JSON below). Harden the
suite so each survivor is addressed BY NAME: add or strengthen assertions so the suite would now catch
that specific variant's wrongness. Show failing-first evidence per survivor before your fix, matching
your role's contract. Survivors JSON:
${JSON.stringify(survivors)}
File scope: the test suite files only, per your role's contract.
Append a section titled "## test-author — round 2" to ${A.reportPath} listing each survivor addressed
and evidence tails of at most 30 lines.`

const hardenResult = await agent(hardenPrompt, {
  label: 'test-author-harden',
  phase: 'Harden',
  model: 'sonnet',
  agentType: A.agentTypes.testAuthor
})

if (!hardenResult) {
  log('Harden dispatch returned null — treating full survivor set as residue')
  return { gaps: survivors, hardened: false, residue: survivors }
}

const recheckPrompt = `${CWD_CONTRACT}
Read FIRST: ${A.briefPath}, then ${A.reportPath} (see the "## test-author — round 2" section
just appended) and the now-hardened test suite. Rebuild ONLY the previously-surviving variants listed
below under ${A.scratchDir}/recheck/, run the hardened suite (${A.suiteCommand}) against each, and
report which still pass (residue) vs are now caught. Previously-surviving variants JSON:
${JSON.stringify(survivors)}
File scope: only write inside ${A.scratchDir}/recheck/. Clean up scratch variants after recording
results. Append a section titled "## test-breaker — round 3" to ${A.reportPath} (this is the
re-verification pass, after the round-1 break and round-2 harden sections) with per-variant results
and evidence tails of at most 30 lines each.`

const recheckResult = await agent(recheckPrompt, {
  label: 'test-breaker-recheck',
  phase: 'Harden',
  model: 'sonnet',
  agentType: A.agentTypes.testBreaker,
  schema: BREAKER_SCHEMA
})

const residue = recheckResult ? (recheckResult.survivors || []) : survivors
if (!recheckResult) {
  log('Re-verification dispatch returned null — treating full survivor set as residue')
}

log(`Harden phase complete: ${survivors.length} survivor(s) addressed, ${residue.length} residue after re-check`)

return { gaps: survivors, hardened: true, residue }
