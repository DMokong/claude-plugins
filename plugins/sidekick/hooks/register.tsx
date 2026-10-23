import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, PromptSubmitResult, Register } from 'claude-code'

import { MAX_MISSES, canStart, holdsMain, judgePrompt, judgeSystem, lockKeys, parseJudgment, precheck, taughtVerdict } from './lib/judge'
import type { Judgment } from './lib/judge'
import { NO_SPEND, addTally, tallyLine, tallyOf, tokens, usd } from './lib/cost'
import { migrate, toTaught } from './lib/state'
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
import type { Entry, EntryStatus, Mode, Outcome, Profile, SidekickState, Taught, Tally } from '../types'

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
let judgeModel = 'haiku'
let workerModel = 'haiku'
let maxConcurrent = 1
let cwd = ''
let guardPath = ''
/** The loaded version, from the plugin's own manifest; shown in the pane so a stale load is visible. */
let version = ''
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
    backend: judgeModel,
    createdAt: now,
    startedAt: 0,
    endedAt: 0,
    steps: [],
    outcome: null,
    isMissed: false,
    judgeSpend: NO_SPEND,
    workerSpend: NO_SPEND,
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
        model: judgeModel,
        system: judgeSystem(misses),
        prompt: judgePrompt(text, `cwd: ${cwd}`),
        maxTokens: 8,
        ...(budgetMs === null ? {} : { timeoutMs: budgetMs }),
      },
      { signal: stop.signal },
    )
    await state
    spent = tallyOf(judgeModel, reply.usage)
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
  // A cold first call can outlast the judge's budget; say so in the band rather than leave a
  // message that times out to the main session unexplained.
  await change($, s => ({ ...s, isWarming: true }))
  const reply = await $.model.complete({ model: judgeModel, prompt: 'Reply with: ok', maxTokens: 1 }).catch(() => undefined)
  await change($, s => ({ ...s, isWarming: false }))
  if (reply !== undefined) await addSpend($, tallyOf(judgeModel, reply.usage))
}

