import { test, expect } from 'claude-code/testing'

import { parseAgents, parseRegistry, parseStream, parseTabs, parseWorkspaces } from './lib/sources'

const AGENTS = JSON.stringify({
  id: 'cli:agent:list',
  result: {
    type: 'agent_list',
    agents: [
      { agent: 'codex', agent_status: 'working', pane_id: 'wE:p2', terminal_title_stripped: 'impl-01', name: 'docs-impl', tab_id: 'wE:t2', workspace_id: 'wE', cwd: '/home/me/projects/exampleapp' },
      { agent: 'claude', agent_status: 'blocked', pane_id: 'wE:p3', terminal_title_stripped: 'reviewer' },
    ],
  },
})

test('parseAgents reads pane, kind, status, title, and the name and place when herdr gives them', () => {
  expect(parseAgents(AGENTS)).toEqual([
    { paneId: 'wE:p2', kind: 'codex', status: 'working', title: 'impl-01', name: 'docs-impl', tabId: 'wE:t2', workspaceId: 'wE', cwd: '/home/me/projects/exampleapp' },
    { paneId: 'wE:p3', kind: 'claude', status: 'blocked', title: 'reviewer', name: '', tabId: '', workspaceId: '', cwd: '' },
  ])
})

test('parseTabs and parseWorkspaces read ids, labels and the focused tab; junk gives nothing', () => {
  const tabs = JSON.stringify({ result: { tabs: [{ tab_id: 'wE:t1', label: '1', focused: false }, { tab_id: 'wE:t8', label: '2', focused: true }, { label: 'no id' }, null] } })
  expect(parseTabs(tabs)).toEqual([
    { tabId: 'wE:t1', label: '1', isFocused: false },
    { tabId: 'wE:t8', label: '2', isFocused: true },
  ])
  const workspaces = JSON.stringify({ result: { workspaces: [{ workspace_id: 'wE', label: 'DOCS' }, { label: 'no id' }] } })
  expect(parseWorkspaces(workspaces)).toEqual([{ workspaceId: 'wE', label: 'DOCS' }])
  expect(parseTabs('not json')).toEqual([])
  expect(parseTabs('')).toEqual([])
  expect(parseWorkspaces('{"error":{}}')).toEqual([])
})

test('parseAgents answers null for an error envelope or junk, and [] for no agents', () => {
  expect(parseAgents('{"error":{"code":"herdr_unreachable"}}')).toBe(null)
  expect(parseAgents('not json')).toBe(null)
  expect(parseAgents(JSON.stringify({ result: { agents: [] } }))).toEqual([])
})

const row = (o: Record<string, unknown>) => JSON.stringify({ kind: 'codex', issue: '', parent_pane: 'wE:p1', ...o })

test('parseRegistry keeps the latest row per name', () => {
  const file = [row({ name: 'impl-01', pane_id: 'wE:p2' }), row({ name: 'impl-01', pane_id: 'wE:p9', issue: 'app-12a.32' })].join('\n')
  expect(parseRegistry([file])).toEqual([
    { name: 'impl-01', kind: 'codex', issue: 'app-12a.32', paneId: 'wE:p9', parentPane: 'wE:p1' },
  ])
})

test('parseRegistry skips a truncated line and rows with no name or pane', () => {
  const file = [row({ name: 'a', pane_id: 'w:p1' }), '{"name":"b","pane_id":"w:p', row({ pane_id: 'w:p3' }), ''].join('\n')
  expect(parseRegistry([file]).map(r => r.name)).toEqual(['a'])
})

test('parseRegistry reads across files, later files winning', () => {
  const first = row({ name: 'a', pane_id: 'w:p1' })
  const second = row({ name: 'a', pane_id: 'w:p2' })
  const latest = parseRegistry([first, second])[0]
  if (latest === undefined) throw new Error('expected a registry row')
  expect(latest.paneId).toBe('w:p2')
})

const STREAM = `---
stream: 2026-01-01-example-stream-01
phase: finalize
tracker: app-12a
weave:
  beads: present
---

# Stream C

## Ledger

| Task | Wave | Status | Fix rounds | Notes |
|---|---|---|---|---|
| 01-first-ledger-row | W1 | done | 0 | 1111111 |
| 11-fallback | W11 | done | 1 | 2222222 · gate | with a pipe in notes |
| 12-an-example-with-a-longer-name | W12 | running | 0 | re-fix |

## Escalations
| E1 | not a ledger row | running |
`

test('parseStream reads the front matter and counts ledger rows by status', () => {
  expect(parseStream(STREAM)).toEqual({
    name: '2026-01-01-example-stream-01',
    phase: 'finalize',
    tracker: 'app-12a',
    counts: { done: 2, running: 1 },
    running: ['12-an-example-with-a-longer-name'],
  })
})

test('parseStream answers null without a stream name, and empty counts without a ledger', () => {
  expect(parseStream('# just a doc')).toBe(null)
  expect(parseStream('---\nstream: s\nphase: plan\n---\n')).toEqual({ name: 's', phase: 'plan', tracker: '', counts: {}, running: [] })
})
