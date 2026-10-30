import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, PromptSubmitInput, PromptSubmitResult, Register } from 'claude-code'

import { MAX_MISSES, canStart, holdsMain, judgePrompt, judgeSystem, lockKeys, parseJudgment, precheck, taughtVerdict } from './lib/judge'
import type { Judgment } from './lib/judge'
import { NO_SPEND, addTally, modelName, tallyLine, tallyOf, tokens, usd } from './lib/cost'
import { migrate, toTaught } from './lib/state'
import { HISTORY_KEY, NO_TOTALS, appendRow, bestDay, markGiven, perDay, savedFor, startOfDay, streak, toRows, totals, weekStart } from './lib/history'
import type { HistoryRow } from './lib/history'
import { JUDGE_CHIPS, SETTINGS_KEY, WORKER_CHIPS, chipsFor, defaultsFrom, effective, withChange } from './lib/settings'
import { COLORS, barCells, bigText, dayLevels, spaced, tileMoney } from './lib/draw'
import { daysSvg, progressSvg, stackSvg, tileSvg } from './lib/svg'
import { DUMP_KEEP, configRoot, dumpDir, dumpName, dumpText } from './lib/dump'
import type { Call } from './lib/dump'
import {
  chatLine,
  cleanupArgv,
  giveToMainPrompt,
  handoffNote,
  parseOutcome,
  parseStreamEvents,
  splitLines,
  workerArgv,
  workerInput,
} from './lib/worker'
import type { Entry, EntryStatus, Mode, Outcome, Profile, Settings, SidekickState, Taught, Tally } from '../types'

export const EMPTY: SidekickState = {
  mode: 'off',
  entries: [],
  waiting: [],
  notes: [],
  watching: '',
  totals: { assists: 0, passed: 0, failed: 0 },
  spend: NO_SPEND,
  tick: 0,
  isWarming: false,
  learned: [],
  instructions: null,
  settings: defaultsFrom({}),
  panelOpen: false,
  today: NO_TOTALS,
  tab: 'today',
  view: 'dashboard',
  jobId: '',
}

const sidekick = atom({ plugin: 'sidekick', key: 'sidekick' } as const, EMPTY)

/** The session's state, upgraded from whatever version wrote it. */
async function load($: EngineInterface): Promise<SidekickState> {
  return migrate(await read($, sidekick), EMPTY)
}

/** Writes the session's state through `fn`, which always sees it upgraded. */
async function change($: EngineInterface, fn: (state: SidekickState) => SidekickState): Promise<void> {
  await update($, sidekick, state => fn(migrate(state, EMPTY)))
}

const PANE = 'sidekick'
/** Rows asked for inline, past the default third, so a running assist's command and buttons show. */
const PANE_ROWS = 28
/** The control panel's width: room for a setting's name, its note and its pill on one row. */
const PANEL_WIDTH = 72

/** Engines before this refuse a Button holding Text, and any children beside a label. */
const RICH_BUTTONS_SINCE = [2, 1, 308]
const UPDATE_MESSAGE = 'Sidekick needs Claude Code 2.1.308 or later for its full panel: run claude update'

function isBefore(release: string, since: number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(release)?.slice(1).map(Number)
  if (parts === undefined) return false
  const at = parts.findIndex((part, i) => part !== since[i])
  return at !== -1 && parts[at]! < since[at]!
}

/** The surfaces that draw graphics: the desktop app, the editor, the phone. */
type RichSurface = 'desktop' | 'vscode' | 'mobile'

/** The mode as a filled badge, where a graphical surface draws it. */
function richBadge(Text: ElementTable<RichSurface>['Text'], mode: Mode) {
  return mode === 'auto' ? (
    <Text key="mp" bold backgroundColor={COLORS.green} color={COLORS.ink}>{' ● Auto '}</Text>
  ) : mode === 'shadow' ? (
    <Text key="mp" bold backgroundColor={COLORS.purple} color={COLORS.ink}>{' ◌ Shadow '}</Text>
  ) : (
    <Text key="mp" dimColor>{'○ Off'}</Text>
  )
}
// Raised from 1.8 s: a cold or busy judge (2-4 s measured) sent chores to the main session.
// Draft judging still makes the usual wait at Enter close to zero.
const JUDGE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 400
const WORKER_TIMEOUT_MS = 10 * 60_000
const MAX_ENTRIES = 60
const MAX_STEPS = 40
const ACTIVE: readonly EntryStatus[] = ['judging', 'queued', 'running']

// The engine follows `$` only into functions declared at the top of this file, so what the
// hooks share lives here. `register` sets the options; `session.start` the rest.
let isOff = false
/** The plugin's options, as settings: what the panel's Reset to defaults goes back to. */
let defaults: Settings = defaultsFrom({})
/** The settings in force; re-read from the store before each judgment and worker run, so another session's change reaches this one. */
let live: Settings = defaults
let cwd = ''
let guardPath = ''
/** The loaded version, from the plugin's own manifest; shown in the pane so a stale load is visible. */
let version = ''
/** An older engine draws each Button's label alone, without its colours. */
let isLabelOnly = false
/** The person's "should've been sidekick" corrections, across sessions; the judge learns from them. */
let misses: Taught[] = []
const MISSES_KEY = 'missed'
let sequence = 0
/** When the judge's connection was last used; a cold one blows the budget (measured: 1.8 s+ against ~1.2 s warm). */
let lastJudgeAt = 0
type Judged = { judgment: Judgment; ms: number; stateMs: number; repo: string; spend: Tally }
/**
 * The draft judged while it was being typed. A prompt submitted with the same text takes this
 * verdict instead of starting a judge of its own, so the judge's latency hides in typing time.
 */
let speculation: { text: string; judged: Promise<Judged> } | null = null
let draftTimer: { cancel: () => void } | null = null
const DRAFT_PAUSE_MS = 450
/** Live worker processes by entry id. A reload kills them with the module. */
const workers = new Map<string, { stop: () => void }>()

function newId(now: number): string {
  sequence += 1
  return `${now.toString(36)}-${sequence}`
}

function blankEntry(id: string, prompt: string, now: number): Entry {
  return {
    id,
    kind: 'chore',
    prompt,
    status: 'judging',
    verdict: '',
    reason: '',
    judgeMs: 0,
    task: '',
    locks: [],
    backend: live.judgeModel,
    createdAt: now,
    startedAt: 0,
    endedAt: 0,
    steps: [],
    outcome: null,
    isMissed: false,
    judgeSpend: NO_SPEND,
    workerSpend: NO_SPEND,
    dump: '',
  }
}

/** Adds one call's tokens and dollars to the session's spend. */
async function addSpend($: EngineInterface, spend: Tally): Promise<void> {
  if (spend.input + spend.output + spend.cacheRead + spend.cacheWrite5m + spend.cacheWrite1h === 0) return
  await change($, s => ({ ...s, spend: addTally(s.spend, spend) }))
}

async function addEntry($: EngineInterface, entry: Entry): Promise<void> {
  await change($, s => ({ ...s, entries: [entry, ...s.entries].slice(0, MAX_ENTRIES) }))
}

async function patchEntry($: EngineInterface, id: string, patch: (entry: Entry) => Partial<Entry>): Promise<void> {
  await change($, s => ({ ...s, entries: s.entries.map(x => (x.id === id ? { ...x, ...patch(x) } : x)) }))
}

const isActive = (entry: Entry): boolean => ACTIVE.includes(entry.status)

/** Branch, dirtiness and repository root, for the judge. Empty strings where git can't say. */
async function repoState($: EngineInterface): Promise<{ text: string; repo: string }> {
  try {
    const [status, root] = await Promise.all([
      $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { cwd, timeoutMs: STATE_TIMEOUT_MS }),
      $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: STATE_TIMEOUT_MS }),
    ])
    if (status.exitCode !== 0) return { text: `cwd: ${cwd}\nnot a git repository`, repo: cwd }
    const lines = status.stdout.split('\n').filter(line => line !== '')
    const branch = (lines[0] ?? '').replace(/^## /, '')
    const repo = root.exitCode === 0 ? root.stdout.trim() : cwd
    return { text: `repo: ${repo}\nbranch: ${branch}\nuncommitted files: ${lines.length - 1}`, repo }
  } catch {
    return { text: `cwd: ${cwd}`, repo: cwd }
  }
}

/** One judgment within the budget. A timeout or failure is `unclear`, which routes to the main session. */
async function judge($: EngineInterface, text: string, budgetMs: number | null = JUDGE_TIMEOUT_MS): Promise<Judged> {
  const started = await $.clock.now()
  lastJudgeAt = started
  const timedOut: Judgment = { verdict: 'unclear', task: '', resources: [], reason: 'judge timed out' }
  let repo = cwd
  let stateMs = 0
  let spent: Tally = NO_SPEND
  // Whichever settles first ends the other: an answer cancels the timer, a timeout the call.
  const stop = new AbortController()
  const asked = (async (): Promise<Judgment> => {
    // The repository root (for lock keys) is read beside the model call, not before it:
    // the judge decides from the message alone, so git never adds to its latency.
    const state = repoState($).then(found => {
      repo = found.repo
      return $.clock.now().then(now => {
        stateMs = now - started
      })
    })
    const reply = await $.model.complete(
      {
        model: live.judgeModel,
        system: judgeSystem(misses),
        prompt: judgePrompt(text, `cwd: ${cwd}`),
        maxTokens: 8,
        ...(budgetMs === null ? {} : { timeoutMs: budgetMs }),
      },
      { signal: stop.signal },
    )
    await state
    spent = tallyOf(live.judgeModel, reply.usage)
    await addSpend($, spent)
    if (!reply.isAnswered) return { verdict: 'unclear', task: '', resources: [], reason: `judge: ${reply.reason}` }
    return parseJudgment(reply.text, text)
  })().catch((): Judgment => ({ verdict: 'unclear', task: '', resources: [], reason: 'judge failed' }))
  // Shadow passes no budget: it holds nothing, so it measures what the judge really takes.
  const timer =
    budgetMs === null
      ? asked
      : $.clock.sleep(budgetMs, { signal: stop.signal }).then(
          () => timedOut,
          () => timedOut,
        )
  const judgment = await Promise.race([asked, timer])
  stop.abort()
  return { judgment, ms: (await $.clock.now()) - started, stateMs, repo, spend: spent }
}

/**
 * The verdict for a submitted prompt within the budget: the draft's, when the person submits
 * what was already judged while they typed, else a fresh judgment. `ms` is the wait at submit.
 */
async function verdictFor($: EngineInterface, text: string): Promise<Judged> {
  const ahead = speculation
  speculation = null
  if (ahead === null || ahead.text !== text.trim()) return judge($, text)
  const started = await $.clock.now()
  const stop = new AbortController()
  const timedOut: Judged = {
    judgment: { verdict: 'unclear', task: '', resources: [], reason: 'judge timed out' },
    ms: JUDGE_TIMEOUT_MS,
    stateMs: 0,
    repo: cwd,
    spend: NO_SPEND,
  }
  const timer = $.clock.sleep(JUDGE_TIMEOUT_MS, { signal: stop.signal }).then(
    () => timedOut,
    () => timedOut,
  )
  const settled = await Promise.race([ahead.judged, timer])
  stop.abort()
  // The draft's judge call was already counted, as draft judging: the submit spent nothing more.
  return settled === timedOut ? settled : { ...settled, spend: NO_SPEND, ms: (await $.clock.now()) - started }
}

