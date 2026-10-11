import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

type Agent = { pane_id: string; agent: string; agent_status: string; terminal_title_stripped: string; tab_id?: string; workspace_id?: string; cwd?: string; name?: string }

const ENV = { HERDR_ENV: '1', HERDR_PANE_ID: 'wE:p1', HOME: '/home/me' }
const REGISTRY_DIR = '/home/me/.local/state/herdr-jutsu'
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const reg = (name: string, pane_id: string, issue = '') =>
  JSON.stringify({ name, kind: 'codex', issue, pane_id, parent_pane: 'wE:p1' })

type World = {
  agents: Agent[]
  registry: string
  herdrFails?: boolean
  stream?: string
  env: Record<string, string>
}

/**
 * The world beneath the mod: herdr's answer, the registry file, one stream, the environment,
 * and a bottom for every engine call the mod reaches. Returns what the mod did to it.
 */
function world(on: On, state: World) {
  const seen = {
    toasts: [] as string[],
    status: [] as (string | undefined)[],
    spoken: [] as string[],
    registered: [] as string[],
    opened: [] as string[],
    envAsked: [] as string[],
    herdrCalls: 0,
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('env.get', async (_$, e) => {
    seen.envAsked.push(e.name)
    return { value: state.env[e.name] }
  })
  on('process.run', async (_$, e) => {
    const command = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // The two read-only listings that say where a pane is shown. They do not count as polls.
    if (command === 'herdr tab list') {
      return ok(JSON.stringify({ result: { tabs: [{ tab_id: 'wE:t2', label: '2', focused: true }, { tab_id: 'wA:t1', label: '1', focused: false }] } }))
    }
    if (command === 'herdr workspace list') {
      return ok(JSON.stringify({ result: { workspaces: [{ workspace_id: 'wE', label: 'DOCS' }, { workspace_id: 'wA', label: 'data' }] } }))
    }
    if (command !== 'herdr agent list') throw new Error(`not a read-only herdr listing: ${command}`)
    seen.herdrCalls += 1
    return {
      value: {
        exitCode: state.herdrFails ? 1 : 0,
        stdout: state.herdrFails ? '' : JSON.stringify({ result: { agents: state.agents } }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('fs.exists', async (_$, e) => ({ value: e.path === REGISTRY_DIR }))
  on('fs.list', async (_$, e) => {
    const file = (name: string, mtimeMs: number) => ({ name, kind: 'file' as const, size: 1, mtimeMs, isLink: false })
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false })
    if (e.path === REGISTRY_DIR) return { value: [file('c.jsonl', state.registry.length)] }
    if (e.path === '/repo/docs/fable-streams') return { value: state.stream === undefined ? [] : [dir('s1')] }
    if (e.path === '/repo/docs/fable-streams/s1') return { value: [file('stream.md', 1)] }
    return { value: [] }
  })
  on('fs.read', async (_$, e) => {
    if (e.path === `${REGISTRY_DIR}/c.jsonl`) return { value: state.registry }
    if (e.path === '/repo/docs/fable-streams/s1/stream.md') return { value: state.stream ?? '' }
    throw new Error(`unexpected read: ${e.path}`)
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', async () => ({ value: [] }))
  on('ui.open', async (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('audio.speak', async (_$, e) => {
    seen.spoken.push(e.text)
    return { value: { via: 'system' } }
  })
  return seen
}

const working: Agent = { pane_id: 'wE:p2', agent: 'codex', agent_status: 'working', terminal_title_stripped: 'impl-01', tab_id: 'wE:t2', workspace_id: 'wE', cwd: '/home/me/projects/exampleapp' }

test('the status line shows the crew after the first poll', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: ENV })
  await $.session.start(START)
  await clock.advance(0)
  expect(seen.status[seen.status.length - 1]).toBe('crew 1 working')
})

test('a member that blocks raises one toast, and speaks only when asked', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const state: World = { agents: [working], registry: reg('impl-01', 'wE:p2'), env: ENV }
  const seen = world(on, state)
  await $.session.start(START)
  await clock.advance(0)
  state.agents = [{ ...working, agent_status: 'blocked' }]
  await clock.advance(10_000)
  await clock.advance(10_000)
  expect(seen.toasts.filter(t => t === 'impl-01 is blocked')).toHaveLength(1)
  expect(seen.spoken).toHaveLength(0)
  expect(seen.status[seen.status.length - 1]).toBe('crew 1 blocked')
})

test('with speak on, a blocked member is spoken', { options: { speak: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, {
    agents: [{ ...working, agent_status: 'blocked' }],
    registry: reg('impl-01', 'wE:p2'),
    env: ENV,
  })
  await $.session.start(START)
  await clock.advance(0)
  expect(seen.spoken).toEqual(['impl-01 is blocked'])
})

test('herdr failing keeps the last crew and never throws', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const state: World = { agents: [working], registry: reg('impl-01', 'wE:p2'), env: ENV }
  const seen = world(on, state)
  await $.session.start(START)
  await clock.advance(0)
  const calls = seen.herdrCalls
  state.herdrFails = true
  await clock.advance(10_000)
  expect(seen.herdrCalls).toBe(calls + 1)
  expect(seen.status[seen.status.length - 1]).toBe('crew 1 working')
  expect(seen.toasts).toHaveLength(0)
})

test('with an empty crew the mod polls once a minute, not every ten seconds', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [], registry: '', env: ENV })
  await $.session.start(START)
  await clock.advance(0)
  const after = seen.herdrCalls
  expect(after).toBe(1)
  await clock.advance(50_000)
  expect(seen.herdrCalls).toBe(after)
  await clock.advance(10_000)
  expect(seen.herdrCalls).toBe(after + 1)
})

