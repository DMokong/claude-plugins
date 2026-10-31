import { test, expect, mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SidekickState } from '../types'
import { tallyOf, usd } from './lib/cost'
import type { HistoryRow } from './lib/history'

let clock: MockClock
/** The mod's state as it last wrote it, seen from beneath. */
let latest: SidekickState | undefined

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const STATE = { plugin: 'sidekick', key: 'sidekick' } as const
const TYPED = { origin: { kind: 'composer' }, wait: false } as const

type World = {
  /** What the judge model replies; a number delays the reply by that many ms first. */
  judge: string
  /** What a review of a finished main-session turn answers. */
  review?: string
  judgeDelayMs?: number
  /** What the worker's final result line carries. */
  worker: string
  /** When set, the worker waits for this promise before it reports. */
  workerGate?: Promise<void>
  /** What the record folder holds, as `$.fs.list` answers. */
  listed?: { name: string; kind: 'file'; size: number; mtimeMs: number; isLink: boolean }[]
  /** The main session's model, as `$.session.model()` answers. */
  mainModel?: string
  /** What the store holds before the session starts. */
  stored?: Record<string, unknown>
  /** The session's state as an earlier load of the mod left it, for the session that starts here to find. */
  seed?: Record<string, unknown>
  /** Runs before each write of the session's state lands, with the state as it stood and as it will stand; the write waits for it. */
  beforeWrite?: (was: SidekickState | undefined, will: SidekickState) => Promise<void>
  /** Runs before the store answers a read of `key`. */
  beforeGet?: (key: string) => void
  /** How many writes of a history key the store loses: the next ones answer and keep nothing. */
  losesWrites?: { count: number }
  /** The main session's steps, as the peek log holds them from the start. */
  peekSteps?: unknown[]
}

let peeks: Record<string, unknown>[] = []
let peekReply: string | undefined = 'It is running the tests.'

/** The engine beneath the mod: answers every call it makes and records what it did. */
function world(on: On, w: World) {
  clock = mock.clock(on)
  // The mod's store, as a map the test can read and change (another session's write, say).
  const store = new Map<string, unknown>(Object.entries(w.stored ?? {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  on('store.get', async (_$, e) => {
    w.beforeGet?.(e.key)
    return { value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }
  })
  on('store.set', async (_$, e) => {
    if (e.key.startsWith('history:') && w.losesWrites !== undefined && w.losesWrites.count > 0) {
      w.losesWrites.count -= 1
      return { value: undefined }
    }
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('session.model', async () => ({ value: w.mainModel ?? 'Opus 5.5' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 40_000, window: 200_000 }, rateLimits: [] } }))
  latest = undefined
  // Until the mod first writes its state, it reads the seed: a version-0 read answers it, and the first write lands on it.
  if (w.seed !== undefined) {
    on('state.get', async (_$, e, next) => {
      const read = await next(e)
      return e.plugin === 'sidekick' && e.key === 'sidekick' && read.value.version === 0 ? { value: { value: w.seed, version: 0 } } : read
    })
  }
  if (w.peekSteps !== undefined) {
    on('state.get', async (_$, e, next) => {
      const read = await next(e)
      return e.plugin === 'sidekick' && e.key === 'peek' && read.value.version === 0 ? { value: { value: { steps: w.peekSteps, turnStartedAt: 0, turnEndedAt: 0, isOpen: false, isAsking: false, isSteps: false, summary: '', askedAt: 0 }, version: 0 } } : read
    })
  }
  on('state.set', async (_$, e, next) => {
    if (e.plugin === 'sidekick' && e.key === 'sidekick') {
      await w.beforeWrite?.(e.previous as SidekickState | undefined, e.value as SidekickState)
      latest = e.value as SidekickState
    }
    return next(e)
  })
  let release = () => {}
  const slow = new Promise<void>(resolve => {
    release = resolve
  })
  const seen = {
    toMain: [] as { text: string; context: readonly string[] }[],
    logs: [] as string[],
    notified: [] as string[],
    appended: [] as string[],
    resubmitted: [] as string[],
    spawned: [] as string[][],
    written: [] as { path: string; text: string }[],
    ran: [] as string[][],
    judged: 0,
    judgments: [] as string[],
    systems: [] as string[],
    judgedWith: [] as string[],
    toasts: [] as string[],
    status: [] as (string | undefined)[],
    store,
    release: () => release(),
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', async () => ({ text: '' }))
  // The engine's own answer to a context build: the blocks it was given.
  on('prompt.context', async (_$, e) => ({ blocks: e.blocks }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('env.get', async (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.write', async (_$, e) => {
    seen.written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.list', async () => ({ value: w.listed ?? [] }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('fs.read', async (_$, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'sidekick', version: '9.9.9' }) }
    throw new Error(`unexpected read: ${e.path}`)
  })
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', async (_$, e) => {
    seen.notified.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('session.append', async (_$, e, next) => {
    const block = e.message.content[0]
    seen.appended.push(block !== undefined && 'text' in block ? String(block.text) : '')
    return next(e)
  })
  on('process.run', async (_$, e) => {
    seen.ran.push([...e.argv])
    const out = e.argv.includes('rev-parse') ? '/repo\n' : '## main...origin/main\n M a.txt\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', async ($, e) => {
    if (typeof e.system === 'string' && e.system.startsWith('You review')) {
      reviews.push(e.prompt)
      return { value: { isAnswered: true, text: w.review ?? '', usage: { input_tokens: 500, output_tokens: 50 } } } as never
    }
    if (typeof e.system === 'string' && e.system.startsWith('You tell a developer')) {
      peeks.push({ ...e })
      if (peekReply === undefined) return { value: { isAnswered: false, reason: 'refused', usage: { input_tokens: 500, output_tokens: 0 } } } as never
      return { value: { isAnswered: true, text: peekReply, usage: { input_tokens: 500, output_tokens: 30 } } } as never
    }
    seen.judged += 1
    if (e.prompt.includes('<message>')) {
      seen.judgments.push(e.prompt)
      seen.systems.push(typeof e.system === 'string' ? e.system : '')
      seen.judgedWith.push(e.model ?? '')
    }
    if (w.judgeDelayMs !== undefined) await slow
    return { value: { isAnswered: true, text: w.judge, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('process.spawn', async function* (_$, e) {
    seen.spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'system', subtype: 'init', session_id: WORKER_SESSION })}\n` }
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'git commit -m x' } }] } })}\n` }
    if (w.workerGate !== undefined) await w.workerGate
    yield {
      stream: 'stdout' as const,
      text: `${JSON.stringify({ type: 'result', result: w.worker, is_error: false, total_cost_usd: 0.00055948, usage: WORKER_USAGE })}\n`,
    }
    return { value: { code: 0, signal: null } }
  })
  // The bottom of prompt.submit: the main session receiving the prompt, or the mod re-sending one.
  on('prompt.submit', async (_$, e) => {
    if (e.origin.kind === 'plugin') seen.resubmitted.push(e.text)
    else seen.toMain.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, context: e.context }
  })
  return seen
}

const MECHANICAL = 'mechanical'
const WORKER_SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const WORKER_USAGE = {
  input_tokens: 4,
  cache_creation_input_tokens: 1642,
  cache_read_input_tokens: 15068,
  output_tokens: 160,
  cache_creation: { ephemeral_1h_input_tokens: 1642, ephemeral_5m_input_tokens: 0 },
}
const NEEDS_MAIN = 'needs-main'
const DONE = '{"status":"done","summary":"Committed 3f2a91c and pushed to origin/main","commands":["git commit","git push"],"shas":["3f2a91c"],"changed":["a.txt"],"uncertain":[],"needsMain":""}'

async function state(_$: unknown): Promise<SidekickState> {
  return latest as SidekickState
}

/** Every history row the store holds, whichever key a session kept its own under. */
function storedRows(seen: { store: Map<string, unknown> }): HistoryRow[] {
  const all = [...seen.store.entries()].filter(([key]) => key === 'history' || key.startsWith('history:')).flatMap(([, rows]) => rows as HistoryRow[])
  // A job kept in two places (copied from the shared key into a session's own) is one job.
  return all.filter((r, i) => r.kind === 'draft' || all.findIndex(o => o.kind === r.kind && o.id === r.id && o.at === r.at) === i)
}

const DAY = 24 * 60 * 60 * 1000
/** A finished chore someone else's session recorded `ago` ms before `now`. */
const chore = (now: number, ago: number, id: string): HistoryRow => ({ at: now - ago, kind: 'chore', status: 'done', ms: 1000, judgeUsd: 0.001, workerUsd: 0.002, savedUsd: 0.05, id })

/** Moves the mocked clock on until the mod's state satisfies `ok`. */
async function until($: unknown, ok: (s: SidekickState) => boolean): Promise<SidekickState> {
  for (let i = 0; i < 300; i += 1) {
    const s = await state($)
    if (s !== undefined && ok(s)) return s
    await clock.advance(10)
  }
  throw new Error(`state never settled: ${JSON.stringify(await state($))}`)
}

test('a new session starts off: every prompt reaches the main session untouched', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  const result = await $.prompt.submit({ text: 'commit and push', ...TYPED })
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['commit and push'])
  expect(seen.judged).toBe(0)
})

test('in auto, a mechanical chore is dropped from main, done by the worker, and reported back', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)

  const result = await $.prompt.submit({ text: 'commit and push', ...TYPED })
  expect(result.drop).toContain('→ sidekick (haiku)')
  // The person's own words stay in the transcript even though the main session never sees them.
  expect(seen.logs).toContain('❯ commit and push')
  expect(seen.toMain).toEqual([])

  const s = await until($, x => x.entries[0]?.status === 'done')
  expect(s.entries[0]?.steps).toEqual(['$ git commit -m x'])
  expect(s.totals.assists).toBe(1)
  // Priced with caching: the worker's run as Claude Code prices it, plus the judge's call.
  expect(Math.abs((s.entries[0]?.workerSpend.usd ?? 0) - 0.00055948)).toBeLessThan(1e-10)
  expect(s.entries[0]?.judgeSpend.input).toBe(1000)
  expect(s.spend.usd).toBeGreaterThan(0.00055948)
  expect(s.spend.savedUsd).toBeGreaterThan(0)
  expect(seen.spawned[0]?.slice(0, 4)).toEqual(['claude', '-p', '--model', 'haiku'])
  expect(seen.logs.some(line => line.startsWith('✓ Committed 3f2a91c') && line.includes('≈$'))).toBe(true)
  expect(seen.notified[0]).toContain('Committed 3f2a91c')
  // The main session learns what happened without the raw output.
  expect(seen.appended[0]).toContain('"commit and push"')
  expect(seen.appended[0]).toContain('3f2a91c')
})

test('in auto, a message that needs the session goes to main', async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const result = await $.prompt.submit({ text: 'rename the judge function', ...TYPED })
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['rename the judge function'])
  expect((await state($)).entries[0]?.status).toBe('passed')
  // The pass is visible in the transcript, and the status line says the sidekick is on.
  expect(seen.logs.some(line => line.startsWith('→ to Claude:'))).toBe(true)
  // The band, not the status line, says the sidekick is on.
  expect(seen.status.every(text => text === undefined)).toBe(true)
})

test('a slow judge fails open within the budget', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, judgeDelayMs: 8_000, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const pending = $.prompt.submit({ text: 'push it', ...TYPED })
  await clock.advance(5_000)
  const result = await pending
  seen.release()
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['push it'])
  expect((await state($)).entries[0]?.reason).toBe('judge timed out')
})

test('reasoning questions skip the judge entirely', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'why did the rebase fail?', ...TYPED })
  expect(seen.judged).toBe(0)
  expect(seen.toMain.map(p => p.text)).toEqual(['why did the rebase fail?'])
})

test('a prompt for main waits while an assist runs, then is sent in order', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const seen = world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)

  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  const held = await $.prompt.submit({ text: 'why does the stage-2 doc mention codex twice?', ...TYPED })
  expect(held.drop).toContain('until the sidekick finishes')
  expect(held.drop).toContain('❯ why does the stage-2 doc mention codex twice?')
  expect(seen.toMain).toEqual([])
  expect((await state($)).waiting.map(w => w.text)).toEqual(['why does the stage-2 doc mention codex twice?'])

  open()
  await until($, x => x.entries.find(e => e.prompt === 'commit and push')?.status === 'done' && x.waiting.length === 0)
  expect(seen.resubmitted).toEqual(['why does the stage-2 doc mention codex twice?'])
})

