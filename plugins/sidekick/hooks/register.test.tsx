import { test, expect, mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SidekickState } from '../types'

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
}

/** The engine beneath the mod: answers every call it makes and records what it did. */
function world(on: On, w: World) {
  clock = mock.clock(on)
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
    judged: 0,
    judgments: [] as string[],
    status: [] as (string | undefined)[],
    release: () => release(),
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('env.get', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', async (_$, e) => {
    seen.notified.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.toast', async () => ({ value: undefined }))
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
    const out = e.argv.includes('rev-parse') ? '/repo\n' : '## main...origin/main\n M a.txt\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', async ($, e) => {
    seen.judged += 1
    if (e.prompt.includes('<message>')) seen.judgments.push(e.prompt)
    if (w.judgeDelayMs !== undefined) await slow
    return { value: { isAnswered: true, text: w.judge, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('process.spawn', async function* (_$, e) {
    seen.spawned.push([...e.argv])
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
  const seen = world(on, { judge: MECHANICAL, judgeDelayMs: 5_000, worker: DONE })
  await $.session.start(START)
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  const pending = $.prompt.submit({ text: 'push it', ...TYPED })
  await clock.advance(1_800)
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
    expect(await ui.find({ type: 'Text', text: /✓ commit and push/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▌ DONE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /caching saved/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Committed 3f2a91c/ })).toBeDefined()
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

test('the band shows while on and stacks above the band beneath it', async ($, on) => {
  world(on, { judge: MECHANICAL, worker: DONE })
  // Another plugin's band, beneath this one.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  await $.session.start(START)
  const BAND = { plugin: 'sidekick', component: 'AbovePrompt', props: { bodyColumns: 100, hasSurvey: false, view: {} } } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const off = await $.ui.mount({ ...(BAND as object), surface } as never)
    expect(await off.find({ type: 'Text', text: /◆ sidekick/ })).toBeUndefined()
    expect(await off.find({ type: 'Text', text: /other band/ })).toBeDefined()
    await off.unmount()
  }
  await $.command.run({ command: 'sidekick', args: 'auto', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...(BAND as object), surface } as never)
    expect(await ui.find({ type: 'Text', text: /◆ sidekick/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / AUTO / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /other band/ })).toBeDefined()
    await ui.unmount()
  }
})
