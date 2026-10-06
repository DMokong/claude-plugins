export type MemberStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | 'gone'

export type Member = {
  name: string
  /** The agent kind: `claude` or `codex`. */
  kind: string
  /** The tracker issue recorded at spawn; empty when none. */
  issue: string
  paneId: string
  status: MemberStatus
  /** When this mod first saw the member in its current status, ms since epoch. */
  since: number
  /** Where herdr shows it: workspace label, a slash, tab label (`DOCS/2`); the tab id when labels are unknown. */
  where: string
  /** True when its tab is the one focused in herdr. */
  isFocusedTab: boolean
  /** The last segment of its working directory; empty when unknown. */
  dir: string
}

export type StreamSummary = {
  name: string
  phase: string
  tracker: string
  /** Ledger rows per status (`done`, `running`, ...). */
  counts: Record<string, number>
  /** Task names whose status is `running`. */
  running: string[]
}

export type CrewState = {
  members: Member[]
  streams: StreamSummary[]
  /** True: every live herdr agent. False: only members this session's pane spawned. */
  showAll: boolean
  /** A dim one-line reason when a source could not be read; null otherwise. */
  error: string | null
  /**
   * Whether this session runs inside herdr. `unknown` until `session.start` has read the
   * environment, so a pane drawn before then is not mistaken for one drawn outside.
   */
  environment: 'unknown' | 'inside' | 'outside'
}

declare module 'claude-code' {
  interface PluginState {
    'crew-pane': { crew: CrewState }
  }
}
