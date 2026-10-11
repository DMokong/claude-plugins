import { test, expect } from 'claude-code/testing'

import { age, alerts, headerCells, joinCrew, layout, memberCells, rowText, statusText, divider, streamColumns, streamCounts, streamHeader, streamLead, streamRow } from './lib/crew'
import type { LiveAgent, RegistryRow } from './lib/sources'
import type { Member, StreamSummary } from '../types'

const T0 = 1_000_000_000
const rows: RegistryRow[] = [
  { name: 'impl-01', kind: 'codex', issue: 'app-12a.32', paneId: 'wE:p2', parentPane: 'wE:p1' },
  { name: 'reviewer', kind: 'claude', issue: '', paneId: 'wE:p3', parentPane: 'wE:p1' },
  { name: 'someone-elses', kind: 'codex', issue: '', paneId: 'wA:p7', parentPane: 'wA:p1' },
  { name: 'old-member', kind: 'codex', issue: '', paneId: 'wE:p0', parentPane: 'wE:p1' },
]
const live = (paneId: string, kind: string, status: string, title: string, over: Partial<LiveAgent> = {}): LiveAgent => ({
  paneId, kind, status, title, name: '', tabId: '', workspaceId: '', cwd: '', ...over,
})
const agents: LiveAgent[] = [
  live('wE:p1', 'claude', 'working', 'me'),
  live('wE:p2', 'codex', 'working', 'impl-01', { tabId: 'wE:t2', workspaceId: 'wE', cwd: '/home/me/projects/exampleapp' }),
  live('wE:p3', 'claude', 'blocked', 'reviewer', { tabId: 'wE:t3', workspaceId: 'wE' }),
  live('wA:p7', 'codex', 'idle', 'elsewhere'),
]
const mine = (over: Partial<Parameters<typeof joinCrew>[0]> = {}) =>
  joinCrew({ rows, agents, myPane: 'wE:p1', showAll: false, prev: [], now: T0, ...over })

function firstMember(members: readonly Member[]): Member {
  const member = members[0]
  if (member === undefined) throw new Error('expected at least one member')
  return member
}

test('mine: only members this pane spawned, live ones only on first sight', () => {
  expect(mine().map(m => [m.name, m.status])).toEqual([['impl-01', 'working'], ['reviewer', 'blocked']])
})

test('a member seen alive and now missing is gone; one never seen is dropped', () => {
  const prev = mine()
  const next = mine({ agents: agents.filter(a => a.paneId !== 'wE:p2'), prev, now: T0 + 5000 })
  expect(next.map(m => [m.name, m.status])).toEqual([['impl-01', 'gone'], ['reviewer', 'blocked']])
  expect(next.find(m => m.name === 'old-member')).toBeUndefined()
})

test('since is kept while the status holds and reset when it changes', () => {
  const prev = mine()
  const same = mine({ prev, now: T0 + 60_000 })
  expect(firstMember(same).since).toBe(T0)
  const changed = mine({
    agents: agents.map(a => (a.paneId === 'wE:p2' ? { ...a, status: 'done' } : a)),
    prev,
    now: T0 + 60_000,
  })
  expect(firstMember(changed).since).toBe(T0 + 60_000)
})

test('all: every live agent but this session, named from the registry or the title', () => {
  expect(mine({ showAll: true }).map(m => m.name)).toEqual(['impl-01', 'reviewer', 'someone-elses'])
  const unnamed = mine({ showAll: true, rows: [] })
  expect(unnamed.map(m => m.name)).toEqual(['impl-01', 'reviewer', 'elsewhere'])
})

test('an unrecognised herdr status reads as unknown', () => {
  const odd = mine({ agents: [live('wE:p2', 'codex', 'thinking', '')] })
  expect(firstMember(odd).status).toBe('unknown')
})

const member = (name: string, status: Member['status']): Member => ({ name, kind: 'codex', issue: '', paneId: name, status, since: T0, where: '', isFocusedTab: false, dir: '' })

test('alerts: newly blocked, finished, gone; nothing when unchanged', () => {
  const prev = [member('a', 'working'), member('b', 'working'), member('c', 'working'), member('d', 'idle')]
  const next = [member('a', 'blocked'), member('b', 'done'), member('c', 'gone'), member('d', 'idle')]
  expect(alerts(prev, next)).toEqual([
    { text: 'a is blocked', isBlocked: true },
    { text: 'b finished', isBlocked: false },
    { text: 'c is gone', isBlocked: false },
  ])
  expect(alerts(next, next)).toEqual([])
})

test('alerts: a member first seen already blocked is announced; first seen idle is not', () => {
  expect(alerts([], [member('a', 'blocked'), member('b', 'idle')])).toEqual([{ text: 'a is blocked', isBlocked: true }])
})