/** Judges the draft in the background once typing pauses, if it is one the judge would see. */
function judgeDraftSoon($: EngineInterface, draft: string): void {
  draftTimer?.cancel()
  // Off in the panel: a message is judged only when it is sent.
  if (!live.draftJudging) return
  const text = draft.trim()
  if (!precheck(text, false).isJudged || speculation?.text === text) return
  draftTimer = $.clock.after(DRAFT_PAUSE_MS, () => {
    void (async () => {
      // Turned off in another session since: this one stops paying for drafts too.
      await refreshSettings($)
      if (!live.draftJudging) return
      const judged = judge($, text, null)
      speculation = { text, judged }
      const j = await judged
      await record($, { at: 0, kind: 'draft', status: 'passed', ms: j.ms, judgeUsd: j.spend.usd, workerUsd: 0, savedUsd: 0, id: 'draft', count: 1 })
    })().catch(() => {})
  })
}

const WARM_AFTER_MS = 45_000

/** A one-token call that opens the judge's connection ahead of the prompt that needs it. */
async function warm($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - lastJudgeAt < WARM_AFTER_MS) return
  lastJudgeAt = now
  // A cold first call can outlast the judge's budget; say so in the band rather than leave a
  // message that times out to the main session unexplained.
  await change($, s => ({ ...s, isWarming: true }))
  const reply = await $.model.complete({ model: live.judgeModel, prompt: 'Reply with: ok', maxTokens: 1 }).catch(() => undefined)
  await change($, s => ({ ...s, isWarming: false }))
  if (reply !== undefined) await addSpend($, tallyOf(live.judgeModel, reply.usage))
}

/** Starts every queued assist whose locks are free, oldest first; when nothing is left, releases held prompts. */
async function pump($: EngineInterface): Promise<void> {
  const state = await load($)
  const held = state.entries.filter(x => x.status === 'running').map(x => x.locks)
  const queued = state.entries.filter(x => x.status === 'queued').reverse()
  for (const entry of queued) {
    if (!canStart(entry.locks, held, live.maxConcurrent)) continue
    held.push(entry.locks)
    await patchEntry($, entry.id, () => ({ status: 'running' }))
    void runAssist($, entry.id)
  }
  if (!holdingMain(await load($))) await releaseWaiting($)
}

/** Whether a running or queued assist holds prompts for the main session (chores do; investigations don't). */
function holdingMain(state: SidekickState): boolean {
  return state.entries.some(x => (x.status === 'running' || x.status === 'queued') && holdsMain(x.locks))
}

/** Sends the prompts held for the main session, in the order they were typed. */
async function releaseWaiting($: EngineInterface): Promise<void> {
  const { waiting } = await load($)
  if (waiting.length === 0) return
  await change($, s => ({ ...s, waiting: [] }))
  for (const held of waiting) await $.prompt.submit({ text: held.text, asUser: true })
}

/** Puts a note where the main session will read it: in the conversation now, else with the next prompt. */
async function deliverNote($: EngineInterface, note: string): Promise<void> {
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
    if (!('deny' in appended && appended.deny !== undefined)) return
  } catch {
    // Kept below for the next prompt.
  }
  await change($, s => ({ ...s, notes: [...s.notes, note] }))
}

async function tell($: EngineInterface, text: string): Promise<void> {
  // Off in the panel: the chat line and the band still say it.
  if (!live.notifications) return
  try {
    const sent = await $.ui.notify(text, { title: 'Sidekick' })
    if (sent.isSent) return
  } catch {
    // Falls back to a toast.
  }
  $.ui.toast(text)
}

/**
 * Writes an investigation's full record outside any repository and keeps the newest few. Returns
 * its path, or '' when there is nowhere to write it; a record is a help, never a reason to fail.
 */
async function writeDump($: EngineInterface, entry: Entry, calls: readonly Call[], outcome: Outcome, now: number): Promise<string> {
  try {
    const home = await $.env.get('HOME')
    const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
    if (typeof home !== 'string' || home === '') return ''
    const dir = dumpDir(home, typeof configDir === 'string' ? configDir : undefined)
    const path = `${dir}/${dumpName(now, entry.id)}`
    const cost = usd(entry.judgeSpend.usd + entry.workerSpend.usd)
    await $.fs.write(path, dumpText(entry, calls, outcome, cost === '$0' ? 'cost unknown' : `≈${cost}`))
    const kept = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name).sort()
    // $.fs has no delete; these are the mod's own files.
    for (const name of kept.slice(0, Math.max(0, kept.length - DUMP_KEEP))) await $.process.run(['rm', '-f', `${dir}/${name}`], { timeoutMs: 2_000 })
    return path
  } catch {
    return ''
  }
}

/** Re-reads the panel's settings from the store, so a change made in another session counts here too. */
async function refreshSettings($: EngineInterface): Promise<void> {
  const stored = await $.store.get(SETTINGS_KEY).catch(() => undefined)
  live = effective(defaults, stored)
  const settings = live
  await change($, s => ({ ...s, settings })).catch(() => {})
}

/** One change from the panel: kept across sessions (only what was changed), in force at once. */
async function setSetting<K extends keyof Settings>($: EngineInterface, key: K, value: Settings[K]): Promise<void> {
  const stored = await $.store.get(SETTINGS_KEY).catch(() => undefined)
  await $.store.set(SETTINGS_KEY, withChange(stored, key, value)).catch(() => {})
  await refreshSettings($)
}

/** Flips one on/off setting from its value now, which another session may have changed. */
async function toggleSetting($: EngineInterface, key: 'investigations' | 'draftJudging' | 'notifications'): Promise<void> {
  await refreshSettings($)
  await setSetting($, key, !live[key])
}

/** Forgets every change made in the panel: the plugin's options are in force again. */
async function resetSettings($: EngineInterface): Promise<void> {
  await $.store.set(SETTINGS_KEY, {}).catch(() => {})
  await refreshSettings($)
}

/** The local midnight `state.today` counts from; the band refreshes it when the day turns. */
let todayFrom = 0
/** The jobs this session recorded, for the dashboard's Session tab (the entry list keeps only the newest 60). */
const sessionIds = new Set<string>()

/** Mirrors today's totals into the session's state, where the band can draw them. */
async function refreshToday($: EngineInterface, rows?: readonly HistoryRow[]): Promise<void> {
  const all = rows ?? toRows(await $.store.get(HISTORY_KEY).catch(() => historyRows))
  historyRows = [...all]
  const now = await $.clock.now()
  todayFrom = startOfDay(now)
  const today = totals(all, todayFrom)
  await change($, s => ({ ...s, today })).catch(() => {})
}

/**
 * History writes, one at a time: each reads the rows, changes them and writes them back, so two at
 * once (two chores finishing together, a draft and its submit) would lose one.
 */
let historyQueue: Promise<void> = Promise.resolve()
/** The rows as this session last read or wrote them, for the pane to draw without re-reading. */
let historyRows: HistoryRow[] = []

function editHistory($: EngineInterface, edit: (rows: HistoryRow[], now: number) => HistoryRow[]): Promise<void> {
  const run = historyQueue.then(async () => {
    const now = await $.clock.now()
    const rows = edit(toRows(await $.store.get(HISTORY_KEY).catch(() => historyRows)), now)
    await $.store.set(HISTORY_KEY, rows).catch(() => {})
    historyRows = rows
    await refreshToday($, rows)
  })
  historyQueue = run.catch(() => {})
  return run
}

/** Adds one row to the history kept across sessions. */
async function record($: EngineInterface, row: HistoryRow): Promise<void> {
  if (row.kind !== 'draft') sessionIds.add(row.id)
  await editHistory($, (rows, now) => appendRow(rows, { ...row, at: now }, now))
}

/** What the main session would have spent on this job, less what the sidekick did; 0 unless it finished. */
async function savedOn($: EngineInterface, status: Outcome['status'], spentUsd: number): Promise<number> {
  if (status !== 'done' && status !== 'partial') return 0
  const model = await $.session.model().catch(() => 'opus')
  const usage = await $.session.usage().catch(() => undefined)
  return savedFor(model, usage?.context.tokens, spentUsd)
}

/** Deletes the folder a finished worker session left under Claude's config folder. */
async function cleanupSession($: EngineInterface, sessionId: string): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
    if (typeof home !== 'string' || home === '') return
    const argv = cleanupArgv(configRoot(home, typeof configDir === 'string' ? configDir : undefined), sessionId)
    if (argv !== null) await $.process.run(argv, { timeoutMs: 5_000 })
  } catch {
    // Left behind is only disk space.
  }
}

async function finish($: EngineInterface, id: string, outcome: Outcome, calls: readonly Call[] = []): Promise<void> {
  workers.delete(id)
  const now = await $.clock.now()
  const found = (await load($)).entries.find(x => x.id === id)
  if (found === undefined) return
  const dump = found.kind === 'investigate' ? await writeDump($, found, calls, outcome, now) : ''
  if (dump !== '') await patchEntry($, id, () => ({ dump }))
  const entry = { ...found, dump }
  const status: EntryStatus = outcome.status === 'done' || outcome.status === 'partial' ? 'done' : outcome.status
  // In the history before it shows as finished, so a give to main pressed at once finds its row.
  const judgeUsd = found.judgeSpend.usd
  const workerUsd = found.workerSpend.usd
  await record($, {
    at: now,
    kind: entry.kind,
    status: outcome.status,
    ms: now - (entry.startedAt || entry.createdAt),
    judgeUsd,
    workerUsd,
    savedUsd: await savedOn($, outcome.status, judgeUsd + workerUsd),
    id,
  })
  await patchEntry($, id, () => ({ status, outcome, endedAt: now }))
  await change($, s => ({
    ...s,
    totals: {
      ...s.totals,
      assists: s.totals.assists + 1,
      failed: s.totals.failed + (status === 'done' ? 0 : 1),
    },
  }))
  const seconds = Math.max(1, Math.round((now - (entry.startedAt || entry.createdAt)) / 1000))
  const after = (await load($)).entries.find(x => x.id === id)
  $.ui.log(chatLine(outcome, entry.backend, seconds, (after?.judgeSpend.usd ?? 0) + (after?.workerSpend.usd ?? 0)))
  await deliverNote($, handoffNote(entry.prompt, outcome, entry.backend, entry.dump))
  await tell($, status === 'done' ? `✓ ${outcome.summary}` : `⚠ ${outcome.summary} — open /sidekick to hand it to main`)
  await pump($)
}

