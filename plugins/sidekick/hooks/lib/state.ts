import { NO_SPEND } from './cost'
import type { Entry, SidekickState, Taught } from '../../types'

/**
 * A session's state outlives the module: a `/reload-plugins` onto a newer version hands the new
 * code whatever an older one wrote. Every read and write goes through this, so a field added
 * since is filled with its default and never read as undefined.
 */
export function migrate(raw: Partial<SidekickState> | undefined, empty: SidekickState): SidekickState {
  const state = { ...empty, ...(raw ?? {}) }
  return {
    ...state,
    entries: (state.entries ?? []).map(migrateEntry),
    waiting: state.waiting ?? [],
    notes: state.notes ?? [],
    totals: { ...empty.totals, ...(state.totals ?? {}) },
    spend: { ...NO_SPEND, ...(state.spend ?? {}) },
    tick: typeof state.tick === 'number' ? state.tick : 0,
    isWarming: state.isWarming === true,
    learned: toTaught(state.learned),
    instructions: Array.isArray(state.instructions) ? state.instructions : null,
  }
}

/**
 * Stored corrections, in whatever shape a version wrote them: 0.2.x kept bare strings, which all
 * taught "mechanical". Anything else unreadable is dropped.
 */
export function toTaught(raw: unknown): Taught[] {
  if (!Array.isArray(raw)) return []
  const out: Taught[] = []
  for (const item of raw) {
    if (typeof item === 'string') out.push({ text: item, verdict: 'mechanical' })
    else if (item !== null && typeof item === 'object' && typeof (item as Taught).text === 'string') {
      out.push({ text: (item as Taught).text, verdict: (item as Taught).verdict === 'investigate' ? 'investigate' : 'mechanical' })
    }
  }
  return out
}

function migrateEntry(raw: Partial<Entry>): Entry {
  return {
    id: '',
    kind: 'chore',
    prompt: '',
    status: 'passed',
    verdict: '',
    reason: '',
    judgeMs: 0,
    task: '',
    locks: [],
    backend: '',
    createdAt: 0,
    startedAt: 0,
    endedAt: 0,
    steps: [],
    outcome: null,
    isMissed: false,
    dump: '',
    ...raw,
    judgeSpend: { ...NO_SPEND, ...(raw.judgeSpend ?? {}) },
    workerSpend: { ...NO_SPEND, ...(raw.workerSpend ?? {}) },
  }
}