const INVESTIGATE = 'investigate'
const LOOKED = '{"status":"done","summary":"acme-bot was hung; restarted it and it came back (pid 901)","commands":["launchctl print gui/501/com.example.acme"],"shas":[],"changed":["restarted: acme-bot"],"uncertain":[],"needsMain":""}'

/** The main session's context build, carrying one instruction file the worker should get. */
async function withInstructions($: { prompt: { context: (e: never) => Promise<unknown> } }): Promise<void> {
  await $.prompt.context({ blocks: [], instructionFiles: [{ path: '/repo/CLAUDE.md', kind: 'project', content: 'acme-bot runs as com.example.acme.' }] } as never)
}

test('an investigation goes to the worker with the investigate profile and the ops lock', async ($, on) => {
  const seen = world(on, { judge: INVESTIGATE, worker: LOOKED })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await withInstructions($ as never)
  const result = await $.prompt.submit({ text: 'acme-bot stopped replying, look into it', ...TYPED })
  expect(result.drop).toContain('→ sidekick (haiku) · investigating')
  expect(seen.toMain).toEqual([])
  const s = await until($, x => x.entries[0]?.status === 'done')
  expect(s.entries[0]?.kind).toBe('investigate')
  expect(s.entries[0]?.locks).toEqual(['ops'])
  const argv = seen.spawned[0] ?? []
  expect(argv[argv.indexOf('--settings') + 1]).toContain('sidekick-guard investigate')
  expect(argv[argv.indexOf('--append-system-prompt') + 1]).toContain('acme-bot runs as com.example.acme.')
})

test("a finished investigation writes its record outside the repo and the note points to it; chores don't", async ($, on) => {
  const listed = Array.from({ length: 52 }, (_, i) => ({ name: `2026-10-${String(i).padStart(2, '0')}-x.md`, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }))
  const seen = world(on, { judge: INVESTIGATE, worker: LOOKED, listed })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await withInstructions($ as never)
  await $.prompt.submit({ text: 'acme-bot stopped replying, look into it', ...TYPED })
  const s = await until($, x => x.entries[0]?.status === 'done')
  const dump = s.entries[0]?.dump ?? ''
  expect(dump).toMatch(/^\/home\/u\/\.claude\/sidekick\/investigations\/\d{4}-\d{2}-\d{2}-.+\.md$/)
  expect(seen.written.map(w => w.path)).toEqual([dump])
  expect(seen.written[0]?.text).toContain('### $ git commit -m x')
  expect(seen.written[0]?.text).toContain('restarted: acme-bot')
  expect(seen.appended.at(-1)).toContain(`Full record (every command and its output): ${dump}.`)
  // The two oldest of 52 go; the newest 50 stay.
  expect(seen.ran.filter(argv => argv[0] === 'rm')).toEqual([
    ['rm', '-f', '/home/u/.claude/sidekick/investigations/2026-10-00-x.md'],
    ['rm', '-f', '/home/u/.claude/sidekick/investigations/2026-10-01-x.md'],
  ])
})

test("the pane tags an investigation, and its record button copies the record's path", async ($, on) => {
  const seen = world(on, { judge: INVESTIGATE, worker: LOOKED })
  const copied: string[] = []
  on('ui.copy', async (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await withInstructions($ as never)
  await $.prompt.submit({ text: 'check the acme-bot logs', ...TYPED })
  const s = await until($, x => x.entries[0]?.status === 'done')
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  expect(await ui.find({ type: 'Text', text: /investigate · check the acme-bot logs/ })).toBeDefined()
  await openJob(ui, s.entries[0]?.id)
  await ui.press({ key: `dump-${s.entries[0]?.id}` })
  await ui.unmount()
  expect(copied).toEqual([s.entries[0]?.dump ?? ''])
  expect(seen.toasts.some(t => t.startsWith('Copied: /home/u/.claude/sidekick/investigations/'))).toBe(true)
})

test('a chore writes no record', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done')
  expect(seen.written).toEqual([])
  expect(seen.appended.at(-1)).not.toContain('Full record')
  // What the worker session left on disk goes once it ends.
  expect(seen.ran.some(argv => argv[0] === 'find' && argv.includes(WORKER_SESSION) && argv[1] === '/home/u/.claude/projects')).toBe(true)
})

test('with no instruction files yet, an investigation goes to main instead', async ($, on) => {
  const seen = world(on, { judge: INVESTIGATE, worker: LOOKED })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const result = await $.prompt.submit({ text: 'acme-bot stopped replying, look into it', ...TYPED })
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['acme-bot stopped replying, look into it'])
  expect(seen.logs.some(line => line.includes('no instruction files yet'))).toBe(true)
  expect(seen.spawned).toEqual([])
  expect((await state($)).entries[0]?.status).toBe('passed')
  // The judge was right; there's nothing for "should've been sidekick" to teach.
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  await openJob(ui, (await state($)).entries[0]?.id)
  expect(await ui.find({ type: 'Text', text: /no instruction files yet/ })).toBeDefined()
  expect(await ui.find({ key: `missed-${(await state($)).entries[0]?.id}` })).toBeUndefined()
  await ui.unmount()
})

test('a running investigation does not hold prompts for the main session', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const seen = world(on, { judge: INVESTIGATE, worker: LOOKED, workerGate: gate })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await withInstructions($ as never)
  await $.prompt.submit({ text: 'acme-bot stopped replying, look into it', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  const through = await $.prompt.submit({ text: 'why does the stage-2 doc mention codex twice?', ...TYPED })
  expect(through.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['why does the stage-2 doc mention codex twice?'])
  open()
  await until($, x => x.entries.some(e => e.status === 'done'))
})

test('shadow says what it would investigate', async ($, on) => {
  const seen = world(on, { judge: 'investigate: acme-bot is a service whose logs are on this machine', worker: LOOKED })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'shadow', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'check the acme-bot logs', ...TYPED })
  const s = await until($, x => x.entries[0]?.status === 'shadow')
  expect(s.entries[0]?.reason).toContain('would investigate: acme-bot is a service whose logs are on this machine')
  expect(seen.spawned).toEqual([])
})

test('shadow judges and logs, but everything still goes to main', async ($, on) => {
  const seen = world(on, { judge: 'mechanical: commits and pushes this branch', worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'shadow', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const result = await $.prompt.submit({ text: 'commit and push', ...TYPED })
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['commit and push'])
  const s = await until($, x => x.entries[0]?.status === 'shadow')
  expect(s.entries[0]?.reason).toContain('would hand off: commits and pushes this branch')
  expect(seen.spawned).toEqual([])
})

test('prompts the mod did not get from the person are never judged', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', origin: { kind: 'task-notification' }, wait: false } as never)
  expect(seen.judged).toBe(0)
  expect(seen.toMain.map(p => p.text)).toEqual(['commit and push'])
})

test('the pane draws the assist with its buttons on every surface', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  const filled: string[] = []
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sidekick',
      surface,
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    } as never)
    if ((await ui.find({ key: 'back' })) !== undefined) await ui.press({ key: 'back' })
    // The dashboard: hero tiles (segment digits on the terminal, SVG on the desktop), the live strip,
    // the recent job.
    expect(await ui.find({ key: 'tile-done' })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^ {2}╷ $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^DONE$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^SAVED$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /est\. vs Opus$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Best day: today, 1 job/ })).toBeDefined()
    } else {
      const source = (key: string) => ui.find({ key }).then(x => String((x as { children?: { props?: { source?: string } }[] })?.children?.[0]?.props?.source))
      expect(await source('tile-done')).toContain('>1</text>')
      expect(await source('tile-saved')).toContain('est. vs Opus')
      expect(await source('days')).toContain('Today · 1 job')
      expect(await ui.find({ type: 'Text', text: /best today/ })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /WHERE IT WENT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /LAST 7 DAYS/ })).toBeDefined()
    // The loaded version, read from the manifest, sits quietly in the header.
    expect((await ui.find({ type: 'Text', text: /v9\.9\.9$/ }))?.text?.trim()).toBe('v9.9.9')
    expect(await ui.find({ type: 'Text', text: /caching saved/ })).toBeDefined()
    expect(await ui.find({ key: `job-${(await state($)).entries[0]?.id}` })).toBeDefined()
    // Its words are one press away.
    await openJob(ui, (await state($)).entries[0]?.id)
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /Committed 3f2a91c/ })).toBeDefined()
    else expect(String((await ui.find({ key: 'job-summary' }) as { props?: { text?: string } })?.props?.text)).toContain('Committed 3f2a91c')
    // The handed-off prompt is not in the up-arrow history, so the pane recalls it.
    filled.length = 0
    await ui.press({ key: `edit-${(await state($)).entries[0]?.id}` })
    expect(filled).toEqual(['commit and push'])
    await ui.unmount()
  }
})

test('a draft judged while typing answers the submit without a second judge call', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  // The kit raises prompt.edit at run time; its typings leave it off the prompt noun.
  const typing = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await typing.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'commit and push' })
  await clock.advance(500)
  await clock.advance(10)
  expect(seen.judgments.length).toBe(1)
  const result = await $.prompt.submit({ text: 'commit and push', ...TYPED })
  expect(result.drop).toContain('→ sidekick (haiku)')
  // The draft was judged once while typing; the submit asked nothing more.
  expect(seen.judgments.length).toBe(1)
  expect((await state($)).entries[0]?.status).not.toBe('passed')
})

type Mounted = { press: (q: { key: string }) => Promise<unknown>; find: (q: object) => Promise<unknown> }

/** Opens one job's details in the pane, from wherever it is: its buttons live there. */
async function openJob(ui: Mounted, id: string | undefined): Promise<void> {
  if ((await ui.find({ key: 'back' })) !== undefined) await ui.press({ key: 'back' })
  await ui.press({ key: `job-${id}` })
}

/** The engine's own band, beneath the mod's: empty. */
function underBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{''}</Text>
  })
}

const BAND = (columns = 100, maxRows = 40) =>
  ({ plugin: 'sidekick', component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: columns, maxRows, hasSurvey: false, isWorking: false, view: {} } }) as never

test('the folded line shows even while off, and stacks above the band beneath it', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  // Another plugin's band, beneath this one.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const off = await $.ui.mount({ ...(BAND() as object), surface } as never)
    expect(await off.find({ type: 'Text', text: /◆ sidekick/i })).toBeDefined()
    expect(await off.find({ type: 'Text', text: /○ off/i })).toBeDefined()
    expect(await off.find({ key: 'band-toggle' })).toBeDefined()
    expect(await off.find({ type: 'Text', text: /other band/ })).toBeDefined()
    await off.unmount()
  }
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const ui = await $.ui.mount(BAND())
  expect(await ui.find({ type: 'Text', text: / ● AUTO / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /saved/ })).toBeDefined()
  await ui.unmount()
})

test('on the desktop, the chosen mode and models are marked without relying on colour', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const ui = await $.ui.mount({ ...(BAND() as object), surface: 'desktop' } as never)
  await ui.press({ key: 'band-toggle' })
  const valueOf = (key: string) => ui.find({ key }).then(x => (x as { props?: { value?: string } } | undefined)?.props?.value)
  expect(await valueOf('mode-select')).toBe('auto')
  expect(await valueOf('judge-model')).toBe('haiku')
  // A pick in the mode dropdown changes the session's mode.
  await (ui as unknown as { select: (q: { key: string; value: string }) => Promise<unknown> }).select({ key: 'mode-select', value: 'shadow' })
  expect((await state($)).mode).toBe('shadow')
  // The toolbox is small type: footnote text, inside the buttons too.
  const drawn = JSON.stringify(await (ui as unknown as { drawn: () => Promise<unknown> }).drawn())
  expect(drawn).toMatch(/"type":"Button"[^]*?"size":"footnote"/)
  expect(drawn).not.toMatch(/"size":"body"/)
  await ui.unmount()
})

test('while the judge warms up, the folded line says so', async ($, on) => {
  // The judge's first call hangs until released: the warm-up is under way.
  const seen = world(on, { judge: MECHANICAL, worker: DONE, judgeDelayMs: 1 })
  underBand(on)
  await $.session.start(START)
  // A judge idle for more than 45 s is cold: turning the sidekick on warms it.
  await clock.advance(50_000)
  void $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await until($, x => x.isWarming)
  const ui = await $.ui.mount(BAND())
  expect(await ui.find({ type: 'Text', text: /warming up/ })).toBeDefined()
  await ui.unmount()
  seen.release()
  await until($, x => !x.isWarming)
})

