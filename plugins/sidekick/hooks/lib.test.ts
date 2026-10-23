import { test, expect } from 'claude-code/testing'

import { JUDGE_SYSTEM, canStart, holdsMain, judgeSystem, lockKeys, parseJudgment, precheck, resourcesOf } from './lib/judge'
import { migrate, toTaught } from './lib/state'
import { EMPTY } from './register'
import { INVESTIGATE_SYSTEM, WORKER_SYSTEM, chatLine, cleanupArgv, giveToMainPrompt, handoffNote, instructionsPrompt, parseOutcome, parseStreamEvents, parseStreamLine, splitLines, workerArgv } from './lib/worker'
import { COLORS, barCells, bigText, bigWidth, dayLevels, spaced, tileMoney } from './lib/draw'
import { DUMP_KEEP, dumpDir, dumpName, dumpText, redact } from './lib/dump'

test('precheck lets short imperative chores through to the judge', async () => {
  expect(precheck('commit and push', false)).toEqual({ isJudged: true })
  expect(precheck("what's the git status?", false)).toEqual({ isJudged: true })
})

test('precheck sends reasoning, long, pasted and conversational prompts straight to main', async () => {
  expect(precheck('why does the stage-2 doc mention codex twice?', false).isJudged).toBe(false)
  expect(precheck('how does the judge decide?', false).isJudged).toBe(false)
  expect(precheck('x'.repeat(201), false).isJudged).toBe(false)
  expect(precheck('line one\nline two', false).isJudged).toBe(false)
  expect(precheck('commit this', true).isJudged).toBe(false)
  expect(precheck('commit what we just discussed', false).isJudged).toBe(false)
  expect(precheck('   ', false).isJudged).toBe(false)
})

test('precheck lets operational why-questions through to the judge, but not code ones', async () => {
  expect(precheck('why did nightly-report fail?', false).isJudged).toBe(true)
  expect(precheck('why is acme-bot not replying', false).isJudged).toBe(true)
  expect(precheck('how come acme-bot stopped', false).isJudged).toBe(true)
  expect(precheck('why does parseOutcome return partial?', false).isJudged).toBe(false)
  expect(precheck('why did the rebase fail?', false).isJudged).toBe(false)
  expect(precheck('why did the tests fail?', false).isJudged).toBe(false)
})

test('investigate is a fourth verdict, holding the ops lock', async () => {
  expect(parseJudgment('investigate', 'acme-bot stopped replying, look into it ')).toEqual({
    verdict: 'investigate',
    task: 'acme-bot stopped replying, look into it',
    resources: ['ops'],
    reason: 'investigation',
  })
  expect(lockKeys(['ops'], '/r/a')).toEqual(['ops'])
  expect(canStart(['git:/r/a'], [['ops']], 2)).toBe(true)
  expect(canStart(['ops'], [['ops']], 2)).toBe(false)
})

test('only assists that touch git or bd hold the main session', async () => {
  expect(holdsMain(['git:/r/a'])).toBe(true)
  expect(holdsMain(['bd'])).toBe(true)
  expect(holdsMain(['*'])).toBe(true)
  expect(holdsMain(['ops'])).toBe(false)
  expect(holdsMain([])).toBe(false)
})

test('the judge rule names investigations and restarts, and four reply words', async () => {
  expect(JUDGE_SYSTEM).toContain('"investigate"')
  expect(JUDGE_SYSTEM).toMatch(/restart/i)
  expect(JUDGE_SYSTEM).toContain('mechanical, investigate, needs-main or unclear')
})

test('precedents are split by the verdict they teach, capped in total', async () => {
  const system = judgeSystem([
    { text: 'tidy branches', verdict: 'mechanical' },
    { text: 'check acme-bot logs', verdict: 'investigate' },
  ])
  const chores = system.indexOf('mechanical chore:')
  const looks = system.indexOf('investigation:')
  expect(chores).toBeGreaterThan(0)
  expect(looks).toBeGreaterThan(0)
  expect(system.indexOf('- tidy branches')).toBeGreaterThan(chores)
  expect(system.slice(looks)).toContain('- check acme-bot logs')
  expect(system.slice(looks)).not.toContain('- tidy branches')
})