/** Starts every queued assist whose locks are free, oldest first; when nothing is left, releases held prompts. */
async function pump($: EngineInterface): Promise<void> {
  const state = await load($)
  const held = state.entries.filter(x => x.status === 'running').map(x => x.locks)
  const queued = state.entries.filter(x => x.status === 'queued').reverse()
  for (const entry of queued) {
    if (!canStart(entry.locks, held, maxConcurrent)) continue
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
  const entry = (await load($)).entries.find(x => x.id === id)
  if (entry === undefined) return
  const status: EntryStatus = outcome.status === 'done' || outcome.status === 'partial' ? 'done' : outcome.status
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
  $.ui.log(chatLine(outcome, workerModel, seconds, (after?.judgeSpend.usd ?? 0) + (after?.workerSpend.usd ?? 0)))
  await deliverNote($, handoffNote(entry.prompt, outcome, workerModel))
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
    argv: workerArgv(workerModel, guardPath, instructions ?? [], entry.kind),
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
    const commands = new Map<string, string>()
    for await (const chunk of stream) {
      if (isStopped) break
      if (chunk.stream !== 'stdout') continue
      const split = splitLines(buffer, chunk.text)
      buffer = split.rest
      for (const line of split.lines) {
        const event = parseStreamLine(line)
        if (event.kind === 'step') {
          const step = event.text
          commands.set(event.id, step)
          await patchEntry($, id, x => ({ steps: [...x.steps, step].slice(-MAX_STEPS) }))
        } else if (event.kind === 'refused') {
          // Say which command was turned down, so a stopped assist can be explained and fixed.
          const step = `✗ refused: ${(commands.get(event.id) ?? '(a tool call)').replace(/^\$ /, '')}`
          await patchEntry($, id, x => ({ steps: [...x.steps, step].slice(-MAX_STEPS) }))
        } else if (event.kind === 'result') {
          result = { text: event.text, isError: event.isError }
          const priced = tallyOf(workerModel, event.usage)
          // An unpriced model still has Claude Code's own figure for the run.
          const workerSpend = priced.usd === 0 && event.costUsd > 0 ? { ...priced, usd: event.costUsd } : priced
          await patchEntry($, id, () => ({ workerSpend }))
          await addSpend($, workerSpend)
        }
      }
    }
  } catch {
    // An unstartable or killed child ends here; the outcome below says which.
  }
  timer.cancel()
  ticker.cancel()
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
  const kind: Profile = judgment.verdict === 'investigate' ? 'investigate' : 'chore'
  await patchEntry($, id, () => ({
    kind,
    status: 'queued',
    task: judgment.task,
    locks: lockKeys(judgment.resources, repo),
    backend: workerModel,
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
    await patchEntry($, id, () => ({ status: 'stopped', endedAt }))
    await pump($)
  }
}

async function giveToMain($: EngineInterface, id: string): Promise<void> {
  const entry = (await load($)).entries.find(x => x.id === id)
  if (entry === undefined) return
  if (isActive(entry)) await stopEntry($, id)
  await $.prompt.submit({ text: giveToMainPrompt(entry.prompt, entry.outcome, entry.steps), asUser: true })
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
    try {
      const manifest = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))) as { version?: unknown }
      version = typeof manifest.version === 'string' ? manifest.version : ''
    } catch {
      version = ''
    }
    // A reload keeps the session's mode; the new module's connection starts cold.
    try {
      const stored = await $.store.get(MISSES_KEY)
      misses = toTaught(stored)
    } catch {
      misses = []
    }
    await change($, state => ({ ...state, learned: misses }))
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
    if (isOff || (await load($)).mode !== 'auto') return box
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
      auto: `Sidekick is on for this session: mechanical chores go to ${workerModel}, everything else to Claude.`,
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
    const { judgment, ms, repo, spend } = await verdictFor($, e.text)
    // An investigation without the main session's instruction files would guess where things live.
    const isBlind = judgment.verdict === 'investigate' && (await load($)).instructions === null
    const routed: Judgment = isBlind
      ? { ...judgment, verdict: 'needs-main', reason: "no instruction files yet: the sidekick wouldn't know where things live (they arrive with the next /clear or compaction)" }
      : judgment
    await patchEntry($, id, () => ({ verdict: judgment.verdict, reason: routed.reason, judgeMs: ms, judgeSpend: spend }))
    if (routed.verdict !== 'mechanical' && routed.verdict !== 'investigate') {
      await patchEntry($, id, () => ({ status: 'passed' }))
      await change($, s => ({ ...s, totals: { ...s.totals, passed: s.totals.passed + 1 } }))
      // A pass is a decision too: say so, or a sidekick that passes looks like one that is gone.
      $.ui.log(`→ to Claude: ${routed.reason} · judged in ${(ms / 1000).toFixed(1)}s`)
      return holdForAssists(routed.reason)
    }
    void enqueue($, id, routed, repo).catch(() => {})
    clearRestored($, e.text)
    const doing = routed.verdict === 'investigate' ? ' · investigating' : ''
    return { drop: `❯ ${e.text} → sidekick (${workerModel})${doing} · judged in ${(ms / 1000).toFixed(1)}s` }
  }).catch(($, e, next) => next(e)) // fail open: any error lets the prompt through as typed

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // Read the state before any early return, so every draw subscribes and a later write redraws it.
    const state = await load($)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns ?? 60)
    const spin = SPINNER[state.tick % SPINNER.length] ?? '⟳'
    const running = state.entries.filter(x => x.status === 'running')
    const queued = state.entries.filter(x => x.status === 'queued')
    const finished = state.entries.filter(x => x.status === 'done' || x.status === 'stopped' || x.status === 'failed')
    const passed = state.entries.filter(x => x.status === 'passed' || x.status === 'shadow' || x.status === 'judging')
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 40) - 16) / 3))
    // The corrections the judge follows now, newest first; each can be forgotten.
    const learned = state.learned.slice(-MAX_MISSES).reverse()

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
        list.push(toMainButton)
      } else if (entry.status === 'passed' && entry.verdict !== '' && !entry.isMissed) {
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

    const section = (key: string, title: string, color: string, count: number) => (
      <Box key={`h-${key}`} marginTop={1}>
        <Text bold color={color}>
          {`▌ ${title}`}
        </Text>
        <Text dimColor>{` ${count}`}</Text>
      </Box>
    )

    const modeColor: Record<Mode, string> = { off: 'subtle', shadow: 'suggestion', auto: 'success' }
    const cost = (entry: Entry) => entry.judgeSpend.usd + entry.workerSpend.usd

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={modeColor[state.mode]} paddingX={1} paddingY={0}>
          <Box justifyContent="space-between">
            <Text bold color="claude">
              ◆ SIDEKICK
            </Text>
            {version !== '' && <Text dimColor>{`v${version}`}</Text>}
          </Box>
          <Box>
            <Text dimColor>{'mode   '}</Text>
            {(['off', 'shadow', 'auto'] as const).flatMap((mode, i) => [
              ...(i > 0 ? [<Text key={`mg-${mode}`}>{'  '}</Text>] : []),
              <Button
                key={`mode-${mode}`}
                label={state.mode === mode ? `● ${mode.toUpperCase()}` : `○ ${mode}`}
                plain
                dimColor={state.mode !== mode}
                onPress={() => void setMode($, mode)}
              />,
            ])}
          </Box>
          <Box flexWrap="wrap">
            <Text dimColor>{'now    '}</Text>
            <Text color={running.length > 0 ? 'warning' : 'subtle'}>{`${running.length > 0 ? spin : '·'} ${running.length} running`}</Text>
            <Text color={queued.length > 0 ? 'suggestion' : 'subtle'}>{`   ◷ ${queued.length} queued`}</Text>
            <Text color={state.waiting.length > 0 ? 'warning' : 'subtle'}>{`   ⏸ ${state.waiting.length} waiting`}</Text>
          </Box>
          <Box flexWrap="wrap">
            <Text dimColor>{'total  '}</Text>
            <Text color="success">{`✓ ${state.totals.assists - state.totals.failed} done`}</Text>
            <Text color={state.totals.failed > 0 ? 'error' : 'subtle'}>{`   ✗ ${state.totals.failed} stopped`}</Text>
            <Text dimColor>{`   → ${state.totals.passed} to Claude`}</Text>
          </Box>
          <Box flexWrap="wrap">
            <Text dimColor>{'cost   '}</Text>
            <Text bold>{`≈${usd(state.spend.usd)}`}</Text>
            <Text dimColor>{' this session   '}</Text>
            <Text color={state.spend.savedUsd >= 0 ? 'success' : 'warning'}>
              {`caching ${state.spend.savedUsd >= 0 ? 'saved' : 'cost'} ≈${usd(Math.abs(state.spend.savedUsd))}`}
            </Text>
          </Box>
          <Text dimColor wrap="wrap">{`models judge ${judgeModel} · worker ${workerModel} · costs are API-equivalent estimates`}</Text>
          <Text dimColor wrap="wrap">{`context ${contextLine(state.instructions)}`}</Text>
        </Box>

        {state.mode === 'off' && <Text dimColor>Off for this session. Pick shadow to watch the judge, auto to let it act.</Text>}
        {state.mode !== 'off' && state.entries.length === 0 && state.waiting.length === 0 && (
          <Text dimColor>Nothing yet. Type a chore like "commit and push".</Text>
        )}

        {running.length > 0 && section('run', 'RUNNING', 'warning', running.length)}
        {running.map(entry => (
          <Box key={`e-${entry.id}`} flexDirection="column">
            <Box>
              <Text color="warning" bold>
                {clip(`${spin} ${entry.prompt}`, width - 12)}
              </Text>
              <Text dimColor>{`  ${Math.max(0, Math.round((now - (entry.startedAt || entry.createdAt)) / 1000))}s`}</Text>
            </Box>
            <Text color={(entry.steps.at(-1) ?? '').startsWith('✗') ? 'error' : 'text'}>{clip(`    ↳ ${entry.steps.at(-1) ?? 'starting the worker…'}`, width)}</Text>
            {buttonsFor(entry)}
            {watched(entry)}
          </Box>
        ))}

        {queued.length > 0 && section('queue', 'QUEUED', 'suggestion', queued.length)}
        {queued.map(entry => (
          <Box key={`e-${entry.id}`} flexDirection="column">
            <Text color="suggestion">{clip(`◷ ${entry.prompt}`, width)}</Text>
            {buttonsFor(entry)}
          </Box>
        ))}

        {state.waiting.length > 0 && section('wait', 'WAITING FOR CLAUDE', 'warning', state.waiting.length)}
        {state.waiting.map(held => (
          <Box key={`wt-${held.id}`} flexDirection="column">
            <Text color="warning">{clip(`⏸ ${held.text}`, width)}</Text>
            <Box>
              <Text>{'    '}</Text>
              <Button key={`send-${held.id}`} label="send now" plain onPress={() => void sendNow($, held.id)} />
              <Text dimColor> · </Text>
              <Button key={`edit-${held.id}`} label="edit" plain onPress={() => void $.prompt.fill({ text: held.text, mode: 'replace' })} />
            </Box>
          </Box>
        ))}

        {finished.length > 0 && section('done', 'DONE', 'success', finished.length)}
        {finished.slice(0, room).map(entry => {
          const isOk = entry.status === 'done'
          const seconds = Math.max(1, Math.round((entry.endedAt - (entry.startedAt || entry.createdAt)) / 1000))
          return (
            <Box key={`e-${entry.id}`} flexDirection="column">
              <Box>
                <Text color={isOk ? 'success' : 'error'}>{clip(`${STATUS_MARK[entry.status]} ${entry.prompt}`, width - 22)}</Text>
                <Text dimColor>{`  ${seconds}s · ≈${usd(cost(entry))}`}</Text>
              </Box>
              <Text dimColor>{clip(`    ${entry.outcome?.summary ?? ''}`, width)}</Text>
              {buttonsFor(entry)}
              {watched(entry)}
            </Box>
          )
        })}

        {passed.length > 0 && section('pass', 'TO CLAUDE', 'permission', passed.length)}
        {passed.slice(0, room).map(entry => (
          <Box key={`e-${entry.id}`} flexDirection="column">
            <Text dimColor>{clip(`${STATUS_MARK[entry.status]} ${entry.prompt}`, width)}</Text>
            <Text dimColor>{clip(`    ${entryDetail(entry, now)}`, width)}</Text>
            {buttonsFor(entry)}
          </Box>
        ))}

        {learned.length > 0 && section('learned', 'LEARNED', 'claude', state.learned.length)}
        {learned.map(m => (
          <Box key={`l-${m.text}`}>
            <Text dimColor>{clip(`✎ [${verdictLabel(m.verdict)}] ${m.text.replace(/\s+/g, ' ')}`, width - 10)}</Text>
            <Text>{'  '}</Text>
            <Button key={`forget-${m.text}`} label="forget" plain onPress={() => void forget($, m.text)} />
          </Box>
        ))}
        {state.learned.length > learned.length && (
          <Text dimColor>{`    +${state.learned.length - learned.length} older, stored but not used · /sidekick learned`}</Text>
        )}
      </Box>
    )
  })

  // The band says the sidekick is on and what it is doing; it stacks above any other band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOff || e.props.hasSurvey) return next(e)
    const state = await load($)
    if (state.mode === 'off') return next(e)
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 80
    const spin = SPINNER[state.tick % SPINNER.length] ?? '⟳'
    const running = state.entries.filter(x => x.status === 'running')
    const queued = state.entries.filter(x => x.status === 'queued').length
    const lead = running[0]
    const activity =
      lead !== undefined
        ? `${spin} ${lead.prompt}${lead.steps.length > 0 ? ` · ${lead.steps.at(-1)}` : ''}${running.length > 1 ? ` +${running.length - 1}` : ''}`
        : state.isWarming
          ? 'warming up the judge…'
          : 'idle'
    // One line at any width: the least useful parts give way first, then the activity is cut.
    const parts: { text: string; color: string; keep: number }[] = [
      { text: queued > 0 ? `◷ ${queued} queued` : '', color: 'suggestion', keep: 2 },
      { text: state.waiting.length > 0 ? `⏸ ${state.waiting.length} waiting` : '', color: 'warning', keep: 3 },
      { text: `≈${usd(state.spend.usd)}`, color: 'subtle', keep: 1 },
      { text: `${state.totals.assists} ${state.totals.assists === 1 ? 'assist' : 'assists'}`, color: 'subtle', keep: 0 },
    ].filter(part => part.text !== '')
    const fixed = 'sidekick '.length + state.mode.length + 2 + ' │ '.length + ' Open '.length + 8
    const minActivity = 14
    const length = (list: typeof parts) => list.reduce((n, part) => n + part.text.length + 3, 0)
    let shown = [...parts]
    while (shown.length > 0 && fixed + minActivity + length(shown) > width) {
      const lowest = Math.min(...shown.map(part => part.keep))
      shown = shown.filter(part => part.keep !== lowest)
    }
    const room = Math.max(8, width - fixed - length(shown))
    return (
      <Box flexDirection="column">
        <Box key="sidekick-band" flexWrap="nowrap">
          <Text bold color="claude">
            ◆ sidekick{' '}
          </Text>
          <Text bold inverse color={state.mode === 'auto' ? 'success' : 'suggestion'}>
            {` ${state.mode.toUpperCase()} `}
          </Text>
          <Text dimColor> │ </Text>
          <Text color={lead !== undefined ? 'warning' : state.isWarming ? 'suggestion' : 'subtle'}>{clip(activity, room)}</Text>
          {shown.map(part => (
            <Text key={`band-${part.keep}`} color={part.color}>
              {` · ${part.text}`}
            </Text>
          ))}
          <Text> </Text>
          <Button key="open" label="Open" onPress={() => void $.ui.open({ id: PANE, title: 'Sidekick', rows: PANE_ROWS })} />
        </Box>
        {below}
      </Box>
    )
  })
}