test('the toggle opens the control panel; its chips and pills change the session and the settings', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'band-toggle' })
  expect((await state($)).panelOpen).toBe(true)
  expect(await ui.find({ type: 'Text', text: /S I D E K I C K/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /S E T T I N G S/ })).toBeDefined()
  // One click from off to on.
  await ui.press({ key: 'mode-auto' })
  expect((await state($)).mode).toBe('auto')
  await ui.press({ key: 'set-draftJudging' })
  expect((await state($)).settings.draftJudging).toBe(false)
  expect(seen.store.get('settings')).toEqual({ draftJudging: false })
  await ui.press({ key: 'worker-sonnet' })
  expect((await state($)).settings.workerModel).toBe('sonnet')
  for (const n of [2, 3, 4, 1]) {
    await ui.press({ key: 'set-maxConcurrent' })
    expect((await state($)).settings.maxConcurrent).toBe(n)
  }
  await ui.press({ key: 'launch-reset' })
  expect((await state($)).settings).toEqual({ judgeModel: 'haiku', workerModel: 'haiku', investigations: true, draftJudging: true, reviews: true, notifications: true, maxConcurrent: 1, pet: 'off' })
  expect(seen.store.get('settings')).toEqual({})
  await ui.press({ key: 'band-toggle' })
  expect((await state($)).panelOpen).toBe(false)
  await ui.unmount()
})

test('typing folds the panel', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'band-toggle' })
  await ui.unmount()
  const typing = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await typing.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'c' })
  expect((await state($)).panelOpen).toBe(false)
})

test('while a job runs, the band shows its card: the latest command and Working', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running' && x.entries[0].steps.length > 0)
  const ui = await $.ui.mount(BAND())
  expect(await ui.find({ type: 'Text', text: /Working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /git commit -m x/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Report back to Claude/ })).toBeDefined()
  await ui.unmount()
  open()
  await until($, x => x.entries[0]?.status === 'done')
})

test('a narrow band keeps the toggle and drops cost, then saved, then the counts', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const wide = await $.ui.mount(BAND(120))
  expect(await wide.find({ type: 'Text', text: /^cost/ })).toBeDefined()
  await wide.unmount()
  const mid = await $.ui.mount(BAND(68))
  expect(await mid.find({ type: 'Text', text: /^cost/ })).toBeUndefined()
  expect(await mid.find({ type: 'Text', text: /^saved/ })).toBeDefined()
  await mid.unmount()
  const narrow = await $.ui.mount(BAND(40))
  expect(await narrow.find({ key: 'band-toggle' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /^saved/ })).toBeUndefined()
  await narrow.unmount()
})

test('state a 0.3.0 session wrote draws the band', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  on('state.get', async (_$, e, next) => (e.key === 'sidekick' ? { value: { value: { mode: 'auto', entries: [] }, version: 1 } } : next(e)))
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND())
  expect(await ui.find({ key: 'band-toggle' })).toBeDefined()
  await ui.unmount()
})

test("should've been sidekick teaches the judge: the next judgment carries the miss", async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'tidy up merged branches', ...TYPED })
  expect(seen.systems.at(-1)).not.toContain('corrected you')
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as never)
  await openJob(ui, (await state($)).entries[0]?.id)
  await ui.press({ key: `missed-${(await state($)).entries[0]?.id}` })
  await ui.unmount()
  expect(seen.toasts.some(t => t.includes('tidy up merged branches'))).toBe(true)
  await $.prompt.submit({ text: 'tidy up stale branches', ...TYPED })
  expect(seen.systems.at(-1)).toContain('- tidy up merged branches')
})

test('learned corrections can be listed and forgotten, from the pane and the command', async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const pane = () =>
    $.ui.mount({
      plugin: 'sidekick',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    } as never)
  for (const text of ['tidy up merged branches', 'sync with origin']) {
    await $.prompt.submit({ text, ...TYPED })
    const ui = await pane()
    const id = (await state($)).entries.find(x => x.prompt === text)?.id
    await openJob(ui, id)
    await ui.press({ key: `missed-${id}` })
    await ui.unmount()
  }
  const run = (args: string) => $.command.run({ command: 'sidekick', args, origin: { kind: 'composer' }, presentation: 'inline' } as never) as Promise<{ text: string }>
  const listed = (await run('learned')).text
  expect(listed).toContain('1. [chore] sync with origin')
  expect(listed).toContain('2. [chore] tidy up merged branches')

  const ui = await pane()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'view-learned' })
  expect(await ui.find({ type: 'Text', text: /LEARNED/ })).toBeDefined()
  await ui.press({ key: 'forget-tidy up merged branches' })
  await ui.unmount()
  expect((await state($)).learned).toEqual([{ text: 'sync with origin', verdict: 'mechanical' }])
  await $.prompt.submit({ text: 'prune branches', ...TYPED })
  expect(seen.systems.at(-1)).not.toContain('- tidy up merged branches')
  expect(seen.systems.at(-1)).toContain('- sync with origin')

  expect((await run('forget 1')).text).toContain('sync with origin')
  expect((await state($)).learned).toEqual([])
  await $.prompt.submit({ text: 'prune more branches', ...TYPED })
  expect(seen.systems.at(-1)).not.toContain('corrected you')
  expect((await run('forget 3')).text).toContain('Usage')
})

test('corrections a 0.2.x store kept as plain strings still list, steer and forget', async ($, on) => {
  // The store as 0.2.x left it.
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE, stored: { missed: ['prune merged branches'] } })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const run = (args: string) => $.command.run({ command: 'sidekick', args, origin: { kind: 'composer' }, presentation: 'inline' } as never) as Promise<{ text: string }>
  expect((await run('learned')).text).toContain('1. [chore] prune merged branches')
  await $.prompt.submit({ text: 'sync with origin', ...TYPED })
  expect(seen.systems.at(-1)).toContain('- prune merged branches')
  expect((await run('forget 1')).text).toContain('prune merged branches')
  expect((await state($)).learned).toEqual([])
})

test("should've been sidekick on a message about a running service teaches investigate", async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'acme-bot logs look wrong', ...TYPED })
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as never)
  await openJob(ui, (await state($)).entries[0]?.id)
  await ui.press({ key: `missed-${(await state($)).entries[0]?.id}` })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'view-learned' })
  expect(await ui.find({ type: 'Text', text: /\[investigate\] / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /acme-bot logs look wrong/ })).toBeDefined()
  await ui.unmount()
  expect((await state($)).learned).toEqual([{ text: 'acme-bot logs look wrong', verdict: 'investigate' }])
  await $.prompt.submit({ text: 'acme-bot health', ...TYPED })
  const system = seen.systems.at(-1) ?? ''
  expect(system.slice(system.indexOf('investigation:'))).toContain('- acme-bot logs look wrong')
})

test("the worker gets the instruction files the main session loaded, and the pane says so", async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  expect((await state($)).instructions).toBeNull()
  await $.prompt.context({ blocks: [], instructionFiles: [{ path: '/repo/CLAUDE.md', kind: 'project', content: 'The bot logs to logs/bot.log.' }] })
  expect((await state($)).instructions).toEqual([{ path: '/repo/CLAUDE.md', kind: 'project', content: 'The bot logs to logs/bot.log.' }])
  await $.prompt.submit({ text: 'push it', ...TYPED })
  await clock.advance(10)
  const argv = seen.spawned.at(-1) ?? []
  expect(argv[argv.indexOf('--append-system-prompt') + 1]).toContain('The bot logs to logs/bot.log.')
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as never)
  expect(await ui.find({ type: 'Text', text: /1 instruction file/ })).toBeDefined()
  await ui.unmount()
})

test('settings changed in an earlier session are in force, and only changed ones are kept', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE, stored: { settings: { workerModel: 'sonnet', notifications: false } } })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const s0 = await state($)
  expect(s0.settings.workerModel).toBe('sonnet')
  expect(s0.settings.notifications).toBe(false)
  expect(s0.settings.draftJudging).toBe(true)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done')
  const argv = seen.spawned[0] ?? []
  expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
  // Notifications off: no ping, but the chat line still says it.
  expect(seen.notified).toEqual([])
  expect(seen.logs.some(line => line.startsWith('✓ Committed 3f2a91c'))).toBe(true)
})

test("another session's change is in force from the next message", async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'tidy up', ...TYPED })
  seen.store.set('settings', { judgeModel: 'sonnet' })
  await $.prompt.submit({ text: 'tidy up again', ...TYPED })
  expect(seen.judgedWith.at(-2)).toBe('haiku')
  expect(seen.judgedWith.at(-1)).toBe('sonnet')
})

test('draft judging off: pauses in typing cost nothing, and a sent message is still judged', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE, stored: { settings: { draftJudging: false } } })
  on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const before = seen.judgments.length
  const typing = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await typing.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'commit and push' })
  await clock.advance(2_000)
  expect(seen.judgments.length).toBe(before)
  const result = await $.prompt.submit({ text: 'commit and push', ...TYPED })
  expect(result.drop).toContain('→ sidekick')
  expect(seen.judgments.length).toBe(before + 1)
})

test('investigations off: an investigate verdict goes to main, saying why', async ($, on) => {
  const seen = world(on, { judge: INVESTIGATE, worker: LOOKED, stored: { settings: { investigations: false } } })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await withInstructions($ as never)
  const result = await $.prompt.submit({ text: 'acme-bot stopped replying, look into it', ...TYPED })
  expect(result.drop).toBeUndefined()
  expect(seen.logs.some(line => line.includes('investigations are off'))).toBe(true)
  expect(seen.spawned).toEqual([])
})

test('history: finished work and passes are kept across sessions, and give to main takes the saving back', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  const s = await until($, x => x.entries[0]?.status === 'done' && x.today.done === 1)
  const rows = storedRows(seen)
  expect(rows.length).toBe(1)
  expect(rows[0]?.kind).toBe('chore')
  expect(rows[0]?.status).toBe('done')
  // One Opus turn on a 40k context is worth more than a Haiku chore costs.
  expect(rows[0]!.savedUsd).toBeGreaterThan(0.02)
  expect(s.today.savedUsd).toBe(rows[0]!.savedUsd)
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  await openJob(ui, s.entries[0]?.id)
  await ui.press({ key: `main-${s.entries[0]?.id}` })
  await ui.unmount()
  const after = await until($, x => x.today.savedUsd === 0)
  expect(after.today.done).toBe(0)
  expect(storedRows(seen)[0]?.status).toBe('given')
})

test('a pass to Claude is kept in the history too', async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'rename the judge function', ...TYPED })
  expect(storedRows(seen).map(r => r.kind)).toEqual(['to-claude'])
})

test('the dashboard tabs pick the span, and a narrow pane stacks the tiles', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  // Other sessions' work: one chore today, one three days ago, two ten days ago (outside the week).
  await clock.set(Date.UTC(2026, 9, 14, 12))
  const now = clock.now()
  seen.store.set('history', [chore(now, 0, 'x1'), chore(now, 3 * DAY, 'x2'), chore(now, 10 * DAY, 'x3'), chore(now, 10 * DAY, 'x4')])
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done' && x.today.done === 2)
  const pane = (columns: number) =>
    $.ui.mount({
      plugin: 'sidekick',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
  const ui = await pane(100)
  // The span decides the count: this session did 1, today holds 2, the week 3; the ten-day-old two are in none.
  for (const [tab, chores] of [['week', 3], ['session', 1], ['today', 2]] as const) {
    await ui.press({ key: `tab-${tab}` })
    expect((await state($)).tab).toBe(tab)
    expect(await ui.find({ type: 'Text', text: new RegExp(`(^|\\D)${chores} chores · 0 looks`) })).toBeDefined()
    for (const other of [1, 2, 3].filter(n => n !== chores)) expect(await ui.find({ type: 'Text', text: new RegExp(`(^|\\D)${other} chores · 0 looks`) })).toBeUndefined()
  }
  await ui.unmount()
  const narrow = await pane(50)
  const drawn = JSON.stringify(await (narrow as unknown as { drawn: () => Promise<unknown> }).drawn())
  // Stacked: the tiles sit in a column, DONE above SAVED.
  expect(drawn.indexOf('"DONE"')).toBeLessThan(drawn.indexOf('"SAVED"'))
  expect(drawn).toContain('"flexDirection":"column"')
  await narrow.unmount()
  const tiny = await pane(30)
  // Too narrow for segment digits: plain numbers.
  expect(await tiny.find({ type: 'Text', text: /^2$/ })).toBeDefined()
  await tiny.unmount()
})

test('the panel takes the shape that fits the band: rules when roomy, one LAUNCH row when tight', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const tall = await $.ui.mount(BAND(100, 30))
  await tall.press({ key: 'band-toggle' })
  expect(await tall.find({ type: 'Text', text: /N O W/ })).toBeUndefined()
  expect(await tall.find({ type: 'Text', text: /S E T T I N G S/ })).toBeDefined()
  expect(await tall.find({ type: 'Text', text: /What it learned/ })).toBeDefined()
  // LAUNCH is at most two rows: three to a row, full labels.
  expect(await tall.find({ key: 'lr-1' })).toBeDefined()
  expect(await tall.find({ key: 'lr-2' })).toBeUndefined()
  await tall.unmount()
  const short = await $.ui.mount(BAND(100, 12))
  expect(await short.find({ type: 'Text', text: /N O W/ })).toBeUndefined()
  expect(await short.find({ type: 'Text', text: /S E T T I N G S/ })).toBeUndefined()
  expect(await short.find({ type: 'Text', text: /^Learned 0$/ })).toBeDefined()
  for (const key of ['launch-dashboard', 'launch-learned', 'launch-record', 'launch-main', 'launch-reset', 'set-draftJudging', 'mode-auto']) {
    expect(await short.find({ key })).toBeDefined()
  }
  const drawn = JSON.stringify(await (short as unknown as { drawn: () => Promise<unknown> }).drawn())
  await short.unmount()
  expect(drawn).toContain('Reset')
})

