import type { StreamSummary } from '../../types'

export type LiveAgent = {
  paneId: string
  kind: string
  status: string
  /** The terminal title the agent set, stripped of its status glyph. */
  title: string
  /** The herdr agent name, when the pane's agent has been given one. */
  name: string
  tabId: string
  workspaceId: string
  cwd: string
}
export type TabInfo = { tabId: string; label: string; isFocused: boolean }
export type WorkspaceInfo = { workspaceId: string; label: string }
export type RegistryRow = { name: string; kind: string; issue: string; paneId: string; parentPane: string }

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseAgents(stdout: string): LiveAgent[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.result)) return null
  const agents = parsed.result.agents
  if (!Array.isArray(agents)) return null

  const live: LiveAgent[] = []
  for (const agent of agents) {
    if (!isRecord(agent)) continue
    const paneId = text(agent.pane_id)
    if (paneId === '') continue
    live.push({
      paneId,
      kind: text(agent.agent),
      status: text(agent.agent_status),
      title: text(agent.terminal_title_stripped),
      name: text(agent.name),
      tabId: text(agent.tab_id),
      workspaceId: text(agent.workspace_id),
      cwd: text(agent.cwd),
    })
  }
  return live
}

/** The rows of one herdr list result (`result.<key>`), or null when the output is not that. */
function listOf(stdout: string, key: string): Record<string, unknown>[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.result)) return null
  const rows = parsed.result[key]
  return Array.isArray(rows) ? rows.filter(isRecord) : null
}

/** `herdr tab list`: each tab's id, the label herdr shows for it, and whether it is the focused one. */
export function parseTabs(stdout: string): TabInfo[] {
  return (listOf(stdout, 'tabs') ?? [])
    .filter(tab => text(tab.tab_id) !== '')
    .map(tab => ({ tabId: text(tab.tab_id), label: text(tab.label), isFocused: tab.focused === true }))
}

/** `herdr workspace list`: each workspace's id and the label herdr shows for it. */
export function parseWorkspaces(stdout: string): WorkspaceInfo[] {
  return (listOf(stdout, 'workspaces') ?? [])
    .filter(workspace => text(workspace.workspace_id) !== '')
    .map(workspace => ({ workspaceId: text(workspace.workspace_id), label: text(workspace.label) }))
}

/**
 * Reads five fields of a registry row: name, kind, issue, pane_id, parent_pane. The plugin that
 * writes the registry pins them in its test suite (`registry_row_carries_fields_crew_pane_reads`).
 */
export function parseRegistry(files: readonly string[]): RegistryRow[] {
  const latest = new Map<string, RegistryRow>()
  for (const file of files) {
    for (const line of file.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed)) continue
      const name = text(parsed.name)
      const paneId = text(parsed.pane_id)
      if (name === '' || paneId === '') continue
      // Delete first so a re-recorded member moves to the end, keeping spawn order by latest row.
      latest.delete(name)
      latest.set(name, {
        name,
        kind: text(parsed.kind),
        issue: text(parsed.issue),
        paneId,
        parentPane: text(parsed.parent_pane),
      })
    }
  }
  return [...latest.values()]
}

export function parseStream(source: string): StreamSummary | null {
  const lines = source.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end === -1) return null

  const front: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line)
    const key = match?.[1]
    const value = match?.[2]
    if (key !== undefined && value !== undefined) front[key] = value.trim()
  }
  const name = front.stream
  if (name === undefined || name === '') return null

  const counts: Record<string, number> = {}
  const running: string[] = []
  const at = lines.findIndex(line => /^##\s+Ledger\s*$/.test(line))
  if (at !== -1) {
    for (const line of lines.slice(at + 1)) {
      if (/^##\s/.test(line)) break
      if (!line.startsWith('|')) continue
      const cells = line.split('|').slice(1).map(cell => cell.trim())
      const [task, , status] = cells
      if (task === undefined || status === undefined || task === 'Task' || /^-+$/.test(task)) continue
      counts[status] = (counts[status] ?? 0) + 1
      if (status === 'running') running.push(task)
    }
  }
  return { name, phase: front.phase ?? '', tracker: front.tracker ?? '', counts, running }
}
