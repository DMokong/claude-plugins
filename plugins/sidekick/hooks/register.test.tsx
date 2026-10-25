import { test, expect, mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SidekickState } from '../types'
import { tallyOf } from './lib/cost'

let clock: MockClock
/** The mod's state as it last wrote it, seen from beneath. */
let latest: SidekickState | undefined

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const STATE = { plugin: 'sidekick', key: 'sidekick' } as const
const TYPED = { origin: { kind: 'composer' }, wait: false } as const

type World = {
  /** What the judge model replies; a number delays the reply by that many ms first. */
  judge: string
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
}

/** The engine beneath the mod: answers every call it makes and records what it did. */
function world(on: On, w: World) {
  clock = mock.clock(on)
  // The mod's store, as a map the test can read and change (another session's write, say).
  const store = new Map<string, unknown>(Object.entries(w.stored ?? {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  on('store.get', async (_$, e) => ({ value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }))
  on('store.set', async (_$, e) => {
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
  on('state.set', async (_$, e, next) => {
    if (e.plugin === 'sidekick' && e.key === 'sidekick') latest = e.value as SidekickState
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
  expect(result.drop?.startsWith('❯ commit and push')).toBe(true)
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
  await until($, x => x.entries[0]?.status === 'done' && x.waiting.length === 0)
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
  const seen = world(on, { judge: INVESTIGATE, worker: LOOKED })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'shadow', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'check the acme-bot logs', ...TYPED })
  const s = await until($, x => x.entries[0]?.status === 'shadow')
  expect(s.entries[0]?.reason).toContain('would investigate: check the acme-bot logs')
  expect(seen.spawned).toEqual([])
})

test('shadow judges and logs, but everything still goes to main', async ($, on) => {
  const seen = world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'shadow', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const result = await $.prompt.submit({ text: 'commit and push', ...TYPED })
  expect(result.drop).toBeUndefined()
  expect(seen.toMain.map(p => p.text)).toEqual(['commit and push'])
  const s = await until($, x => x.entries[0]?.status === 'shadow')
  expect(s.entries[0]?.reason).toContain('would hand off: commit and push')
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
  expect((await state($)).settings).toEqual({ judgeModel: 'haiku', workerModel: 'haiku', investigations: true, draftJudging: true, notifications: true, maxConcurrent: 1 })
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
  const mid = await $.ui.mount(BAND(60))
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
  const rows = seen.store.get('history') as { kind: string; status: string; savedUsd: number; id: string }[]
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
  expect((seen.store.get('history') as { status: string }[])[0]?.status).toBe('given')
})

test('a pass to Claude is kept in the history too', async ($, on) => {
  const seen = world(on, { judge: NEEDS_MAIN, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'rename the judge function', ...TYPED })
  expect((seen.store.get('history') as { kind: string }[]).map(r => r.kind)).toEqual(['to-claude'])
})

test('the dashboard tabs pick the span, and a narrow pane stacks the tiles', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await $.prompt.submit({ text: 'commit and push', ...TYPED })
  await until($, x => x.entries[0]?.status === 'done' && x.today.done === 1)
  const pane = (columns: number) =>
    $.ui.mount({
      plugin: 'sidekick',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidekick',
      props: { title: 'Sidekick', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
  const ui = await pane(100)
  for (const tab of ['week', 'session', 'today'] as const) {
    await ui.press({ key: `tab-${tab}` })
    expect((await state($)).tab).toBe(tab)
    // One chore in every span: the DONE tile draws a 1.
    expect(await ui.find({ type: 'Text', text: /^ {2}╷ $/ })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /1 chores · 0 looks/ })).toBeDefined()
  await ui.unmount()
  const narrow = await pane(50)
  const drawn = JSON.stringify(await (narrow as unknown as { drawn: () => Promise<unknown> }).drawn())
  // Stacked: the tiles sit in a column, DONE above SAVED.
  expect(drawn.indexOf('"DONE"')).toBeLessThan(drawn.indexOf('"SAVED"'))
  expect(drawn).toContain('"flexDirection":"column"')
  await narrow.unmount()
  const tiny = await pane(30)
  // Too narrow for segment digits: plain numbers.
  expect(await tiny.find({ type: 'Text', text: /^1$/ })).toBeDefined()
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
  await until($, () => Array.isArray(seen.store.get('history')))
  await $.prompt.submit({ text: 'rename the judge', ...TYPED })
  const rows = seen.store.get('history') as { kind: string; judgeUsd: number }[]
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
  expect((seen.store.get('history') as unknown[]).length).toBe(2)
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