test("a draft's judge call is counted once: as draft judging, not again on the message it answered", async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const typing = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await typing.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'rename the judge' })
  await clock.advance(500)
  await until($, () => storedRows(seen).length > 0)
  await $.prompt.submit({ text: 'rename the judge', ...TYPED })
  const rows = storedRows(seen)
  const judged = rows.reduce((n, r) => n + r.judgeUsd, 0)
  // One judge call: 1000 input tokens and 1 output at Haiku's rates.
  expect(Math.abs(judged - tallyOf('haiku', { input_tokens: 1000, output_tokens: 1 }).usd) < 1e-12).toBe(true)
  expect(rows.map(r => r.kind).sort()).toEqual(['draft', 'to-claude'])
})

test('two jobs finishing together both land in the history', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const seen = world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate, stored: { settings: { maxConcurrent: 2 } } })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await $.prompt.submit({ text: 'close the bd issue', ...TYPED })
  await until($, x => x.entries.filter(e => e.status === 'running').length === 2)
  open()
  await until($, x => x.entries.every(e => e.status === 'done') && x.today.done === 2)
  expect(storedRows(seen).length).toBe(2)
})

test('the folded line fits its width, keeping the toggle, at every width', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  for (const mode of ['off', 'auto', 'shadow'] as const) {
    if (mode !== 'off') await $.command.run({ command: 'sidekick', args: mode, origin: { kind: 'composer' }, presentation: 'inline' } as never)
    for (const width of [24, 30, 40, 66, 67, 68, 80, 120]) {
      const ui = await $.ui.mount(BAND(width))
      const tree = (await (ui as unknown as { drawn: () => Promise<unknown> }).drawn()) as { children?: unknown[] }
      // The folded line is the last row the mod draws, above the band beneath it.
      const rows = (tree.children ?? []) as { props?: { key?: string } ; children?: unknown[] }[]
      const line = rows.find(r => JSON.stringify(r).includes('band-toggle'))
      const text = (JSON.stringify(line).match(/"(?:children|label)":"([^"]*)"/g) ?? []).map(m => JSON.parse(m.slice(m.indexOf(':') + 1)) as string).join('')
      expect(text.length).toBeLessThanOrEqual(width)
      expect(await ui.find({ key: 'band-toggle' })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('tiles sit side by side only where segment money fits in them', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  const pane = (columns: number) =>
    $.ui.mount({
      plugin: 'sidekick',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
  for (const [columns, isRow] of [[66, false], [67, false], [68, true]] as const) {
    const ui = await pane(columns)
    const drawn = (await (ui as unknown as { drawn: () => Promise<unknown> }).drawn()) as object
    const tiles = JSON.stringify(drawn).match(/"flexDirection":"(row|column)","marginTop":1/)
    expect(tiles?.[1]).toBe(isRow ? 'row' : 'column')
    await ui.unmount()
  }
})

test('the panel pops up at the right end, a fixed width, not across the band', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND(160))
  await ui.press({ key: 'band-toggle' })
  const drawn = JSON.stringify(await (ui as unknown as { drawn: () => Promise<unknown> }).drawn())
  await ui.unmount()
  // A spacer pushes it right, and the frame is 72 wide however wide the band.
  const row = drawn.slice(drawn.indexOf('"sk-panel-row"'))
  expect(row.indexOf('"flexGrow":1')).toBeLessThan(row.indexOf('"key":"sk-panel"'))
  expect(row).toMatch(/"key":"sk-panel"[^}]*"width":72/)
  const narrow = await $.ui.mount(BAND(50))
  const small = JSON.stringify(await (narrow as unknown as { drawn: () => Promise<unknown> }).drawn())
  await narrow.unmount()
  expect(small).toContain('"width":50')
})

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

/** The text a node draws, its children's in order. */
function textOf(node: Node | string): string {
  if (typeof node === 'string') return node
  return (node.children ?? []).map(textOf).join('')
}

/** Every row of the open panel that must stay on one line: its own nowrap boxes. */
function panelRows(tree: Node): { width: number; rows: string[] } {
  const find = (n: Node): Node | undefined =>
    n.props?.key === 'sk-panel' ? n : (n.children ?? []).filter((c): c is Node => typeof c !== 'string').map(find).find(x => x !== undefined)
  const panel = find(tree)!
  const rows: string[] = []
  const walk = (n: Node) => {
    if (n.type === 'Box' && n.props?.flexWrap === 'nowrap' && n.props?.key !== 'sk-panel') rows.push(textOf(n))
    else for (const c of n.children ?? []) if (typeof c !== 'string') walk(c)
  }
  for (const c of panel.children ?? []) if (typeof c !== 'string') walk(c)
  return { width: Number(panel.props?.width), rows }
}

test('the panel picks a layout that fits its width: no row runs over, every control stays', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: INVESTIGATE, worker: LOOKED, workerGate: gate })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await withInstructions($ as never)
  await $.prompt.submit({ text: 'acme-bot stopped replying overnight, look into it please', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  const first = await $.ui.mount(BAND(100, 30))
  await first.press({ key: 'band-toggle' })
  await first.unmount()
  for (const width of [120, 72, 64, 60, 50, 44, 40, 34, 28, 24]) {
    for (const maxRows of [30, 12]) {
      const ui = await $.ui.mount(BAND(width, maxRows))
      const { width: w, rows } = panelRows((await (ui as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(Math.max(20, w - 4))
      for (const key of ['mode-auto', 'judge-haiku', 'worker-sonnet', 'set-draftJudging', 'set-maxConcurrent', 'launch-dashboard', 'launch-reset']) {
        expect(await ui.find({ key })).toBeDefined()
      }
      await ui.unmount()
    }
  }
  open()
  await until($, x => x.entries[0]?.status === 'done')
})

test('a narrow panel drops the notes and shortens chips; a wide one keeps them', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const wide = await $.ui.mount(BAND(100))
  await wide.press({ key: 'band-toggle' })
  expect(await wide.find({ type: 'Text', text: /look into services/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /What it learned/ })).toBeDefined()
  await wide.unmount()
  const compact = await $.ui.mount(BAND(56))
  expect(await compact.find({ type: 'Text', text: /look into services/ })).toBeUndefined()
  expect(await compact.find({ type: 'Text', text: /^Learned 0$/ })).toBeDefined()
  expect(await compact.find({ type: 'Text', text: / Haiku 5\.5 / })).toBeDefined()
  await compact.unmount()
  const mini = await $.ui.mount(BAND(36))
  expect(await mini.find({ type: 'Text', text: /^ Haiku $/ })).toBeDefined()
  expect(await mini.find({ type: 'Text', text: /^ 1× $/ })).toBeDefined()
  await mini.unmount()
})

test("the dashboard's header fits the pane: one row when it fits, the tabs on a second when not", async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  for (const columns of [120, 80, 60, 45, 40, 34, 28]) {
    const ui = await $.ui.mount({
      plugin: 'sidekick',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
    const tree = (await (ui as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
    const find = (n: Node): Node | undefined =>
      n.props?.key === 'hdr' ? n : (n.children ?? []).filter((c): c is Node => typeof c !== 'string').map(find).find(x => x !== undefined)
    const hdr = find(tree)!
    const rows = (hdr.children ?? []).filter((c): c is Node => typeof c !== 'string')
    for (const row of rows) expect(textOf(row).length).toBeLessThanOrEqual(columns - 4)
    // The title is never split: it stays whole on its row.
    expect(textOf(rows[0]!)).toContain('✦ SIDEKICK')
    expect(rows.length).toBe(columns >= 60 ? 1 : 2)
    for (const key of ['tab-session', 'tab-today', 'tab-week', 'view-learned']) expect(await ui.find({ key })).toBeDefined()
    await ui.unmount()
  }
})

test('every one-line row of the dashboard fits its pane, at every width', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push all of the documentation changes please', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  const over: string[] = []
  for (const columns of [120, 80, 68, 60, 50, 45, 40, 34, 28]) {
    const ui = await $.ui.mount({
      plugin: 'sidekick',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
    } as never)
    const tree = (await (ui as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
    // A bordered box loses 4 cells (border and padding) for what is inside it.
    const walk = (n: Node, room: number) => {
      const inside = n.props?.borderStyle !== undefined ? room - 4 : room
      if (n.type === 'Box' && n.props?.flexWrap === 'nowrap' && textOf(n).length > room) over.push(`${columns}: ${textOf(n)} (${textOf(n).length} > ${room})`)
      for (const c of n.children ?? []) if (typeof c !== 'string') walk(c, inside)
    }
    walk(tree, columns)
    await ui.unmount()
  }
  open()
  await until($, x => x.entries[0]?.status === 'done')
  expect(over).toEqual([])
})

test('the worker is offered Haiku and Sonnet, not Opus: that work belongs in the main session', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND(100))
  await ui.press({ key: 'band-toggle' })
  expect(await ui.find({ key: 'worker-haiku' })).toBeDefined()
  expect(await ui.find({ key: 'worker-sonnet' })).toBeDefined()
  expect(await ui.find({ key: 'worker-opus' })).toBeUndefined()
  await ui.unmount()
})

/** What, on a graphical surface, could run past its slot or still look like a terminal. */
function richSpill(tree: Node, columns: number): string[] {
  const out: string[] = []
  const words = (n: Node): string => (n.type === 'Button' ? String(n.props?.label ?? '') : textOf(n))
  const walk = (n: Node) => {
    const text = words(n)
    if (n.type === 'Box' && typeof n.props?.width === 'number') out.push(`${columns}: a fixed width ${n.props.width}`)
    if (n.type === 'Box' && typeof n.props?.minWidth === 'number' && n.props.minWidth > 0) out.push(`${columns}: a fixed minWidth ${n.props.minWidth}`)
    if (n.type === 'Text' && /[─━▆╭╮╰╯│▮]/.test(text)) out.push(`${columns}: terminal art "${text}"`)
    if (n.type === 'Text' && text.length > 40 && n.props?.wrap === undefined) out.push(`${columns}: long text that never wraps "${text}"`)
    if (n.type === 'Button' && text.length > columns) out.push(`${columns}: a button wider than the slot "${text}"`)
    // In a row that never wraps, anything long must be able to shrink: truncating text, or a box that gives way.
    if (n.type === 'Box' && n.props?.flexWrap === 'nowrap')
      for (const c of n.children ?? []) {
        if (typeof c === 'string') continue
        if (c.type === 'Text' && words(c).length > 14 && c.props?.wrap === undefined) out.push(`${columns}: fixed text in a row "${words(c)}"`)
        if (c.type === 'Button' && words(c).length > 14) out.push(`${columns}: a button that cannot shrink in a row "${words(c)}"`)
      }
    for (const c of n.children ?? []) if (typeof c !== 'string') walk(c)
  }
  walk(tree)
  return out
}

test('on the desktop, nothing in the band, panel or dashboard can run past its slot, at any width', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push all of the documentation changes please, then tidy the changelog and the readme as well', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  const over: string[] = []
  const seen = { svg: 0, card: false, panel: false }
  for (const columns of [24, 30, 45, 60, 100, 160]) {
    for (const isOpen of [false, true]) {
      const band = await $.ui.mount({ ...(BAND(columns, 40) as object), surface: 'desktop' } as never)
      if (isOpen) await band.press({ key: 'band-toggle' })
      const tree = (await (band as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
      seen.card ||= JSON.stringify(tree).includes('"sk-card"')
      seen.panel ||= JSON.stringify(tree).includes('"sk-panel"')
      over.push(...richSpill(tree, columns))
      if (isOpen) await band.press({ key: 'band-toggle' })
      await band.unmount()
    }
    const pane = await $.ui.mount({
      plugin: 'sidekick',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
    } as never)
    const tree = (await (pane as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
    seen.svg = Math.max(seen.svg, (JSON.stringify(tree).match(/"type":"Svg"/g) ?? []).length)
    over.push(...richSpill(tree, columns))
    await pane.unmount()
  }
  open()
  await until($, x => x.entries[0]?.status === 'done')
  // Tiles, the running job's sweep, where it went and the week: real drawings, not cells.
  expect(seen).toEqual({ svg: 6, card: true, panel: true })
  // The open panel fits the space above the prompt: two rows of small type, never a scroll.
  const band = await $.ui.mount({ ...(BAND(100, 40) as object), surface: 'desktop' } as never)
  await band.press({ key: 'band-toggle' })
  const tree = (await (band as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
  const find = (n: Node): Node | undefined => (n.props?.key === 'sk-panel' ? n : (n.children ?? []).filter((c): c is Node => typeof c !== 'string').map(find).find(x => x !== undefined))
  expect(find(tree)?.children?.length).toBe(2)
  await band.unmount()
  expect(over).toEqual([])
})

test('the check for spills catches a fixed width, unwrapped words and a button that cannot shrink', async () => {
  const bad: Node = {
    type: 'Box',
    props: { flexWrap: 'nowrap', width: 72 },
    children: [
      { type: 'Text', children: ['a long line of words that would run over the edge'] },
      { type: 'Button', props: { label: 'a long button label' } },
      { type: 'Text', props: { wrap: 'truncate-end' }, children: ['─────'] },
    ],
  }
  expect(richSpill(bad, 30).length).toBe(5)
})

test('on the desktop, the models are dropdowns and side by side is a stepper', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...(BAND() as object), surface: 'desktop' } as never)
  await ui.press({ key: 'band-toggle' })
  const select = (ui as unknown as { select: (q: { key: string; value: string }) => Promise<unknown> }).select
  await select({ key: 'worker-model', value: 'sonnet' })
  expect((await state($)).settings.workerModel).toBe('sonnet')
  expect(seen.store.get('settings')).toEqual({ workerModel: 'sonnet' })
  const many = (await state($)).settings.maxConcurrent
  await ui.press({ key: 'set-maxConcurrent-up' })
  expect((await state($)).settings.maxConcurrent).toBe(Math.min(4, many + 1))
  await ui.press({ key: 'set-maxConcurrent-down' })
  await ui.press({ key: 'set-maxConcurrent-down' })
  expect((await state($)).settings.maxConcurrent).toBe(Math.max(1, Math.min(4, many + 1) - 2))
  // The settings are buttons that say their state.
  expect((await ui.find({ key: 'set-draftJudging' }) as { text?: string })?.text).toBe('● Draft judging')
  await ui.press({ key: 'set-draftJudging' })
  expect((await ui.find({ key: 'set-draftJudging' }) as { text?: string })?.text).toBe('○ Draft judging')
  await ui.unmount()
})

test('the open panel is never taller than 15 rows, so the folded line stays in view', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  for (const maxRows of [12, 18, 23, 30, 60]) {
    const ui = await $.ui.mount(BAND(100, maxRows))
    if ((await ui.find({ key: 'sk-panel' })) === undefined) await ui.press({ key: 'band-toggle' })
    const tree = (await (ui as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
    const find = (n: Node): Node | undefined =>
      n.props?.key === 'sk-panel' ? n : (n.children ?? []).filter((c): c is Node => typeof c !== 'string').map(find).find(x => x !== undefined)
    const panel = find(tree)!
    // One row per child at this width, plus the two borders.
    const height = (panel.children ?? []).filter(c => typeof c !== 'string').length + 2
    expect({ maxRows, height: Math.min(height, 15) }).toEqual({ maxRows, height })
    await ui.unmount()
  }
})

test('on an engine before 2.1.308, the panel draws: every Button is its label alone', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  on('session.version', async () => ({ value: { version: '2.1.300' } }))
  await $.session.start(START)
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'band-toggle' })
  const found: Node[] = []
  const walk = (n: Node) => {
    if (n.type === 'Button') found.push(n)
    for (const child of n.children ?? []) if (typeof child === 'object') walk(child as Node)
  }
  walk((await (ui as unknown as { drawn: () => Promise<Node> }).drawn()))
  expect(found.length).toBeGreaterThan(5)
  expect(found.filter(n => (n.children ?? []).some(child => typeof child === 'object'))).toEqual([])
  await ui.unmount()
})

test('on an engine before 2.1.308, the desktop says to update and the session is told once', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  on('session.version', async () => ({ value: { version: '2.1.300' } }))
  await $.session.start(START)
  expect(seen.toasts.filter(text => /2\.1\.308/.test(text))).toHaveLength(1)
  const ui = await $.ui.mount({ ...(BAND() as object), surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Text', text: /claude update/ })).toBeDefined()
  expect(await ui.find({ key: 'band-toggle' })).toBeUndefined()
  await ui.unmount()
})

test('on 2.1.308 itself, nothing asks for an update', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  on('session.version', async () => ({ value: { version: '2.1.308' } }))
  await $.session.start(START)
  expect(seen.toasts.filter(text => /2\.1\.308/.test(text))).toEqual([])
  const ui = await $.ui.mount({ ...(BAND() as object), surface: 'desktop' } as never)
  expect(await ui.find({ key: 'band-toggle' })).toBeDefined()
  await ui.unmount()
})

test('the pet starts off, and the panel chooses it, keeps it and hides it', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND(100, 30))
  expect(await ui.find({ key: 'sk-pet' })).toBeUndefined()
  await ui.press({ key: 'band-toggle' })
  expect(await ui.find({ type: 'Text', text: 'v9.9.9' })).toBeDefined()
  await ui.press({ key: 'pet-mochi' })
  expect((await state($)).settings.pet).toBe('mochi')
  expect(seen.store.get('settings')).toEqual({ pet: 'mochi' })
  // With nothing to do it stays in, and the flag says it's on.
  await ui.press({ key: 'band-toggle' })
  expect(await ui.find({ key: 'sk-pet' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /🐾 mochi/ })).toBeDefined()
  // The band's own button goes round the choices.
  await ui.press({ key: 'band-pet' })
  expect((await state($)).settings.pet).toBe('tater')
  await ui.press({ key: 'band-pet' })
  expect((await state($)).settings.pet).toBe('off')
  expect(await ui.find({ type: 'Text', text: /🐾 off/ })).toBeDefined()
  await ui.press({ key: 'band-pet' })
  expect((await state($)).settings.pet).toBe('mochi')
  await ui.unmount()
})

test('a pet chosen in 0.6.0 under its old name stays chosen', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE, stored: { settings: { pet: 'ibara' } } })
  await $.session.start(START)
  expect((await state($)).settings.pet).toBe('tater')
})