test('a judgment is one word, read strictly; anything else routes to main', async () => {
  expect(parseJudgment('mechanical', 'commit and push')).toEqual({ verdict: 'mechanical', task: 'commit and push', resources: ['git'], reason: 'mechanical chore' })
  expect(parseJudgment(' Mechanical.\n', 'close app-1 in bd')).toEqual({ verdict: 'mechanical', task: 'close app-1 in bd', resources: ['bd'], reason: 'mechanical chore' })
  expect(parseJudgment('needs-main', 'x').verdict).toBe('needs-main')
  expect(parseJudgment('sure, that is mechanical', 'x').verdict).toBe('unclear')
  expect(parseJudgment('', 'x').verdict).toBe('unclear')
})

test('resources come from the words: git by default, bd for tracker chores, both when both', async () => {
  expect(resourcesOf('commit and push')).toEqual(['git'])
  expect(resourcesOf('close the bd issue')).toEqual(['bd'])
  expect(resourcesOf('commit and comment on the issue')).toEqual(['git', 'bd'])
  expect(resourcesOf('tidy up')).toEqual(['git'])
})

test('locks are per repository for git, one for bd, global for anything unnamed', async () => {
  expect(lockKeys(['git'], '/r/a')).toEqual(['git:/r/a'])
  expect(lockKeys(['git', 'bd'], '/r/a')).toEqual(['git:/r/a', 'bd'])
  expect(lockKeys([], '/r/a')).toEqual(['*'])
  expect(lockKeys(['network'], '/r/a')).toEqual(['*'])
})

test('one at a time by default; in parallel only on different resources', async () => {
  expect(canStart(['git:/a'], [], 1)).toBe(true)
  expect(canStart(['bd'], [['git:/a']], 1)).toBe(false)
  expect(canStart(['bd'], [['git:/a']], 2)).toBe(true)
  expect(canStart(['git:/a'], [['git:/a']], 2)).toBe(false)
  expect(canStart(['git:/b'], [['git:/a']], 2)).toBe(true)
  expect(canStart(['*'], [['git:/a']], 3)).toBe(false)
  expect(canStart(['bd'], [['*']], 3)).toBe(false)
})

test('the worker runs lean, locked down and guarded', async () => {
  const argv = workerArgv('haiku', '/p/bin/sidekick-guard')
  expect(argv.slice(0, 4)).toEqual(['claude', '-p', '--model', 'haiku'])
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--exclude-dynamic-system-prompt-sections']) expect(argv).toContain(flag)
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
  expect(argv).toContain('Bash(git reset --hard:*)')
  // Read-only helpers, so `cd repo && git ...` or `git log | head` is not refused whole.
  for (const helper of ['Bash(cd:*)', 'Bash(head:*)', 'Bash(wc:*)']) expect(argv).toContain(helper)
  expect(argv[argv.indexOf('--settings') + 1]).toContain('/p/bin/sidekick-guard')
  // The guard sees reads too, so a credentials file never enters the worker's context.
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')
  expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash|Read|Grep')
  expect(settings.autoMemoryEnabled).toBe(false)
  for (const rule of ['Read(**/.env)', 'Read(**/.mcp.json)']) expect(argv).toContain(rule)
  expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(WORKER_SYSTEM)
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('/p/bin/sidekick-guard chore')
})

test('the investigation worker may run any command, but stays guarded and read-only', async () => {
  const files = [{ path: '/repo/CLAUDE.md', kind: 'project', content: 'acme-bot logs to logs/acme.log.' }]
  const argv = workerArgv('haiku', '/p/bin/sidekick-guard', files, 'investigate')
  const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'))
  expect(allowed).toContain('Bash')
  expect(allowed).not.toContain('Bash(git:*)')
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1)
  for (const rule of ['Edit', 'Write', 'NotebookEdit', 'Read(**/.env)', 'Read(**/.mcp.json)', 'Bash(git reset --hard:*)']) expect(denied).toContain(rule)
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('/p/bin/sidekick-guard investigate')
  const system = argv[argv.indexOf('--append-system-prompt') + 1] ?? ''
  expect(system.startsWith(INVESTIGATE_SYSTEM)).toBe(true)
  expect(system.endsWith('acme-bot logs to logs/acme.log.')).toBe(true)
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
})

