import { NO_SPEND } from './cost'
import type { Entry, SidekickState } from '../../types'

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
  }
}

function migrateEntry(raw: Partial<Entry>): Entry {
  return {
    id: '',
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
    ...raw,
    judgeSpend: { ...NO_SPEND, ...(raw.judgeSpend ?? {}) },
    workerSpend: { ...NO_SPEND, ...(raw.workerSpend ?? {}) },
  }
}
