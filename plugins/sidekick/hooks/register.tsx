import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, PromptSubmitResult, Register } from 'claude-code'

import { JUDGE_SYSTEM, canStart, judgePrompt, lockKeys, parseJudgment, precheck } from './lib/judge'
import type { Judgment } from './lib/judge'
import {
  chatLine,
  giveToMainPrompt,
  handoffNote,
  parseOutcome,
  parseStreamLine,
  splitLines,
  workerArgv,
  workerInput,
} from './lib/worker'
import type { Entry, EntryStatus, Mode, Outcome, SidekickState } from '../types'

export const EMPTY: SidekickState = {
  mode: 'off',
  entries: [],
  waiting: [],
  notes: [],
  watching: '',
  totals: { assists: 0, passed: 0, failed: 0 },
}

const sidekick = atom({ plugin: 'sidekick', key: 'sidekick' } as const, EMPTY)

const PANE = 'sidekick'
// Dustin's ceiling is 2 s on any message; this leaves room for the hook around the call.
const JUDGE_TIMEOUT_MS = 1_800
const STATE_TIMEOUT_MS = 400
const WORKER_TIMEOUT_MS = 10 * 60_000
const MAX_ENTRIES = 60
const MAX_STEPS = 40
const ACTIVE: readonly EntryStatus[] = ['judging', 'queued', 'running']

// The engine follows `$` only into functions declared at the top of this file, so what the
// hooks share lives here. `register` sets the options; `session.start` the rest.
let isOff = false
let judgeModel = 'haiku'
let workerModel = 'haiku'
let maxConcurrent = 1
let cwd = ''
let guardPath = ''
let sequence = 0
/** When the judge's connection was last used; a cold one blows the budget (measured: 1.8 s+ against ~1.2 s warm). */
let lastJudgeAt = 0
type Judged = { judgment: Judgment; ms: number; stateMs: number; repo: string }
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
    prompt,
    status: 'judging',
    verdict: '',
    reason: '',
    judgeMs: 0,
    task: '',
    locks: [],
    backend: judgeModel,
    createdAt: now,
    startedAt: 0,
    endedAt: 0,
    steps: [],
    outcome: null,
    isMissed: false,
  }
}

async function addEntry($: EngineInterface, entry: Entry): Promise<void> {
  await update($, sidekick, s => ({ ...s, entries: [entry, ...s.entries].slice(0, MAX_ENTRIES) }))
}

async function patchEntry($: EngineInterface, id: string, patch: (entry: Entry) => Partial<Entry>): Promise<void> {
  await update($, sidekick, s => ({ ...s, entries: s.entries.map(x => (x.id === id ? { ...x, ...patch(x) } : x)) }))
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
        model: judgeModel,
        system: JUDGE_SYSTEM,
        prompt: judgePrompt(text, `cwd: ${cwd}`),
        maxTokens: 8,
        ...(budgetMs === null ? {} : { timeoutMs: budgetMs }),
      },
      { signal: stop.signal },
    )
    await state
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
  return { judgment, ms: (await $.clock.now()) - started, stateMs, repo }
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
  }
  const timer = $.clock.sleep(JUDGE_TIMEOUT_MS, { signal: stop.signal }).then(
    () => timedOut,
    () => timedOut,
  )
  const settled = await Promise.race([ahead.judged, timer])
  stop.abort()
  return settled === timedOut ? settled : { ...settled, ms: (await $.clock.now()) - started }
}

/** Judges the draft in the background once typing pauses, if it is one the judge would see. */
function judgeDraftSoon($: EngineInterface, draft: string): void {
  draftTimer?.cancel()
  const text = draft.trim()
  if (!precheck(text, false).isJudged || speculation?.text === text) return
  draftTimer = $.clock.after(DRAFT_PAUSE_MS, () => {
    speculation = { text, judged: judge($, text, null) }
  })
}

const WARM_AFTER_MS = 45_000

/** A one-token call that opens the judge's connection ahead of the prompt that needs it. */
async function warm($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - lastJudgeAt < WARM_AFTER_MS) return
  lastJudgeAt = now
  await $.model.complete({ model: judgeModel, prompt: 'Reply with: ok', maxTokens: 1 }).catch(() => undefined)
}

