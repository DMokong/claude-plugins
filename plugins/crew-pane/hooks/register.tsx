import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  COLUMN_GAP,
  EMPTY,
  alerts,
  countColor,
  divider,
  headerCells,
  joinCrew,
  layout,
  memberCells,
  statusText,
  streamColumns,
  streamCounts,
  streamHeader,
  streamLead,
} from './lib/crew'
import { parseAgents, parseRegistry, parseStream, parseTabs, parseWorkspaces } from './lib/sources'
import type { CrewState, StreamSummary } from '../types'

const crew = atom({ plugin: 'crew-pane', key: 'crew' } as const, EMPTY)

const PANE = 'crew'
const POLL_MS = 10_000
const SLOW_EVERY = 6 // polls: 6 x 10 s = once a minute
const HERDR_TIMEOUT_MS = 5_000
const STREAMS_DIR = 'docs/fable-streams'
const MAX_STREAMS = 2
const FOCUS_HINT = '* focused tab'

/** A repo-relative path made absolute under the session's directory, so it never depends on where the host resolves it. */
function inSession(path: string): string {
  return cwd === '' ? path : `${cwd}/${path}`
}

// The engine follows `$` only into functions declared at the top of this file, so what the
// hooks share lives here rather than in `register`'s closure. `register` sets the options.
let isOff = false
let isSpeaking = false
let myPane = ''
let cwd = ''
let registryDir: string | null = null
let ticks = 0
// Files are re-read only when their modification time moves.
const fileCache = new Map<string, { mtimeMs: number; text: string }>()

async function readCached($: EngineInterface, path: string, mtimeMs: number): Promise<string> {
  const hit = fileCache.get(path)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.text
  const text = String(await $.fs.read(path))
  fileCache.set(path, { mtimeMs, text })
  return text
}

async function findRegistryDir($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? ''
  const stateHome = (await $.env.get('XDG_STATE_HOME')) ?? (home === '' ? '' : `${home}/.local/state`)
  const candidates = [
    (await $.env.get('JUTSU_STATE_DIR')) ?? '',
    stateHome === '' ? '' : `${stateHome}/herdr-jutsu`,
    inSession('.jutsu/state'),
  ]
  for (const candidate of candidates) {
    if (candidate !== '' && (await $.fs.exists(candidate))) return candidate
  }
  return null
}

async function readRegistry($: EngineInterface): Promise<string[]> {
  if (registryDir === null) registryDir = await findRegistryDir($)
  if (registryDir === null) return []
  const dir = registryDir
  const entries = (await $.fs.list(dir))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  const texts: string[] = []
  for (const entry of entries) texts.push(await readCached($, `${dir}/${entry.name}`, entry.mtimeMs))
  return texts
}

async function readStreams($: EngineInterface): Promise<StreamSummary[]> {
  const found: { mtimeMs: number; summary: StreamSummary }[] = []
  const root = inSession(STREAMS_DIR)
  for (const dir of await $.fs.list(root)) {
    if (dir.kind !== 'dir') continue
    const ledger = (await $.fs.list(`${root}/${dir.name}`)).find(entry => entry.name === 'stream.md')
    if (ledger === undefined) continue
    const summary = parseStream(await readCached($, `${root}/${dir.name}/stream.md`, ledger.mtimeMs))
    if (summary !== null && summary.phase !== 'done') found.push({ mtimeMs: ledger.mtimeMs, summary })
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_STREAMS).map(item => item.summary)
}

/** The output of `herdr <noun> list`, or '' when it could not be read. Never throws. */
async function listing($: EngineInterface, noun: 'tab' | 'workspace'): Promise<string> {
  try {
    const listed = await $.process.run(['herdr', noun, 'list'], { timeoutMs: HERDR_TIMEOUT_MS })
    return listed.exitCode === 0 ? listed.stdout : ''
  } catch {
    return ''
  }
}