test('outside herdr nothing is polled', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: { HOME: '/home/me' } })
  await $.session.start(START)
  await clock.advance(120_000)
  // The hook ran and looked at HERDR_ENV, found it unset, and stopped.
  expect(seen.envAsked).toContain('HERDR_ENV')
  expect(seen.herdrCalls).toBe(0)
})

test('DMOKONG_MODS=0 polls nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: { ...ENV, DMOKONG_MODS: '0' } })
  await $.session.start(START)
  await clock.advance(60_000)
  // The hook ran and read the switch, and went no further.
  expect(seen.envAsked).toContain('DMOKONG_MODS')
  expect(seen.envAsked).not.toContain('HERDR_ENV')
  expect(seen.herdrCalls).toBe(0)
})

test('the enabled option set to off polls nothing', { options: { enabled: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: ENV })
  await $.session.start(START)
  await clock.advance(60_000)
  expect(seen.envAsked).toContain('DMOKONG_MODS')
  expect(seen.envAsked).not.toContain('HERDR_ENV')
  expect(seen.herdrCalls).toBe(0)
})

test('a headless session polls nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: ENV })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await clock.advance(60_000)
  expect(seen.envAsked).toContain('DMOKONG_MODS')
  expect(seen.envAsked).not.toContain('HERDR_ENV')
  expect(seen.herdrCalls).toBe(0)
})

const PANE_AT = (columns: number) =>
  ({
    plugin: 'crew-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'crew',
    props: {
      title: 'Crew',
      isFocused: false,
      bodyColumns: columns,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

/** `/crew` as the person types it at the prompt. */
const crewCommand = {
  command: 'crew',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

const STREAM_MD = `---
stream: example-stream-01
phase: finalize
tracker: app-12a
---

## Ledger

| Task | Wave | Status | Fix rounds | Notes |
|---|---|---|---|---|
| 11-fallback | W11 | done | 1 | x |
| 12-an-example-with-a-longer-name | W12 | running | 0 | x |
`

test('/crew opens the pane with members and the stream ledger', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [working], registry: reg('impl-01', 'wE:p2', 'app-12a.32'), stream: STREAM_MD, env: ENV })
  await $.session.start(START)
  await clock.advance(0)
  expect(seen.registered).toEqual(['crew'])
  const answer = await $.command.run(crewCommand)
  expect(answer.text).toContain('1 member')
  expect(seen.opened).toEqual(['crew'])
  const ui = await $.ui.mount(PANE_AT(80))
  expect((await ui.find({ type: 'Text', text: /^working/ }))?.text).toContain('working')
  expect(await ui.find({ type: 'Text', text: /impl-01/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /app-12a\.32/ })).toBeDefined()
  // Where herdr shows it (workspace label / tab label, starred when that tab is focused), its pane and directory.
  expect(await ui.find({ type: 'Text', text: /DOCS\/2\*/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /wE:p2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /exampleapp/ })).toBeDefined()
  // The legend for the star is its own short line, shown only while a starred row is; the button line holds only buttons.
  expect((await ui.find({ type: 'Text', text: /focused tab/ }))?.text).toBe('* focused tab')
  // A header row names the columns.
  expect(await ui.find({ type: 'Text', text: /^STATUS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /WHERE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /example-stream-01/ })).toBeDefined()
  // The streams are their own section: set off by a rule, under their own header.
  expect(await ui.find({ type: 'Text', text: /^─{80}$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^STREAM/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /LEDGER/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /finalize/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /12-an-example-with-a-longer-name/ })).toBeDefined()
  await ui.unmount()
})

test('All switches to every live agent; pressing it again switches back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const elsewhere: Agent = { pane_id: 'wA:p7', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Wave 1 rollout' }
  world(on, { agents: [working, elsewhere], registry: reg('impl-01', 'wE:p2'), env: ENV })
  await $.session.start(START)
  await clock.advance(0)
  const ui = await $.ui.mount(PANE_AT(80))
  expect(await ui.find({ type: 'Text', text: /Wave 1 rollout/ })).toBeUndefined()
  await ui.press({ key: 'all' })
  expect(await ui.find({ type: 'Text', text: /Wave 1 rollout/ })).toBeDefined()
  await ui.press({ key: 'all' })
  expect(await ui.find({ type: 'Text', text: /Wave 1 rollout/ })).toBeUndefined()
  await ui.unmount()
})