async function runAssist($: EngineInterface, id: string): Promise<void> {
  const entry = (await load($)).entries.find(x => x.id === id)
  if (entry === undefined) return
  const startedAt = await $.clock.now()
  await patchEntry($, id, () => ({ startedAt }))
  let isStopped = false
  let result: { text: string; isError: boolean } | null = null
  // A running assist moves the clock once a second, so the pane's spinner and timers redraw.
  const ticker = $.clock.every(1_000, () => void change($, s => ({ ...s, tick: s.tick + 1 })).catch(() => {}))
  const { instructions } = await load($)
  const stream = $.process.spawn({
    argv: workerArgv(entry.backend, guardPath, instructions ?? [], entry.kind),
    cwd,
    env: { DMOKONG_MODS: '0', SIDEKICK_WORKER: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
    input: workerInput(entry.task, entry.prompt),
  })
  const stop = () => {
    isStopped = true
    void stream.return(undefined as never).catch(() => {})
  }
  workers.set(id, { stop })
  const timer = $.clock.after(WORKER_TIMEOUT_MS, stop)
  // Every tool call and what came back, in order, for an investigation's record.
  const calls = new Map<string, Call>()
  let sessionId = ''
  try {
    let buffer = ''
    for await (const chunk of stream) {
      if (isStopped) break
      if (chunk.stream !== 'stdout') continue
      const split = splitLines(buffer, chunk.text)
      buffer = split.rest
      for (const line of split.lines) {
        for (const event of parseStreamEvents(line)) {
          if (event.kind === 'init') {
            sessionId = event.sessionId
          } else if (event.kind === 'step') {
            const step = event.text
            calls.set(event.id, { command: event.full, output: '', isError: false })
            await patchEntry($, id, x => ({ steps: [...x.steps, step].slice(-MAX_STEPS) }))
          } else if (event.kind === 'output') {
            const call = calls.get(event.id)
            if (call !== undefined) calls.set(event.id, { ...call, output: event.text, isError: event.isError })
          } else if (event.kind === 'refused') {
            // Say which command was turned down, so a stopped assist can be explained and fixed.
            const command = calls.get(event.id)?.command ?? '(a tool call)'
            calls.set(event.id, { command, output: 'refused by the permission layer or the guard', isError: true })
            const step = `✗ refused: ${(command.split('\n')[0] ?? '').replace(/^\$ /, '')}`
            await patchEntry($, id, x => ({ steps: [...x.steps, step].slice(-MAX_STEPS) }))
          } else if (event.kind === 'result') {
            result = { text: event.text, isError: event.isError }
            const priced = tallyOf(entry.backend, event.usage)
            // An unpriced model still has Claude Code's own figure for the run.
            const workerSpend = priced.usd === 0 && event.costUsd > 0 ? { ...priced, usd: event.costUsd } : priced
            await patchEntry($, id, () => ({ workerSpend }))
            await addSpend($, workerSpend)
          }
        }
      }
    }
  } catch {
    // An unstartable or killed child ends here; the outcome below says which.
  }
  timer.cancel()
  ticker.cancel()
  // After the stream ends, so the worker is done with its own saved output.
  if (sessionId !== '') await cleanupSession($, sessionId)
  if (isStopped) {
    await finish($, id, {
      status: 'stopped',
      summary: 'Stopped before it finished.',
      commands: [],
      shas: [],
      changed: [],
      uncertain: ['It may have run some commands before it stopped; check git status.'],
      needsMain: 'Stopped by you or by the time limit.',
    }, [...calls.values()])
    return
  }
  if (result === null) {
    await finish($, id, {
      status: 'failed',
      summary: 'The worker ended without a report.',
      commands: [],
      shas: [],
      changed: [],
      uncertain: ['Check git status and git log.'],
      needsMain: 'The worker session did not finish.',
    }, [...calls.values()])
    return
  }
  await finish($, id, parseOutcome(result.text, result.isError), [...calls.values()])
}

/** Queues an assist for a task and starts it if its locks are free. */
async function enqueue($: EngineInterface, id: string, judgment: Judgment, repo: string): Promise<void> {
  const kind: Profile = judgment.verdict === 'investigate' ? 'investigate' : 'chore'
  await patchEntry($, id, () => ({
    kind,
    status: 'queued',
    task: judgment.task,
    locks: lockKeys(judgment.resources, repo),
    backend: live.workerModel,
  }))
  await pump($)
}

/** Lets a prompt through to the main session, carrying any handoff notes it hasn't read yet. */
async function toMain($: EngineInterface, e: PromptSubmitInput, next: (e: PromptSubmitInput) => Promise<PromptSubmitResult>): Promise<PromptSubmitResult> {
  const { notes } = await load($)
  if (notes.length === 0) return next(e)
  await change($, s => ({ ...s, notes: [] }))
  return next({ ...e, context: [...(e.context ?? []), ...notes] })
}

/**
 * A dropped prompt is put back in the prompt box for editing, as a refused one is. Ours was
 * handled, not refused, so take it back out, keeping anything typed after it since.
 */
function clearRestored($: EngineInterface, dropped: string): void {
  // The engine puts the text back at a moment of its own, so look a few times in the first second.
  let isCleared = false
  for (const ms of [60, 200, 450, 900]) {
    $.clock.after(ms, () => {
      if (isCleared) return
      void (async () => {
        const box = await $.prompt.read()
        if (!box.text.startsWith(dropped)) return
        isCleared = true
        await $.prompt.fill({ text: box.text.slice(dropped.length).trimStart(), mode: 'replace' })
      })().catch(() => {})
    })
  }
}

async function setMode($: EngineInterface, mode: Mode): Promise<void> {
  await change($, s => ({ ...s, mode }))
  if (mode !== 'off') void warm($)
}

async function shadowJudge($: EngineInterface, id: string, text: string): Promise<void> {
  const { judgment, ms, stateMs, spend } = await judge($, text, null)
  const would = judgment.verdict === 'mechanical' || judgment.verdict === 'investigate'
  const what = judgment.verdict === 'investigate' ? 'would investigate' : 'would hand off'
  await patchEntry($, id, () => ({
    status: would ? 'shadow' : 'passed',
    verdict: judgment.verdict,
    reason: `${would ? `${what}: ${judgment.task}` : judgment.reason}${ms > JUDGE_TIMEOUT_MS ? ' · over budget' : ''} (git ${stateMs}ms)`,
    task: judgment.task,
    judgeMs: ms,
    judgeSpend: spend,
  }))
}

async function stopEntry($: EngineInterface, id: string): Promise<void> {
  const live = workers.get(id)
  if (live !== undefined) {
    live.stop()
    return
  }
  const entry = (await load($)).entries.find(x => x.id === id)
  if (entry?.status === 'queued') {
    const endedAt = await $.clock.now()
    await record($, { at: 0, kind: entry.kind, status: 'stopped', ms: 0, judgeUsd: entry.judgeSpend.usd, workerUsd: 0, savedUsd: 0, id })
    await patchEntry($, id, () => ({ status: 'stopped', endedAt }))
    await pump($)
  }
}

async function giveToMain($: EngineInterface, id: string): Promise<void> {
  const entry = (await load($)).entries.find(x => x.id === id)
  if (entry === undefined) return
  if (isActive(entry)) await stopEntry($, id)
  // The main session spends the turn after all, so the job saved nothing.
  await editHistory($, rows => markGiven(rows, id))
  await $.prompt.submit({ text: giveToMainPrompt(entry.prompt, entry.outcome, entry.steps, entry.dump), asUser: true })
}

/** Puts an investigation's record path on the clipboard; says it in a toast where there is none. */
async function copyDump($: EngineInterface, path: string): Promise<void> {
  const copied = await $.ui.copy({ text: path }).catch(() => ({ isCopied: false as const, reason: 'no clipboard' }))
  $.ui.toast(copied.isCopied ? `Copied: ${path}` : `Record: ${path}`)
}

async function revert($: EngineInterface, id: string): Promise<void> {
  const entry = (await load($)).entries.find(x => x.id === id)
  const shas = entry?.outcome?.shas ?? []
  if (entry === undefined || shas.length === 0) return
  const now = await $.clock.now()
  const revertId = newId(now)
  await addEntry($, { ...blankEntry(revertId, `revert ${shas.join(' ')}`, now), verdict: 'mechanical', reason: 'revert pressed' })
  const { repo } = await repoState($)
  await enqueue(
    $,
    revertId,
    {
      verdict: 'mechanical',
      task: `Revert commit(s) ${shas.join(', ')} with git revert --no-edit (newest first). If those commits were on the upstream, push the revert.`,
      resources: ['git'],
      reason: '',
    },
    repo,
  )
}

async function sendNow($: EngineInterface, waitingId: string): Promise<void> {
  const { waiting } = await load($)
  const held = waiting.find(w => w.id === waitingId)
  if (held === undefined) return
  await change($, s => ({ ...s, waiting: s.waiting.filter(w => w.id !== waitingId) }))
  await $.prompt.submit({ text: held.text, asUser: true })
}

/** Replaces the corrections the judge learns from: in the store for later sessions, here for this one. */
async function setLearned($: EngineInterface, list: Taught[]): Promise<void> {
  misses = list.slice(-200)
  // The judge follows this session even if the store refuses; the store carries it to the next.
  await $.store.set(MISSES_KEY, misses).catch(() => {})
  await change($, s => ({ ...s, learned: misses }))
}

async function storedMisses($: EngineInterface): Promise<Taught[]> {
  const prior = await $.store.get(MISSES_KEY).catch(() => misses)
  return Array.isArray(prior) ? toTaught(prior) : misses
}

async function markMissed($: EngineInterface, id: string): Promise<void> {
  await patchEntry($, id, () => ({ isMissed: true }))
  const entry = (await load($)).entries.find(x => x.id === id)
  if (entry === undefined) return
  // Kept across sessions; the judge sees the latest few as precedents from its next call on.
  const known = await storedMisses($)
  const verdict = taughtVerdict(entry.prompt)
  await setLearned($, [...known.filter(m => m.text !== entry.prompt), { text: entry.prompt, verdict }])
  $.ui.toast(`Noted: messages like "${clip(entry.prompt, 40)}" go to the sidekick (${verdictLabel(verdict)}) from now on`)
}

/** Drops one correction (or all of them) so the judge stops following it. */
async function forget($: EngineInterface, which: string | 'all'): Promise<number> {
  const known = await storedMisses($)
  const kept = which === 'all' ? [] : known.filter(m => m.text !== which)
  await setLearned($, kept)
  return known.length - kept.length
}

/** `/sidekick learned`: every stored correction, newest first, numbered for `/sidekick forget <n>`. */
const verdictLabel = (verdict: Taught['verdict']): string => (verdict === 'investigate' ? 'investigate' : 'chore')

function learnedText(list: readonly Taught[]): string {
  if (list.length === 0) return "The judge has learned nothing yet. Press should've been sidekick on a TO CLAUDE entry to teach it."
  const newest = [...list].reverse()
  const lines = newest.map((m, i) => `${String(i + 1).padStart(3)}. [${verdictLabel(m.verdict)}] ${clip(m.text.replace(/\s+/g, ' '), 100)}${i < MAX_MISSES ? '' : '  (stored, not used)'}`)
  return [`The judge follows the newest ${Math.min(MAX_MISSES, list.length)} of ${list.length} corrections:`, ...lines, '/sidekick forget <n> drops one; /sidekick forget all drops them all.'].join('\n')
}

/** What the worker knows of the project, for the pane's header. */
function contextLine(instructions: SidekickState['instructions']): string {
  if (instructions === null) return 'lean: the main session\'s instruction files arrive with its next /clear or compaction'
  if (instructions.length === 0) return 'the main session loads no instruction files'
  const chars = instructions.reduce((sum, f) => sum + f.content.length, 0)
  return `the main session's ${instructions.length} instruction file${instructions.length === 1 ? '' : 's'} (~${tokens(Math.round(chars / 4))} tokens, cached)`
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const STATUS_MARK: Record<EntryStatus, string> = {
  judging: '…',
  queued: '◷',
  running: '⟳',
  done: '✓',
  stopped: '■',
  failed: '✗',
  passed: '→',
  shadow: '◌',
}

/** `investigate · ` before an investigation's prompt in the pane; chores need no tag. */
const kindTag = (entry: Entry): string => (entry.kind === 'investigate' ? 'investigate · ' : '')

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

function entryDetail(entry: Entry, now: number): string {
  const age = entry.endedAt > 0 ? Math.round((entry.endedAt - (entry.startedAt || entry.createdAt)) / 1000) : Math.round((now - (entry.startedAt || entry.createdAt)) / 1000)
  switch (entry.status) {
    case 'judging':
      return 'judging…'
    case 'queued':
      return `queued · ${entry.task}`
    case 'running':
      return `${entry.steps.at(-1) ?? 'starting'} · ${age}s`
    case 'passed':
      return `to main${entry.judgeMs > 0 ? ` · ${entry.judgeMs}ms` : ''} · ${entry.reason}`
    case 'shadow':
      return `shadow · ${entry.judgeMs}ms · ${entry.reason}`
    default:
      return `${entry.outcome?.summary ?? ''} · ${entry.backend} · ${age}s`
  }
}

export const register: Register = (on, options) => {
  isOff = options.enabled === 'off'
  defaults = defaultsFrom(options)
  live = defaults

  on('session.start', async ($, e, next) => {
    if ((await $.env.get('DMOKONG_MODS')) === '0' || (await $.env.get('SIDEKICK_WORKER')) === '1') isOff = true
    if (isOff || !e.isInteractive) return next(e)
    cwd = e.cwd
    guardPath = `${$.plugin.root}/bin/sidekick-guard`
    try {
      const manifest = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))) as { version?: unknown }
      version = typeof manifest.version === 'string' ? manifest.version : ''
    } catch {
      version = ''
    }
    try {
      isLabelOnly = isBefore((await $.session.version()).version, RICH_BUTTONS_SINCE)
    } catch {
      isLabelOnly = false
    }
    if (isLabelOnly) $.ui.toast(UPDATE_MESSAGE)
    // A reload keeps the session's mode; the new module's connection starts cold.
    try {
      const stored = await $.store.get(MISSES_KEY)
      misses = toTaught(stored)
    } catch {
      misses = []
    }
    await change($, state => ({ ...state, learned: misses }))
    await refreshSettings($)
    await refreshToday($)
    // Store the upgraded shape, so state written by an older version is current from here on.
    await change($, state => state)
    // 0.1.2 kept the mode in the status line; the band carries it now, so clear what it left.
    $.ui.status(undefined)
    const { mode } = await load($)
    if (mode !== 'off') void warm($)
    await $.command.register({
      name: 'sidekick',
      description: 'Sidekick for this session: hand mechanical chores (git, bd) to a cheap worker',
      argumentHint: '[auto|shadow|off|learned|forget <n|all>]',
    })
    return next(e)
  })

  // The main session's instruction files, as it loaded them: the worker gets the same, so
  // nothing about the project is written into the sidekick. Kept whatever the mode, so turning
  // it on later still has them.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (isOff) return result
    const files = result.instructionFiles ?? e.instructionFiles
    if (files !== undefined) {
      const instructions = files.map(f => ({ path: f.path, kind: f.kind, content: f.content }))
      await change($, s => ({ ...s, instructions })).catch(() => {})
    }
    return result
  })

  // Typing is the cue a prompt is coming: judge the draft while the person types, not after.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (isOff) return box
    const { mode, panelOpen } = await load($)
    // Typing folds the panel: it must never stand between the person and the prompt.
    if (panelOpen && box.text !== e.text) await change($, st => ({ ...st, panelOpen: false }))
    if (mode !== 'auto') return box
    if (e.text === '') void warm($)
    judgeDraftSoon($, box.text)
    return box
  })

  on('command.run', { command: 'sidekick' }, async ($, e) => {
    if (isOff) return { text: 'Sidekick is disabled here (DMOKONG_MODS=0, a worker session, or the Enabled option).' }
    const arg = e.args.trim().toLowerCase()
    if (arg === 'learned') return { text: learnedText(await storedMisses($)) }
    if (arg.startsWith('forget')) {
      const what = arg.slice('forget'.length).trim()
      const newest = [...(await storedMisses($))].reverse()
      const n = Number(what)
      if (what === 'all') return { text: `Forgot ${await forget($, 'all')} corrections; the judge is back to its defaults.` }
      const target = Number.isInteger(n) && n >= 1 ? newest[n - 1] : undefined
      if (target === undefined) return { text: 'Usage: /sidekick forget <n|all>. /sidekick learned shows the numbers.' }
      await forget($, target.text)
      return { text: `Forgot "${clip(target.text, 60)}"; the judge no longer follows it.` }
    }
    const asked: Mode | null = arg === 'auto' ? 'auto' : arg === 'off' ? 'off' : arg === 'on' || arg === 'shadow' ? 'shadow' : null
    if (arg !== '' && asked === null) return { text: 'Usage: /sidekick [auto|shadow|off|learned|forget <n|all>]' }
    if (asked !== null) await setMode($, asked)
    const { mode } = await load($)
    if (mode !== 'off') await $.ui.open({ id: PANE, title: 'Sidekick', rows: PANE_ROWS })
    const what: Record<Mode, string> = {
      off: 'Sidekick is off for this session.',
      shadow: 'Sidekick is in shadow for this session: it judges each message and logs what it would hand off, but everything still goes to Claude. /sidekick auto to let it act.',
      auto: `Sidekick is on for this session: mechanical chores go to ${live.workerModel}, everything else to Claude.`,
    }
    return { text: what[mode] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isOff) return next(e)
    const state = await load($)
    const isUsers = e.origin.kind === 'composer'
    if (state.mode === 'off' || !isUsers || e.command !== undefined || e.isMeta === true) return toMain($, e, next)

    const now = await $.clock.now()
    const pre = precheck(e.text, (e.attachments?.length ?? 0) > 0)
    const isMidTurn = e.turnId !== undefined

    if (state.mode === 'shadow') {
      if (pre.isJudged && !isMidTurn) {
        const id = newId(now)
        await addEntry($, blankEntry(id, e.text, now))
        void shadowJudge($, id, e.text).catch(() => {})
      }
      return toMain($, e, next)
    }

    // auto
    const isBusy = holdingMain(state)
    const holdForAssists = async (why: string): Promise<PromptSubmitResult> => {
      if (!isBusy || isMidTurn) return toMain($, e, next)
      const id = newId(now)
      await change($, s => ({ ...s, waiting: [...s.waiting, { id, text: e.text }] }))
      clearRestored($, e.text)
      return { drop: `❯ ${clip(e.text.replace(/\s+/g, ' '), 160)} · held for Claude until the sidekick finishes (/sidekick → send now)` }
    }
    if (isMidTurn) return toMain($, e, next)
    if (!pre.isJudged) return holdForAssists(pre.why)

    const id = newId(now)
    await addEntry($, blankEntry(id, e.text, now))
    draftTimer?.cancel()
    // A change made in the panel of another session counts from this message on.
    await refreshSettings($)
    const { judgment, ms, repo, spend } = await verdictFor($, e.text)
    // An investigation without the main session's instruction files would guess where things live.
    const isBlind = judgment.verdict === 'investigate' && (await load($)).instructions === null
    const isLooksOff = judgment.verdict === 'investigate' && !live.investigations
    const routed: Judgment = isLooksOff
      ? { ...judgment, verdict: 'needs-main', reason: 'investigations are off (the sidekick panel turns them on)' }
      : isBlind
        ? { ...judgment, verdict: 'needs-main', reason: "no instruction files yet: the sidekick wouldn't know where things live (they arrive with the next /clear or compaction)" }
        : judgment
    await patchEntry($, id, () => ({ verdict: judgment.verdict, reason: routed.reason, judgeMs: ms, judgeSpend: spend }))
    if (routed.verdict !== 'mechanical' && routed.verdict !== 'investigate') {
      await patchEntry($, id, () => ({ status: 'passed' }))
      await change($, s => ({ ...s, totals: { ...s.totals, passed: s.totals.passed + 1 } }))
      await record($, { at: 0, kind: 'to-claude', status: 'passed', ms, judgeUsd: spend.usd, workerUsd: 0, savedUsd: 0, id })
      // A pass is a decision too: say so, or a sidekick that passes looks like one that is gone.
      $.ui.log(`→ to Claude: ${routed.reason} · judged in ${(ms / 1000).toFixed(1)}s`)
      return holdForAssists(routed.reason)
    }
    void enqueue($, id, routed, repo).catch(() => {})
    clearRestored($, e.text)
    const doing = routed.verdict === 'investigate' ? ' · investigating' : ''
    return { drop: `❯ ${e.text} → sidekick (${live.workerModel})${doing} · judged in ${(ms / 1000).toFixed(1)}s` }
  }).catch(($, e, next) => next(e)) // fail open: any error lets the prompt through as typed

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button: DrawnButton, Text } = $.ui.resolve(e)
    const Button: typeof DrawnButton = isLabelOnly ? ({ children: _, ...props }) => DrawnButton(props) : DrawnButton
    // An older engine refuses the graphical layout too; only its terminal gets the panel.
    if (isLabelOnly && e.surface !== 'terminal') return <Text>{UPDATE_MESSAGE}</Text>
    // A desktop, an editor or a phone draws real graphics: they get SVG charts, rendered markdown and
    // native controls, laid out to flow; the terminal gets the drawing in cells.
    const rich = e.surface === 'terminal' ? null : ($.ui.resolve(e) as ElementTable<RichSurface>)
    // Read the state before any early return, so every draw subscribes and a later write redraws it.
    const state = await load($)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns ?? 60)
    const running = state.entries.filter(x => x.status === 'running')
    const queued = state.entries.filter(x => x.status === 'queued')
    // The corrections the judge follows now, newest first; each can be forgotten.
    const learned = state.learned.slice(-MAX_MISSES).reverse()
    // The rows this session last read or wrote: the pane redraws often, the store is read on writes.
    const rows = historyRows

    const buttonsFor = (entry: Entry) => {
      const isWatched = state.watching === entry.id
      const list: { key: string; label: string; act: () => void }[] = []
      // A prompt the sidekick took never entered the up-arrow history; `edit` is its recall.
      const edit = { key: 'edit', label: 'edit', act: () => void $.prompt.fill({ text: entry.prompt, mode: 'replace' }) }
      const watch = { key: 'watch', label: isWatched ? 'hide' : 'watch', act: () => void change($, s => ({ ...s, watching: isWatched ? '' : entry.id })) }
      const toMainButton = { key: 'main', label: 'give to main', act: () => void giveToMain($, entry.id) }
      if (entry.status === 'running' || entry.status === 'queued') {
        list.push(edit, watch, { key: 'stop', label: 'stop', act: () => void stopEntry($, entry.id) }, toMainButton)
      } else if (entry.status === 'done' || entry.status === 'stopped' || entry.status === 'failed') {
        list.push(edit, watch)
        if (entry.status === 'done' && (entry.outcome?.shas.length ?? 0) > 0) list.push({ key: 'revert', label: 'revert', act: () => void revert($, entry.id) })
        if (entry.dump !== '') list.push({ key: 'dump', label: 'record', act: () => void copyDump($, entry.dump) })
        list.push(toMainButton)
      } else if (entry.status === 'passed' && entry.verdict !== '' && entry.verdict !== 'investigate' && !entry.isMissed) {
        // An investigation sent to main for want of instruction files was judged right; nothing to teach.
        list.push({ key: 'missed', label: "should've been sidekick", act: () => void markMissed($, entry.id) })
      }
      if (list.length === 0) return null
      return (
        <Box key={`b-${entry.id}`}>
          <Text>{'    '}</Text>
          {list.flatMap((b, i) => [
            ...(i > 0 ? [<Text key={`gap-${b.key}-${entry.id}`} dimColor> · </Text>] : []),
            <Button key={`${b.key}-${entry.id}`} label={b.label} plain onPress={b.act} />,
          ])}
        </Box>
      )
    }

    const watched = (entry: Entry) =>
      state.watching !== entry.id ? null : (
        <Box key={`w-${entry.id}`} flexDirection="column" marginLeft={4} borderStyle="single" borderColor="subtle" paddingX={1}>
          <Text dimColor>{clip(`task: ${entry.task}`, width - 10)}</Text>
          <Text color="suggestion">{clip(`judge   ${tallyLine(entry.judgeSpend)}`, width - 10)}</Text>
          <Text color="suggestion">{clip(`worker  ${tallyLine(entry.workerSpend)}`, width - 10)}</Text>
          {entry.steps.length === 0 && <Text dimColor>no commands yet</Text>}
          {entry.steps.map((step, i) => (
            <Text key={`s-${entry.id}-${i}`} color="subtle">
              {clip(step, width - 10)}
            </Text>
          ))}
          {entry.outcome !== null && entry.outcome.uncertain.length > 0 && (
            <Text color="warning">{clip(`unsure: ${entry.outcome.uncertain.join('; ')}`, width - 10)}</Text>
          )}
          {entry.outcome !== null && entry.outcome.needsMain !== '' && (
            <Text color="warning">{clip(`needs main: ${entry.outcome.needsMain}`, width - 10)}</Text>
          )}
        </Box>
      )

    const rule = (key: string, title: string, right = '') =>
      rich !== null ? (
        <Box key={key} flexWrap="wrap" marginTop={1} columnGap="sm">
          <Text bold dimColor>{title}</Text>
          <Box flexGrow={1} />
          <Text dimColor>{right}</Text>
        </Box>
      ) : (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Box flexWrap="nowrap">
          <Text bold>{title}</Text>
          <Box flexGrow={1} />
          <Text dimColor>{right}</Text>
        </Box>
        <Text color={COLORS.line}>{'─'.repeat(Math.max(4, width - 2))}</Text>
      </Box>
    )
    const modePill =
      state.mode === 'auto' ? (
        <Text key="mp" bold backgroundColor={COLORS.green} color={COLORS.ink}>{' ● AUTO '}</Text>
      ) : state.mode === 'shadow' ? (
        <Text key="mp" bold backgroundColor={COLORS.purple} color={COLORS.ink}>{' ◌ SHADOW '}</Text>
      ) : (
        <Text key="mp" dimColor>{'○ OFF'}</Text>
      )
    const back = (
      <Button key="back" label="← back" plain onPress={() => void change($, s => ({ ...s, view: 'dashboard', jobId: '' }))}>
        <Text color={COLORS.yellow}>{'← back'}</Text>
      </Button>
    )
    // The header fits the pane: one row when it all fits, else the right-hand controls on a second
    // row; the models and the version give way first. `rightWidth` is what `right` draws, in cells.
    const header = (right: unknown, rightWidth: number) => {
      if (rich !== null) {
        return (
          <Box key="hdr" flexWrap="wrap" alignItems="center" columnGap="sm" rowGap="xs">
            <Text bold color={COLORS.claude}>{'◆ Sidekick'}</Text>
            {richBadge(Text, state.mode)}
            <Text dimColor>{`judge ${state.settings.judgeModel} · worker ${state.settings.workerModel}`}</Text>
            {version !== '' && <Text dimColor>{`v${version}`}</Text>}
            <Box flexGrow={1} />
            {right as never}
          </Box>
        )
      }
      const inner = width - 4
      const title = '✦ SIDEKICK  '
      const pillWidth = state.mode === 'auto' ? 8 : state.mode === 'shadow' ? 10 : 5
      const models = `  ${state.settings.judgeModel} · ${state.settings.workerModel}`
      const ver = version !== '' ? `  v${version}` : ''
      const core = title.length + pillWidth
      const isOneRow = core + rightWidth + 1 <= inner
      const room = inner - core - (isOneRow ? rightWidth + 1 : 0)
      const showModels = models.length <= room
      const showVersion = showModels && models.length + ver.length <= room
      return (
        <Box key="hdr" flexDirection="column" borderStyle="round" borderColor={COLORS.line} paddingX={1}>
          <Box flexWrap="nowrap">
            <Text bold color={COLORS.claude}>{title}</Text>
            {modePill}
            {showModels && <Text dimColor>{models}</Text>}
            {showVersion && <Text dimColor>{ver}</Text>}
            <Box flexGrow={1} />
            {isOneRow && (right as never)}
          </Box>
          {!isOneRow && (
            <Box flexWrap="nowrap">
              <Box flexGrow={1} />
              {right as never}
            </Box>
          )}
        </Box>
      )
    }

    // ── one job, in words: everything it did, and what can be done with it
    const job = state.view === 'job' ? state.entries.find(x => x.id === state.jobId) : undefined
    if (job !== undefined) {
      const seconds = Math.max(1, Math.round(((job.endedAt || now) - (job.startedAt || job.createdAt)) / 1000))
      const color = job.status === 'done' ? COLORS.green : job.status === 'failed' || job.status === 'stopped' ? COLORS.pink : COLORS.yellow
      return (
        <Box flexDirection="column">
          {header(back, 6)}
          <Box flexWrap="nowrap" marginTop={1}>
            <Text bold color={color}>{`${STATUS_MARK[job.status]} `}</Text>
            <Text bold>{clip(`${kindTag(job)}${job.prompt}`, width - 24)}</Text>
            <Box flexGrow={1} />
            <Text dimColor>{`${seconds}s · ≈${usd(job.judgeSpend.usd + job.workerSpend.usd)}`}</Text>
          </Box>
          {rich !== null ? (
            <rich.Markdown key="job-summary" text={job.outcome?.summary ?? entryDetail(job, now)} />
          ) : (
            <Text dimColor wrap="wrap">{job.outcome?.summary ?? entryDetail(job, now)}</Text>
          )}
          {buttonsFor(job)}
          {watched({ ...job, id: job.id }) ?? null}
          {state.watching !== job.id && (
            <Box flexDirection="column" marginLeft={4}>
              {job.steps.slice(-8).map((step, i) => (
                <Text key={`js-${i}`} color="subtle">
                  {clip(step, width - 6)}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    // ── what it learned: each correction the judge follows, with forget
    if (state.view === 'learned') {
      return (
        <Box flexDirection="column">
          {header(back, 6)}
          {rule('lh', 'LEARNED', `${state.learned.length} stored`)}
          {learned.length === 0 && <Text dimColor>{"Nothing yet. Press should've been sidekick on a job that went to Claude."}</Text>}
          {learned.map(m => (
            <Box key={`l-${m.text}`} flexWrap="nowrap">
              <Text color={m.verdict === 'investigate' ? COLORS.orange : COLORS.yellow}>{`✎ [${verdictLabel(m.verdict)}] `}</Text>
              <Text>{clip(m.text.replace(/\s+/g, ' '), width - 30)}</Text>
              <Box flexGrow={1} />
              <Button key={`forget-${m.text}`} label="forget" plain onPress={() => void forget($, m.text)} />
            </Box>
          ))}
          {state.learned.length > learned.length && <Text dimColor>{`+${state.learned.length - learned.length} older, stored but not used · /sidekick learned`}</Text>}
        </Box>
      )
    }

    // ── the dashboard
    const ids = new Set([...sessionIds, ...state.entries.map(x => x.id)])
    const span =
      state.tab === 'session'
        ? { ...totals(rows.filter(r => ids.has(r.id)), 0), costUsd: state.spend.usd }
        : totals(rows, state.tab === 'today' ? startOfDay(now) : weekStart(now))
    const isShortTabs = width - 4 < 30
    const tabName = (tab: 'session' | 'today' | 'week') => (isShortTabs ? { session: 'Sess', today: 'Day', week: 'Wk' }[tab] : `${tab[0]!.toUpperCase()}${tab.slice(1)}`)
    const tabs = (['session', 'today', 'week'] as const).map(tab => (
      <Button key={`tab-${tab}`} label={`${state.tab === tab ? '✓ ' : ''}${tabName(tab)}`} plain onPress={() => void change($, s => ({ ...s, tab }))}>
        {state.tab === tab ? (
          <Text bold backgroundColor={COLORS.yellow} color={COLORS.ink}>{` ${tabName(tab)} `}</Text>
        ) : (
          <Text dimColor>{` ${tabName(tab)} `}</Text>
        )}
      </Button>
    ))
    const learnedText = `✎ ${state.learned.length}  `
    const tabsWidth = learnedText.length + (['session', 'today', 'week'] as const).reduce((n, t) => n + tabName(t).length + 2, 0)
    // Three tiles side by side need room for `$4.18` in segment digits: 18 cells inside each.
    const isStacked = width < 68
    const isPlain = width < 40
    const tileW = isStacked ? width - 2 : Math.floor((width - 2) / 3)
    const mainModel = modelName(await $.session.model().catch(() => 'the main model'))
    const tile = (key: string, title: string, value: string, color: string, caption: string) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={COLORS.line} paddingX={1} width={tileW}>
        <Text dimColor>{title}</Text>
        {isPlain ? (
          <Text bold color={color}>{value}</Text>
        ) : (
          bigText(value).map((row, i) => (
            <Text key={`${key}-r${i}`} bold color={color}>
              {row}
            </Text>
          ))
        )}
        <Text dimColor>{clip(caption, tileW - 4)}</Text>
      </Box>
    )
    const counts = [
      { glyph: '●', n: running.length, label: 'running', color: COLORS.pink },
      { glyph: '◷', n: queued.length, label: 'queued', color: COLORS.blue },
      { glyph: '⏸', n: state.waiting.length, label: 'waiting', color: COLORS.yellow },
    ]
    // The bars fit the pane: narrow, the labels shorten and the cost column goes before the bar does.
    const isNarrowBars = width < 44
    const labelW = isNarrowBars ? 10 : 16
    const costW = width >= 36 ? 9 : 0
    const barW = Math.max(3, Math.min(30, width - 2 - labelW - 5 - costW))
    const where = [
      { key: 'chores', label: 'chores', n: span.chores, cost: span.choreUsd, color: COLORS.yellow },
      { key: 'looks', label: isNarrowBars ? 'looks' : 'investigations', n: span.looks, cost: span.lookUsd, color: COLORS.pink },
      { key: 'claude', label: 'to Claude', n: span.toClaude, cost: span.claudeUsd, color: COLORS.purple },
      { key: 'drafts', label: isNarrowBars ? 'drafts' : 'draft judging', n: span.drafts, cost: span.draftUsd, color: '#8b93a7' },
    ]
    const top = Math.max(...where.map(w => w.n))
    const days = perDay(rows, now)
    const levels = dayLevels(days.map(d => d.jobs))
    const best = bestDay(days)
    const days_ = streak(days)
    // Seven columns in the room there is: the blocks narrow first, then the day names shorten.
    const colW = Math.max(3, Math.min(9, Math.floor(width / 7)))
    const gapW = colW >= 5 ? 2 : 1
    const recent = state.entries.filter(x => !ACTIVE.includes(x.status)).slice(0, 6)
    const markOf = (entry: Entry) => {
      const mark = entry.outcome?.status === 'partial' ? '◐' : STATUS_MARK[entry.status]
      const color = entry.status === 'done' ? (mark === '◐' ? COLORS.orange : COLORS.green) : entry.status === 'passed' || entry.status === 'shadow' ? COLORS.purple : COLORS.pink
      return { mark, color }
    }
    const openJob = (id: string) => () => void change($, s => ({ ...s, view: 'job', jobId: id }))
    if (rich !== null) {
      const { Svg } = rich
      // Room for a line's words, in cells: proportional type is narrower, so this never runs over.
      const room = Math.max(16, width - 16)
      const series = (pick: (d: (typeof days)[number]) => number) => days.map(pick)
      return (
        <Box flexDirection="column" rowGap="sm">
          {header(
            <Box key="hdr-r" flexWrap="wrap" columnGap="xs">
              {(['session', 'today', 'week'] as const).map(tab => (
                <Button key={`tab-${tab}`} variant={state.tab === tab ? 'primary' : 'secondary'} onPress={() => void change($, s => ({ ...s, tab }))} label={`${state.tab === tab ? '✓ ' : ''}${tab[0]!.toUpperCase()}${tab.slice(1)}`} />
              ))}
              <Button key="view-learned" variant="secondary" onPress={() => void change($, s => ({ ...s, view: 'learned' }))} label={`✎ Learned ${state.learned.length}`} />
            </Box>,
            0,
          )}
          <Box key="tiles" flexWrap="wrap" gap="sm">
            <Box key="tile-done">
              <Svg alt={`Done: ${span.done}`} source={tileSvg({ title: 'DONE', value: String(span.done), caption: `${span.chores} chores · ${span.looks} looks`, color: COLORS.yellow, series: series(d => d.jobs) })} />
            </Box>
            <Box key="tile-saved">
              <Svg alt={`Saved: ${tileMoney(span.savedUsd)}`} source={tileSvg({ title: 'SAVED', value: tileMoney(span.savedUsd), caption: `est. vs ${mainModel}`, color: COLORS.green, series: series(d => d.savedUsd) })} />
            </Box>
            <Box key="tile-cost">
              <Svg alt={`Cost: ${tileMoney(span.costUsd)}`} source={tileSvg({ title: 'COST', value: tileMoney(span.costUsd), caption: 'judge + worker', color: COLORS.blue, series: series(d => d.costUsd) })} />
            </Box>
          </Box>
          <Box key="live" flexWrap="wrap" columnGap="md">
            {counts.map(c => (
              <Text key={`lc-${c.label}`} color={c.n > 0 ? c.color : undefined} dimColor={c.n === 0}>{`${c.glyph} ${c.n} ${c.label}`}</Text>
            ))}
            <Text dimColor>{`caching saved ${usd(Math.max(0, state.spend.savedUsd))}`}</Text>
          </Box>

          {rule('h-now', 'NOW')}
          {running.length === 0 && queued.length === 0 && state.waiting.length === 0 && <Text dimColor>{'Nothing running'}</Text>}
          {running.map(entry => (
            <Box key={`n-${entry.id}`} flexDirection="column" rowGap="xs">
              <Box flexWrap="nowrap" alignItems="center" columnGap="sm">
                <Text color={COLORS.pink}>{'●'}</Text>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Button key={`job-${entry.id}`} variant="secondary" onPress={openJob(entry.id)} label={clip(`${kindTag(entry)}${entry.prompt}`, room)} />
                </Box>
                <Text dimColor>{`${Math.round((now - (entry.startedAt || entry.createdAt)) / 1000)}s`}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">{clip(entry.steps.at(-1) ?? 'starting the worker…', room)}</Text>
              <Box key={`pg-${entry.id}`}>
                <Svg alt="working" source={progressSvg(COLORS.orange)} isInteractive />
              </Box>
            </Box>
          ))}
          {[...queued].reverse().map((entry, i) => (
            <Box key={`n-${entry.id}`} flexWrap="nowrap" columnGap="sm">
              <Text color={COLORS.blue}>{'◷'}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">{clip(`${kindTag(entry)}${entry.prompt}`, room)}</Text>
              </Box>
              <Text dimColor>{i === 0 ? 'Next' : 'Then'}</Text>
            </Box>
          ))}
          {state.waiting.map(held => (
            <Box key={`wt-${held.id}`} flexWrap="nowrap" alignItems="center" columnGap="sm">
              <Text color={COLORS.yellow}>{'⏸'}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">{clip(held.text, room)}</Text>
              </Box>
              <Button key={`send-${held.id}`} variant="secondary" onPress={() => void sendNow($, held.id)} label="Send now" />
            </Box>
          ))}

          {rule('h-where', 'WHERE IT WENT')}
          <Box key="where">
            <Svg alt={where.map(w => `${w.label} ${w.n}, ${tileMoney(w.cost)}`).join('; ')}
              source={stackSvg(where.map(w => ({ label: w.label, n: w.n, usd: w.cost, color: w.color })))}
              isInteractive />
          </Box>
          <Box key="where-legend" flexWrap="wrap" columnGap="md">
            {where.map(w => (
              <Text key={`wl-${w.key}`} color={w.color}>
                {`■ ${w.label} ${w.n} · ${tileMoney(w.cost)}`}
              </Text>
            ))}
          </Box>

          {rule('h-days', 'LAST 7 DAYS', best === undefined ? 'no jobs yet' : `best ${best.isToday ? 'today' : best.label}${days_ > 0 ? ` · ${days_}-day streak` : ''}`)}
          <Box key="days">
            <Svg alt={days.map(d => `${d.label} ${d.jobs}`).join(', ')} source={daysSvg(days, { today: COLORS.yellow, bar: COLORS.blue })} isInteractive />
          </Box>

          {recent.length > 0 && rule('h-recent', 'RECENT')}
          {recent.map(entry => {
            const { mark, color } = markOf(entry)
            const seconds = entry.endedAt > 0 ? `${Math.max(1, Math.round((entry.endedAt - (entry.startedAt || entry.createdAt)) / 1000))}s` : ''
            const cost = entry.judgeSpend.usd + entry.workerSpend.usd
            return (
              <Box key={`rc-${entry.id}`} flexDirection="column" borderStyle="round" borderColor={COLORS.line} paddingX={1}>
                <Box flexWrap="nowrap" alignItems="center" columnGap="sm">
                  <Text color={color}>{mark}</Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Button key={`job-${entry.id}`} variant="secondary" onPress={openJob(entry.id)} label={clip(`${kindTag(entry)}${entry.prompt}`, room)} />
                  </Box>
                  <Text dimColor>{cost > 0 ? usd(cost) : ''}</Text>
                </Box>
                <Text dimColor wrap="truncate-end">{[entry.status, seconds, entry.outcome?.summary.split('\n')[0] ?? entry.reason].filter(x => x !== '').join(' · ')}</Text>
              </Box>
            )
          })}
          <Text dimColor wrap="wrap">{`Context: ${contextLine(state.instructions)}`}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {header(
          <Box key="hdr-r" flexWrap="nowrap">
            <Button key="view-learned" label={learnedText} plain onPress={() => void change($, s => ({ ...s, view: 'learned' }))}>
              <Text color={COLORS.purple}>{learnedText}</Text>
            </Button>
            {tabs}
          </Box>,
          tabsWidth,
        )}
        <Box flexDirection={isStacked ? 'column' : 'row'} marginTop={1}>
          {tile('tile-done', 'DONE', String(span.done), COLORS.yellow, `${span.chores} chores · ${span.looks} looks`)}
          {tile('tile-saved', 'SAVED', tileMoney(span.savedUsd), COLORS.green, `est. vs ${mainModel}`)}
          {tile('tile-cost', 'COST', tileMoney(span.costUsd), COLORS.blue, 'judge + worker')}
        </Box>
        <Box flexWrap="wrap" marginTop={1}>
          {counts.map(c => (
            <Box key={`lc-${c.label}`} flexWrap="nowrap">
              <Text color={c.n > 0 ? c.color : COLORS.dim}>{`${c.glyph} `}</Text>
              <Text bold>{String(c.n)}</Text>
              <Text dimColor>{width >= 60 ? ` ${c.label}   ` : '   '}</Text>
            </Box>
          ))}
          <Text dimColor>{'·  '}</Text>
          <Text color={COLORS.green}>{'caching saved '}</Text>
          <Text bold>{usd(Math.max(0, state.spend.savedUsd))}</Text>
        </Box>

        {rule('h-now', 'NOW')}
        {running.length === 0 && queued.length === 0 && <Text dimColor>{'nothing running'}</Text>}
        {running.map(entry => (
          <Box key={`n-${entry.id}`} flexDirection="column">
            <Box flexWrap="nowrap">
              <Text color={COLORS.pink}>{'● '}</Text>
              <Button key={`job-${entry.id}`} label={clip(`${kindTag(entry)}${entry.prompt}`, width - 26)} plain onPress={() => void change($, s => ({ ...s, view: 'job', jobId: entry.id }))}>
                <Text bold>{clip(`${kindTag(entry)}${entry.prompt}`, width - 26)}</Text>
              </Button>
              <Box flexGrow={1} />
              <Text bold color={COLORS.pink}>{'Working'}</Text>
              <Text dimColor>{` ${Math.round((now - (entry.startedAt || entry.createdAt)) / 1000)}s`}</Text>
            </Box>
            <Text dimColor>{clip(`  ↳ ${(entry.steps.at(-1) ?? 'starting the worker…').replace(/^\$ /, '')}`, width - 2)}</Text>
          </Box>
        ))}
        {[...queued].reverse().map((entry, i) => (
          <Box key={`n-${entry.id}`} flexWrap="nowrap">
            <Text color={COLORS.blue}>{'◷ '}</Text>
            <Text>{clip(`${kindTag(entry)}${entry.prompt}`, width - 12)}</Text>
            <Box flexGrow={1} />
            <Text dimColor>{i === 0 ? 'Next' : 'Then'}</Text>
          </Box>
        ))}
        {state.waiting.map(held => (
          <Box key={`wt-${held.id}`} flexWrap="nowrap">
            <Text color={COLORS.yellow}>{'⏸ '}</Text>
            <Text>{clip(held.text, width - 24)}</Text>
            <Box flexGrow={1} />
            <Button key={`send-${held.id}`} label="send now" plain onPress={() => void sendNow($, held.id)} />
          </Box>
        ))}

        {rule('h-where', 'WHERE IT WENT', costW > 0 ? 'jobs     cost' : 'jobs')}
        {where.map(w => {
          const cells = barCells(w.n, top, barW)
          return (
            <Box key={`w-${w.key}`} flexWrap="nowrap">
              <Text color={w.color}>{'● '}</Text>
              <Text>{w.label.padEnd(labelW)}</Text>
              <Text color={w.color}>{'━'.repeat(cells.filled)}</Text>
              <Text color={COLORS.line}>{'─'.repeat(cells.empty)}</Text>
              <Box flexGrow={1} />
              <Text bold>{String(w.n).padStart(5)}</Text>
              {costW > 0 && <Text dimColor>{` ${usd(w.cost).padStart(8)}`}</Text>}
            </Box>
          )
        })}

        {rule('h-days', 'LAST 7 DAYS', 'jobs a day')}
        {[4, 3, 2, 1].map(level => (
          <Box key={`d-${level}`} flexWrap="nowrap">
            {levels.map((l, i) => (
              <Text key={`d-${level}-${i}`} color={COLORS.blue}>
                {(l >= level ? '▆'.repeat(colW - gapW) : ' '.repeat(colW - gapW)) + ' '.repeat(gapW)}
              </Text>
            ))}
          </Box>
        ))}
        <Box flexWrap="nowrap">
          {days.map((d, i) => (
            <Text key={`dl-${i}`} bold={d.isToday} dimColor={!d.isToday}>
              {d.label.slice(0, colW >= 5 ? 3 : colW - 1).padEnd(colW)}
            </Text>
          ))}
        </Box>
        <Box flexWrap="nowrap">
          <Text bold>{best === undefined ? 'No jobs yet this week' : `Best day: ${best.isToday ? 'today' : best.label}, ${best.jobs} ${best.jobs === 1 ? 'job' : 'jobs'}`}</Text>
          {days_ > 0 && <Text dimColor>{`  ·  ${days_} day streak`}</Text>}
        </Box>

        {recent.length > 0 && rule('h-recent', 'RECENT', 'open one for its details')}
        <Box flexWrap="wrap">
          {recent.map(entry => {
            const { mark, color } = markOf(entry)
            const seconds = entry.endedAt > 0 ? `${Math.max(1, Math.round((entry.endedAt - (entry.startedAt || entry.createdAt)) / 1000))}s` : ''
            return (
              <Box key={`rc-${entry.id}`} flexWrap="nowrap">
                <Button key={`job-${entry.id}`} label={`${mark} ${clip(`${kindTag(entry)}${entry.prompt}`, Math.max(20, Math.floor(width / 2) - 8))}`} plain onPress={openJob(entry.id)}>
                  <Text color={color}>{`${mark} `}</Text>
                  <Text>{clip(`${kindTag(entry)}${entry.prompt}`, Math.max(20, Math.floor(width / 2) - 8))}</Text>
                </Button>
                <Text dimColor>{` ${seconds}   `}</Text>
              </Box>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">{`context  ${contextLine(state.instructions)}`}</Text>
        </Box>
      </Box>
    )
  })

  // The band says the sidekick is on and what it is doing; it stacks above any other band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOff || e.props.hasSurvey) return next(e)
    const state = await load($)
    const below = await next(e)
    if (isLabelOnly && e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>{UPDATE_MESSAGE}</Text>
          {below}
        </Box>
      )
    }
    const { Box, Button: DrawnButton, Text } = $.ui.resolve(e)
    const Button: typeof DrawnButton = isLabelOnly ? ({ children: _, ...props }) => DrawnButton(props) : DrawnButton
    const width = Math.max(24, e.props.bodyColumns ?? 80)
    const maxRows = e.props.maxRows ?? 40
    const running = state.entries.filter(x => x.status === 'running')
    const queued = state.entries.filter(x => x.status === 'queued')
    const isOn = state.mode !== 'off'
    const lead = running[0]
    const now = await $.clock.now()

    // ── the folded line: what's happening, at a glance; parts give way from the right as it narrows
    // The day turned since today's totals were counted: count them again (the draw after shows them).
    if (todayFrom !== 0 && startOfDay(now) !== todayFrom) void refreshToday($).catch(() => {})
    const counts = [
      { glyph: '●', n: running.length, color: COLORS.pink },
      { glyph: '◷', n: queued.length, color: COLORS.blue },
      { glyph: '⏸', n: state.waiting.length, color: COLORS.yellow },
    ]
    const savedText = tileMoney(state.today.savedUsd)
    const costText = tileMoney(state.today.costUsd)
    const pillText = state.mode === 'auto' ? ' ● AUTO ' : state.mode === 'shadow' ? ' ◌ SHADOW ' : '○ OFF'
    const head = '◆ sidekick '.length + pillText.length + (state.isWarming ? ' warming up…'.length : 0)
    const partWidths = {
      counts: ' │ '.length + counts.reduce((n, c) => n + `${c.glyph} ${c.n} `.length, 0),
      saved: '│ saved '.length + savedText.length + 1,
      cost: '│ cost '.length + costText.length,
    }
    const longToggle = state.panelOpen ? ' ◆ Sidekick ▴ ' : ' ◆ Sidekick ▾ '
    // Below the room for the whole button, it keeps its arrow: it always opens the panel.
    const toggleText = head + longToggle.length + 1 <= width ? longToggle : state.panelOpen ? ' ▴ ' : ' ▾ '
    const fits = (parts: (keyof typeof partWidths)[]) => head + parts.reduce((n, k) => n + partWidths[k], 0) + toggleText.length + 1 <= width
    const order: (keyof typeof partWidths)[] = ['counts', 'saved', 'cost']
    let shown = isOn ? order : []
    while (shown.length > 0 && !fits(shown)) shown = shown.slice(0, -1)
    const modeChip =
      state.mode === 'auto' ? (
        <Text key="pill" bold backgroundColor={COLORS.green} color={COLORS.ink}>{' ● AUTO '}</Text>
      ) : state.mode === 'shadow' ? (
        <Text key="pill" bold backgroundColor={COLORS.purple} color={COLORS.ink}>{' ◌ SHADOW '}</Text>
      ) : (
        <Text key="pill" dimColor>{'○ OFF'}</Text>
      )
    const folded = (
      <Box key="sk-folded" flexWrap="nowrap">
        <Text bold={isOn} dimColor={!isOn} color={isOn ? COLORS.claude : undefined}>{'◆ sidekick '}</Text>
        {modeChip}
        {/* A cold judge can take seconds on its first call; say so, or the first message looks ignored. */}
        {state.isWarming && <Text color={COLORS.purple}>{' warming up…'}</Text>}
        {shown.includes('counts') && <Text color={COLORS.line}>{' │ '}</Text>}
        {shown.includes('counts') &&
          counts.map(c => (
            <Text key={`c-${c.glyph}`} color={c.n > 0 ? c.color : COLORS.dim}>{`${c.glyph} ${c.n} `}</Text>
          ))}
        {shown.includes('saved') && <Text color={COLORS.line}>{'│ '}</Text>}
        {shown.includes('saved') && <Text dimColor>{'saved '}</Text>}
        {shown.includes('saved') && <Text bold color={COLORS.green}>{`${savedText} `}</Text>}
        {shown.includes('cost') && <Text color={COLORS.line}>{'│ '}</Text>}
        {shown.includes('cost') && <Text dimColor>{'cost '}</Text>}
        {shown.includes('cost') && <Text color={COLORS.blue}>{costText}</Text>}
        <Box flexGrow={1} />
        <Button key="band-toggle" label={toggleText} plain onPress={() => void change($, s => ({ ...s, panelOpen: !s.panelOpen }))}>
          <Text bold backgroundColor={COLORS.claude} color={COLORS.ink}>{toggleText}</Text>
        </Button>
      </Box>
    )

    // ── the live job card (image 1): the running job, its latest command, what comes next
    const ageOf = (entry: Entry) => Math.max(0, Math.round((now - (entry.startedAt || entry.createdAt)) / 1000))
    const block = (entry: Entry) => {
      const lit = entry.steps.length % 4
      return [0, 1].map(i => <Text key={`blk-${i}`} backgroundColor={i === 0 || lit >= 2 ? COLORS.orange : '#3a2a2a'}>{'  '}</Text>)
    }
    const card =
      lead !== undefined && !state.panelOpen ? (
        <Box key="sk-card" flexDirection="column" borderStyle="round" borderColor={COLORS.pink} paddingX={1}>
          <Box flexWrap="nowrap">
            <Text color={COLORS.pink}>{'✦ '}</Text>
            <Text bold color={COLORS.orange}>{lead.kind === 'investigate' ? 'investigate ' : 'chore '}</Text>
            <Text bold>{clip(lead.prompt, width - 20)}</Text>
            {running.length > 1 && <Text dimColor>{`  +${running.length - 1}`}</Text>}
          </Box>
          <Box flexWrap="nowrap">
            <Text color={COLORS.pink}>{'● '}</Text>
            <Text bold>{clip((lead.steps.at(-1) ?? 'starting the worker…').replace(/^\$ /, ''), width - 30)}</Text>
            <Box flexGrow={1} />
            {block(lead)}
            <Text bold color={COLORS.pink}>{'  Working'}</Text>
            <Text dimColor>{` ${ageOf(lead)}s`}</Text>
          </Box>
          <Box flexWrap="nowrap">
            <Text dimColor>{'○ Report back to Claude'}</Text>
            <Box flexGrow={1} />
            <Text dimColor>{'Next'}</Text>
          </Box>
        </Box>
      ) : null

    // ── the control panel (image 3)
    // A popup, not a sheet: a fixed width, anchored above the toggle at the right end of the line.
    const panelW = Math.min(width, PANEL_WIDTH)
    const inner = Math.max(20, panelW - 4)
    // The layout follows the room: wide keeps every note; compact drops the notes and packs LAUNCH
    // into short labels; mini also shortens the model chips and the pills.
    const size: 'wide' | 'compact' | 'mini' = inner >= 60 ? 'wide' : inner >= 40 ? 'compact' : 'mini'
    const isMini = size === 'mini'
    // A chip and the gap after it, as siblings in the row: wrapped in a Box of its own, the last
    // chip's colour stretched to the row's end.
    const rowLabel = (word: string) => word.padEnd(size === 'wide' ? 10 : 7)
    const chipLabel = (label: string) => (isMini ? (label.split(' ')[0] ?? label) : label)
    // A desktop draws every Button as its own native button, so the colour that marks the chosen
    // chip is lost there: it gets the primary button and a check mark instead.
    const isTerminal = e.surface === 'terminal'
    const chip = (key: string, label: string, isOn_: boolean, color: string, act: () => void) => [
      <Button key={key} label={isOn_ ? `✓ ${label}` : label} plain onPress={act} variant={isOn_ ? 'primary' : 'secondary'}>
        {isOn_ ? (
          <Text bold backgroundColor={color} color={COLORS.ink}>{isTerminal ? ` ${label} ` : ` ✓ ${label} `}</Text>
        ) : (
          <Text>{` ${label} `}</Text>
        )}
      </Button>,
      <Text key={`gap-${key}`}>{' '}</Text>,
    ]
    const rule = (key: string, title: string) => {
      const label = title === '' ? '' : `── ${spaced(title)} `
      return (
        <Box key={key} flexWrap="nowrap">
          <Text color={COLORS.line}>{label === '' ? '' : '── '}</Text>
          <Text dimColor>{label === '' ? '' : `${spaced(title)} `}</Text>
          <Text color={COLORS.line}>{'─'.repeat(Math.max(0, inner - label.length))}</Text>
        </Box>
      )
    }
    const pill = (key: string, on_: boolean, act: () => void) => (
      <Button key={key} label={on_ ? '● On' : '○ Off'} plain onPress={act}>
        {on_ ? (
          <Text bold backgroundColor={COLORS.green} color={COLORS.ink}>{isMini ? ' On ' : ' ● On '}</Text>
        ) : (
          <Text backgroundColor="#2a2f3a">{isMini ? ' Off ' : ' ○ Off '}</Text>
        )}
      </Button>
    )
    const settingRow = (key: keyof Settings, name: string, desc: string, control: unknown) => (
      <Box key={`row-${key}`} flexWrap="nowrap">
        <Text color={state.settings[key] === false ? COLORS.line : COLORS.green}>{state.settings[key] === false ? '○ ' : '● '}</Text>
        <Text bold>{isMini ? name : name.padEnd(15)}</Text>
        {size === 'wide' && <Text dimColor>{clip(desc, Math.max(4, inner - 30))}</Text>}
        <Box flexGrow={1} />
        {control as never}
      </Box>
    )
    const toggle = (key: 'investigations' | 'draftJudging' | 'notifications') => pill(`set-${key}`, state.settings[key], () => void toggleSetting($, key))
    const lastDump = state.entries.find(x => x.dump !== '')
    const lastDone = state.entries.find(x => x.status === 'done' || x.status === 'stopped' || x.status === 'failed')
    const openPane = (view: SidekickState['view']) => {
      void change($, s => ({ ...s, view, panelOpen: false }))
      void $.ui.open({ id: PANE, title: 'Sidekick', rows: PANE_ROWS })
    }
    const launch = [
      { key: 'launch-dashboard', glyph: '▣', color: COLORS.yellow, label: 'Dashboard', act: () => openPane('dashboard') },
      { key: 'launch-learned', glyph: '✎', color: COLORS.purple, label: `What it learned (${state.learned.length})`, act: () => openPane('learned') },
      { key: 'launch-record', glyph: '▤', color: COLORS.blue, label: 'Last record', act: () => void (lastDump !== undefined ? copyDump($, lastDump.dump) : $.ui.toast('No investigation record yet')) },
      { key: 'launch-main', glyph: '↩', color: COLORS.green, label: 'Give last to main', act: () => void (lastDone !== undefined ? giveToMain($, lastDone.id) : $.ui.toast('Nothing finished yet')) },
      { key: 'launch-reset', glyph: '↺', color: COLORS.dim, label: 'Reset to defaults', act: () => void resetSettings($) },
    ]
    // The band gets at most half the terminal: the panel takes the shape that fits its rows.
    // At most 15 rows (Dustin), so the folded line stays in view: rules, LAUNCH three to a row;
    // tight: no rules, LAUNCH on one row of short labels (12). No NOW: the job card shows it.
    const isTight = maxRows < 18
    // Short labels on wrapping rows when the rows are few or the panel is narrow.
    const isPacked = isTight || size !== 'wide'
    // Three to a row keeps LAUNCH to two rows.
    const perRow = isPacked ? launch.length : 3
    const cellW = Math.floor(inner / perRow)
    const launchRows = Array.from({ length: Math.ceil(launch.length / perRow) }, (_, r) => launch.slice(r * perRow, r * perRow + perRow))
    const shortLabel: Record<string, string> = {
      'launch-dashboard': 'Dashboard',
      'launch-learned': `Learned ${state.learned.length}`,
      'launch-record': 'Record',
      'launch-main': 'To main',
      'launch-reset': 'Reset',
    }
    const panel = !state.panelOpen ? null : (
      <Box key="sk-panel" flexDirection="column" borderStyle="round" borderColor={COLORS.claude} paddingX={1} width={panelW}>
        <Box flexWrap="nowrap">
          <Text color={COLORS.claude}>{'◆  '}</Text>
          <Text bold color={COLORS.orange}>{spaced('SIDEKICK')}</Text>
          <Box flexGrow={1} />
          {inner >= 60 &&
            counts.map(c => (
              <Text key={`pc-${c.glyph}`} color={c.n > 0 ? c.color : COLORS.dim}>{`${c.glyph} ${c.n}  `}</Text>
            ))}
          {inner >= 40 && <Text color={COLORS.green}>{`saved ${savedText}`}</Text>}
          {inner >= 40 && <Text dimColor>{' · '}</Text>}
          {inner >= 40 && <Text color={COLORS.blue}>{costText}</Text>}
        </Box>
        {!isTight && rule('r0', '')}
        <Box flexWrap="wrap">
          <Text dimColor>{rowLabel('MODE')}</Text>
          {chip('mode-off', 'Off', state.mode === 'off', '#c9ced8', () => void setMode($, 'off'))}
          {chip('mode-shadow', 'Shadow', state.mode === 'shadow', COLORS.purple, () => void setMode($, 'shadow'))}
          {chip('mode-auto', 'Auto', state.mode === 'auto', COLORS.green, () => void setMode($, 'auto'))}
        </Box>
        <Box flexWrap="wrap">
          <Text dimColor>{rowLabel('JUDGE')}</Text>
          {chipsFor(JUDGE_CHIPS, state.settings.judgeModel).map(([label, alias]) =>
            chip(`judge-${alias}`, chipLabel(label), state.settings.judgeModel === alias, COLORS.purple, () => void setSetting($, 'judgeModel', alias)),
          )}
        </Box>
        <Box flexWrap="wrap">
          <Text dimColor>{rowLabel('WORKER')}</Text>
          {chipsFor(WORKER_CHIPS, state.settings.workerModel).map(([label, alias]) =>
            chip(`worker-${alias}`, chipLabel(label), state.settings.workerModel === alias, COLORS.purple, () => void setSetting($, 'workerModel', alias)),
          )}
        </Box>
        {!isTight && rule('r1', 'SETTINGS')}
        {settingRow('investigations', 'Investigations', 'look into services, restart in place', toggle('investigations'))}
        {settingRow('draftJudging', 'Draft judging', 'judge as you type · ≈$0.0001 a pause', toggle('draftJudging'))}
        {settingRow('notifications', 'Notifications', 'a ping when a job finishes', toggle('notifications'))}
        {settingRow(
          'maxConcurrent',
          'Side by side',
          'chores in different repos at once',
          <Button key="set-maxConcurrent" label={isMini ? `${state.settings.maxConcurrent}×` : `${state.settings.maxConcurrent} at a time`} plain onPress={() => void setSetting($, 'maxConcurrent', (state.settings.maxConcurrent % 4) + 1)}>
            <Text backgroundColor="#2a2f3a">{isMini ? ` ${state.settings.maxConcurrent}× ` : ` ${state.settings.maxConcurrent} at a time `}</Text>
          </Button>,
        )}
        {!isTight && rule('r3', 'LAUNCH')}
        {launchRows.map((row, r) => (
          <Box key={`lr-${r}`} flexWrap={isPacked ? 'wrap' : 'nowrap'}>
            {row.map(item => (
              <Box key={`li-${item.key}`} width={isPacked ? undefined : cellW} flexWrap="nowrap">
                <Text color={item.color}>{`${item.glyph} `}</Text>
                <Button key={item.key} label={isPacked ? shortLabel[item.key] ?? item.label : clip(item.label, cellW - 2)} plain onPress={item.act}>
                  <Text>{isPacked ? shortLabel[item.key] ?? item.label : clip(item.label, cellW - 2)}</Text>
                </Button>
                {isPacked && <Text>{isMini ? '  ' : '   '}</Text>}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )

    if (e.surface !== 'terminal') {
      const rich = $.ui.resolve(e) as ElementTable<RichSurface>
      const { Svg } = rich
      // The phone draws no Select: its models stay buttons.
      const Select = 'Select' in rich ? rich.Select : undefined
      const room = Math.max(16, width - 24)
      const labels = ['running', 'queued', 'waiting']
      // The space above the prompt is short: the panel packs into a few rows of small type, so it never
      // needs a scroll and reads as a toolbox, not a form.
      const small = (key: string, text: string, props: { color?: string; dimColor?: boolean; bold?: boolean } = {}) => (
        <Text key={key} size="footnote" {...props}>
          {text}
        </Text>
      )
      const tool = (key: string, act: () => void, parts: { text: string; color?: string; dimColor?: boolean }[]) => (
        <Button key={key} label={parts.map(part => part.text).join('')} plain onPress={act}>
          {parts.map((part, i) => (
            <Text key={`${key}-${i}`} size="footnote" color={part.color} dimColor={part.dimColor}>
              {part.text}
            </Text>
          ))}
        </Button>
      )
      const dropdown = (key: string, title: string, options: { value: string; label: string }[], value: string, act: (value: string) => void) => [
        small(`label-${key}`, title, { dimColor: true }),
        Select !== undefined ? (
          <Select key={key} options={options} value={value} onSelect={act} />
        ) : (
          options.map(o => tool(`${key.replace(/-model$/, '')}-${o.value}`, () => act(o.value), [{ text: o.value === value ? `✓ ${o.label}` : o.label, dimColor: o.value !== value }]))
        ),
      ]
      const modes = [
        { value: 'off', label: 'Off' },
        { value: 'shadow', label: 'Shadow' },
        { value: 'auto', label: 'Auto' },
      ]
      const modelOptions = (chips: typeof JUDGE_CHIPS, field: 'judgeModel' | 'workerModel') => chipsFor(chips, state.settings[field]).map(([label, alias]) => ({ value: alias, label }))
      const setting = (key: 'investigations' | 'draftJudging' | 'notifications', name: string) =>
        tool(`set-${key}`, () => void toggleSetting($, key), [
          { text: state.settings[key] ? '● ' : '○ ', color: state.settings[key] ? COLORS.green : undefined, dimColor: !state.settings[key] },
          { text: name, dimColor: !state.settings[key] },
        ])
      const many = state.settings.maxConcurrent
      const richPanel = !state.panelOpen ? null : (
        <Box key="sk-panel" flexDirection="column" borderStyle="round" borderColor={COLORS.claude} paddingX={1} rowGap="xs" minWidth={0} flexShrink={1}>
          <Box key="row-models" flexWrap="wrap" alignItems="center" columnGap="sm" rowGap="xs">
            {small('title', '◆ Sidekick', { color: COLORS.claude, bold: true })}
            {dropdown('mode-select', 'Mode', modes, state.mode, value => void setMode($, value as Mode))}
            {dropdown('judge-model', 'Judge', modelOptions(JUDGE_CHIPS, 'judgeModel'), state.settings.judgeModel, value => void setSetting($, 'judgeModel', value))}
            {dropdown('worker-model', 'Worker', modelOptions(WORKER_CHIPS, 'workerModel'), state.settings.workerModel, value => void setSetting($, 'workerModel', value))}
            {small('label-many', 'Side by side', { dimColor: true })}
            {tool('set-maxConcurrent-down', () => void setSetting($, 'maxConcurrent', Math.max(1, many - 1)), [{ text: '−' }])}
            {small('many', String(many), { bold: true })}
            {tool('set-maxConcurrent-up', () => void setSetting($, 'maxConcurrent', Math.min(4, many + 1)), [{ text: '+' }])}
          </Box>
          <Box key="row-settings" flexWrap="wrap" alignItems="center" columnGap="md" rowGap="xs">
            {setting('investigations', 'Investigations')}
            {setting('draftJudging', 'Draft judging')}
            {setting('notifications', 'Notifications')}
            <Box flexGrow={1} />
            {launch.map(item =>
              tool(item.key, item.act, [
                { text: `${item.glyph} `, color: item.color },
                { text: item.key === 'launch-reset' ? 'Reset' : (shortLabel[item.key] ?? item.label) },
              ]),
            )}
            {version !== '' && small('version', `v${version}`, { dimColor: true })}
          </Box>
        </Box>
      )
      const richCard =
        lead === undefined || state.panelOpen ? null : (
          <Box key="sk-card" flexDirection="column" borderStyle="round" borderColor={COLORS.line} paddingX={1} rowGap="xs">
            <Box flexWrap="nowrap" alignItems="center" columnGap="sm">
              <Text bold color={COLORS.orange}>{lead.kind === 'investigate' ? 'Investigating' : 'Chore'}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text bold wrap="truncate-end">{clip(lead.prompt, room)}</Text>
              </Box>
              {running.length > 1 && <Text dimColor>{`+${running.length - 1}`}</Text>}
              <Text dimColor>{`${ageOf(lead)}s · step ${lead.steps.length}`}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">{clip(lead.steps.at(-1) ?? 'starting the worker…', room)}</Text>
            <Box key="sk-progress">
              <Svg alt="working" source={progressSvg(COLORS.orange)} isInteractive />
            </Box>
            <Text dimColor>{'Next: report back to Claude'}</Text>
          </Box>
        )
      const richFolded = (
        <Box key="sk-folded" flexWrap="wrap" alignItems="center" columnGap="sm" rowGap="xs">
          {small('f-title', '◆ Sidekick', { color: isOn ? COLORS.claude : undefined, dimColor: !isOn, bold: isOn })}
          {state.mode === 'off' ? small('f-mode', '○ Off', { dimColor: true }) : small('f-mode', state.mode === 'auto' ? '● Auto' : '◌ Shadow', { color: state.mode === 'auto' ? COLORS.green : COLORS.purple, bold: true })}
          {state.isWarming && small('f-warm', 'warming up…', { color: COLORS.purple })}
          {isOn && counts.map((c, i) => small(`c-${c.glyph}`, `${c.glyph} ${c.n} ${labels[i]}`, { color: c.n > 0 ? c.color : undefined, dimColor: c.n === 0 }))}
          {isOn && small('f-saved', `saved ${savedText}`, { color: COLORS.green })}
          {isOn && small('f-cost', `cost ${costText}`, { color: COLORS.blue })}
          <Box flexGrow={1} />
          {tool('band-toggle', () => void change($, s => ({ ...s, panelOpen: !s.panelOpen })), [{ text: state.panelOpen ? 'Sidekick ▴' : 'Sidekick ▾', color: COLORS.claude }])}
        </Box>
      )
      return (
        <Box flexDirection="column" rowGap="xs">
          {richCard}
          {richPanel !== null && (
            <Box key="sk-panel-row" flexWrap="nowrap">
              <Box flexGrow={1} />
              {richPanel}
            </Box>
          )}
          {richFolded}
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {card}
        {panel !== null && (
          <Box key="sk-panel-row" flexWrap="nowrap">
            <Box flexGrow={1} />
            {panel}
          </Box>
        )}
        {folded}
        {below}
      </Box>
    )
  })
}
