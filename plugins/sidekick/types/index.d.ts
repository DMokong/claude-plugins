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

/** One instruction file the main session loaded (a CLAUDE.md, a rules file), as it loaded it. */
export type Instruction = { path: string; kind: string; content: string }

/** The panel's settings: what the person changed there is kept across sessions; the rest follows the plugin's options. */
export type Settings = {
  judgeModel: string
  workerModel: string
  investigations: boolean
  draftJudging: boolean
  notifications: boolean
  maxConcurrent: number
  /** Which pet keeps you company above the prompt, in the terminal; off for none. */
  pet: 'off' | 'mochi' | 'tater'
}

/** What the tiles and bars count over a span of the history. */
export type Totals = {
  done: number
  chores: number
  looks: number
  toClaude: number
  drafts: number
  costUsd: number
  savedUsd: number
  draftUsd: number
  choreUsd: number
  lookUsd: number
  claudeUsd: number
}

export type Verdict = 'mechanical' | 'investigate' | 'needs-main' | 'unclear'

/** Which worker setup an assist runs with: a git/bd chore, or a look into something on this machine. */
export type Profile = 'chore' | 'investigate'

/** One "should've been sidekick" correction, and the verdict it teaches the judge. */
export type Taught = { text: string; verdict: 'mechanical' | 'investigate' }

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
  /** A git/bd chore or an investigation; chores before 0.3.0 read as chores. */
  kind: Profile
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
  /** Where an investigation's full record was written; empty for chores and older entries. */
  dump: string
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
  /** The "should've been sidekick" corrections the judge learns from, oldest first; a copy of the stored list, so the pane redraws when one is added or forgotten. */
  learned: Taught[]
  /**
   * The main session's instruction files, captured when it built its context; the worker gets the
   * same. Null until that happens in a conversation this mod saw (it is redone after a compaction or /clear).
   */
  instructions: Instruction[] | null
  /** The settings in force: the plugin's options, with what the person changed in the panel over them. */
  settings: Settings
  /** True while the band shows the control panel rather than its one folded line. */
  panelOpen: boolean
  /** Today's totals across sessions, mirrored from the store's history so the band can draw them. */
  today: Totals
  /** The dashboard's span. */
  tab: 'session' | 'today' | 'week'
  /** What the pane shows: the dashboard, one job's details, or the learned corrections. */
  view: 'dashboard' | 'learned' | 'job'
  /** The job the pane shows when `view` is `job`. */
  jobId: string
}

declare module 'claude-code' {
  interface PluginState {
    sidekick: {
      sidekick: SidekickState
      /** Counts the pet's frames; kept apart so its redraws touch nothing else. */
      petBeat: number
    }
  }
}