test('the investigation prompt carries the restart, evidence and no-side-effect rules, and the same report', async () => {
  for (const words of ['If the task asks for a restart, do it', 'verify', 'job manager', 'Never unload', 'Post or send anything', 'credential files', 'git reads only', 'An absence only counts']) {
    expect(INVESTIGATE_SYSTEM).toContain(words)
  }
  const report = (prompt: string) => prompt.slice(prompt.indexOf('Finish with ONLY a JSON object'))
  expect(report(INVESTIGATE_SYSTEM)).toBe(report(WORKER_SYSTEM))
})

test("the worker gets the main session's instruction files in its system prompt, within a size limit", async () => {
  const files = [
    { path: '/repo/CLAUDE.md', kind: 'project', content: 'Logs live in logs/.' },
    { path: '/repo/.claude/rules/empty.md', kind: 'project', content: '   ' },
    { path: '/home/CLAUDE.md', kind: 'user', content: 'x'.repeat(90_000) },
    { path: '/repo/late.md', kind: 'local', content: 'never fits' },
  ]
  const system = workerArgv('haiku', '/g', files)[workerArgv('haiku', '/g', files).indexOf('--append-system-prompt') + 1] ?? ''
  expect(system.startsWith(WORKER_SYSTEM)).toBe(true)
  expect(system).toContain('## /repo/CLAUDE.md (project)\n\nLogs live in logs/.')
  expect(system).not.toContain('empty.md')
  expect(system).toContain('[cut: over the size limit]')
  expect(system).toContain('## /repo/late.md (local)\n\n[left out: over the size limit]')
  expect(system.length).toBeLessThan(WORKER_SYSTEM.length + 82_000)
  expect(instructionsPrompt([])).toBe('')
})

test('streamed output splits on lines across chunks', async () => {
  const first = splitLines('', '{"a":1}\n{"b"')
  expect(first).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
  expect(splitLines(first.rest, ':2}\n')).toEqual({ lines: ['{"b":2}'], rest: '' })
})

test('stream lines become steps and a result', async () => {
  const step = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'git push' } }] } }))
  expect(step).toEqual({ kind: 'step', text: '$ git push', id: '', full: '$ git push' })
  const refused = parseStreamLine(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission to use Bash has been denied.' }] } }),
  )
  expect(refused).toEqual({ kind: 'refused', id: 't1' })
  const result = parseStreamLine(JSON.stringify({ type: 'result', result: '{"status":"done"}', is_error: false, total_cost_usd: 0.01 }))
  expect(result).toEqual({ kind: 'result', text: '{"status":"done"}', isError: false, costUsd: 0.01 })
  expect(parseStreamLine('not json')).toEqual({ kind: 'other' })
})

test('a message with several tool calls or results yields an event for each', async () => {
  const calls = parseStreamEvents(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'launchctl list' } },
          { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'ERROR', path: 'logs' } },
        ],
      },
    }),
  )
  expect(calls).toEqual([
    { kind: 'step', text: '$ launchctl list', id: 'a', full: '$ launchctl list' },
    { kind: 'step', text: '$ grep "ERROR" logs', id: 'b', full: '$ grep "ERROR" logs' },
  ])
  const multi = parseStreamEvents(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'm', input: { command: 'for j in a b; do\n  echo $j\ndone' } }] } }))
  expect(multi).toEqual([{ kind: 'step', text: '$ for j in a b; do', id: 'm', full: '$ for j in a b; do\n  echo $j\ndone' }])
  const results = parseStreamEvents(
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: '- 0 com.example.acme' },
          { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'logs/a.log:3' }], is_error: false },
          { type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'sidekick guard: refused (rm deletes files).' },
        ],
      },
    }),
  )
  expect(results).toEqual([
    { kind: 'output', id: 'a', text: '- 0 com.example.acme', isError: false },
    { kind: 'output', id: 'b', text: 'logs/a.log:3', isError: false },
    { kind: 'refused', id: 'c' },
  ])
  expect(parseStreamEvents(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }))).toEqual([{ kind: 'init', sessionId: 's-1' }])
})

test("a finished worker's session folder is deleted by id, and only a real session id is accepted", async () => {
  const id = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  expect(cleanupArgv('/home/u/.claude/', id)).toEqual(['find', '/home/u/.claude/projects', '-mindepth', '2', '-maxdepth', '2', '-type', 'd', '-name', id, '-exec', 'rm', '-rf', '{}', '+'])
  expect(cleanupArgv('/home/u/.claude', '*')).toBeNull()
  expect(cleanupArgv('/home/u/.claude', '')).toBeNull()
  expect(cleanupArgv('/home/u/.claude', '../x')).toBeNull()
})

