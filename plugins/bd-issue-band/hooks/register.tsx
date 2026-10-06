import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { parseLastComment, parseShow } from './lib/bd'
import type { IssueInfo } from './lib/bd'
import { detect, isExempt } from './lib/detect'
import { EMPTY, applyEvent, applyProbe, applyRefresh, bandModel, fit, staleMark, takeStaleToast, touch } from './lib/model'

const band = atom({ plugin: 'bd-issue-band', key: 'band' } as const, EMPTY)
const BD_TIMEOUT_MS = 8_000
const TICK_MS = 60_000
const REFRESH_MS = 5 * 60_000

/** What bd says about one issue; `info` is null when it could not be read. Never throws. */
async function readIssue($: EngineInterface, id: string): Promise<{ info: IssueInfo | null; last: number | null }> {
  try {
    const shown = await $.process.run(['bd', 'show', id, '--json'], { timeoutMs: BD_TIMEOUT_MS })
    const info = shown.exitCode === 0 ? parseShow(shown.stdout) : null
    if (info === null) return { info: null, last: null }
    const listed = await $.process.run(['bd', 'comments', id, '--json'], { timeoutMs: BD_TIMEOUT_MS })
    return { info, last: listed.exitCode === 0 ? parseLastComment(listed.stdout) : null }
  } catch {
    return { info: null, last: null }
  }
}

/** Reads one issue from bd and folds it into the state. Never throws. */
async function refresh($: EngineInterface, id: string): Promise<void> {
  try {
    const { info, last } = await readIssue($, id)
    await update($, band, state => applyRefresh(state, id, info, last))
  } catch {
    // The state write failed; the band keeps what it showed.
  }
}

/** Asks bd once whether a tracker resolves from the session's directory. Never throws. */
async function probe($: EngineInterface): Promise<void> {
  let isTracked = false
  try {
    const where = await $.process.run(['bd', 'where'], { timeoutMs: BD_TIMEOUT_MS })
    isTracked = where.exitCode === 0
  } catch {
    // No bd on PATH, or it did not answer in time: the same as no tracker.
  }
  await update($, band, state => applyProbe(state, isTracked)).catch(() => {})
}

let home = ''

/**
 * What the mod does after a tool call has run. Never throws into the call path.
 * Declared at the top of the file: the engine only follows `$` into top-level functions.
 */
async function observe($: EngineInterface, call: Record<string, unknown>): Promise<void> {
  const now = await $.clock.now()
  const event = detect(call)
  if (event === null) {
    await update($, band, state => touch(state, now))
    return
  }
  if (event.kind === 'edit') {
    if (home === '') home = (await $.env.get('HOME')) ?? ''
    if (isExempt(event.path, home)) return
    const before = await read($, band)
    if (before.isTracked === false) return
    await update($, band, state => touch(applyEvent(state, event, now), now))
    if (Object.keys(before.issues).length === 0 && before.edits === 0) {
      $.ui.toast('Editing with no bd issue claimed')
    }
    return
  }
  await update($, band, state => applyEvent(state, event, now))
  if (event.kind === 'close') {
    $.ui.toast(`${event.ids.join(', ')} closed`)
    return
  }
  for (const id of event.ids) void refresh($, id)
}