/** Starts every queued assist whose locks are free, oldest first; when nothing is left, releases held prompts. */
async function pump($: EngineInterface): Promise<void> {
  const state = await read($, sidekick)
  const held = state.entries.filter(x => x.status === 'running').map(x => x.locks)
  const queued = state.entries.filter(x => x.status === 'queued').reverse()
  for (const entry of queued) {
    if (!canStart(entry.locks, held, maxConcurrent)) continue
    held.push(entry.locks)
    await patchEntry($, entry.id, () => ({ status: 'running' }))
    void runAssist($, entry.id)
  }
  const after = await read($, sidekick)
  if (!after.entries.some(x => x.status === 'running' || x.status === 'queued')) await releaseWaiting($)
}

/** Sends the prompts held for the main session, in the order they were typed. */
async function releaseWaiting($: EngineInterface): Promise<void> {
  const { waiting } = await read($, sidekick)
  if (waiting.length === 0) return
  await update($, sidekick, s => ({ ...s, waiting: [] }))
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
  await update($, sidekick, s => ({ ...s, notes: [...s.notes, note] }))
}

async function tell($: EngineInterface, text: string): Promise<void> {
  try {
    const sent = await $.ui.notify(text, { title: 'Sidekick' })
    if (sent.isSent) return
  } catch {
    // Falls back to a toast.
  }
  $.ui.toast(text)
}

async function finish($: EngineInterface, id: string, outcome: Outcome): Promise<void> {
  workers.delete(id)
  const now = await $.clock.now()
  const entry = (await read($, sidekick)).entries.find(x => x.id === id)
  if (entry === undefined) return
  const status: EntryStatus = outcome.status === 'done' || outcome.status === 'partial' ? 'done' : outcome.status
  await patchEntry($, id, () => ({ status, outcome, endedAt: now }))
  await update($, sidekick, s => ({
    ...s,
    totals: {
      ...s.totals,
      assists: s.totals.assists + 1,
      failed: s.totals.failed + (status === 'done' ? 0 : 1),
    },
  }))
  const seconds = Math.max(1, Math.round((now - (entry.startedAt || entry.createdAt)) / 1000))
  $.ui.log(chatLine(outcome, workerModel, seconds))
  await deliverNote($, handoffNote(entry.prompt, outcome, workerModel))
  await tell($, status === 'done' ? `✓ ${outcome.summary}` : `⚠ ${outcome.summary} — open /sidekick to hand it to main`)
  await pump($)
}

async function runAssist($: EngineInterface, id: string): Promise<void> {
  const entry = (await read($, sidekick)).entries.find(x => x.id === id)
  if (entry === undefined) return
  const startedAt = await $.clock.now()
  await patchEntry($, id, () => ({ startedAt }))
  let isStopped = false
  let result: { text: string; isError: boolean } | null = null
  const stream = $.process.spawn({
    argv: workerArgv(workerModel, guardPath),
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
  try {
    let buffer = ''
    for await (const chunk of stream) {
      if (isStopped) break
      if (chunk.stream !== 'stdout') continue
      const split = splitLines(buffer, chunk.text)
      buffer = split.rest
      for (const line of split.lines) {
        const event = parseStreamLine(line)
        if (event.kind === 'step') {
          const step = event.text
          await patchEntry($, id, x => ({ steps: [...x.steps, step].slice(-MAX_STEPS) }))
        } else if (event.kind === 'result') {
          result = { text: event.text, isError: event.isError }
        }
      }
    }
  } catch {
    // An unstartable or killed child ends here; the outcome below says which.
  }
  timer.cancel()
  if (isStopped) {
    await finish($, id, {
      status: 'stopped',
      summary: 'Stopped before it finished.',
      commands: [],
      shas: [],
      changed: [],
      uncertain: ['It may have run some commands before it stopped; check git status.'],
      needsMain: 'Stopped by you or by the time limit.',
    })
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
    })
    return
  }
  await finish($, id, parseOutcome(result.text, result.isError))
}

/** Queues an assist for a task and starts it if its locks are free. */
async function enqueue($: EngineInterface, id: string, judgment: Judgment, repo: string): Promise<void> {
  await patchEntry($, id, () => ({
    status: 'queued',
    task: judgment.task,
    locks: lockKeys(judgment.resources, repo),
    backend: workerModel,
  }))
  await pump($)
}