test('alerts: done is announced from any known status, so a turn shorter than a poll is not missed', () => {
  for (const was of ['idle', 'working', 'blocked', 'unknown'] as const) {
    expect(alerts([member('a', was)], [member('a', 'done')])).toEqual([{ text: 'a finished', isBlocked: false }])
  }
})

test('alerts: done is not announced on first sight, when it holds, or coming back from gone', () => {
  expect(alerts([], [member('a', 'done')])).toEqual([])
  expect(alerts([member('a', 'done')], [member('a', 'done')])).toEqual([])
  expect(alerts([member('a', 'gone')], [member('a', 'done')])).toEqual([])
})

test('statusText orders blocked first and omits zeroes and gone', () => {
  expect(statusText([member('a', 'working'), member('b', 'working'), member('c', 'blocked'), member('d', 'gone')])).toBe('crew 1 blocked · 2 working')
  expect(statusText([])).toBeUndefined()
  expect(statusText([member('d', 'gone')])).toBeUndefined()
})

test('age reads in seconds, minutes, hours', () => {
  expect(age(T0, T0 + 45_000)).toBe('45s')
  expect(age(T0, T0 + 12 * 60_000)).toBe('12m')
  expect(age(T0, T0 + 3 * 3_600_000 + 5)).toBe('3h')
})

const at = (name: string, over: Partial<Member> = {}): Member => ({
  name, kind: 'codex', issue: '', paneId: `wE:${name}`, status: 'working', since: T0, where: 'DOCS/2', isFocusedTab: false, dir: 'exampleapp', ...over,
})

test('a member carries where herdr shows it, whether that tab is focused, and its directory', () => {
  const placed = mine({
    tabs: [{ tabId: 'wE:t2', label: '2', isFocused: true }, { tabId: 'wE:t3', label: 'review', isFocused: false }],
    workspaces: [{ workspaceId: 'wE', label: 'DOCS' }],
  })
  expect(placed.map(m => [m.name, m.where, m.isFocusedTab, m.dir])).toEqual([
    ['impl-01', 'DOCS/2', true, 'exampleapp'],
    ['reviewer', 'DOCS/review', false, ''],
  ])
})

test('without tab or workspace labels the place falls back to the tab id', () => {
  expect(firstMember(mine()).where).toBe('wE:t2')
  expect(firstMember(mine({ tabs: [{ tabId: 'wE:t2', label: '2', isFocused: false }] })).where).toBe('wE:t2')
})

test('all: an agent herdr has named is shown by that name before its terminal title', () => {
  const named = [live('wE:p1', 'claude', 'working', 'me'), live('wA:p7', 'codex', 'idle', 'elsewhere', { name: 'named-by-herdr' })]
  expect(mine({ showAll: true, rows: [], agents: named }).map(m => m.name)).toEqual(['named-by-herdr'])
})

test('the header and every row share one layout, so columns line up', () => {
  const members = [
    at('docs-impl', { kind: 'claude', issue: 'app-567.1', status: 'done' }),
    at('docs-crew-cdx', { issue: 'app-567.2', status: 'idle', where: 'fixes/1', isFocusedTab: true }),
    at('x', { since: T0 - 125_000 }),
  ]
  const shape = layout(members, 120, T0 + 9_000)
  expect(shape.keys).toEqual(['status', 'name', 'where', 'pane', 'kind', 'issue', 'dir', 'age'])
  const head = rowText(headerCells(shape))
  const lines = members.map(m => rowText(memberCells(m, T0 + 9_000, shape)))
  expect(head.startsWith('STATUS   NAME ')).toBe(true)
  for (const line of lines) expect(line.length).toBe(head.length)
  const [first, second, third] = lines
  if (first === undefined || second === undefined || third === undefined) throw new Error('expected three rows')
  expect(first.indexOf('claude ')).toBe(head.indexOf('KIND'))
  expect(second.indexOf('codex')).toBe(head.indexOf('KIND'))
  expect(first.indexOf('DOCS/2')).toBe(head.indexOf('WHERE'))
  expect(second.indexOf('fixes/1*')).toBe(head.indexOf('WHERE'))
  expect(first.indexOf('app-567.1')).toBe(head.indexOf('ISSUE'))
  expect(first.endsWith('  9s')).toBe(true)
  expect(third.endsWith('  2m')).toBe(true)
})

test('a column no member has a value for is left out', () => {
  const shape = layout([at('a', { where: '', dir: '' }), at('b', { where: '', dir: '' })], 120)
  expect(shape.keys).toEqual(['status', 'name', 'pane', 'kind', 'age'])
})

