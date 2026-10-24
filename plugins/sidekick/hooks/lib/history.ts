/**
 * What the sidekick did across sessions, for the dashboard's Today and Week and the 7-day chart: one
 * row per finished job or pass to Claude, and one row a day for draft judging. Kept in the mod's
 * store, 35 days at most.
 */
import { priceOf } from './cost'
import type { Totals } from '../../types'

export type HistoryRow = {
  at: number
  kind: 'chore' | 'investigate' | 'to-claude' | 'draft'
  status: 'done' | 'partial' | 'stopped' | 'failed' | 'passed' | 'given'
  ms: number
  judgeUsd: number
  workerUsd: number
  /** What the main session didn't have to spend, less what the sidekick spent; 0 when it saved nothing. */
  savedUsd: number
  id: string
  /** Draft rows: how many typing pauses were judged that day. */
  count?: number
}

export const HISTORY_KEY = 'history'
export const KEEP_DAYS = 35
const DAY_MS = 24 * 60 * 60 * 1000

const KINDS: readonly HistoryRow['kind'][] = ['chore', 'investigate', 'to-claude', 'draft']
const STATUSES: readonly HistoryRow['status'][] = ['done', 'partial', 'stopped', 'failed', 'passed', 'given']

/** Local midnight on the day `now` falls in. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Local midnight six calendar days before today's: the Week tab's span, the same seven days as the chart. */
export function weekStart(now: number): number {
  const d = new Date(startOfDay(now))
  d.setDate(d.getDate() - 6)
  return d.getTime()
}

/** Rows as the store holds them, whatever wrote them; anything unreadable is dropped. */
export function toRows(raw: unknown): HistoryRow[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is HistoryRow => {
    if (r === null || typeof r !== 'object') return false
    const row = r as Record<string, unknown>
    return (
      typeof row.at === 'number' &&
      KINDS.includes(row.kind as HistoryRow['kind']) &&
      STATUSES.includes(row.status as HistoryRow['status']) &&
      typeof row.judgeUsd === 'number' &&
      typeof row.workerUsd === 'number' &&
      typeof row.savedUsd === 'number' &&
      typeof row.id === 'string'
    )
  })
}

/** Adds a row, dropping what is older than 35 days; draft spend joins the day's draft row. */
export function appendRow(rows: readonly HistoryRow[], row: HistoryRow, now: number): HistoryRow[] {
  const kept = rows.filter(r => r.at >= now - KEEP_DAYS * DAY_MS)
  if (row.kind === 'draft') {
    const day = startOfDay(row.at)
    const same = kept.findIndex(r => r.kind === 'draft' && startOfDay(r.at) === day)
    if (same >= 0) {
      const merged = { ...kept[same]!, judgeUsd: kept[same]!.judgeUsd + row.judgeUsd, count: (kept[same]!.count ?? 1) + (row.count ?? 1) }
      return kept.map((r, i) => (i === same ? merged : r))
    }
  }
  return [...kept, row]
}

/** A job given to the main session after all: what it saved is spent again. */
export function markGiven(rows: readonly HistoryRow[], id: string): HistoryRow[] {
  return rows.map(r => (r.id === id && (r.kind === 'chore' || r.kind === 'investigate') ? { ...r, status: 'given' as const, savedUsd: 0 } : r))
}

export type { Totals }

export const NO_TOTALS: Totals = { done: 0, chores: 0, looks: 0, toClaude: 0, drafts: 0, costUsd: 0, savedUsd: 0, draftUsd: 0, choreUsd: 0, lookUsd: 0, claudeUsd: 0 }

const isFinished = (r: HistoryRow): boolean => r.status === 'done' || r.status === 'partial'

/** Everything from `from` on, as the tiles and bars count it. */
export function totals(rows: readonly HistoryRow[], from: number): Totals {
  const t = { ...NO_TOTALS }
  for (const r of rows) {
    if (r.at < from) continue
    const spent = r.judgeUsd + r.workerUsd
    t.costUsd += spent
    t.savedUsd += r.savedUsd
    if (r.kind === 'chore') {
      t.choreUsd += spent
      if (isFinished(r)) t.chores += 1
    } else if (r.kind === 'investigate') {
      t.lookUsd += spent
      if (isFinished(r)) t.looks += 1
    } else if (r.kind === 'to-claude') {
      t.toClaude += 1
      t.claudeUsd += spent
    } else {
      t.drafts += r.count ?? 1
      t.draftUsd += spent
    }
  }
  t.done = t.chores + t.looks
  t.savedUsd = Math.max(0, t.savedUsd)
  return t
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export type Day = { label: string; jobs: number; isToday: boolean; savedUsd: number; costUsd: number }

/** Finished jobs, saving and spend per day for the last `days` days, oldest first, today last. */
export function perDay(rows: readonly HistoryRow[], now: number, days = 7): Day[] {
  const today = startOfDay(now)
  return Array.from({ length: days }, (_, i) => {
    // Step back by calendar days, so a daylight-saving change never skips or doubles one.
    const d = new Date(today)
    d.setDate(d.getDate() - (days - 1 - i))
    const start = d.getTime()
    const next = new Date(start)
    next.setDate(next.getDate() + 1)
    const inDay = rows.filter(r => r.at >= start && r.at < next.getTime())
    const jobs = inDay.filter(r => (r.kind === 'chore' || r.kind === 'investigate') && isFinished(r)).length
    const savedUsd = inDay.reduce((n, r) => n + r.savedUsd, 0)
    const costUsd = inDay.reduce((n, r) => n + r.judgeUsd + r.workerUsd, 0)
    return { label: WEEKDAYS[d.getDay()] ?? '', jobs, isToday: start === today, savedUsd, costUsd }
  })
}

export function bestDay(days: readonly Day[]): Day | undefined {
  return days.reduce<Day | undefined>((best, d) => (d.jobs > 0 && (best === undefined || d.jobs > best.jobs) ? d : best), undefined)
}

/** Days in a row with work, ending today. */
export function streak(days: readonly Day[]): number {
  let n = 0
  for (let i = days.length - 1; i >= 0 && (days[i]?.jobs ?? 0) > 0; i -= 1) n += 1
  return n
}

const DEFAULT_CONTEXT = 40_000
const TURN_OUTPUT = 500

/**
 * What one main-session turn would have cost for the job the sidekick took, less what the
 * sidekick spent on it; never below 0. The turn is priced as the main session's context read from
 * cache plus 500 output tokens, at the main model's rates. An estimate, and the tile says so.
 */
export function savedFor(mainModel: string, contextTokens: number | undefined, spentUsd: number): number {
  const price = priceOf(mainModel) ?? priceOf('opus')!
  const context = contextTokens !== undefined && contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT
  const turn = (context * price.input * 0.1) / 1_000_000 + (TURN_OUTPUT * price.output) / 1_000_000
  return Math.max(0, turn - spentUsd)
}