test('credentials are redacted from what the record keeps', async () => {
  // Built from parts, so this file never holds a whole token-shaped string.
  const slack = ['xoxb', '1234567890', 'abcdefghij'].join('-')
  const anthropic = `sk-ant-${'a'.repeat(20)}`
  const github = `ghp_${'b'.repeat(30)}`
  expect(redact(`token=${slack} ok`)).toBe('token=[redacted] ok')
  expect(redact(anthropic)).toBe('[redacted]')
  expect(redact(`x ${github} y`)).toBe('x [redacted] y')
  expect(redact('postgres://app:hunter2@db.example.com:5432/app')).toBe('postgres://app:[redacted]@db.example.com:5432/app')
  expect(redact('nothing secret here')).toBe('nothing secret here')
  expect(redact(`key ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`)).toBe('key [redacted]')
  expect(redact(`jwt ${['eyJhbGciOi', 'eyJzdWIiOiIx', 'c2lnbmF0dXJl'].join('.')}`)).toBe('jwt [redacted]')
  expect(redact(`OPENAI=sk-${'c'.repeat(24)}`)).toBe('OPENAI=[redacted]')
  expect(redact('DB_PASSWORD=hunter22 port=5432')).toBe('DB_PASSWORD=[redacted] port=5432')
  expect(redact('slack_token: "abcd1234efgh"')).toBe('slack_token: "[redacted]"')
  expect(redact('Authorization: Bearer abc.def.ghi123')).toBe('Authorization: Bearer [redacted]')
  expect(redact('tokens used: 42')).toBe('tokens used: 42')
})

test('the record has the prompt, each command and its output, cut to size, and the report', async () => {
  const outcome = parseOutcome('{"status":"partial","summary":"acme-bot logs DNS failures","uncertain":["when they began"],"needsMain":"check DNS"}', false)
  const slack = ['xoxb', '1234567890', 'abcdefghij'].join('-')
  const text = dumpText(
    { prompt: 'acme-bot stopped replying', createdAt: Date.UTC(2026, 9, 23, 6, 0) },
    [
      { command: '$ tail -n 5 logs/acme.log', output: `ENOTFOUND example.com\nSLACK_BOT_TOKEN=${slack}`, isError: false },
      { command: '$ cat big.log', output: 'z'.repeat(5_000), isError: false },
      { command: '$ rm x', output: 'sidekick guard: refused', isError: true },
      { command: '$ for j in a b; do\n  echo $j\ndone', output: 'a\nb', isError: false },
    ],
    outcome,
    '≈$0.0050',
  )
  expect(text).toContain('# sidekick investigation: acme-bot stopped replying')
  expect(text).toContain('2026-10-23T06:00:00.000Z · partial · ≈$0.0050')
  expect(text).toContain('### $ tail -n 5 logs/acme.log')
  expect(text).toContain('ENOTFOUND example.com')
  expect(text).toContain('[cut: 1000 more chars]')
  expect(text).toContain('### $ rm x (error)')
  expect(text).toContain('### $ for j in a b; do …\n\n```sh\nfor j in a b; do\n  echo $j\ndone\n```')
  expect(text).toContain('## For the main session\n\ncheck DNS')
  expect(text).toContain('"summary": "acme-bot logs DNS failures"')
  expect(text).not.toContain(slack)
  expect(DUMP_KEEP).toBe(50)
  expect(dumpDir('/home/u', undefined)).toBe('/home/u/.claude/sidekick/investigations')
  expect(dumpDir('/home/u', '/cfg/')).toBe('/cfg/sidekick/investigations')
  expect(dumpName(Date.UTC(2026, 9, 23), 'mh1x-3')).toBe('2026-10-23-mh1x-3.md')
})

