import { test, expect } from 'claude-code/testing'

import { parseLastComment, parseShow } from './lib/bd'

test('parseShow reads title and status from the one-element array', () => {
  const out = JSON.stringify([{ id: 'app-1', title: 'Fix it', status: 'in_progress' }])
  expect(parseShow(out)).toEqual({ title: 'Fix it', status: 'in_progress' })
})

test('parseShow answers null for junk, an empty array, or a missing title', () => {
  expect(parseShow('Error: no such issue')).toBe(null)
  expect(parseShow('[]')).toBe(null)
  expect(parseShow(JSON.stringify([{ id: 'app-1' }]))).toBe(null)
})

test('parseLastComment takes the newest created_at whatever the order', () => {
  const out = JSON.stringify([
    { text: 'b', created_at: '2026-09-30T22:41:16Z' },
    { text: 'a', created_at: '2026-09-30T22:13:44Z' },
  ])
  expect(parseLastComment(out)).toBe(Date.parse('2026-09-30T22:41:16Z'))
})

test('parseLastComment answers null with no comments or junk', () => {
  expect(parseLastComment('[]')).toBe(null)
  expect(parseLastComment('null')).toBe(null)
  expect(parseLastComment('not json')).toBe(null)
})

test('malformed array rows fail open', () => {
  expect(parseShow('[null]')).toBe(null)
  expect(parseLastComment('[null]')).toBe(null)
})
