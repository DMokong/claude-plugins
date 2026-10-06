export type Issue = {
  id: string
  title: string
  /** When this session claimed or adopted it, ms since epoch. */
  claimedAt: number
  /** Newest comment by anyone, ms since epoch; null when none is known. */
  lastCommentAt: number | null
  /** Last tool call this session ran while holding it, ms since epoch. */
  lastActivityAt: number
  /** The staleness mark a toast was already shown for; null when none. */
  toastedMark: number | null
}

export type BandState = {
  issues: Record<string, Issue>
  focus: string | null
  /** Edits made while holding no issue. */
  edits: number
  isHidden: boolean
  /** A dim one-line reason when bd could not be read; null otherwise. */
  error: string | null
  /** Minute counter; written by the redraw timer so the band re-renders. */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'bd-issue-band': { band: BandState }
  }
}