test('an empty crew and a herdr failure each say so', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const state: World = { agents: [], registry: '', env: ENV }
  world(on, state)
  await $.session.start(START)
  await clock.advance(0)
  const ui = await $.ui.mount(PANE_AT(80))
  expect(await ui.find({ type: 'Text', text: /No crew spawned from this pane/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /focused tab/ })).toBeUndefined()
  // With no streams there is no stream header, and still a rule above the buttons.
  expect(await ui.find({ type: 'Text', text: /^STREAM/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  state.herdrFails = true
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /herdr unavailable/ })).toBeDefined()
  await ui.unmount()
})

test('outside herdr the pane says so', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [], registry: '', env: { HOME: '/home/me' } })
  await $.session.start(START)
  expect(seen.registered).toEqual(['crew'])
  const ui = await $.ui.mount(PANE_AT(80))
  expect(await ui.find({ type: 'Text', text: /Not inside herdr/ })).toBeDefined()
  await ui.unmount()
  expect(seen.herdrCalls).toBe(0)
})

test('a pane drawn before the session has started shows Starting, then the crew in the same pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: ENV })
  const ui = await $.ui.mount(PANE_AT(80))
  expect(await ui.find({ type: 'Text', text: /Starting/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Not inside/ })).toBeUndefined()
  await $.session.start(START)
  await clock.advance(0)
  // The same mounted pane, no remount: the state write redrew it.
  expect(await ui.find({ type: 'Text', text: /Starting/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^working/ }))?.text).toContain('working')
  await ui.unmount()
})

test('a pane drawn before the session has started ends on the outside message when not in herdr', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const seen = world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: { HOME: '/home/me' } })
  const ui = await $.ui.mount(PANE_AT(80))
  expect(await ui.find({ type: 'Text', text: /Starting/ })).toBeDefined()
  await $.session.start(START)
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /Starting/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Not inside herdr/ })).toBeDefined()
  await ui.unmount()
  expect(seen.herdrCalls).toBe(0)
})

test('/crew typed before the session has started does not stick the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  world(on, { agents: [working], registry: reg('impl-01', 'wE:p2'), env: ENV })
  const answer = await $.command.run(crewCommand)
  expect(answer.text).toContain('Crew pane opened')
  const ui = await $.ui.mount(PANE_AT(80))
  expect(await ui.find({ type: 'Text', text: /Starting/ })).toBeDefined()
  await $.session.start(START)
  await clock.advance(0)
  expect((await ui.find({ type: 'Text', text: /^working/ }))?.text).toContain('working')
  await ui.unmount()
})

test('at forty columns no member row is wider than the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  world(on, { agents: [working], registry: reg('impl-01-an-example-with-a-longer-name', 'wE:p2', 'app-12a.32'), env: ENV })
  await $.session.start(START)
  await clock.advance(0)
  const ui = await $.ui.mount(PANE_AT(40))
  const status = (await ui.find({ type: 'Text', text: /^working/ }))?.text ?? ''
  const name = (await ui.find({ type: 'Text', text: /impl-01/ }))?.text ?? ''
  const age = (await ui.find({ type: 'Text', text: /\d+[smh]$/ }))?.text ?? ''
  expect(status.length > 0 && name.length > 0 && age.length > 0).toBe(true)
  expect(status.length + name.length + age.length <= 40).toBe(true)
  // The location columns are the first to go at this width.
  expect(await ui.find({ type: 'Text', text: /exampleapp/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /wE:p2/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /WHERE/ })).toBeUndefined()
  await ui.unmount()
})
