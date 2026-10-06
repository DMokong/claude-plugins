import type { BandState, Issue } from '../../types'
import type { IssueInfo } from './bd'
import type { BdEvent } from './detect'

export const STALE_MS = 30 * 60_000
const TOUCH_EVERY_MS = 60_000

export const EMPTY: BandState = {
  issues: {},
  focus: null,
  edits: 0,
  isHidden: false,
  error: null,
  tick: 0,
}

export type BandModel =
  | { kind: 'none' }
  | { kind: 'unclaimed'; edits: number }
  | {
      kind: 'issue'
      id: string
      title: string
      minutes: number
      isStale: boolean
      more: number
      error: string | null
      /** Whether anyone is known to have commented; `minutes` runs from the claim when not. */
      hasComment: boolean
    }

function fresh(id: string, now: number): Issue {
  return { id, title: '', claimedAt: now, lastCommentAt: null, lastActivityAt: now, toastedMark: null }
}

function without(state: BandState, ids: readonly string[]): BandState {
  const issues = { ...state.issues }
  for (const id of ids) delete issues[id]
  const left = Object.keys(issues)
  const focus = state.focus !== null && issues[state.focus] !== undefined ? state.focus : left[left.length - 1] ?? null
  return { ...state, issues, focus }
}

export function applyEvent(state: BandState, event: BdEvent, now: number): BandState {
  if (event.kind === 'edit') {
    return Object.keys(state.issues).length === 0 ? { ...state, edits: state.edits + 1 } : state
  }
  if (event.kind === 'close') return without(state, event.ids)
  const issues = { ...state.issues }
  for (const id of event.ids) {
    const held = issues[id] ?? fresh(id, now)
    issues[id] = event.kind === 'comment' ? { ...held, lastCommentAt: now, toastedMark: null } : held
  }
  return { ...state, issues, focus: event.ids[event.ids.length - 1] ?? null, edits: 0, isHidden: false }
}

export function applyRefresh(
  state: BandState,
  id: string,
  info: IssueInfo | null,
  lastCommentAt: number | null,
): BandState {
  const held = state.issues[id]
  if (held === undefined) return state
  if (info === null) return { ...state, error: 'bd unavailable' }
  if (info.status === 'closed') return { ...without(state, [id]), error: null }
  const newest =
    lastCommentAt === null ? held.lastCommentAt : Math.max(lastCommentAt, held.lastCommentAt ?? 0)
  return {
    ...state,
    error: null,
    issues: { ...state.issues, [id]: { ...held, title: info.title, lastCommentAt: newest } },
  }
}

/** Records that the session did something while holding the focus issue. */
export function touch(state: BandState, now: number): BandState {
  const held = state.focus === null ? undefined : state.issues[state.focus]
  if (held === undefined || now - held.lastActivityAt < TOUCH_EVERY_MS) return state
  return { ...state, issues: { ...state.issues, [held.id]: { ...held, lastActivityAt: now } } }
}

/** The moment staleness is measured from: the later of the claim and the last comment. */
export function staleMark(issue: Issue): number {
  return Math.max(issue.claimedAt, issue.lastCommentAt ?? 0)
}

export function isStale(issue: Issue, now: number): boolean {
  const mark = staleMark(issue)
  return now - mark >= STALE_MS && issue.lastActivityAt > mark
}

/** The focus issue's id, once per stale episode; the state remembers it was announced. */
export function takeStaleToast(state: BandState, now: number): { state: BandState; id: string | null } {
  const held = state.focus === null ? undefined : state.issues[state.focus]
  if (held === undefined || !isStale(held, now)) return { state, id: null }
  const mark = staleMark(held)
  if (held.toastedMark === mark) return { state, id: null }
  return {
    id: held.id,
    state: { ...state, issues: { ...state.issues, [held.id]: { ...held, toastedMark: mark } } },
  }
}

export function bandModel(state: BandState, now: number): BandModel {
  const held = state.focus === null ? undefined : state.issues[state.focus]
  if (held === undefined) {
    return state.edits > 0 ? { kind: 'unclaimed', edits: state.edits } : { kind: 'none' }
  }
  return {
    kind: 'issue',
    id: held.id,
    title: held.title,
    minutes: Math.max(0, Math.floor((now - staleMark(held)) / 60_000)),
    isStale: isStale(held, now),
    more: Object.keys(state.issues).length - 1,
    error: state.error,
    hasComment: held.lastCommentAt !== null,
  }
}

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}