/** Lets a prompt through to the main session, carrying any handoff notes it hasn't read yet. */
async function toMain($: EngineInterface, e: PromptSubmitInput, next: (e: PromptSubmitInput) => Promise<PromptSubmitResult>): Promise<PromptSubmitResult> {
  const { notes } = await read($, sidekick)
  if (notes.length === 0) return next(e)
  await update($, sidekick, s => ({ ...s, notes: [] }))
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

/** The status line says whether the sidekick is on, so a reload never leaves it in doubt. */
function showMode($: EngineInterface, mode: Mode): void {
  $.ui.status(mode === 'off' ? undefined : `on (${mode})`)
}

async function setMode($: EngineInterface, mode: Mode): Promise<void> {
  await update($, sidekick, s => ({ ...s, mode }))
  showMode($, mode)
  if (mode !== 'off') void warm($)
}

async function shadowJudge($: EngineInterface, id: string, text: string): Promise<void> {
  const { judgment, ms, stateMs } = await judge($, text, null)
  const would = judgment.verdict === 'mechanical'
  await patchEntry($, id, () => ({
    status: would ? 'shadow' : 'passed',
    verdict: judgment.verdict,
    reason: `${would ? `would hand off: ${judgment.task}` : judgment.reason}${ms > JUDGE_TIMEOUT_MS ? ' · over budget' : ''} (git ${stateMs}ms)`,
    task: judgment.task,
    judgeMs: ms,
  }))
}

async function stopEntry($: EngineInterface, id: string): Promise<void> {
  const live = workers.get(id)
  if (live !== undefined) {
    live.stop()
    return
  }
  const entry = (await read($, sidekick)).entries.find(x => x.id === id)
  if (entry?.status === 'queued') {
    const endedAt = await $.clock.now()
    await patchEntry($, id, () => ({ status: 'stopped', endedAt }))
    await pump($)
  }
}

async function giveToMain($: EngineInterface, id: string): Promise<void> {
  const entry = (await read($, sidekick)).entries.find(x => x.id === id)
  if (entry === undefined) return
  if (isActive(entry)) await stopEntry($, id)
  await $.prompt.submit({ text: giveToMainPrompt(entry.prompt, entry.outcome, entry.steps), asUser: true })
}

async function revert($: EngineInterface, id: string): Promise<void> {
  const entry = (await read($, sidekick)).entries.find(x => x.id === id)
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
  const { waiting } = await read($, sidekick)
  const held = waiting.find(w => w.id === waitingId)
  if (held === undefined) return
  await update($, sidekick, s => ({ ...s, waiting: s.waiting.filter(w => w.id !== waitingId) }))
  await $.prompt.submit({ text: held.text, asUser: true })
}

async function markMissed($: EngineInterface, id: string): Promise<void> {
  await patchEntry($, id, () => ({ isMissed: true }))
  const entry = (await read($, sidekick)).entries.find(x => x.id === id)
  if (entry === undefined) return
  // Kept across sessions so the judge can be tuned from real misses.
  const key = 'missed'
  const prior = ((await $.store.get(key)) as string[] | undefined) ?? []
  await $.store.set(key, [...prior, entry.prompt].slice(-200))
}

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
  judgeModel = typeof options.judgeModel === 'string' && options.judgeModel !== '' ? options.judgeModel : 'haiku'
  workerModel = typeof options.workerModel === 'string' && options.workerModel !== '' ? options.workerModel : 'haiku'
  maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 1)

  on('session.start', async ($, e, next) => {
    if ((await $.env.get('DMOKONG_MODS')) === '0' || (await $.env.get('SIDEKICK_WORKER')) === '1') isOff = true
    if (isOff || !e.isInteractive) return next(e)
    cwd = e.cwd
    guardPath = `${$.plugin.root}/bin/sidekick-guard`
    // A reload keeps the session's mode; the new module's connection starts cold.
    const { mode } = await read($, sidekick)
    showMode($, mode)
    if (mode !== 'off') void warm($)
    await $.command.register({
      name: 'sidekick',
      description: 'Sidekick for this session: hand mechanical chores (git, bd) to a cheap worker',
      argumentHint: '[auto|shadow|off]',
    })
    return next(e)
  })

  // Typing is the cue a prompt is coming: judge the draft while the person types, not after.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (isOff || (await read($, sidekick)).mode !== 'auto') return box
    if (e.text === '') void warm($)
    judgeDraftSoon($, box.text)
    return box
  })

  on('command.run', { command: 'sidekick' }, async ($, e) => {
    if (isOff) return { text: 'Sidekick is disabled here (DMOKONG_MODS=0, a worker session, or the Enabled option).' }
    const arg = e.args.trim().toLowerCase()
    const asked: Mode | null = arg === 'auto' ? 'auto' : arg === 'off' ? 'off' : arg === 'on' || arg === 'shadow' ? 'shadow' : null
    if (arg !== '' && asked === null) return { text: 'Usage: /sidekick [auto|shadow|off]' }
    if (asked !== null) await setMode($, asked)
    const { mode } = await read($, sidekick)
    if (mode !== 'off') await $.ui.open({ id: PANE, title: 'Sidekick' })
    const what: Record<Mode, string> = {
      off: 'Sidekick is off for this session.',
      shadow: 'Sidekick is in shadow for this session: it judges each message and logs what it would hand off, but everything still goes to Claude. /sidekick auto to let it act.',
      auto: `Sidekick is on for this session: mechanical chores go to ${workerModel}, everything else to Claude.`,
    }
    return { text: what[mode] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isOff) return next(e)
    const state = await read($, sidekick)
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
    const isBusy = state.entries.some(x => x.status === 'running' || x.status === 'queued')
    const holdForAssists = async (why: string): Promise<PromptSubmitResult> => {
      if (!isBusy || isMidTurn) return toMain($, e, next)
      const id = newId(now)
      await update($, sidekick, s => ({ ...s, waiting: [...s.waiting, { id, text: e.text }] }))
      clearRestored($, e.text)
      return { drop: `❯ ${clip(e.text.replace(/\s+/g, ' '), 160)} · held for Claude until the sidekick finishes (/sidekick → send now)` }
    }
    if (isMidTurn) return toMain($, e, next)
    if (!pre.isJudged) return holdForAssists(pre.why)

    const id = newId(now)
    await addEntry($, blankEntry(id, e.text, now))
    draftTimer?.cancel()
    const { judgment, ms, repo } = await verdictFor($, e.text)
    await patchEntry($, id, () => ({ verdict: judgment.verdict, reason: judgment.reason, judgeMs: ms }))
    if (judgment.verdict !== 'mechanical') {
      await patchEntry($, id, () => ({ status: 'passed' }))
      await update($, sidekick, s => ({ ...s, totals: { ...s.totals, passed: s.totals.passed + 1 } }))
      // A pass is a decision too: say so, or a sidekick that passes looks like one that is gone.
      $.ui.log(`→ to Claude: ${judgment.reason} · judged in ${(ms / 1000).toFixed(1)}s`)
      return holdForAssists(judgment.reason)
    }
    void enqueue($, id, judgment, repo).catch(() => {})
    clearRestored($, e.text)
    return { drop: `❯ ${e.text} → sidekick (${workerModel}) · judged in ${(ms / 1000).toFixed(1)}s` }
  }).catch(($, e, next) => next(e)) // fail open: any error lets the prompt through as typed

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, sidekick)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns ?? 60)
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 6) / 3))
    const modeButton = (mode: Mode) => (
      <Button key={`mode-${mode}`} label={state.mode === mode ? `[${mode}]` : mode} plain onPress={() => void setMode($, mode)} />
    )
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>Sidekick </Text>
          {modeButton('off')}
          <Text> </Text>
          {modeButton('shadow')}
          <Text> </Text>
          {modeButton('auto')}
        </Box>
        <Text dimColor>
          {clip(`${state.totals.assists} assists · ${state.totals.passed} to main · ${state.totals.failed} stopped/failed · judge ${judgeModel} · worker ${workerModel}`, width)}
        </Text>
        {state.mode === 'off' && <Text dimColor>Off for this session. Pick shadow to watch the judge, auto to let it act.</Text>}
        {state.waiting.map(held => (
          <Box key={`w-${held.id}`}>
            <Text color="warning">{clip(`◷ waiting for Claude: ${held.text}`, width - 12)} </Text>
            <Button key={`send-${held.id}`} label="send now" onPress={() => void sendNow($, held.id)} />
            <Text> · </Text>
            <Button key={`edit-${held.id}`} label="edit" plain onPress={() => void $.prompt.fill({ text: held.text, mode: 'replace' })} />
          </Box>
        ))}
        {state.entries.length === 0 && state.mode !== 'off' && <Text dimColor>Nothing yet. Type a chore like "commit and push".</Text>}
        {state.entries.slice(0, room).map(entry => {
          const isWatched = state.watching === entry.id
          const buttons: { key: string; label: string; act: () => void }[] = []
          // A prompt the sidekick took never entered the up-arrow history; this is its recall.
          const edit = { key: 'edit', label: 'edit', act: () => void $.prompt.fill({ text: entry.prompt, mode: 'replace' }) }
          const watch = { key: 'watch', label: isWatched ? 'hide' : 'watch', act: () => void update($, sidekick, s => ({ ...s, watching: isWatched ? '' : entry.id })) }
          if (entry.status === 'running' || entry.status === 'queued') {
            buttons.push(edit, watch, { key: 'stop', label: 'stop', act: () => void stopEntry($, entry.id) })
            buttons.push({ key: 'main', label: 'give to main', act: () => void giveToMain($, entry.id) })
          } else if (entry.status === 'done' || entry.status === 'stopped' || entry.status === 'failed') {
            buttons.push(edit, watch)
            if (entry.status === 'done' && (entry.outcome?.shas.length ?? 0) > 0) buttons.push({ key: 'revert', label: 'revert', act: () => void revert($, entry.id) })
            buttons.push({ key: 'main', label: 'give to main', act: () => void giveToMain($, entry.id) })
          } else if (entry.status === 'passed' && entry.verdict !== '' && !entry.isMissed) {
            buttons.push({ key: 'missed', label: "should've been sidekick", act: () => void markMissed($, entry.id) })
          }
          const color = entry.status === 'failed' || entry.status === 'stopped' ? 'error' : entry.status === 'done' ? 'success' : entry.status === 'running' ? 'warning' : undefined
          return (
            <Box key={`e-${entry.id}`} flexDirection="column">
              <Text color={color} dimColor={entry.status === 'passed' || entry.status === 'shadow'}>
                {clip(`${STATUS_MARK[entry.status]} ${entry.prompt}`, width)}
              </Text>
              <Text dimColor>{clip(`  ${entryDetail(entry, now)}`, width)}</Text>
              {buttons.length > 0 && (
                <Box>
                  <Text>  </Text>
                  {buttons.flatMap((b, i) => [
                    ...(i > 0 ? [<Text key={`gap-${b.key}-${entry.id}`}> · </Text>] : []),
                    <Button key={`${b.key}-${entry.id}`} label={b.label} plain onPress={b.act} />,
                  ])}
                </Box>
              )}
              {isWatched && (
                <Box flexDirection="column">
                  <Text dimColor>{clip(`  task: ${entry.task}`, width)}</Text>
                  {entry.steps.map((step, i) => (
                    <Text key={`s-${entry.id}-${i}`} dimColor>
                      {clip(`  ${step}`, width)}
                    </Text>
                  ))}
                  {entry.outcome !== null && entry.outcome.uncertain.length > 0 && (
                    <Text color="warning">{clip(`  unsure: ${entry.outcome.uncertain.join('; ')}`, width)}</Text>
                  )}
                  {entry.outcome !== null && entry.outcome.needsMain !== '' && (
                    <Text color="warning">{clip(`  needs main: ${entry.outcome.needsMain}`, width)}</Text>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOff || e.props.hasSurvey) return next(e)
    const state = await read($, sidekick)
    if (state.mode === 'off') return next(e)
    const running = state.entries.filter(x => x.status === 'running')
    const queued = state.entries.filter(x => x.status === 'queued').length
    if (running.length === 0 && queued === 0 && state.waiting.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 80
    const lead = running[0]
    const parts = [
      lead !== undefined ? `⟳ sidekick: ${lead.task}${lead.steps.length > 0 ? ` · ${lead.steps.at(-1)}` : ''}` : '◷ sidekick',
      running.length > 1 ? `+${running.length - 1} running` : '',
      queued > 0 ? `${queued} queued` : '',
      state.waiting.length > 0 ? `${state.waiting.length} waiting for Claude` : '',
    ].filter(part => part !== '')
    return (
      <Box>
        <Text key="line" color="warning">
          {clip(parts.join(' · '), Math.max(10, width - 10))}{' '}
        </Text>
        <Button key="open" label="Open" onPress={() => void $.ui.open({ id: PANE, title: 'Sidekick' })} />
      </Box>
    )
  })
}