export const register: Register = (on, options) => {
  let isOff = options.enabled === 'off'

  on('session.start', async ($, e, next) => {
    if ((await $.env.get('DMOKONG_MODS')) === '0') isOff = true
    // A headless run (claude -p) has nobody to draw for: no timers, no command.
    if (isOff || !e.isInteractive) return next(e)

    await $.command.register({
      name: 'issue',
      description: 'Show the bd issue band, or adopt an issue: /issue app-abc',
    })
    // Not awaited: start-up never waits for bd. Until it answers the band behaves as before.
    void probe($)

    $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        let announced: { id: string; minutes: number } | null = null
        await update($, band, state => {
          const taken = takeStaleToast(state, now)
          const held = taken.id === null ? undefined : state.issues[taken.id]
          announced = taken.id === null || held === undefined
            ? null
            : { id: taken.id, minutes: Math.floor((now - staleMark(held)) / 60_000) }
          return { ...taken.state, tick: Math.floor(now / TICK_MS) }
        })
        if (announced !== null) {
          const { id, minutes } = announced
          $.ui.toast(`${id}: ${minutes} min with no comment`)
        }
      })().catch(() => {})
    })

    $.clock.every(REFRESH_MS, () => {
      void (async () => {
        const { focus } = await read($, band)
        if (focus !== null) await refresh($, focus)
      })().catch(() => {})
    })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const answer = await next(e)
    if (isOff || answer.deny !== undefined || answer.isError === true) return answer
    try {
      await observe($, e as unknown as Record<string, unknown>)
    } catch {
      // Observation is best effort; the tool's answer is what matters.
    }
    return answer
  })

  on('command.run', { command: 'issue' }, async ($, e) => {
    const id = e.args.trim()
    if (id === '') {
      await update($, band, state => ({ ...state, isHidden: false }))
      const state = await read($, band)
      const held = Object.keys(state.issues)
      if (held.length === 0 && state.isTracked === false) {
        return { text: 'No bd tracker found from this directory; the band is dormant.' }
      }
      return { text: held.length === 0 ? 'No bd issue held by this session.' : `Holding ${held.join(', ')}.` }
    }
    if (!/^[a-z][a-z0-9]*-[a-z0-9]+(\.[0-9]+)*$/.test(id)) {
      return { text: `"${id}" is not a bd issue id.` }
    }
    // Read first: an id bd cannot read, or one that is closed, never reaches the band.
    const { info, last } = await readIssue($, id)
    if (info === null) return { text: `Could not read ${id} from bd; the band is unchanged.` }
    if (info.status === 'closed') return { text: `${id} is closed.` }
    const now = await $.clock.now()
    await update($, band, state => {
      const adopted = applyRefresh(applyEvent(state, { kind: 'claim', ids: [id] }, now), id, info, last)
      const held = adopted.issues[id]
      if (held === undefined || held.lastCommentAt === null) return adopted
      // An adopted issue was claimed in an earlier session, so no later than its last comment:
      // without this the band would read 0m ago from the moment of adoption.
      const claimedAt = Math.min(held.claimedAt, held.lastCommentAt)
      return { ...adopted, issues: { ...adopted.issues, [id]: { ...held, claimedAt } } }
    })
    return { text: `Band now follows ${id}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOff || e.props.hasSurvey) return next(e)
    const state = await read($, band)
    const model = bandModel(state, await $.clock.now())
    if (state.isHidden || model.kind === 'none') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const hide = <Button key="hide" label="Hide" onPress={() => update($, band, s => ({ ...s, isHidden: true }))} />

    if (model.kind === 'unclaimed') {
      return (
        <Box>
          <Text key="line" color="warning">
            No bd issue claimed · {model.edits} {model.edits === 1 ? 'edit' : 'edits'} this session{' '}
          </Text>
          {hide}
        </Box>
      )
    }

    const since = model.hasComment ? `last comment ${model.minutes}m ago` : `no comment yet · claimed ${model.minutes}m ago`
    const tail = ` · ${since}${model.more > 0 ? ` · +${model.more} more` : ''} `
    const room = (e.props.bodyColumns ?? 80) - model.id.length - tail.length - 30
    const title = model.title === '' ? '' : ` · ${fit(model.title, Math.max(8, room))}`
    return (
      <Box>
        <Text key="line" color={model.isStale ? 'warning' : undefined} dimColor={!model.isStale}>
          {model.id}
          {title}
          {tail}
        </Text>
        {model.error !== null && <Text key="error" dimColor>{model.error} </Text>}
        <Button
          key="comment"
          label="Comment"
          onPress={() => $.prompt.fill({ text: `Post a bd comment on ${model.id}: `, mode: 'insert' })}
        />
        <Text> </Text>
        {hide}
      </Box>
    )
  })
}