test('the handoff note points at the record, and a long summary never cuts the pointer', async () => {
  const outcome = parseOutcome(JSON.stringify({ status: 'done', summary: 'y'.repeat(900) }), false)
  const note = handoffNote('look into acme-bot', outcome, 'haiku', '/home/u/.claude/sidekick/investigations/2026-10-23-a.md')
  expect(note.length).toBeLessThanOrEqual(700)
  expect(note).toContain('Full record (every command and its output): /home/u/.claude/sidekick/investigations/2026-10-23-a.md.')
  expect(note.endsWith('Treat this as already done; take over only if the user asks or it needs you.')).toBe(true)
  expect(handoffNote('push', outcome, 'haiku')).not.toContain('Full record')
})

test('an outcome is validated; prose still reports something', async () => {
  const done = parseOutcome('{"status":"done","summary":"Committed abc1234","commands":["git commit"],"shas":["abc1234def5678"],"changed":["a.txt"],"uncertain":[],"needsMain":""}', false)
  expect(done.status).toBe('done')
  expect(done.shas).toEqual(['abc1234def56'])
  const prose = parseOutcome('I committed it.', false)
  expect(prose.status).toBe('partial')
  expect(prose.summary).toBe('I committed it.')
  expect(parseOutcome('{"status":"done","summary":"x"}', true).status).toBe('failed')
  // An investigation's next steps run long; 600 characters keep them whole.
  expect(parseOutcome(JSON.stringify({ status: 'partial', summary: 'x', needsMain: 'n'.repeat(700) }), false).needsMain.length).toBe(600)
})

test('the chat line and the handoff note say what happened', async () => {
  const outcome = parseOutcome('{"status":"done","summary":"Committed 3f2a91c and pushed","shas":["3f2a91c"],"changed":["docs/a.md"]}', false)
  expect(chatLine(outcome, 'haiku', 11)).toBe('✓ Committed 3f2a91c and pushed · haiku · 11s')
  expect(chatLine(outcome, 'haiku', 11, 0.0042)).toBe('✓ Committed 3f2a91c and pushed · haiku · 11s · ≈$0.0042')
  const note = handoffNote('commit and push', outcome, 'haiku')
  expect(note).toContain('"commit and push"')
  expect(note).toContain('SHAs: 3f2a91c')
  expect(note.length).toBeLessThanOrEqual(700)
})

test('give to main hands a finished assist over for context, and an unfinished one as work', async () => {
  const done = parseOutcome('{"status":"done","summary":"Pulled; already up to date","shas":["3f2a91c"],"changed":["main"],"uncertain":["whether a.txt is meant to stay dirty"]}', false)
  const text = giveToMainPrompt('git pull', done, ['$ git pull'], '/home/u/.claude/sidekick/investigations/x.md')
  expect(text).toContain('for your context')
  expect(text).not.toContain('Please take over')
  for (const part of ['SHAs: 3f2a91c', 'Changed: main', 'Unsure about: whether a.txt is meant to stay dirty', 'Commands it ran: $ git pull', 'Full record (every command and its output): /home/u/.claude/sidekick/investigations/x.md']) {
    expect(text).toContain(part)
  }
  const failed = parseOutcome('{"status":"failed","summary":"Push rejected","needsMain":"origin moved"}', false)
  const back = giveToMainPrompt('push', failed, [])
  expect(back).toContain('Please take over')
  expect(back).toContain('Why it stopped: origin moved')
  expect(back).not.toContain('Full record')
  expect(giveToMainPrompt('push', null, [])).toContain('Please take over')
})

test('the chat line hands what is left to main in a few words', async () => {
  const partial = parseOutcome('{"status":"partial","summary":"acme-bot logs DNS failures","needsMain":"check DNS"}', false)
  expect(chatLine(partial, 'haiku', 40)).toBe('◐ acme-bot logs DNS failures · haiku · 40s → main: check DNS (pane → give to main)')
  const done = parseOutcome('{"status":"done","summary":"Restarted acme-bot","needsMain":"watch it overnight"}', false)
  expect(chatLine(done, 'haiku', 40)).toBe('✓ Restarted acme-bot · haiku · 40s → main: watch it overnight')
  const quiet = parseOutcome('{"status":"stopped","summary":"Stopped"}', false)
  expect(chatLine(quiet, 'haiku', 1)).toBe('■ Stopped · haiku · 1s · see the sidekick pane')
})

