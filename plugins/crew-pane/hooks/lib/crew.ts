import type { CrewState, Member, MemberStatus, StreamSummary } from '../../types'
import type { LiveAgent, RegistryRow, TabInfo, WorkspaceInfo } from './sources'

export const EMPTY: CrewState = { members: [], streams: [], showAll: false, error: null, environment: 'unknown' }

function liveStatus(status: string): MemberStatus {
  switch (status) {
    case 'idle':
    case 'working':
    case 'blocked':
    case 'done':
    case 'unknown':
      return status
    default:
      return 'unknown'
  }
}

export function joinCrew(input: {
  rows: readonly RegistryRow[]
  agents: readonly LiveAgent[]
  myPane: string
  showAll: boolean
  prev: readonly Member[]
  now: number
  tabs?: readonly TabInfo[]
  workspaces?: readonly WorkspaceInfo[]
}): Member[] {
  const { rows, agents, myPane, showAll, prev, now } = input
  const tabById = new Map((input.tabs ?? []).map(tab => [tab.tabId, tab]))
  const workspaceById = new Map((input.workspaces ?? []).map(workspace => [workspace.workspaceId, workspace]))

  /** What herdr itself shows for the pane's place, plus the directory it works in. */
  const place = (live: LiveAgent | undefined): Pick<Member, 'where' | 'isFocusedTab' | 'dir'> => {
    if (live === undefined) return { where: '', isFocusedTab: false, dir: '' }
    const tab = tabById.get(live.tabId)
    const workspace = workspaceById.get(live.workspaceId)
    const where =
      tab !== undefined && workspace !== undefined && workspace.label !== ''
        ? `${workspace.label}/${tab.label}`
        : live.tabId
    return { where, isFocusedTab: tab?.isFocused === true, dir: live.cwd.split('/').filter(part => part !== '').pop() ?? '' }
  }
  const liveByPane = new Map(agents.map(agent => [agent.paneId, agent]))
  const rowByPane = new Map(rows.map(row => [row.paneId, row]))
  const prevByPane = new Map(prev.map(member => [member.paneId, member]))

  const stamp = (paneId: string, status: MemberStatus): number => {
    const before = prevByPane.get(paneId)
    return before !== undefined && before.status === status ? before.since : now
  }

  if (showAll) {
    return agents
      .filter(agent => agent.paneId !== myPane)
      .map(agent => {
        const row = rowByPane.get(agent.paneId)
        const status = liveStatus(agent.status)
        return {
          // The registry name, else the name herdr holds for the agent, else what its terminal says.
          name: row?.name ?? (agent.name !== '' ? agent.name : agent.title !== '' ? agent.title : agent.paneId),
          kind: agent.kind,
          issue: row?.issue ?? '',
          paneId: agent.paneId,
          status,
          since: stamp(agent.paneId, status),
          ...place(agent),
        }
      })
  }

  const members: Member[] = []
  for (const row of rows) {
    if (row.parentPane !== myPane) continue
    const live = liveByPane.get(row.paneId)
    // A member with no live pane is shown only if this session saw it alive.
    if (live === undefined && !prevByPane.has(row.paneId)) continue
    const status = live === undefined ? 'gone' : liveStatus(live.status)
    members.push({
      name: row.name,
      kind: row.kind !== '' ? row.kind : live?.kind ?? '',
      issue: row.issue,
      paneId: row.paneId,
      status,
      since: stamp(row.paneId, status),
      ...place(live),
    })
  }
  return members
}

export type Alert = { text: string; isBlocked: boolean }

export function alerts(prev: readonly Member[], next: readonly Member[]): Alert[] {
  const before = new Map(prev.map(member => [member.paneId, member.status]))
  const out: Alert[] = []
  for (const member of next) {
    const was = before.get(member.paneId)
    if (was === member.status) continue
    if (member.status === 'blocked') out.push({ text: `${member.name} is blocked`, isBlocked: true })
    else if (
      // `done` is herdr's "finished, not yet looked at": announced from any known status, so a
      // turn that began and ended between two polls is not missed. A member that was `gone` or
      // never seen has no earlier status to finish from.
      (member.status === 'done' && was !== undefined && was !== 'gone') ||
      (was === 'working' && member.status === 'idle')
    ) {
      out.push({ text: `${member.name} finished`, isBlocked: false })
    } else if (member.status === 'gone' && was !== undefined) {
      out.push({ text: `${member.name} is gone`, isBlocked: false })
    }
  }
  return out
}

