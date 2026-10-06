import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'bd-issue-band',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
const MIN = 60_000

/** `/issue <args>` as the person types it at the prompt. */
const issue = (args: string) =>
  ({
    command: 'issue',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ran = (stdout: string, exitCode = 0): { value: Run } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** Answers the mod's `bd show` and `bd comments` reads. */
function bd(on: On, title: string, comments: string[] = []) {
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[1] === 'show') return ran(JSON.stringify([{ title, status: 'in_progress' }]))
    return ran(JSON.stringify(comments.map(created_at => ({ created_at }))))
  })
}

/**
 * What the engine draws when the mod yields the band. Nothing beneath the plugins answers
 * `ui.render` in a test, so a mount where the mod passes would reject without it.
 */
function blank(on: On) {
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({}))
}

/**
 * The bottoms of `session.start` (core echoes the cwd) and `command.register`, which nothing
 * answers in a test. Returns the names the mod registered.
 */
function booted(on: On): string[] {
  const registered: string[] = []
  on('session.start', async (_$, e) => ({ cwd: (e as { cwd: string }).cwd }))
  on('command.register', async (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  return registered
}

/** The bottom of `ui.toast`, which nothing answers in a test; returns what was shown. */
function toasts(on: On): string[] {
  const shown: string[] = []
  on('ui.toast', async (_$, e) => {
    shown.push(String((e as { text: unknown }).text))
    return { value: undefined }
  })
  return shown
}

test('a successful claim puts the issue on the band', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  bd(on, '[12] A1: an example issue title')
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '✓ Updated issue' } }))
  await $.tool.call({ tool: 'Bash', command: 'bd update app-12a.32 --claim --actor exampleapp' })
  await clock.advance(5 * MIN)
  const ui = await $.ui.mount(BAND)
  const line = (await ui.find({ type: 'Text', text: /app-12a\.32/ }))?.text ?? ''
  expect(line).toContain('app-12a.32')
  expect(line).toContain('[12] A1')
  expect(line).toContain('5m')
  expect(await ui.find({ key: 'comment' })).toBeDefined()
  await ui.unmount()
})

test('a fresh claim with no comments says so, and a comment changes the wording', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  bd(on, 'Fix it')
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'ok' } }))
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  await clock.advance(4 * MIN)
  const ui = await $.ui.mount(BAND)
  const fresh = (await ui.find({ type: 'Text', text: /app-1/ }))?.text ?? ''
  expect(fresh).toContain('no comment yet')
  expect(fresh).toContain('claimed 4m ago')
  expect(fresh).not.toContain('last comment')
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'bd comment app-1 "gates green"' })
  await clock.advance(1 * MIN)
  const again = await $.ui.mount(BAND)
  const commented = (await again.find({ type: 'Text', text: /app-1/ }))?.text ?? ''
  expect(commented).toContain('last comment 1m ago')
  expect(commented).not.toContain('no comment yet')
  await again.unmount()
})

test('a failed claim puts nothing on the band', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  blank(on)
  bd(on, 'never read')
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '' }, isError: true }))
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim --actor exampleapp' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /app-1/ })).toBeUndefined()
  await ui.unmount()
})

test('bd failing leaves the id with a dim reason and the tool call untouched', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  on('process.run', async () => ran('', 1))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'ok' } }))
  const answer = await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  expect(answer.deny).toBeUndefined()
  await clock.settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /app-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /bd unavailable/ })).toBeDefined()
  await ui.unmount()
})

test('edits with nothing claimed show the nudge, and exempt paths do not count', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const shown = toasts(on)
  on('tool.call', async () => ({ result: {} }))
  await $.tool.call({ tool: 'Edit', file_path: '/tmp/scratch.txt', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/home/me/projects/exampleapp/a.ts', old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /No bd issue claimed/ }))?.text).toContain('1 edit')
  expect(shown).toEqual(['Editing with no bd issue claimed'])
  await ui.unmount()
})

test('closing the issue clears the band', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  blank(on)
  const shown = toasts(on)
  bd(on, 'Fix it')
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'ok' } }))
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  await $.tool.call({ tool: 'Bash', command: 'bd close app-1 --reason=done' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /app-1/ })).toBeUndefined()
  expect(shown).toEqual(['app-1 closed'])
  await ui.unmount()
})