test('/sidekick pet chooses, and refuses what is not a pet', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  const run = async (args: string) => ((await $.command.run({ command: 'sidekick', args, origin: { kind: 'composer' }, presentation: 'inline' } as never)) as { text: string }).text
  expect(await run('pet tater')).toContain('Tater')
  expect((await state($)).settings.pet).toBe('tater')
  expect(await run('pet')).toContain('tater')
  expect(await run('pet hamster')).toContain('Usage')
  expect((await state($)).settings.pet).toBe('tater')
  await run('pet off')
  expect((await state($)).settings.pet).toBe('off')
})

const PET_PANE = {
  plugin: 'sidekick',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'sidekick',
  props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as never

test('the pet comes out above the prompt for a job and goes back in 15 seconds after; the pane keeps it', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate, stored: { settings: { pet: 'tater' } } })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const band = await $.ui.mount(BAND(100, 30))
  const pane = await $.ui.mount(PET_PANE)
  expect(await band.find({ key: 'sk-pet' })).toBeUndefined()
  expect(await pane.find({ key: 'sk-pane-pet-tater' })).toBeDefined()
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  expect(await band.find({ key: 'sk-pet-tater' })).toBeDefined()
  // It stands beside the card and the folded line, and adds no row of its own.
  const tree = (await (band as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
  const within = (n: Node, key: string): Node | undefined =>
    n.props?.key === key ? n : (n.children ?? []).filter((c): c is Node => typeof c !== 'string').map(c => within(c, key)).find(x => x !== undefined)
  const pet = within(tree, 'sk-pet')!
  expect(within(pet, 'sk-card')).toBeDefined()
  expect(within(pet, 'sk-folded')).toBeDefined()
  open()
  await until($, x => x.entries[0]?.status === 'done')
  // The outcome stays up to be read, and the pet with it.
  expect(await band.find({ key: 'sk-pet' })).toBeDefined()
  expect(await band.find({ key: 'sk-card' })).toBeDefined()
  await clock.advance(14_000)
  expect(await band.find({ key: 'sk-pet' })).toBeDefined()
  await clock.advance(1_200)
  expect(await band.find({ key: 'sk-pet' })).toBeUndefined()
  expect(await band.find({ key: 'sk-card' })).toBeUndefined()
  expect(await pane.find({ key: 'sk-pane-pet-tater' })).toBeDefined()
  await band.unmount()
  await pane.unmount()
})

test('the pane fills the space beside the pet with facts the tiles do not show', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE, stored: { settings: { pet: 'tater' } } })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const pane = await $.ui.mount(PET_PANE)
  expect(await pane.find({ type: 'Text', text: /no jobs yet/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /nothing yet/ })).toBeDefined()
  await clock.advance(1_000)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done')
  await clock.advance(125_000)
  expect(await pane.find({ type: 'Text', text: /1 of 1 finished/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 day · best 1/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /✓ commit and push/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /2m ago/ })).toBeDefined()
  await pane.unmount()
})

const PEEK_STEP = { id: 't1', tool: 'Bash', detail: 'bun test --all', status: 'running' as const, isAgent: false, at: 500, endedAt: 0 }

test('peek tells what the session is doing mid-turn, and only tells', async ($, on) => {
  peeks = []
  peekReply = 'It is running the tests.'
  const seen = world(on, { judge: MECHANICAL, worker: DONE, peekSteps: [PEEK_STEP] })
  underBand(on)
  await $.session.start(START)
  const band = await $.ui.mount(BAND(100, 30))
  expect(await band.find({ key: 'sk-peek' })).toBeUndefined()
  await clock.advance(2_000)
  await band.press({ key: 'band-peek' })
  await clock.advance(10)
  expect(await band.find({ type: 'Text', text: /It is running the tests/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /is working/ })).toBeDefined()
  // It saw the call still running, and asked with no way to act.
  expect(String(peeks[0]?.prompt)).toContain('● Bash bun test --all')
  expect(peeks[0]).not.toHaveProperty('tools')
  await band.press({ key: 'peek-steps' })
  expect(await band.find({ type: 'Text', text: /● Bash bun test --all/ })).toBeDefined()
  // Nothing reached the session or started a worker.
  expect(seen.toMain).toEqual([])
  expect(seen.appended).toEqual([])
  expect(seen.resubmitted).toEqual([])
  expect(seen.spawned).toEqual([])
  await band.press({ key: 'peek-close' })
  expect(await band.find({ key: 'sk-peek' })).toBeUndefined()
  await band.unmount()
})

