/**
 * Routes each message in cases.json with the judge's real prefilter, prompt and parser, and writes the
 * scores. `claude plugin eval` can't reach the judge: in its headless sessions /sidekick isn't available.
 *
 *   bun plugins/sidekick/evals/judge-routing/run.ts [--runs 3] [--model haiku] [--max-usd 1] [--out docs/evals/sidekick]
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgePrompt, judgeSystem, parseJudgment, precheck } from '../../hooks/lib/judge'

type Route = 'chore' | 'look' | 'main'
type Case = { text: string; expect: Route }
type Run = { route: Route; verdict: string; reason: string; usd: number }

const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback)
}
const runs = Number(option('runs', '3'))
const model = option('model', 'haiku')
const maxUsd = Number(option('max-usd', '1'))
const out = option('out', '')
const cases: Case[] = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8'))
const CONCURRENCY = 4
// An empty folder, with no settings or tools, so only the judge's own prompt reaches the model.
const cwd = mkdtempSync(join(tmpdir(), 'judge-eval-'))

const routeOf = (verdict: string): Route => (verdict === 'mechanical' ? 'chore' : verdict === 'investigate' ? 'look' : 'main')

async function judgeOnce(text: string): Promise<Run> {
  const pre = precheck(text, false)
  if (!pre.isJudged) return { route: 'main', verdict: 'precheck', reason: pre.why, usd: 0 }
  const child = Bun.spawn(
    ['claude', '-p', '--model', model, '--system-prompt', judgeSystem([]), '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', judgePrompt(text, 'cwd: /repo')],
    { cwd, env: { ...process.env, DMOKONG_MODS: '0', SIDEKICK_WORKER: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }, stdout: 'pipe', stderr: 'ignore' },
  )
  const reply = JSON.parse(await new Response(child.stdout).text()) as { result?: string; total_cost_usd?: number }
  const judged = parseJudgment(reply.result ?? '', text)
  return { route: routeOf(judged.verdict), verdict: judged.verdict, reason: judged.reason, usd: reply.total_cost_usd ?? 0 }
}

const results = new Map<string, Run[]>(cases.map(c => [c.text, []]))
const queue = cases.flatMap(c => Array.from({ length: runs }, () => c))
let spent = 0
let isCut = false
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
    if (spent >= maxUsd) { isCut = true; return }
    const run = await judgeOnce(c.text).catch((): Run => ({ route: 'main', verdict: 'error', reason: 'the call failed', usd: 0 }))
    spent += run.usd
    results.get(c.text)?.push(run)
  }
}))

const rows = cases.map(c => {
  const got = results.get(c.text) ?? []
  return { ...c, runs: got, passed: got.filter(r => r.route === c.expect).length }
})
const total = rows.reduce((n, r) => n + r.runs.length, 0)
const passed = rows.reduce((n, r) => n + r.passed, 0)
// The costly mistake: the worker takes something that should have stayed with Claude.
const wrongly = rows.filter(r => r.expect === 'main').reduce((n, r) => n + r.runs.filter(x => x.route !== 'main').length, 0)
const misses = rows.filter(r => r.passed < r.runs.length)
const when = new Date().toISOString()
const summary = `${passed}/${total} runs routed as expected, ${rows.length - misses.length}/${rows.length} messages every time, ${wrongly} wrongly sent to the worker. $${spent.toFixed(3)}, ${model}.${isCut ? ' Stopped early at the cost cap.' : ''}`
console.log(summary)
for (const r of misses) console.log(`✗ ${r.text} (want ${r.expect}): ${r.runs.map(x => `${x.route} [${x.verdict}: ${x.reason}]`).join(' · ')}`)

if (out !== '') {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'judge-routing.json'), `${JSON.stringify({ when, model, runs, spentUsd: spent, isCut, passed, total, wrongly, rows }, null, 2)}\n`)
  const table = rows.map(r => `| ${r.passed === r.runs.length ? '✓' : '✗'} | ${r.text.replace(/\|/g, '\\|')} | ${r.expect} | ${r.passed}/${r.runs.length} | ${[...new Set(r.runs.map(x => x.route))].join(', ')} |`).join('\n')
  writeFileSync(join(out, 'judge-routing.md'), `# Sidekick judge routing\n\n${summary}\n\nRun ${when} by \`plugins/sidekick/evals/judge-routing/run.ts\`, with the judge's real prefilter, prompt and parser. It calls the model through \`claude -p\` rather than the mod's own call, starts with no taught corrections, and doesn't run the worker.\n\n| | Message | Should go to | Right | Went to |\n|---|---|---|---|---|\n${table}\n`)
}
process.exit(isCut || passed < total ? 1 : 0)
