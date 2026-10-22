import { test, expect } from 'claude-code/testing'

import { canStart, lockKeys, parseJudgment, precheck, resourcesOf } from './lib/judge'
import { migrate } from './lib/state'
import { EMPTY } from './register'
import { chatLine, handoffNote, parseOutcome, parseStreamLine, splitLines, workerArgv } from './lib/worker'

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
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) expect(argv).toContain(flag)
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
  expect(argv).toContain('Bash(git reset --hard:*)')
  // Read-only helpers, so `cd repo && git ...` or `git log | head` is not refused whole.
  for (const helper of ['Bash(cd:*)', 'Bash(head:*)', 'Bash(wc:*)']) expect(argv).toContain(helper)
  expect(argv[argv.indexOf('--settings') + 1]).toContain('/p/bin/sidekick-guard')
})

test('streamed output splits on lines across chunks', async () => {
  const first = splitLines('', '{"a":1}\n{"b"')
  expect(first).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
  expect(splitLines(first.rest, ':2}\n')).toEqual({ lines: ['{"b":2}'], rest: '' })
})

test('stream lines become steps and a result', async () => {
  const step = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'git push' } }] } }))
  expect(step).toEqual({ kind: 'step', text: '$ git push' })
  const result = parseStreamLine(JSON.stringify({ type: 'result', result: '{"status":"done"}', is_error: false, total_cost_usd: 0.01 }))
  expect(result).toEqual({ kind: 'result', text: '{"status":"done"}', isError: false, costUsd: 0.01 })
  expect(parseStreamLine('not json')).toEqual({ kind: 'other' })
})

test('an outcome is validated; prose still reports something', async () => {
  const done = parseOutcome('{"status":"done","summary":"Committed abc1234","commands":["git commit"],"shas":["abc1234def5678"],"changed":["a.txt"],"uncertain":[],"needsMain":""}', false)
  expect(done.status).toBe('done')
  expect(done.shas).toEqual(['abc1234def56'])
  const prose = parseOutcome('I committed it.', false)
  expect(prose.status).toBe('partial')
  expect(prose.summary).toBe('I committed it.')
  expect(parseOutcome('{"status":"done","summary":"x"}', true).status).toBe('failed')
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