const STATUS_ORDER: readonly MemberStatus[] = ['blocked', 'working', 'done', 'idle', 'unknown']

export function statusText(members: readonly Member[]): string | undefined {
  const parts = STATUS_ORDER.map(status => [status, members.filter(m => m.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
  return parts.length === 0 ? undefined : `crew ${parts.join(' · ')}`
}

export function age(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

const cut = (value: string, width: number): string =>
  width <= 0 ? '' : value.length <= width ? value : `${value.slice(0, width - 1)}…`

export type ColumnKey = 'status' | 'name' | 'where' | 'pane' | 'kind' | 'issue' | 'dir' | 'age'

/** One piece of a drawn row: its padded text and how to paint it. `color` is a theme key. */
export type Cell = { key: ColumnKey; text: string; color?: string; bold?: boolean; dim?: boolean }

/** The columns one draw shows, in order, and the width of each. */
export type Layout = { keys: ColumnKey[]; widths: Record<ColumnKey, number> }

const HEADINGS: Record<ColumnKey, string> = {
  status: 'STATUS',
  name: 'NAME',
  where: 'WHERE',
  pane: 'PANE',
  kind: 'KIND',
  issue: 'ISSUE',
  dir: 'DIR',
  age: 'AGE',
}
const ORDER: readonly ColumnKey[] = ['status', 'name', 'where', 'pane', 'kind', 'issue', 'dir', 'age']
/** Given up first when the pane is too narrow; status, name and age are never dropped. */
const DROP_ORDER: readonly ColumnKey[] = ['dir', 'pane', 'issue', 'kind', 'where']
const GAP = 2
const MIN_NAME = 6
const FOCUS_MARK = '*'

function value(member: Member, key: ColumnKey, now: number): string {
  switch (key) {
    case 'status':
      return member.status
    case 'name':
      return member.name
    case 'where':
      // A member drawn from state written before these fields existed has none.
      return `${member.where ?? ''}${member.isFocusedTab === true ? FOCUS_MARK : ''}`
    case 'pane':
      return member.paneId
    case 'kind':
      return member.kind
    case 'issue':
      return member.issue
    case 'dir':
      return member.dir ?? ''
    case 'age':
      return age(member.since, now)
  }
}

const totalWidth = (keys: readonly ColumnKey[], widths: Record<ColumnKey, number>): number =>
  keys.reduce((sum, key) => sum + widths[key], 0) + GAP * Math.max(0, keys.length - 1)

/**
 * Chosen once per draw from every member shown, so the rows and the header line up. A column
 * no member has a value for is left out; when the pane is too narrow, columns go in DROP_ORDER
 * and then the name gives way.
 */
export function layout(members: readonly Member[], width: number, now = 0): Layout {
  const widths = {} as Record<ColumnKey, number>
  for (const key of ORDER) {
    widths[key] = Math.max(HEADINGS[key].length, ...members.map(member => value(member, key, now).length))
  }
  widths.age = Math.max(widths.age, 4)
  let keys = ORDER.filter(
    key => key === 'status' || key === 'name' || key === 'age' || members.some(member => value(member, key, now) !== ''),
  )
  for (const drop of DROP_ORDER) {
    if (totalWidth(keys, widths) <= width) break
    keys = keys.filter(key => key !== drop)
  }
  const over = totalWidth(keys, widths) - width
  if (over > 0) widths.name = Math.max(MIN_NAME, widths.name - over)
  return { keys, widths }
}

const pad = (key: ColumnKey, text: string, width: number): string =>
  key === 'age' ? cut(text, width).padStart(width) : cut(text, width).padEnd(width)

const STATUS_COLOR: Record<MemberStatus, string> = {
  blocked: 'error',
  working: 'suggestion',
  done: 'success',
  idle: 'inactive',
  unknown: 'warning',
  gone: 'subtle',
}

function paint(member: Member, key: ColumnKey): Pick<Cell, 'color' | 'bold' | 'dim'> {
  const isGone = member.status === 'gone'
  switch (key) {
    case 'status':
      return { color: STATUS_COLOR[member.status], bold: member.status === 'blocked' }
    case 'name':
      return { bold: !isGone, dim: isGone }
    case 'where':
      return member.isFocusedTab === true ? { color: 'claude', bold: true } : { color: 'inactive' }
    case 'kind':
      return { color: member.kind === 'claude' ? 'claude' : member.kind === 'codex' ? 'planMode' : 'inactive' }
    case 'issue':
      return { color: 'permission' }
    case 'pane':
    case 'dir':
    case 'age':
      // `subtle` proved too faint to read on a dark terminal; `inactive` is the quiet-but-legible key.
      return { color: 'inactive' }
  }
}

/** The header row for a layout: one bold heading per column shown. */
export function headerCells(shape: Layout): Cell[] {
  return shape.keys.map(key => ({ key, text: pad(key, HEADINGS[key], shape.widths[key]), color: 'text', bold: true }))
}

/** One member as painted cells, each padded to its column. */
export function memberCells(member: Member, now: number, shape: Layout): Cell[] {
  return shape.keys.map(key => ({ key, text: pad(key, value(member, key, now), shape.widths[key]), ...paint(member, key) }))
}

/** A row as the plain text it occupies: its cells joined by the column gap. */
export function rowText(cells: readonly Cell[]): string {
  return cells.map(cell => cell.text).join(' '.repeat(GAP))
}

/** The text between two cells of a drawn row. */
export const COLUMN_GAP = ' '.repeat(GAP)

/** The widths of the stream table's first two columns, shared by its header and every row. */
export type StreamColumns = { name: number; phase: number }

const STREAM_HEADINGS = { name: 'STREAM', phase: 'PHASE', ledger: 'LEDGER' } as const

/** Chosen once per draw: the longest stream name and phase, the name giving way in a narrow pane. */
export function streamColumns(streams: readonly StreamSummary[], width: number): StreamColumns {
  const phase = Math.max(STREAM_HEADINGS.phase.length, ...streams.map(stream => stream.phase.length))
  const natural = Math.max(STREAM_HEADINGS.name.length, ...streams.map(stream => stream.name.length))
  // Leave room for the phase and at least a short ledger beside the name.
  const room = width - GAP - phase - GAP - STREAM_HEADINGS.ledger.length
  return { name: Math.max(MIN_NAME, Math.min(natural, room)), phase }
}

/** The stream table's header: STREAM, PHASE, LEDGER, padded to the columns. */
export function streamHeader(cols: StreamColumns): string[] {
  return [STREAM_HEADINGS.name.padEnd(cols.name), STREAM_HEADINGS.phase.padEnd(cols.phase), STREAM_HEADINGS.ledger]
}

/** A stream's name and phase, cut and padded to the columns. */
export function streamLead(stream: StreamSummary, cols: StreamColumns): { name: string; phase: string } {
  return { name: cut(stream.name, cols.name).padEnd(cols.name), phase: cut(stream.phase, cols.phase).padEnd(cols.phase) }
}

/** A horizontal rule across the pane, to set its sections apart. */
export function divider(width: number): string {
  return '─'.repeat(Math.max(0, width))
}

/** How a stream's ledger count is painted, by the status it counts. */
export function countColor(status: string): string {
  if (status === 'done') return 'success'
  if (status === 'running') return 'suggestion'
  if (status === 'blocked' || status === 'failed') return 'error'
  return 'inactive'
}

/** A stream's ledger counts in display order: alphabetical, with running last. */
export function streamCounts(stream: StreamSummary): { status: string; count: number }[] {
  return Object.entries(stream.counts)
    .sort(([a], [b]) => (a === 'running' ? 1 : b === 'running' ? -1 : a.localeCompare(b)))
    .map(([status, count]) => ({ status, count }))
}

export function streamRow(stream: StreamSummary, width: number): string {
  const order = Object.entries(stream.counts)
    .sort(([a], [b]) => (a === 'running' ? 1 : b === 'running' ? -1 : a.localeCompare(b)))
  const counts = order.map(([status, count]) => `${count} ${status}`)
  return cut([stream.name, stream.phase, ...counts].filter(part => part !== '').join(' · '), width)
}