test('peek says so when the call fails', async ($, on) => {
  peeks = []
  peekReply = undefined
  world(on, { judge: MECHANICAL, worker: DONE, peekSteps: [PEEK_STEP] })
  underBand(on)
  await $.session.start(START)
  const band = await $.ui.mount(BAND(100, 30))
  await band.press({ key: 'band-peek' })
  await clock.advance(10)
  expect(await band.find({ type: 'Text', text: /Couldn't get a summary/ })).toBeDefined()
  await band.unmount()
})

test('peek says working from the start of a turn, before any tool call, and idle after it', async ($, on) => {
  peeks = []
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  on('turn.start', () => ({ turnId: 't1' }) as never)
  await $.session.start(START)
  const band = await $.ui.mount(BAND(100, 30))
  await band.press({ key: 'band-peek' })
  await clock.advance(10)
  expect(await band.find({ type: 'Text', text: /is idle/ })).toBeDefined()
  await clock.advance(1_000)
  await $.turn.start({ text: 'think about it', turnId: 't1' })
  await clock.advance(10)
  expect(await band.find({ type: 'Text', text: /is working/ })).toBeDefined()
  await band.unmount()
})

test('with nothing yet, peek says so without a call', async ($, on) => {
  peeks = []
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const band = await $.ui.mount(BAND(100, 30))
  await band.press({ key: 'band-peek' })
  await clock.advance(10)
  expect(await band.find({ type: 'Text', text: /is idle/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Nothing has happened/ })).toBeDefined()
  expect(peeks).toEqual([])
  await band.unmount()
})

test('the pet section of the pane has its own peek button', async ($, on) => {
  peeks = []
  world(on, { judge: MECHANICAL, worker: DONE, stored: { settings: { pet: 'tater' } } })
  underBand(on)
  await $.session.start(START)
  const pane = await $.ui.mount(PET_PANE)
  await pane.press({ key: 'pane-pet-peek' })
  await clock.advance(10)
  expect(await pane.find({ type: 'Text', text: /Nothing has happened/ })).toBeDefined()
  await pane.unmount()
})

test("a judge's answer stays up for 15 seconds when it leaves the message with Claude", async ($, on) => {
  world(on, { judge: NEEDS_MAIN, worker: DONE })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const ui = await $.ui.mount(BAND(100, 30))
  await clock.advance(1_000)
  await $.prompt.submit({ text: 'design the new cache', ...TYPED })
  expect(await ui.find({ key: 'sk-card' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /left with Claude/ })).toBeDefined()
  await clock.advance(14_000)
  expect(await ui.find({ key: 'sk-card' })).toBeDefined()
  await clock.advance(1_200)
  expect(await ui.find({ key: 'sk-card' })).toBeUndefined()
  await ui.unmount()
})

test('the pet chips share the mode row when the panel is wide, saving a row', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND(100, 30))
  await ui.press({ key: 'band-toggle' })
  const tree = (await (ui as unknown as { drawn: () => Promise<unknown> }).drawn()) as Node
  const within = (n: Node, key: string): Node | undefined =>
    n.props?.key === key ? n : (n.children ?? []).filter((c): c is Node => typeof c !== 'string').map(c => within(c, key)).find(x => x !== undefined)
  const row = (within(tree, 'sk-panel')!.children ?? []).filter((c): c is Node => typeof c !== 'string').find(c => within(c, 'mode-auto') !== undefined)!
  expect(within(row, 'pet-mochi')).toBeDefined()
  await ui.unmount()
})

const reviews: string[] = []
const REVIEW = (over: object = {}) => JSON.stringify({ could: true, confidence: 0.9, kind: 'chore', reason: 'Routine git steps.', guidance: 'Pull before tagging.', refines: null, ...over })

function reviewWorld(on: On, reply: string, tools = [{ tool_use_id: '1', tool: 'Bash', input: { command: 'git tag v1' } }], stored: Record<string, unknown> = {}) {
  reviews.length = 0
  const seen = world(on, { judge: NEEDS_MAIN, review: reply, worker: DONE, stored })
  on('session.messages', async () => ({ value: [{ role: 'user', text: 'tag the release', toolUses: [] }, { role: 'assistant', text: '', toolUses: tools }] }) as never)
  underBand(on)
  return { seen }
}

async function finishTurn($: never, prompt = 'tag the release') {
  const api = $ as { session: { start: (x: unknown) => Promise<unknown> }; command: { run: (x: unknown) => Promise<unknown> }; prompt: { submit: (x: unknown) => Promise<unknown> }; turn: { complete: (x: unknown) => Promise<unknown> } }
  await api.session.start(START)
  await api.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' })
  await clock.advance(1_000)
  await api.prompt.submit({ text: prompt, ...TYPED })
  await api.turn.complete({ answer: 'Tagged.', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' })
  // Past the judge's own card, which goes first.
  await clock.advance(16_000)
}

test('a finished main-session job the sidekick could do gets a card; yes teaches it with guidance', async ($, on) => {
  const { seen } = reviewWorld(on, REVIEW())
  await finishTurn($ as never)
  expect(reviews).toHaveLength(1)
  // The review's spend is in this session's history, with its draft judging.
  expect([...seen.store.keys()].some(k => k.startsWith('history:'))).toBe(true)
  expect(storedRows(seen).filter(r => r.kind === 'draft').length).toBe(1)
  expect(seen.toasts.some(t => t.includes('could have done'))).toBe(true)
  const ui = await $.ui.mount(BAND(100, 30))
  expect(await ui.find({ type: 'Text', text: /Teach the sidekick: tag the release/ })).toBeDefined()
  await ui.press({ key: 'card-yes' })
  expect((await state($)).suggestions).toEqual([])
  expect(seen.store.get('missed')).toEqual([{ text: 'tag the release', verdict: 'mechanical', guidance: 'Pull before tagging.' }])
  await ui.unmount()
})

test('no teaches that it stays with Claude; ignore never asks again; either way the card goes', async ($, on) => {
  const { seen } = reviewWorld(on, REVIEW())
  await finishTurn($ as never)
  const ui = await $.ui.mount(BAND(100, 30))
  await ui.press({ key: 'card-ignore' })
  expect((await state($)).suggestions).toEqual([])
  expect(seen.store.get('missed')).toBeUndefined()
  await $.prompt.submit({ text: 'tag the release', ...TYPED })
  await ($ as never as { turn: { complete: (x: unknown) => Promise<unknown> } }).turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(10)
  expect(reviews).toHaveLength(1)
  await ui.unmount()
})

test('no on a new suggestion stays with Claude, and the judge is told', async ($, on) => {
  const { seen } = reviewWorld(on, REVIEW())
  await finishTurn($ as never)
  const ui = await $.ui.mount(BAND(100, 30))
  await ui.press({ key: 'card-no' })
  expect(seen.store.get('missed')).toEqual([{ text: 'tag the release', verdict: 'needs-main' }])
  await ui.unmount()
})

test('a refinement improves the entry in place, and adjust opens it for rewording', async ($, on) => {
  const filled: string[] = []
  const { seen } = reviewWorld(on, REVIEW({ refines: 1 }), undefined, { missed: [{ text: 'tag a release', verdict: 'mechanical', guidance: 'old' }] })
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  await finishTurn($ as never)
  const ui = await $.ui.mount(BAND(100, 30))
  expect(await ui.find({ type: 'Text', text: /Improve the sidekick at/ })).toBeDefined()
  await ui.press({ key: 'card-adjust' })
  await clock.advance(10)
  expect(seen.store.get('missed')).toEqual([{ text: 'tag a release', verdict: 'mechanical', guidance: 'Pull before tagging.', examples: ['tag the release'] }])
  expect(filled).toEqual(['/sidekick teach 1 Pull before tagging.'])
  const run = async (args: string) => ((await $.command.run({ command: 'sidekick', args, origin: { kind: 'composer' }, presentation: 'inline' } as never)) as { text: string }).text
  expect(await run('teach 1 Tag from main only.')).toContain('tag a release')
  expect(seen.store.get('missed')).toEqual([{ text: 'tag a release', verdict: 'mechanical', guidance: 'Tag from main only.', examples: ['tag the release'] }])
  expect(await run('teach 9 x')).toContain('Usage')
  await ui.unmount()
})

test('no review is spent on a job beyond the worker or an interrupted turn', async ($, on) => {
  reviewWorld(on, REVIEW(), [{ tool_use_id: '1', tool: 'Edit', input: {} }])
  await finishTurn($ as never)
  expect(reviews).toEqual([])
  expect((await state($)).suggestions).toEqual([])
  const turn = ($ as never as { turn: { complete: (x: unknown) => Promise<unknown> } }).turn
  await $.prompt.submit({ text: 'tag the release', ...TYPED })
  await turn.complete({ answer: 'x', durationMs: 1, isAborted: true, turnId: 't3', reason: 'aborted' })
  await clock.advance(10)
  expect(reviews).toEqual([])
})

test('beside the open panel an idle pet plays, given the room, and not during a job', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate, stored: { settings: { pet: 'mochi' } } })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  for (const [columns, shows] of [[100, true], [91, true], [90, false]] as const) {
    const ui = await $.ui.mount(BAND(columns, 30))
    if ((await ui.find({ key: 'sk-panel' })) === undefined) await ui.press({ key: 'band-toggle' })
    expect({ columns, shows: (await ui.find({ key: 'sk-panel-pet-mochi' })) !== undefined }).toEqual({ columns, shows })
    await ui.unmount()
  }
  const ui = await $.ui.mount(BAND(100, 30))
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  expect(await ui.find({ key: 'sk-panel-pet-mochi' })).toBeUndefined()
  open()
  await until($, x => x.entries[0]?.status === 'done')
  await ui.unmount()
})

test('a short or narrow band keeps the folded line and leaves the pet out', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate, stored: { settings: { pet: 'mochi' } } })
  underBand(on)
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  for (const [columns, maxRows, shows] of [[100, 6, false], [100, 7, true], [58, 30, false], [59, 30, true]] as const) {
    const ui = await $.ui.mount(BAND(columns, maxRows))
    expect({ columns, maxRows, shows: (await ui.find({ key: 'sk-pet' })) !== undefined }).toEqual({ columns, maxRows, shows })
    expect(await ui.find({ key: 'band-toggle' })).toBeDefined()
    await ui.unmount()
  }
  open()
  await until($, x => x.entries[0]?.status === 'done')
})

test('on an engine before 2.1.308 there is no pet and no chip for one', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE, stored: { settings: { pet: 'mochi' } } })
  underBand(on)
  on('session.version', async () => ({ value: { version: '2.1.300' } }))
  await $.session.start(START)
  const ui = await $.ui.mount(BAND(100, 30))
  expect(await ui.find({ key: 'band-pet' })).toBeUndefined()
  await ui.press({ key: 'band-toggle' })
  expect(await ui.find({ key: 'pet-mochi' })).toBeUndefined()
  await ui.unmount()
})

// ── job handling and figures (trk-at9)

const AUTO = { command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never

/** An entry as an earlier load of the mod left it in the session's state. */
const leftover = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'chore', prompt: `prompt ${id}`, status, locks: ['git:/repo'], backend: 'haiku', createdAt: 100, startedAt: status === 'running' ? 200 : 0, ...extra })

test('two pumps at once start a queued job once: workers finishing together, and prompts judged together', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  // The writes that start a queued job are held back until the test lets them through together,
  // so two pumps that both saw the job queued are both in flight.
  const parked: (() => void)[] = []
  let isParking = false
  const seen = world(on, {
    judge: MECHANICAL,
    worker: DONE,
    workerGate: gate,
    stored: { settings: { maxConcurrent: 2 } },
    beforeWrite: async (was, will) => {
      const isClaim = isParking && will.entries.some(x => x.status === 'running' && (was?.entries ?? []).some(y => y.id === x.id && y.status === 'queued'))
      if (isClaim) await new Promise<void>(resolve => parked.push(resolve))
    },
  })
  await $.session.start(START)
  await $.command.run(AUTO)
  await Promise.all([$.prompt.submit({ text: 'commit and push', ...TYPED }), $.prompt.submit({ text: 'close the bd issue', ...TYPED })])
  await until($, x => x.entries.filter(e => e.status === 'running').length === 2)
  expect(seen.spawned.length).toBe(2)
  // A third waits for a slot; the two running finish together, and each finish pumps.
  await $.prompt.submit({ text: 'tag the release in git', ...TYPED })
  expect((await state($)).entries.filter(e => e.status === 'queued').length).toBe(1)
  isParking = true
  open()
  for (let i = 0; i < 200 && parked.length < 2; i += 1) await clock.advance(10)
  expect(parked.length).toBe(2)
  isParking = false
  for (const release of parked) release()
  await until($, x => x.entries.length === 3 && x.entries.every(e => e.status === 'done'))
  await clock.advance(100)
  expect(seen.spawned.length).toBe(3)
  expect((await state($)).totals.assists).toBe(3)
  expect(storedRows(seen).length).toBe(3)
})