test('thirty minutes with activity and no comment turns the band to warning and toasts once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, {})
  booted(on)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => { toasts.push(String((e as { text: unknown }).text)); return { value: undefined } })
  bd(on, 'Fix it')
  on('tool.call', async () => ({ result: {} }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  await clock.advance(10 * MIN)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await clock.advance(25 * MIN)
  expect(toasts.filter(t => t.includes('app-1') && t.includes('no comment'))).toHaveLength(1)
  await clock.advance(10 * MIN)
  expect(toasts.filter(t => t.includes('no comment'))).toHaveLength(1)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /app-1/ }))?.props?.color).toBe('warning')
  await ui.unmount()
})

test('an idle session never goes stale', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, {})
  booted(on)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => { toasts.push(String((e as { text: unknown }).text)); return { value: undefined } })
  bd(on, 'Fix it')
  on('tool.call', async () => ({ result: {} }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  await clock.advance(120 * MIN)
  expect(toasts.filter(t => t.includes('no comment'))).toHaveLength(0)
})

test('the periodic refresh picks up a comment made elsewhere', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T00:00:00Z') })
  mock.env(on, {})
  booted(on)
  let comments: string[] = []
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    return argv[1] === 'show'
      ? ran(JSON.stringify([{ title: 'Fix it', status: 'in_progress' }]))
      : ran(JSON.stringify(comments.map(created_at => ({ created_at }))))
  })
  on('tool.call', async () => ({ result: {} }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  await clock.advance(20 * MIN)
  comments = ['2026-10-06T00:19:00Z']
  await clock.advance(5 * MIN)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /app-1/ }))?.text).toContain('6m ago')
  await ui.unmount()
})

test('DMOKONG_MODS=0 turns the mod off', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { DMOKONG_MODS: '0' })
  booted(on)
  blank(on)
  bd(on, 'Fix it')
  on('tool.call', async () => ({ result: {} }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /app-1/ })).toBeUndefined()
  await ui.unmount()
})

test('the enabled option set to off turns the mod off', { options: { enabled: 'off' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  blank(on)
  bd(on, 'Fix it')
  on('tool.call', async () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /app-1/ })).toBeUndefined()
  await ui.unmount()
})

test('/issue <id> adopts an issue claimed in an earlier session', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-06T01:00:00Z') })
  mock.env(on, {})
  booted(on)
  bd(on, 'Carried over', ['2026-10-06T00:48:00Z'])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = await $.command.run(issue('app-12a.32'))
  expect(answer.text).toContain('app-12a.32')
  const ui = await $.ui.mount(BAND)
  const line = (await ui.find({ type: 'Text', text: /app-12a\.32/ }))?.text ?? ''
  expect(line).toContain('Carried over')
  expect(line).toContain('12m ago')
  await ui.unmount()
})

/** Holds app-1 on the band, then asks `/issue` for `other`, which bd answers as `answer` does. */
async function refusal(
  $: Engine,
  on: On,
  other: string,
  answer: (argv: string[]) => { value: Run },
) {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, {})
  booted(on)
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[2] === other) return answer(argv)
    if (argv[1] === 'show') return ran(JSON.stringify([{ title: 'Fix it', status: 'in_progress' }]))
    return ran('[]')
  })
  on('tool.call', async () => ({ result: {} }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  const ui = await $.ui.mount(BAND)
  const before = (await ui.find({ type: 'Text', text: /app-1/ }))?.text
  const said = await $.command.run(issue(other))
  const after = (await ui.find({ type: 'Text', text: /app-1/ }))?.text
  const adopted = await ui.find({ type: 'Text', text: new RegExp(other) })
  await ui.unmount()
  return { before, after, adopted, text: said.text }
}

test('/issue refuses an issue bd cannot read and leaves the band as it was', async ($, on) => {
  const r = await refusal($, on, 'app-doesnotexist', () => ran('Error: no such issue', 1))
  expect(r.text).toBe('Could not read app-doesnotexist from bd; the band is unchanged.')
  expect(r.before).toContain('app-1')
  expect(r.after).toBe(r.before)
  expect(r.adopted).toBeUndefined()
})

test('/issue refuses an issue bd shows as closed and leaves the band as it was', async ($, on) => {
  const r = await refusal($, on, 'app-9', () => ran(JSON.stringify([{ title: 'Done long ago', status: 'closed' }])))
  expect(r.text).toBe('app-9 is closed.')
  expect(r.before).toContain('app-1')
  expect(r.after).toBe(r.before)
  expect(r.adopted).toBeUndefined()
})

test('/issue with a bad id says so and adopts nothing', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, {})
  booted(on)
  blank(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = await $.command.run(issue('not an id'))
  expect(answer.text).toContain('not a bd issue id')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'comment' })).toBeUndefined()
  await ui.unmount()
})

