export type Mode = 'off' | 'shadow' | 'auto'

/** Tokens and API-equivalent dollars, prompt caching priced in. */
export type Tally = {
  usd: number
  /** What caching changed against sending every input token uncached; negative when writes cost more than reads saved. */
  savedUsd: number
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export type Verdict = 'mechanical' | 'needs-main' | 'unclear'

export type EntryStatus =
  | 'judging'
  | 'queued'
  | 'running'
  | 'done'
  | 'stopped'
  | 'failed'
  | 'passed'
  | 'shadow'

export type Outcome = {
  status: 'done' | 'partial' | 'stopped' | 'failed'
  summary: string
  commands: string[]
  shas: string[]
  changed: string[]
  uncertain: string[]
  /** Why the main session should take over; empty when it need not. */
  needsMain: string
}

export type Entry = {
  id: string
  /** The prompt as the person typed it. */
  prompt: string
  status: EntryStatus
  /** What the judge said, and why; empty before it answered or when it never ran. */
  verdict: Verdict | ''
  reason: string
  judgeMs: number
  /** The self-contained restatement the worker gets. */
  task: string
  /** Lock keys the assist holds while it runs. */
  locks: string[]
  /** Which judge and worker answered, e.g. `haiku`. */
  backend: string
  createdAt: number
  startedAt: number
  endedAt: number
  /** The worker's most recent steps (commands it ran, notes it wrote), newest last. */
  steps: string[]
  outcome: Outcome | null
  /** Set when the person pressed "should've been sidekick" on a passed entry. */
  isMissed: boolean
  /** The judge's call for this prompt and the worker's run. */
  judgeSpend: Tally
  workerSpend: Tally
}

/** A prompt bound for the main session, held while assists run. */
export type Waiting = { id: string; text: string }

export type SidekickState = {
  mode: Mode
  entries: Entry[]
  waiting: Waiting[]
  /** Handoff notes not yet delivered to the main session. */
  notes: string[]
  /** The entry whose steps the pane shows in full; empty for none. */
  watching: string
  totals: { assists: number; passed: number; failed: number }
  /** This session's spend: every judge call (drafts and warm-ups too) and every worker run. */
  spend: Tally
  /** Moves once a second while an assist runs, so the pane's spinner and clocks redraw. */
  tick: number
  /** True while the judge's first call is opening its connection, which can take seconds. */
  isWarming: boolean
}

declare module 'claude-code' {
  interface PluginState {
    sidekick: { sidekick: SidekickState }
  }
}