test('a narrow pane drops columns in order, then shortens the name, and no row is too wide', () => {
  const members = [
    at('impl-01-an-example-with-a-longer-name', { kind: 'claude', issue: 'app-567.1' }),
    at('short', { issue: 'app-567.2', status: 'idle' }),
  ]
  const wide = layout(members, 200)
  expect(wide.keys.includes('dir')).toBe(true)
  const mid = layout(members, 70)
  expect(mid.keys.includes('dir')).toBe(false)
  expect(mid.keys.includes('pane')).toBe(false)
  const narrow = layout(members, 40, T0 + 60_000)
  expect(narrow.keys).toEqual(['status', 'name', 'age'])
  for (const m of members) {
    const line = rowText(memberCells(m, T0 + 60_000, narrow))
    expect(line.length <= 40).toBe(true)
    expect(line.startsWith(m.status)).toBe(true)
    expect(line.endsWith('1m')).toBe(true)
  }
  expect(rowText(headerCells(narrow)).length <= 40).toBe(true)
})

test('cells are painted by what they mean', () => {
  const shape = layout([at('a')], 120)
  const paintOf = (m: Member, key: string) => memberCells(m, T0, shape).find(cell => cell.key === key)
  expect(paintOf(at('a', { status: 'blocked' }), 'status')).toMatchObject({ color: 'error', bold: true })
  expect(paintOf(at('a', { status: 'working' }), 'status')?.color).toBe('suggestion')
  expect(paintOf(at('a', { status: 'done' }), 'status')?.color).toBe('success')
  expect(paintOf(at('a', { status: 'idle' }), 'status')?.color).toBe('inactive')
  expect(paintOf(at('a', { status: 'gone' }), 'name')?.dim).toBe(true)
  expect(paintOf(at('a', { kind: 'claude' }), 'kind')?.color).toBe('claude')
  expect(paintOf(at('a', { isFocusedTab: true }), 'where')?.color).toBe('claude')
  expect(paintOf(at('a'), 'where')?.color).toBe('inactive')
  for (const cell of memberCells(at('a'), T0, shape)) expect(cell.color === 'subtle').toBe(false)
  for (const cell of headerCells(shape)) expect(cell.bold).toBe(true)
})

test('a member written before the place fields existed still draws', () => {
  const old = { name: 'old', kind: 'codex', issue: '', paneId: 'wE:p2', status: 'working', since: T0 } as unknown as Member
  const shape = layout([old], 120)
  expect(rowText(memberCells(old, T0, shape)).startsWith('working')).toBe(true)
})

test('stream counts come in display order with running last', () => {
  expect(streamCounts({ name: 's', phase: 'p', tracker: '', counts: { running: 1, done: 27, pending: 3 }, running: [] }))
    .toEqual([{ status: 'done', count: 27 }, { status: 'pending', count: 3 }, { status: 'running', count: 1 }])
})

test('streamRow summarises counts with running last', () => {
  expect(streamRow({ name: '2026-01-01-example-stream-01', phase: 'finalize', tracker: 'app-12a', counts: { done: 27, running: 1 }, running: ['12-x'] }, 80))
    .toBe('2026-01-01-example-stream-01 · finalize · 27 done · 1 running')
})

test('the stream table shares one set of columns between its header and rows', () => {
  const streams: StreamSummary[] = [
    { name: '2026-01-01-example-stream-01', phase: 'finalize', tracker: '', counts: { done: 27, running: 1 }, running: [] },
    { name: '2026-01-01-another', phase: 'execute', tracker: '', counts: { done: 8, pending: 3 }, running: [] },
  ]
  const cols = streamColumns(streams, 90)
  const second = streams[1]
  if (second === undefined) throw new Error('expected two streams')
  expect(cols).toEqual({ name: 28, phase: 8 })
  expect(streamHeader(cols)).toEqual(['STREAM'.padEnd(28), 'PHASE   ', 'LEDGER'])
  expect(streamLead(second, cols)).toEqual({ name: '2026-01-01-another'.padEnd(28), phase: 'execute '.padEnd(8) })
})

test('in a narrow pane the stream name gives way and keeps its column', () => {
  const streams: StreamSummary[] = [{ name: '2026-01-01-example-stream-01', phase: 'finalize', tracker: '', counts: {}, running: [] }]
  const cols = streamColumns(streams, 34)
  expect(cols.name).toBe(34 - 2 - 8 - 2 - 6)
  const only = streams[0]
  if (only === undefined) throw new Error('expected one stream')
  const lead = streamLead(only, cols)
  expect(lead.name.length).toBe(cols.name)
  expect(lead.name.endsWith('…')).toBe(true)
  expect(streamColumns([], 80)).toEqual({ name: 6, phase: 5 })
})

test('a divider spans the width it is given and never goes negative', () => {
  expect(divider(5)).toBe('─────')
  expect(divider(0)).toBe('')
  expect(divider(-3)).toBe('')
})