test("state an older version wrote is upgraded, so new fields are never undefined", async () => {
  // What 0.1.2 left in a session: no spend, no tick, entries without spend.
  const old = {
    mode: 'auto',
    entries: [{ id: 'a', prompt: 'git status', status: 'done', verdict: 'mechanical', reason: '', judgeMs: 1, task: 'git status', locks: [], backend: 'haiku', createdAt: 1, startedAt: 1, endedAt: 2, steps: [], outcome: null, isMissed: false }],
    waiting: [],
    notes: [],
    watching: '',
    totals: { assists: 1, passed: 0, failed: 0 },
  }
  const state = migrate(old as never, EMPTY)
  expect(state.mode).toBe('auto')
  expect(state.spend.usd).toBe(0)
  expect(state.tick).toBe(0)
  expect(state.entries[0]?.judgeSpend.usd).toBe(0)
  expect(state.entries[0]?.workerSpend.cacheRead).toBe(0)
  expect(state.entries[0]?.prompt).toBe('git status')
  expect(migrate(undefined, EMPTY)).toEqual(EMPTY)
})

test('stored corrections upgrade from bare strings; junk is dropped', async () => {
  expect(toTaught(['a', { text: 'b', verdict: 'investigate' }, 3, { verdict: 'mechanical' }])).toEqual([
    { text: 'a', verdict: 'mechanical' },
    { text: 'b', verdict: 'investigate' },
  ])
  expect(migrate({ learned: ['a'] } as never, EMPTY).learned).toEqual([{ text: 'a', verdict: 'mechanical' }])
  expect(toTaught(undefined)).toEqual([])
})

test("the person's misses steer the judge: recent ones become precedents, capped", async () => {
  expect(judgeSystem([])).not.toContain('corrected you')
  const many = Array.from({ length: 15 }, (_, i) => ({ text: `tidy branch ${i}`, verdict: 'mechanical' as const }))
  const system = judgeSystem(many)
  expect(system).toContain('corrected you')
  expect(system).toContain('- tidy branch 14')
  expect(system).not.toContain('- tidy branch 4\n')
  expect(system.match(/^- tidy branch/gm)?.length).toBe(10)
})

test('the worker is told to name the upstream in ranges, where braces are refused', async () => {
  // Measured on Claude Code 2.1.309 under dontAsk: `git rev-parse --abbrev-ref @{u}` and
  // `git log -1 @{u}` run, `git log origin/main..HEAD` runs, but `git log @{u}..HEAD` and
  // `git rev-list --left-right --count @{u}...HEAD` are refused.
  expect(WORKER_SYSTEM).toContain('git log origin/main..HEAD, not @{u}..HEAD')
  expect(WORKER_SYSTEM).not.toContain('braces are refused')
  // Claude Code's own prompt says to branch first on the default branch; the worker must not.
  expect(WORKER_SYSTEM).toContain('Work on the branch that is checked out')
})

test('segment digits are five rows tall and line up', async () => {
  const rows = bigText('27')
  expect(rows.length).toBe(5)
  expect(rows[0]).toBe('╶──╮ ╶──╮')
  expect(bigWidth('27')).toBe(9)
  for (const row of rows) expect(row.length).toBe(9)
  expect(bigText('$4.18')[0]?.startsWith('$')).toBe(true)
  expect(new Set(bigText('$0.21').map(r => r.length)).size).toBe(1)
  expect(COLORS.claude).toBe('#d97757')
})

test('tile money is short: cents, dollars, thousands, never negative', async () => {
  expect(tileMoney(0)).toBe('$0')
  expect(tileMoney(-1)).toBe('$0')
  expect(tileMoney(0.0042)).toBe('$.004')
  expect(tileMoney(4.183)).toBe('$4.18')
  expect(tileMoney(42.4)).toBe('$42')
  expect(tileMoney(1234)).toBe('$1.2k')
})

test('bars and day blocks share one scale, and anything above zero shows', async () => {
  expect(barCells(19, 63, 30)).toEqual({ filled: 9, empty: 21 })
  expect(barCells(1, 1000, 30).filled).toBe(1)
  expect(barCells(0, 5, 30)).toEqual({ filled: 0, empty: 30 })
  expect(barCells(5, 0, 30)).toEqual({ filled: 0, empty: 30 })
  expect(dayLevels([3, 9, 27])).toEqual([1, 1, 4])
  expect(dayLevels([0, 0])).toEqual([0, 0])
  expect(spaced('NOW')).toBe('N O W')
})