test('/issue alone brings a hidden band back', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, {})
  booted(on)
  blank(on)
  bd(on, 'Fix it')
  on('tool.call', async () => ({ result: {} }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'hide' })
  const answer = await $.command.run(issue(''))
  expect(answer.text).toContain('app-1')
  expect(await ui.find({ type: 'Text', text: /app-1/ })).toBeDefined()
  await ui.unmount()
})

test('Hide takes the band down', async ($, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  blank(on)
  bd(on, 'Fix it')
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'ok' } }))
  await $.tool.call({ tool: 'Bash', command: 'bd update app-1 --claim' })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /app-1/ })).toBeUndefined()
  await ui.unmount()
})

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const EDIT = { tool: 'Edit', file_path: '/home/me/projects/app/a.ts', old_string: 'a', new_string: 'b' } as const

/** bd as it answers where no tracker resolves: `bd where` exits 1, and so does everything else. */
function untracked(on: On) {
  on('process.run', async () => ran('Error: No active beads workspace found.', 1))
}

test('with no bd tracker an edit draws nothing and raises no toast', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { HOME: '/home/me' })
  booted(on)
  blank(on)
  const shown = toasts(on)
  untracked(on)
  on('tool.call', async () => ({ result: {} }))
  await $.session.start(START)
  await clock.settle()
  const answer = await $.tool.call(EDIT)
  expect(answer.deny).toBeUndefined()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /No bd issue claimed/ })).toBeUndefined()
  expect(shown).toEqual([])
  await ui.unmount()
})

test('with no bd tracker /issue says the band is dormant', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, {})
  booted(on)
  untracked(on)
  await $.session.start(START)
  await clock.settle()
  expect((await $.command.run(issue(''))).text).toBe('No bd tracker found from this directory; the band is dormant.')
})

test('bd missing from PATH leaves the band dormant and the tool call untouched', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { HOME: '/home/me' })
  booted(on)
  blank(on)
  const shown = toasts(on)
  on('process.run', async () => {
    throw new Error('spawn bd ENOENT')
  })
  on('tool.call', async () => ({ result: {} }))
  await $.session.start(START)
  await clock.settle()
  const answer = await $.tool.call(EDIT)
  expect(answer.deny).toBeUndefined()
  expect(shown).toEqual([])
})

test('a claim wakes a dormant band, and edits count again once it closes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { HOME: '/home/me' })
  booted(on)
  const shown = toasts(on)
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[1] === 'where') return ran('', 1)
    if (argv[1] === 'show') return ran(JSON.stringify([{ title: 'Fix it', status: 'in_progress' }]))
    return ran('[]')
  })
  on('tool.call', async () => ({ result: {} }))
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__beads__claim', issue_id: 'app-1' })
  await clock.settle()
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /app-1/ }))?.text).toContain('Fix it')
  await $.tool.call({ tool: 'Bash', command: 'bd close app-1 --reason=done' })
  await $.tool.call(EDIT)
  expect((await ui.find({ type: 'Text', text: /No bd issue claimed/ }))?.text).toContain('1 edit')
  expect(shown).toEqual(['app-1 closed', 'Editing with no bd issue claimed'])
  await ui.unmount()
})

test('with a tracker the nudge still appears', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { HOME: '/home/me' })
  booted(on)
  const shown = toasts(on)
  on('process.run', async () => ran('/repo/.beads'))
  on('tool.call', async () => ({ result: {} }))
  await $.session.start(START)
  await clock.settle()
  await $.tool.call(EDIT)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /No bd issue claimed/ }))?.text).toContain('1 edit')
  expect(shown).toEqual(['Editing with no bd issue claimed'])
  await ui.unmount()
})

test('a probe that has not answered holds nothing up, and its answer forgets earlier edits', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { HOME: '/home/me' })
  booted(on)
  blank(on)
  toasts(on)
  let answerProbe: (run: { value: Run }) => void = () => {}
  const pending = new Promise<{ value: Run }>(resolve => {
    answerProbe = resolve
  })
  on('process.run', async () => pending)
  on('tool.call', async () => ({ result: {} }))
  // Returns while `bd where` is still unanswered: start-up never waits for bd.
  await $.session.start(START)
  await $.tool.call(EDIT)
  const before = await $.ui.mount(BAND)
  expect(await before.find({ type: 'Text', text: /No bd issue claimed/ })).toBeDefined()
  await before.unmount()

  answerProbe(ran('', 1))
  await clock.settle()
  const after = await $.ui.mount(BAND)
  expect(await after.find({ type: 'Text', text: /No bd issue claimed/ })).toBeUndefined()
  await after.unmount()
})