test('a reload leaves no process behind: running and judging entries are settled once, and held prompts go', async ($, on) => {
  const seen = world(on, {
    judge: MECHANICAL,
    worker: DONE,
    seed: {
      mode: 'auto',
      entries: [leftover('old-run', 'running', { workerSpend: { usd: 0.002 } }), leftover('old-judge', 'judging', { locks: [] }), leftover('old-queued', 'queued', { task: 'tag it', locks: ['bd'] })],
      waiting: [{ id: 'w1', text: 'why does the doc mention codex twice?' }],
    },
  })
  // The row the dead job already had, written just before the reload cut it off.
  seen.store.set('history', [{ at: 300, kind: 'chore', status: 'failed', ms: 1, judgeUsd: 0, workerUsd: 0.002, savedUsd: 0, id: 'old-run' }])
  await $.session.start(START)
  const s = await until($, x => x.waiting.length === 0 && x.entries.some(e => e.id === 'old-queued' && e.status !== 'queued'))
  const by = (id: string) => s.entries.find(e => e.id === id)
  expect(by('old-run')?.status).toBe('failed')
  expect(by('old-run')?.outcome?.summary).toMatch(/reload/i)
  expect(by('old-judge')?.status).toBe('failed')
  expect(by('old-judge')?.outcome?.summary).toMatch(/reload/i)
  // The held prompt was released, and the queued job (no process either) was started afresh.
  expect(seen.resubmitted).toEqual(['why does the doc mention codex twice?'])
  expect(seen.spawned.length).toBe(1)
  await until($, x => by('old-queued') !== undefined && x.entries.find(e => e.id === 'old-queued')?.status === 'done')
  // One failed job counted once; the row it already had is not doubled, and the queued job's is its own.
  const rows = storedRows(seen)
  expect(rows.filter(r => r.id === 'old-run').length).toBe(1)
  expect(rows.filter(r => r.id === 'old-judge').length).toBe(0)
  expect((await state($)).totals.failed).toBe(1)
  expect((await state($)).totals.assists).toBe(2)
  // A second start (another reload) finds nothing more to settle.
  await $.session.start(START)
  expect((await state($)).totals.assists).toBe(2)
  expect(storedRows(seen).filter(r => r.id === 'old-run').length).toBe(1)
})

test('a reload settles a job that never wrote a row once, and frees its locks for the next chore', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE, seed: { mode: 'auto', entries: [leftover('old-run', 'running', { workerSpend: { usd: 0.002 } })] } })
  await $.session.start(START)
  await until($, x => x.entries[0]?.status === 'failed')
  const rows = storedRows(seen).filter(r => r.id === 'old-run')
  expect(rows.map(r => r.status)).toEqual(['failed'])
  expect(rows[0]?.workerUsd).toBe(0.002)
  // The dead job held the repository's lock; a new chore starts at once.
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries.some(e => e.id !== 'old-run' && e.status === 'done'))
})

test('a job with a live process is not settled when the module starts again', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate })
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  await $.session.start(START)
  expect((await state($)).entries[0]?.status).toBe('running')
  open()
  await until($, x => x.entries[0]?.status === 'done')
})

test('a prompt whose judgment outlasts the last assist goes straight to main: nothing would release it', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const w: World = { judge: MECHANICAL, worker: DONE, workerGate: gate }
  const seen = world(on, w)
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  // The next message is judged slowly; the assist ends while the judge is still thinking.
  w.judge = NEEDS_MAIN
  w.judgeDelayMs = 1
  const pending = $.prompt.submit({ text: 'rename the judge function', ...TYPED })
  await clock.advance(20)
  open()
  await until($, x => x.entries.some(e => e.prompt === 'commit and push' && e.status === 'done'))
  seen.release()
  const result = await pending
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['rename the judge function'])
  await clock.advance(100)
  expect((await state($)).waiting).toEqual([])
})

test('a prompt added as the held ones are released is not lost with them', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  // The write that takes the held prompts out waits, so another prompt can be added while it does.
  const parked: (() => void)[] = []
  let isParking = false
  const w: World = {
    judge: MECHANICAL,
    worker: DONE,
    workerGate: gate,
    beforeWrite: async (was, will) => {
      if (isParking && (was?.waiting.length ?? 0) > 0 && will.waiting.length === 0) await new Promise<void>(resolve => parked.push(resolve))
    },
  }
  const seen = world(on, w)
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  const held = await $.prompt.submit({ text: 'why does the stage-2 doc mention codex twice?', ...TYPED })
  expect(held.drop).toContain('held for Claude')
  // Another message, judged slowly, is on its way to being held too.
  w.judge = NEEDS_MAIN
  w.judgeDelayMs = 1
  const second = $.prompt.submit({ text: 'rename the judge function', ...TYPED })
  await clock.advance(20)
  isParking = true
  open()
  for (let i = 0; i < 200 && parked.length < 1; i += 1) await clock.advance(10)
  expect(parked.length).toBe(1)
  seen.release()
  await second
  isParking = false
  for (const release of parked) release()
  await until($, x => x.entries.find(e => e.prompt === 'commit and push')?.status === 'done')
  await clock.advance(100)
  const reached = [...seen.resubmitted, ...seen.toMain.map(p => p.text)]
  expect(reached.sort()).toEqual(['rename the judge function', 'why does the stage-2 doc mention codex twice?'])
  expect((await state($)).waiting).toEqual([])
})

test('a prompt with an attachment is not held: the engine cannot carry it to a resubmit, so it goes to main, and says so', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const seen = world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate })
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  const result = await $.prompt.submit({ text: 'why does this screenshot look wrong?', attachments: [{ type: 'image', id: 'img-1' }], ...TYPED })
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['why does this screenshot look wrong?'])
  expect((await state($)).waiting).toEqual([])
  expect(seen.logs.some(line => /attachment/i.test(line) && /not held/i.test(line))).toBe(true)
  open()
  await until($, x => x.entries.find(e => e.prompt === 'commit and push')?.status === 'done')
})

test('the entry list keeps a running job however many finish after it', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const w: World = { judge: MECHANICAL, worker: DONE, workerGate: gate }
  world(on, w)
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  // The job is the oldest entry; 60 messages for Claude come after it.
  w.judge = NEEDS_MAIN
  for (let i = 0; i < 60; i += 1) await $.prompt.submit({ text: `rename function number ${i}`, ...TYPED })
  const s = await state($)
  expect(s.entries.length).toBe(60)
  const job = s.entries.find(e => e.prompt === 'commit and push')
  expect(job?.status).toBe('running')
  // The oldest finished one went instead.
  expect(s.entries.some(e => e.prompt === 'rename function number 0')).toBe(false)
  open()
  await until($, x => x.entries.find(e => e.prompt === 'commit and push')?.status === 'done')
})

test('the session breakdown counts its own draft judging and reviews, and COST matches what it shows', async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  await $.session.start(START)
  await $.command.run(AUTO)
  const typing = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await typing.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'rename the judge function' })
  await clock.advance(500)
  await until($, () => storedRows(seen).some(r => r.kind === 'draft'))
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  await ui.press({ key: 'tab-session' })
  const call = usd(tallyOf('haiku', { input_tokens: 1000, output_tokens: 1 }).usd)
  // The draft's one judge call shows in the draft judging row, not only in COST.
  expect(await ui.find({ type: 'Text', text: new RegExp(`^ +${call.replace('$', '\\$')}$`) })).toBeDefined()
  await ui.unmount()
})

test('everything the session spent reaches the history once: warm-up, draft, job; and done counts only the job', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  await $.session.start(START)
  await clock.advance(50_000)
  await $.command.run(AUTO)
  const typing = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await typing.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'commit and push' })
  await clock.advance(500)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  const s = await until($, x => x.entries[0]?.status === 'done' && x.today.done === 1)
  await clock.advance(100)
  const rows = storedRows(seen)
  const recorded = rows.reduce((n, r) => n + r.judgeUsd + r.workerUsd, 0)
  expect(Math.abs(recorded - (await state($)).spend.usd)).toBeLessThan(1e-12)
  expect(s.today.done).toBe(1)
  // The warm-up is not a draft that was judged: it adds money to draft judging, not a count.
  expect((await state($)).today.drafts).toBe(1)
  expect(rows.filter(r => r.kind === 'draft').reduce((n, r) => n + r.judgeUsd, 0)).toBeGreaterThan(tallyOf('haiku', { input_tokens: 1000, output_tokens: 1 }).usd)
})

test('shadow judging is in the history too, and counts no job', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ ...AUTO, args: 'shadow' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'shadow')
  await clock.advance(100)
  const recorded = storedRows(seen).reduce((n, r) => n + r.judgeUsd + r.workerUsd, 0)
  expect(recorded).toBeGreaterThan(0)
  expect(Math.abs(recorded - (await state($)).spend.usd)).toBeLessThan(1e-12)
  expect((await state($)).today.done).toBe(0)
  expect(storedRows(seen).some(r => r.kind === 'chore' || r.kind === 'to-claude')).toBe(false)
})

test('the session tab survives a reload past 60 jobs: it counts the session, not the entries still listed', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE, seed: { mode: 'auto', session: 'session-a', entries: [] } })
  await clock.set(Date.UTC(2026, 9, 14, 12))
  const now = clock.now()
  // 70 jobs of this session (state keeps 60 entries; the rest only the history remembers) and one of another.
  const mine = Array.from({ length: 70 }, (_, i) => chore(now, 60_000 + i, `mine-${i}`))
  seen.store.set('history:session-a', mine)
  seen.store.set('history:session-b', [chore(now, 1000, 'theirs')])
  await $.session.start(START)
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  await ui.press({ key: 'tab-session' })
  expect(await ui.find({ type: 'Text', text: /70 chores · 0 looks/ })).toBeDefined()
  await ui.press({ key: 'tab-today' })
  expect(await ui.find({ type: 'Text', text: /71 chores · 0 looks/ })).toBeDefined()
  await ui.unmount()
})

test('state written before sessions had an identity gains one, and keeps the jobs it listed', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE, seed: { mode: 'auto', entries: [leftover('e1', 'done', { locks: [] })] } })
  await clock.set(Date.UTC(2026, 9, 14, 12))
  const now = clock.now()
  // An older load recorded these in the shared history, and listed one of them as this session's entry.
  seen.store.set('history', [chore(now, 5000, 'e1'), chore(now, 4000, 'someone-else')])
  await $.session.start(START)
  const s = await state($)
  expect(typeof s.session).toBe('string')
  expect(s.session).not.toBe('')
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  await ui.press({ key: 'tab-session' })
  expect(await ui.find({ type: 'Text', text: /(^|\D)1 chores · 0 looks/ })).toBeDefined()
  await ui.press({ key: 'tab-today' })
  // Counted once in the day, not once for each place it is kept.
  expect(await ui.find({ type: 'Text', text: /(^|\D)2 chores · 0 looks/ })).toBeDefined()
  await ui.unmount()
})

test("another session's history is never overwritten by this one's writes, and both count", async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const seen = world(on, { judge: MECHANICAL, worker: DONE, workerGate: gate })
  await clock.set(Date.UTC(2026, 9, 14, 12))
  const now = clock.now()
  const theirs = [chore(now, 1000, 'theirs-1')]
  seen.store.set('history:session-b', theirs)
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  // The other session finishes a job while this one's is mid-flight: it writes its own history.
  seen.store.set('history:session-b', [...theirs, chore(now, 0, 'theirs-2')])
  open()
  await until($, x => x.entries[0]?.status === 'done' && x.today.done === 3)
  expect(storedRows(seen).filter(r => r.kind !== 'draft').map(r => r.id).sort()).toEqual([(await state($)).entries[0]!.id, 'theirs-1', 'theirs-2'].sort())
})

test('a history write the store lost is made again', async ($, on) => {
  const lost = { count: 2 }
  const seen = world(on, { judge: MECHANICAL, worker: DONE, losesWrites: lost })
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done' && x.today.done === 1)
  expect(lost.count).toBe(0)
  expect(storedRows(seen).filter(r => r.kind === 'chore').length).toBe(1)
})

test('send now pressed as the held prompts are released sends the prompt once', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  // Every write that takes held prompts out waits, so the release and the press are both in flight.
  const parked: (() => void)[] = []
  let isParking = false
  const seen = world(on, {
    judge: MECHANICAL,
    worker: DONE,
    workerGate: gate,
    beforeWrite: async (was, will) => {
      if (isParking && (was?.waiting.length ?? 0) > 0 && will.waiting.length === 0) await new Promise<void>(resolve => parked.push(resolve))
    },
  })
  await $.session.start(START)
  await $.command.run(AUTO)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'running')
  await $.prompt.submit({ text: 'why does the stage-2 doc mention codex twice?', ...TYPED })
  const held = (await state($)).waiting[0]!
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  isParking = true
  open()
  for (let i = 0; i < 200 && parked.length < 1; i += 1) await clock.advance(10)
  await ui.press({ key: `send-${held.id}` })
  for (let i = 0; i < 50 && parked.length < 2; i += 1) await clock.advance(10)
  isParking = false
  for (const release of parked) release()
  await until($, x => x.entries.find(e => e.prompt === 'commit and push')?.status === 'done' && x.waiting.length === 0)
  await clock.advance(100)
  await ui.unmount()
  expect(seen.resubmitted).toEqual(['why does the stage-2 doc mention codex twice?'])
})