/** One read of every source into state, then the status line and any alerts. Never throws. */
async function poll($: EngineInterface, withStreams: boolean): Promise<void> {
  try {
    const before = await read($, crew)
    const listed = await $.process.run(['herdr', 'agent', 'list'], { timeoutMs: HERDR_TIMEOUT_MS })
    const agents = listed.exitCode === 0 ? parseAgents(listed.stdout) : null
    if (agents === null) {
      await update($, crew, state => ({ ...state, error: 'herdr unavailable' }))
      return
    }
    // Where herdr shows each pane. Read-only like the agent list, and optional: without them
    // the WHERE column falls back to the tab id.
    const tabs = parseTabs(await listing($, 'tab'))
    const workspaces = parseWorkspaces(await listing($, 'workspace'))
    const rows = parseRegistry(await readRegistry($))
    const streams = withStreams ? await readStreams($).catch(() => before.streams) : before.streams
    const now = await $.clock.now()
    const members = joinCrew({ rows, agents, myPane, showAll: before.showAll, prev: before.members, now, tabs, workspaces })
    await update($, crew, state => ({ ...state, members, streams, error: null }))
    $.ui.status(statusText(members))
    for (const alert of alerts(before.members, members)) {
      $.ui.toast(alert.text)
      if (alert.isBlocked && isSpeaking) void $.audio.speak(alert.text).catch(() => {})
    }
  } catch {
    await update($, crew, state => ({ ...state, error: 'crew sources unavailable' })).catch(() => {})
  }
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

export const register: Register = (on, options) => {
  isOff = options.enabled === 'off'
  isSpeaking = options.speak === 'on'

  on('session.start', async ($, e, next) => {
    if ((await $.env.get('DMOKONG_MODS')) === '0') isOff = true
    if (isOff || !e.isInteractive) return next(e)
    cwd = e.cwd
    await $.command.register({ name: 'crew', description: 'Open the crew pane: herdr members and the conducted stream' })
    const isInside = (await $.env.get('HERDR_ENV')) === '1'
    if (isInside) myPane = (await $.env.get('HERDR_PANE_ID')) ?? ''
    // What a draw depends on lives in state, so writing it redraws a pane drawn before this ran.
    const environment: CrewState['environment'] = isInside ? 'inside' : 'outside'
    await update($, crew, state => ({ ...state, environment }))
    if (!isInside) return next(e)

    $.clock.after(0, () => void poll($, true))
    $.clock.every(POLL_MS, () => {
      void (async () => {
        ticks += 1
        const isSlowTick = ticks % SLOW_EVERY === 0
        const { members } = await read($, crew)
        if (!isSlowTick && members.length === 0 && !(await isPaneShown($))) return
        await poll($, isSlowTick)
      })().catch(() => {})
    })
    return next(e)
  })

  on('command.run', { command: 'crew' }, async $ => {
    // Before session.start has said where it runs, the first poll is session.start's own.
    if ((await read($, crew)).environment === 'inside') await poll($, true)
    await $.ui.open({ id: PANE, title: 'Crew' })
    const { members } = await read($, crew)
    return { text: `Crew pane opened: ${members.length} ${members.length === 1 ? 'member' : 'members'}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // Read the state before any early return, so every draw subscribes and a later write redraws it.
    const state = await read($, crew)
    if (state.environment === 'unknown') {
      return (
        <Box>
          <Text dimColor>Starting…</Text>
        </Box>
      )
    }
    if (state.environment === 'outside') {
      return (
        <Box>
          <Text dimColor>Not inside herdr. The crew pane only reads a herdr session it is running in.</Text>
        </Box>
      )
    }
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const shape = layout(state.members, width, now)
    const summary = statusText(state.members)
    const streamCols = streamColumns(state.streams, width)
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="claude">
            {state.showAll ? 'All herdr agents' : 'My crew'}
          </Text>
          {summary !== undefined && <Text color="inactive">{`  ${summary.replace(/^crew /, '')}`}</Text>}
        </Box>
        {state.members.length === 0 && (
          <Text dimColor>{state.showAll ? 'No other live herdr agents.' : 'No crew spawned from this pane.'}</Text>
        )}
        {state.members.length > 0 && (
          <Box>
            {headerCells(shape).map((cell, at) => (
              <Text key={`head-${cell.key}`} wrap="truncate-end" bold underline color={cell.color}>
                {at === 0 ? cell.text : COLUMN_GAP + cell.text}
              </Text>
            ))}
          </Box>
        )}
        {state.members.map(member => (
          <Box>
            {memberCells(member, now, shape).map((cell, at) => (
              <Text
                key={`${member.paneId}-${cell.key}`}
                wrap="truncate-end"
                color={cell.color}
                bold={cell.bold === true}
                dimColor={cell.dim === true}
              >
                {at === 0 ? cell.text : COLUMN_GAP + cell.text}
              </Text>
            ))}
          </Box>
        ))}
        {state.members.some(member => member.isFocusedTab === true) && (
          <Text wrap="truncate-end" color="inactive">
            {FOCUS_HINT}
          </Text>
        )}
        {state.streams.length > 0 && (
          <Box flexDirection="column">
            <Text wrap="truncate-end" color="inactive" dimColor>
              {divider(width)}
            </Text>
            <Box>
              {streamHeader(streamCols).map((heading, at) => (
                <Text wrap="truncate-end" bold underline color="text">
                  {at === 0 ? heading : COLUMN_GAP + heading}
                </Text>
              ))}
            </Box>
            {state.streams.map(stream => (
              <Box flexDirection="column">
                <Box>
                  <Text bold wrap="truncate-end">
                    {streamLead(stream, streamCols).name}
                  </Text>
                  <Text color="claude">{COLUMN_GAP + streamLead(stream, streamCols).phase}</Text>
                  {streamCounts(stream).map(({ status, count }, at) => (
                    <Text color={countColor(status)}>{`${at === 0 ? COLUMN_GAP : ' · '}${count} ${status}`}</Text>
                  ))}
                </Box>
                {stream.running.map(task => (
                  <Text wrap="truncate-end" color="suggestion">
                    {`  ↳ ${task}`}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
        <Text wrap="truncate-end" color="inactive" dimColor>
          {divider(width)}
        </Text>
        {state.error !== null && <Text color="warning">{state.error}</Text>}
        <Box>
          <Button
            key="all"
            hotkey="a"
            label={state.showAll ? 'Mine' : 'All'}
            onPress={async () => {
              await update($, crew, s => ({ ...s, showAll: !s.showAll }))
              await poll($, false)
            }}
          />
          <Text> </Text>
          <Button key="refresh" hotkey="r" variant="primary" label="Refresh" onPress={() => poll($, true)} />
        </Box>
      </Box>
    )
  })
}
