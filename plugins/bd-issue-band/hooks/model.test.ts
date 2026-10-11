import { test, expect } from 'claude-code/testing'

import type { BandState, Issue } from '../types'
import { EMPTY, STALE_MS, applyEvent, applyProbe, applyRefresh, bandModel, fit, isStale, takeStaleToast, touch } from './lib/model'

const T0 = 1_000_000_000
const MIN = 60_000

/** The issue a state holds under `id`; a test that expects one fails loudly without it. */
function held(state: BandState, id: string): Issue {
  const issue = state.issues[id]
  if (issue === undefined) throw new Error(`state holds no ${id}`)
  return issue
}

test('EMPTY holds nothing and shows nothing', () => {
  expect(bandModel(EMPTY, T0)).toEqual({ kind: 'none' })
})

test('a claim adds the issue and focuses it', () => {
  const s = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  expect(s.focus).toBe('app-1')
  expect(held(s, 'app-1').claimedAt).toBe(T0)
  expect(held(s, 'app-1').title).toBe('')
  expect(bandModel(s, T0 + 5 * MIN)).toEqual({
    kind: 'issue', id: 'app-1', title: '', minutes: 5, isStale: false, more: 0, error: null, hasComment: false,
  })
})

test('the band knows whether anyone has commented on the issue', () => {
  const claimed = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  const before = bandModel(claimed, T0 + 5 * MIN)
  expect(before.kind === 'issue' && before.hasComment).toBe(false)
  const commented = applyEvent(claimed, { kind: 'comment', ids: ['app-1'] }, T0 + 2 * MIN)
  const after = bandModel(commented, T0 + 5 * MIN)
  expect(after.kind === 'issue' && after.hasComment).toBe(true)
  expect(after.kind === 'issue' && after.minutes).toBe(3)
})

test('a comment resets the clock and adopts an unknown issue', () => {
  const s = applyEvent(EMPTY, { kind: 'comment', ids: ['app-9'] }, T0)
  expect(s.focus).toBe('app-9')
  expect(held(s, 'app-9').lastCommentAt).toBe(T0)
})

test('closing several removes them and moves the focus', () => {
  let s = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  s = applyEvent(s, { kind: 'claim', ids: ['app-2'] }, T0)
  s = applyEvent(s, { kind: 'claim', ids: ['app-3'] }, T0)
  s = applyEvent(s, { kind: 'close', ids: ['app-2', 'app-3'] }, T0)
  expect(Object.keys(s.issues)).toEqual(['app-1'])
  expect(s.focus).toBe('app-1')
  s = applyEvent(s, { kind: 'close', ids: ['app-1'] }, T0)
  expect(s.focus).toBe(null)
})

test('edits count only while nothing is held', () => {
  let s = applyEvent(EMPTY, { kind: 'edit', path: '/repo/a.ts' }, T0)
  s = applyEvent(s, { kind: 'edit', path: '/repo/b.ts' }, T0)
  expect(bandModel(s, T0)).toEqual({ kind: 'unclaimed', edits: 2 })
  s = applyEvent(s, { kind: 'claim', ids: ['app-1'] }, T0)
  expect(s.edits).toBe(0)
  s = applyEvent(s, { kind: 'edit', path: '/repo/c.ts' }, T0)
  expect(s.edits).toBe(0)
})

test('stale needs both thirty minutes and activity since the mark', () => {
  const claimed = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  const idle = held(claimed, 'app-1')
  expect(isStale(idle, T0 + 120 * MIN)).toBe(false)
  const worked = held(touch(claimed, T0 + 10 * MIN), 'app-1')
  expect(isStale(worked, T0 + STALE_MS - 1)).toBe(false)
  expect(isStale(worked, T0 + STALE_MS)).toBe(true)
})

test('a comment clears staleness', () => {
  let s = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  s = touch(s, T0 + 10 * MIN)
  s = applyEvent(s, { kind: 'comment', ids: ['app-1'] }, T0 + 40 * MIN)
  expect(isStale(held(s, 'app-1'), T0 + 45 * MIN)).toBe(false)
})

test('touch writes at most once a minute', () => {
  const s = touch(applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0), T0 + 2 * MIN)
  expect(touch(s, T0 + 2 * MIN + 30_000)).toBe(s)
})

test('a refresh fills the title, takes the newer comment time, drops a closed issue', () => {
  let s = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  s = applyRefresh(s, 'app-1', { title: 'Fix it', status: 'in_progress' }, T0 - 5 * MIN)
  expect(held(s, 'app-1').title).toBe('Fix it')
  expect(held(s, 'app-1').lastCommentAt).toBe(T0 - 5 * MIN)
  expect(s.error).toBe(null)
  s = applyRefresh(s, 'app-1', null, null)
  expect(s.error).toBe('bd unavailable')
  expect(held(s, 'app-1').title).toBe('Fix it')
  s = applyRefresh(s, 'app-1', { title: 'Fix it', status: 'closed' }, null)
  expect(s.issues['app-1']).toBeUndefined()
  expect(s.focus).toBe(null)
})

test('the band counts the other issues held', () => {
  let s = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  s = applyEvent(s, { kind: 'claim', ids: ['app-2'] }, T0)
  const m = bandModel(s, T0)
  expect(m.kind === 'issue' && m.id).toBe('app-2')
  expect(m.kind === 'issue' && m.more).toBe(1)
})

test('fit cuts with an ellipsis and leaves short text alone', () => {
  expect(fit('short', 10)).toBe('short')
  expect(fit('a long title here', 8)).toBe('a long …')
  expect(fit('anything', 0)).toBe('')
})

test('a stale episode is announced once, and again only after a new comment goes stale', () => {
  let s = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  s = touch(s, T0 + 10 * MIN)
  expect(takeStaleToast(s, T0 + 20 * MIN).id).toBe(null)
  const first = takeStaleToast(s, T0 + 31 * MIN)
  expect(first.id).toBe('app-1')
  expect(takeStaleToast(first.state, T0 + 40 * MIN).id).toBe(null)
  let again = applyEvent(first.state, { kind: 'comment', ids: ['app-1'] }, T0 + 41 * MIN)
  again = touch(again, T0 + 50 * MIN)
  expect(takeStaleToast(again, T0 + 72 * MIN).id).toBe('app-1')
})

test('where no tracker is found edits are not counted, and a claim wakes the band', () => {
  const counted = applyEvent(EMPTY, { kind: 'edit', path: '/a' }, T0)
  expect(counted.edits).toBe(1)
  const dormant = applyProbe(counted, false)
  expect(dormant.isTracked).toBe(false)
  expect(dormant.edits).toBe(0)
  expect(bandModel(dormant, T0)).toEqual({ kind: 'none' })
  expect(applyEvent(dormant, { kind: 'edit', path: '/a' }, T0).edits).toBe(0)

  const woken = applyEvent(dormant, { kind: 'claim', ids: ['app-1'] }, T0)
  expect(woken.isTracked).toBe(true)
  const closed = applyEvent(woken, { kind: 'close', ids: ['app-1'] }, T0)
  expect(applyEvent(closed, { kind: 'edit', path: '/a' }, T0).edits).toBe(1)
})

test('a probe that finds no tracker does not undo a claim seen first', () => {
  const claimed = applyEvent(EMPTY, { kind: 'claim', ids: ['app-1'] }, T0)
  expect(applyProbe(claimed, false).isTracked).toBe(true)
  expect(applyProbe(EMPTY, true).isTracked).toBe(true)
})
