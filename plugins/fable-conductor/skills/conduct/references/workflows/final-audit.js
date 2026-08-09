// final-audit.js — finalize-phase audit workflow template (task 10-wf-audit)
//
// Phase 5 (Finalize) sanity check ahead of Fable's own whole-branch final
// review (that logic lives in task 11's SKILL.md — never duplicated here).
//   1. Cold read    — ONE blinded spec-auditor pass over the whole diff,
//      judging ACs against the code as it exists. No task reports, no
//      briefs, no plan reach it — the blindness rule (verbatim from
//      agents/spec-auditor.md) is the entire point of this dispatch.
//   2. Refute panel — per AC, a panel of haiku "skeptics" independently
//      try to REFUTE the auditor's verdict against the live repo. A
//      refuted majority flips that AC into a finding for Fable to weigh.
//
// CONTRACT: the return value is triage for Fable's final review, NOT a
// substitute verdict — see the comment above the final `return` below.
export const meta = {
  name: 'final-audit',
  description: 'Blinded spec-auditor cold-read of a diff plus a per-AC haiku refute panel; majority-refuted ACs become findings for Fable\'s final review.',
  whenToUse: 'Once per stream, entering Phase 5 (Finalize), after all plan tasks are done and before Fable\'s own whole-branch final review.',
  phases: [{ title: 'Cold read' }, { title: 'Refute panel' }]
}

// args may arrive as a JSON-encoded string depending on caller encoding — normalize before use.
const A = typeof args === 'string' ? JSON.parse(args) : args

// CONTRACT: args (verbatim from the brief) — { streamDir (reserved; unused in v1), repoRoot,
// specPath, diffRef (e.g. 'main...HEAD', what the auditor cold-reads),
// acs: [{id, text}] (numbered ACs extracted by the caller), auditReportPath
// (append-only evidence file), agentTypes: {specAuditor}, panelSize
// (haiku voters per AC, default 3 when absent) }.
const panelSize = A.panelSize ?? 3
const majorityThreshold = Math.ceil(panelSize / 2)

// Lens-diverse panel (v1.1.3): identical prompts sampled N times measure
// sampling variance, not independent judgment — and better-calibrated models
// make identical votes MORE correlated, so a same-prompt panel degrades as
// models improve. Each voter judges through a distinct lens; the lens is
// attached to the vote script-side (VOTER_SCHEMA stays {refuted, reason}).
// Ordering rationale: at panelSize 5 the i % 3 assignment (2/2/1) deliberately
// favours the two evidence-grounded lenses — independent samples genuinely
// differ there, while counterexample construction is the most deterministic.
const LENSES = [
  'Re-derive the cited evidence from the files yourself — does it actually hold?',
  'Trace the code path — does the code actually behave as the verdict claims?',
  'Construct a concrete counterexample input that would falsify the verdict.'
]

// CONTRACT: auditor structured-output schema (brief step 2, verbatim).
const AUDITOR_SCHEMA = {
  type: 'object',
  properties: {
    acVerdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { enum: ['satisfied', 'violated', 'unverifiable'] },
          evidence: { type: 'string' }
        },
        required: ['id', 'verdict', 'evidence']
      }
    },
    surplus: { type: 'array', items: { type: 'string' } },
    deficit: { type: 'array', items: { type: 'string' } }
  },
  required: ['acVerdicts', 'surplus', 'deficit']
}

// CONTRACT: refute-voter structured-output schema (brief step 3, verbatim).
const VOTER_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason']
}

// ---- Phase 1: Cold read -------------------------------------------------
// Deliberately deviates from the general "name briefPath/reportPath" prompt
// discipline in workflow-api.md: the spec-auditor's whole value is having
// NO account of what anyone intended or did. The prompt below names only
// specPath, diffRef, repoRoot, and the append target — nothing else.
phase('Cold read')
log(`Cold read: dispatching ONE blinded spec-auditor over ${A.diffRef} against ${A.specPath}`)

const auditorPrompt = [
  `You are the spec-auditor for a fable-conductor Phase 5 finalize step, a blinded cold-read.`,
  `Read FIRST: the spec at ${A.specPath}.`,
  `Then run \`git -C ${A.repoRoot} diff ${A.diffRef}\` and read any files it touches as needed to verify behavior.`,
  `BLINDNESS RULE (verbatim): you must NOT read task reports, briefs, or the plan — no account of what anyone intended or claims to have done. Your only inputs are the spec text, the diff, and whatever the codebase itself shows you.`,
  `Assign a per-AC verdict — satisfied | violated | unverifiable — each with evidence (file:line or command output). Also flag scope surplus (diff behavior with no corresponding AC) and scope deficit (ACs with no implementation trace).`,
  `Append a "## spec-auditor — round 1" section to ${A.auditReportPath} (create the file if missing): the per-AC table and surplus/deficit flags, with evidence tails of at most 30 lines each, placed adjacent to the claims they support.`,
  `Finding nothing wrong is a legitimate result — never manufacture a violated verdict or a surplus/deficit flag to look thorough.`
].join('\n')