test('a judge call that answers after its budget is in the history, so the history adds up to the session spend', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, judgeDelayMs: 8_000, worker: DONE })
  await $.session.start(START)
  await $.command.run(AUTO)
  const pending = $.prompt.submit({ text: 'push it', ...TYPED })
  await clock.advance(5_000)
  const result = await pending
  expect(result.drop).toBeUndefined()
  expect((await state($)).entries[0]?.reason).toBe('judge timed out')
  // The judge answers late: its money is spent, and no entry carries it.
  seen.release()
  await until($, x => x.spend.usd > 0)
  await clock.advance(100)
  const recorded = storedRows(seen).reduce((n, r) => n + r.judgeUsd + r.workerUsd, 0)
  expect(recorded).toBeGreaterThan(0)
  expect(Math.abs(recorded - (await state($)).spend.usd)).toBeLessThan(1e-12)
  // It is money in draft judging; it makes no job.
  expect((await state($)).today.done).toBe(0)
})

// ── round 2

test('a reload with only a queued job, or only held prompts, still moves them', async ($, on) => {
  const seen = world(on, {
    judge: MECHANICAL,
    worker: DONE,
    seed: { mode: 'auto', entries: [leftover('q1', 'queued', { task: 'tag it', locks: ['bd'] })], waiting: [{ id: 'w1', text: 'why does the doc mention codex twice?' }] },
  })
  await $.session.start(START)
  // Nothing was running or judging; the queue and the held prompt still go.
  await until($, x => x.entries.find(e => e.id === 'q1')?.status === 'done' && x.waiting.length === 0)
  expect(seen.spawned.length).toBe(1)
  expect(seen.resubmitted).toEqual(['why does the doc mention codex twice?'])
})

test('a reload with only held prompts releases them', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE, seed: { mode: 'auto', entries: [], waiting: [{ id: 'w1', text: 'why does the doc mention codex twice?' }] } })
  await $.session.start(START)
  await until($, x => x.waiting.length === 0)
  expect(seen.resubmitted).toEqual(['why does the doc mention codex twice?'])
})

test("another session's history is kept unless it is long idle, and a write that lands as it is judged idle keeps it", async ($, on) => {
  let armed = false
  let reads = 0
  const seen = world(on, {
    judge: MECHANICAL,
    worker: DONE,
    beforeGet: key => {
      if (!armed || key !== 'history:ancient') return
      reads += 1
      // The session wakes and writes between the first read (judged idle) and the read before deleting.
      if (reads === 2) seen.store.set('history:ancient', [chore(clock.now(), 0, 'woke')])
    },
  })
  await clock.set(Date.UTC(2026, 9, 14, 12))
  const now = clock.now()
  seen.store.set('history:idle-40-days', [chore(now, 40 * DAY, 'a')])
  seen.store.set('history:ancient', [chore(now, 200 * DAY, 'b')])
  seen.store.set('history:ancient-2', [chore(now, 200 * DAY, 'c')])
  await $.session.start(START)
  await $.command.run(AUTO)
  armed = true
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done')
  await clock.advance(100)
  // 40 days is past what is shown, not past what is trusted gone.
  expect(seen.store.has('history:idle-40-days')).toBe(true)
  // The long-idle one that stayed idle goes; the one that woke does not.
  expect(seen.store.has('history:ancient-2')).toBe(false)
  expect((seen.store.get('history:ancient') as { id: string }[]).map(r => r.id)).toEqual(['woke'])
})

test("a job given to main in its session's key stays given, whichever key is read first", async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await clock.set(Date.UTC(2026, 9, 14, 12))
  const now = clock.now()
  const done = chore(now, 5000, 'migrated')
  // The shared key is listed first: its stale copy says done and saved; the session's own key says given.
  seen.store.set('history', [done])
  seen.store.set('history:session-a', [{ ...done, status: 'given', savedUsd: 0 }])
  await $.session.start(START)
  const s = await until($, x => x.today.costUsd > 0)
  expect(s.today.done).toBe(0)
  expect(s.today.savedUsd).toBe(0)
})

test('a judge reply that lands just before the deadline is recorded once, though its spend is counted after it', async ($, on) => {
  const parked: (() => void)[] = []
  let isParking = false
  const seen = world(on, {
    judge: MECHANICAL,
    judgeDelayMs: 4_000,
    worker: DONE,
    beforeWrite: async (was, will) => {
      // The write that counts the reply's spend waits, across the deadline.
      if (isParking && will.spend.usd > (was?.spend.usd ?? 0)) await new Promise<void>(resolve => parked.push(resolve))
    },
  })
  await $.session.start(START)
  await $.command.run(AUTO)
  const pending = $.prompt.submit({ text: 'push it', ...TYPED })
  await clock.advance(10)
  isParking = true
  seen.release()
  for (let i = 0; i < 20 && parked.length < 1; i += 1) await clock.advance(10)
  expect(parked.length).toBe(1)
  await clock.advance(5_000)
  const result = await pending
  expect(result.drop).toBeUndefined()
  expect((await state($)).entries[0]?.reason).toBe('judge timed out')
  isParking = false
  for (const release of parked) release()
  await until($, x => x.spend.usd > 0)
  await clock.advance(100)
  const recorded = storedRows(seen).reduce((n, r) => n + r.judgeUsd + r.workerUsd, 0)
  expect(Math.abs(recorded - (await state($)).spend.usd)).toBeLessThan(1e-12)
})

// ── trk-17a: the whole answer

const LONG_ANSWER = `${Array.from({ length: 3 }, (_, i) => `- bullet ${i + 1}: ${'detail '.repeat(60)}`).join('\n')}\nEND-OF-ANSWER`
const LONG_DONE = JSON.stringify({ status: 'done', summary: LONG_ANSWER, commands: [], shas: [], changed: [], uncertain: [], needsMain: '' })

test('a worker answer over 400 characters is whole in the job view and the record; the chat line says it is shortened', async ($, on) => {
  const seen = world(on, { judge: INVESTIGATE, worker: LONG_DONE })
  await $.session.start(START)
  await $.command.run(AUTO)
  await withInstructions($ as never)
  await $.prompt.submit({ text: 'acme-bot stopped replying, summarize why in three bullets', ...TYPED })
  const s = await until($, x => x.entries[0]?.status === 'done')
  expect(s.entries[0]?.outcome?.summary).toBe(LONG_ANSWER)
  expect(seen.written[0]?.text).toContain('END-OF-ANSWER')
  const chat = seen.logs.find(line => line.startsWith('✓'))!
  expect(chat).not.toContain('END-OF-ANSWER')
  expect(chat).toContain(s.entries[0]!.dump)
  const ui = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    props: { title: 'Sidekick', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  await openJob(ui, s.entries[0]?.id)
  expect(await ui.find({ type: 'Text', text: /END-OF-ANSWER/ })).toBeDefined()
  await ui.unmount()
  // The main session's note says it was shortened, and points to the record.
  expect(seen.appended.at(-1)).toContain('[shortened')
  expect(seen.appended.at(-1)).toContain('full answer in the record')
})

// ── trk-547

const paneProps = (columns = 100) =>
  ({ plugin: 'sidekick', surface: 'terminal', component: 'Pane', requestId: 'sidekick', props: { title: 'Sidekick', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } }) as never

test("a job handed to the sidekick shows the judge's reason in chat, in the job view and on the band's card", async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  world(on, { judge: 'mechanical: commits and pushes the checked-out branch', worker: DONE, workerGate: gate })
  underBand(on)
  await $.session.start(START)
  await $.command.run(AUTO)
  const result = await $.prompt.submit({ text: 'commit and push', ...TYPED })
  expect(result.drop).toContain('commits and pushes the checked-out branch')
  const s = await until($, x => x.entries[0]?.status === 'running')
  expect(s.entries[0]?.reason).toBe('commits and pushes the checked-out branch')
  const band = await $.ui.mount(BAND(100, 30))
  expect(await band.find({ type: 'Text', text: /commits and pushes the checked-out branch/ })).toBeDefined()
  await band.unmount()
  open()
  await until($, x => x.entries[0]?.status === 'done')
  const ui = await $.ui.mount(paneProps())
  await openJob(ui, s.entries[0]?.id)
  expect(await ui.find({ type: 'Text', text: /commits and pushes the checked-out branch/ })).toBeDefined()
  await ui.unmount()
})

test("a message left with Claude shows the judge's reason in chat, the pane and the band; the bare word still routes", async ($, on) => {
  const seen = world(on, { judge: 'needs-main: renames a function, which is a code change', worker: DONE })
  underBand(on)
  await $.session.start(START)
  await $.command.run(AUTO)
  const band = await $.ui.mount(BAND(100, 30))
  await clock.advance(1_000)
  await $.prompt.submit({ text: 'rename the judge function', ...TYPED })
  expect(seen.logs.some(line => line.startsWith('→ to Claude: renames a function, which is a code change'))).toBe(true)
  expect(await band.find({ type: 'Text', text: /renames a function, which is a code change/ })).toBeDefined()
  await band.unmount()
  const ui = await $.ui.mount(paneProps())
  expect(await ui.find({ type: 'Text', text: /renames a function, which is a code change/ })).toBeDefined()
  await ui.unmount()
})

test('a message the precheck keeps from the judge shows why: in chat, the pane and the band, with no judge call and no figures', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  underBand(on)
  await $.session.start(START)
  await $.command.run(AUTO)
  const band = await $.ui.mount(BAND(100, 30))
  await clock.advance(1_000)
  await $.prompt.submit({ text: 'why does the stage-2 doc mention codex twice?', ...TYPED })
  expect(seen.judged).toBe(0)
  expect(seen.logs).toContain('→ to Claude: asks for reasoning, which stays with Claude')
  const s = await state($)
  expect(s.entries[0]).toMatchObject({ status: 'passed', reason: 'asks for reasoning, which stays with Claude' })
  // Nothing was judged, so nothing is counted as a judged pass.
  expect(s.totals.passed).toBe(0)
  expect(storedRows(seen).some(r => r.kind === 'to-claude')).toBe(false)
  expect(await band.find({ type: 'Text', text: /asks for reasoning, which stays with Claude/ })).toBeDefined()
  await band.unmount()
  const ui = await $.ui.mount(paneProps())
  expect(await ui.find({ type: 'Text', text: /asks for reasoning, which stays with Claude/ })).toBeDefined()
  await ui.unmount()
})

test('a review that says no, is unsure, or fails leaves a line in the pane, and no card', async ($, on) => {
  reviewWorld(on, REVIEW({ could: false, reason: 'It needed the plan from earlier.' }))
  await finishTurn($ as never)
  expect(reviews).toHaveLength(1)
  expect((await state($)).suggestions).toEqual([])
  const s = await state($)
  expect(s.reviews.map(r => r.outcome)).toEqual(['no'])
  expect(s.reviews[0]).toMatchObject({ prompt: 'tag the release', detail: 'It needed the plan from earlier.' })
  const ui = await $.ui.mount(paneProps())
  expect(await ui.find({ type: 'Text', text: /no · tag the release · It needed the plan from earlier\./ })).toBeDefined()
  await ui.unmount()
})

test('a review under 0.7 confidence shows its number, and a failed review says it failed', async ($, on) => {
  reviewWorld(on, REVIEW({ confidence: 0.55, reason: 'Probably routine.' }))
  await finishTurn($ as never)
  const low = await state($)
  expect(low.suggestions).toEqual([])
  expect(low.reviews[0]).toMatchObject({ outcome: 'low', detail: '0.55 · Probably routine.' })
  const ui = await $.ui.mount(paneProps())
  expect(await ui.find({ type: 'Text', text: /low confidence · tag the release · 0\.55/ })).toBeDefined()
  await ui.unmount()
})

test('a review whose call failed is told apart from a no', async ($, on) => {
  reviewWorld(on, 'this is not json')
  await finishTurn($ as never)
  const s = await state($)
  expect(s.reviews[0]).toMatchObject({ outcome: 'failed', detail: 'the reply was not readable' })
  const ui = await $.ui.mount(paneProps())
  expect(await ui.find({ type: 'Text', text: /failed · tag the release · the reply was not readable/ })).toBeDefined()
  await ui.unmount()
})

test('/sidekick task runs beside the main session, without holding what is typed to it', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  const said = await $.command.run({ command: 'sidekick', args: 'task commit a.txt', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  expect(String(said.text)).toContain('side task')
  expect(seen.toMain).toEqual([])
  const s = await until($, x => x.entries[0]?.status === 'done')
  expect(s.entries[0]?.isSide).toBe(true)
  expect(seen.spawned[0]?.join(' ')).toContain('sidekick-guard side')
})

test('/sidekick task with nothing to do says how to use it', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  const said = await $.command.run({ command: 'sidekick', args: 'task', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  expect(String(said.text)).toContain('Usage: /sidekick task')
})