const auditorResult = await agent(auditorPrompt, {
  label: 'spec-auditor:cold-read',
  phase: 'Cold read',
  model: 'opus', // audit is judgment-tier work: fable -> opus -> sonnet -> haiku
  agentType: A.agentTypes.specAuditor,
  schema: AUDITOR_SCHEMA
})
if (!auditorResult) log('Cold read: spec-auditor dispatch returned null — no acVerdicts to refute, returning empty triage')

const acVerdicts = (auditorResult && auditorResult.acVerdicts) || []
const surplus = (auditorResult && auditorResult.surplus) || []
const deficit = (auditorResult && auditorResult.deficit) || []
const verdictById = new Map(acVerdicts.map((v) => [v.id, v]))

log(`Cold read done: ${acVerdicts.length} AC verdict(s), ${surplus.length} surplus flag(s), ${deficit.length} deficit flag(s)`)

// ---- Phase 2: Refute panel -----------------------------------------------
phase('Refute panel')

const acs = A.acs || []
const panelResults = acs.length
  ? await pipeline(acs, async (prev, ac) => {
      const verdict = verdictById.get(ac.id) || { verdict: 'unverifiable', evidence: 'the spec-auditor returned no verdict for this AC' }

      const voterOutcomes = await parallel(
        Array.from({ length: panelSize }, (_, i) => async () => {
          const lens = LENSES[i % LENSES.length]
          const voterPrompt = `AC ${ac.id}: ${ac.text}. The auditor judged it ${verdict.verdict} because ${verdict.evidence}. Try to REFUTE that judgment using the repo at ${A.repoRoot} (read files, run read-only commands). Your lens: ${lens} Return {refuted: boolean, reason}. Default to refuted=false only when the evidence actually holds.`
          // No agentType — plain subagent per the brief; prompt is self-contained.
          const vote = await agent(voterPrompt, { label: `refute-voter:${ac.id}:${i}`, phase: 'Refute panel', model: 'haiku', effort: 'low', schema: VOTER_SCHEMA })
          return vote && { ...vote, lens }
        })
      )

      const liveVotes = voterOutcomes.filter(Boolean)
      const deadVotes = voterOutcomes.length - liveVotes.length
      if (deadVotes > 0) log(`[AC ${ac.id}] ${deadVotes} dead voter(s) of ${panelSize} (agent died or was skipped)`)

      return { ac, verdict, liveVotes }
    })
  : []

// pipeline() drops a throwing item's stage to null — attribute that rather
// than silently losing the AC (mirrors execute-wave.js's drop handling).
const findings = []

panelResults.forEach((result, i) => {
  const ac = acs[i]
  if (!result) {
    log(`[AC ${ac.id}] dropped mid-pipeline (uncaught error) — treating as unverifiable`)
    findings.push({ acId: ac.id, refutedBy: '0 live votes', reasons: ['refute panel dropped mid-pipeline (uncaught error)'] })
    return
  }

  const { verdict, liveVotes } = result

  // Fewer than 2 live votes: don't trust a lone (or zero) voter's call —
  // mark the AC unverifiable rather than tallying a false majority.
  if (liveVotes.length < 2) {
    findings.push({
      acId: ac.id,
      refutedBy: `${liveVotes.length}/${panelSize} live`,
      reasons: [`insufficient live votes (${liveVotes.length} of ${panelSize}) to trust a refute-panel majority; auditor verdict was ${verdict.verdict}`],
      votes: liveVotes.map((v) => ({ lens: v.lens, refuted: v.refuted, reason: v.reason }))
    })
    return
  }

  const refuters = liveVotes.filter((v) => v.refuted)
  if (refuters.length >= majorityThreshold) {
    // De-aggregated readout: heterogeneous lenses make votes non-interchangeable,
    // so the finding carries every live vote with its lens — the conductor reads
    // the distribution (unanimity across lenses >> clustering within one), not
    // just the tally.
    log(`[AC ${ac.id}] refuted ${refuters.length}/${liveVotes.length} — by lens: ${refuters.map((v) => `"${v.lens.split(' — ')[0]}"`).join(', ')}`)
    findings.push({
      acId: ac.id,
      refutedBy: `${refuters.length}/${panelSize}`,
      reasons: refuters.map((v) => v.reason),
      votes: liveVotes.map((v) => ({ lens: v.lens, refuted: v.refuted, reason: v.reason }))
    })
  }
})

log(`Refute panel done: ${panelResults.length} AC(s) tallied, ${findings.length} finding(s) (refuted-majority or unverifiable)`)

// CONTRACT: return shape (brief step 5) — this is triage for Fable's final
// review, not a truth verdict. A "finding" here means "worth Fable's own
// eyes," never an automatic fail; Fable weighs it against the live repo,
// including the audit's own report at auditReportPath.
return { acVerdicts, findings, surplus, deficit, auditReportPath: A.auditReportPath }
