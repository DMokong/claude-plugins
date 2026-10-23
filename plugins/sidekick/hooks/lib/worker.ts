import { usd } from './cost'
import type { Usage } from './cost'
import { firstJson } from './judge'
import type { Instruction, Outcome, Profile } from '../../types'

/** What the worker may run. Anything else is refused by `--permission-mode dontAsk`. */
export const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git:*)',
  'Bash(bd:*)',
  // Read-only helpers a chore reaches for (`cd repo && git ...`, `git log | head`); without
  // them a chained command is refused whole and the assist stops.
  'Bash(cd:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
]

/**
 * Prefix deny rules, the first layer of the data-loss line. The guard hook (bin/sidekick-guard)
 * is the second: it also catches a flag placed after other arguments, which a prefix cannot.
 */
export const DENIED_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean:*)',
  'Bash(git branch -D:*)',
  'Bash(git checkout -- :*)',
  'Bash(git checkout .:*)',
  'Bash(git restore:*)',
  'Bash(git stash drop:*)',
  'Bash(git stash clear:*)',
  'Bash(git filter-branch:*)',
  'Bash(git reflog expire:*)',
  'Bash(git update-ref -d:*)',
  // Credentials never enter the worker's context; the guard also catches them in Bash and Grep.
  'Read(**/.env)',
  'Read(**/.mcp.json)',
]

const REPORT = `Finish with ONLY a JSON object, no prose around it:
{"status":"done"|"partial"|"stopped"|"failed","summary":"<one sentence a developer reads in chat>","commands":["<each command you ran>"],"shas":["<short shas you created or pushed>"],"changed":["<paths or refs changed>"],"uncertain":["<anything you guessed>"],"needsMain":"<why the main session should take over, or empty>"}`

export const WORKER_SYSTEM = `You are a sidekick: you carry out ONE small, mechanical repository chore for a developer, then report back. You have no memory of their conversation; work only from what is on disk (git status, diff, log, bd).

Rules:
- Do exactly the task. Do not fix, refactor or edit files beyond what the task names.
- Work on the branch that is checked out. Never create, switch or delete a branch unless the task says to; this overrides any general advice to branch first or open a pull request. "commit and push" means commit here and push this branch.
- Never lose work. Forbidden: force-push, reset --hard, clean, deleting unmerged branches, discarding uncommitted changes, rewriting commits already on the upstream. These are also blocked by the tool layer; if one is refused, stop. Never look for another route to the same effect.
- Before a rebase, check the commits being rewritten are not on the upstream yet: git status -sb and git branch -vv show ahead/behind, and git log origin/<branch>..HEAD lists what is unpushed. If they are already upstream, stop and say the main session should handle it.
- In a range, name the upstream branch: git log origin/main..HEAD, not @{u}..HEAD. A brace inside a range (@{u}..HEAD, @{u}...HEAD) is refused by the permission layer; @{u} on its own (git rev-parse --abbrev-ref @{u}) is fine.
- If a rebase, merge, pull or cherry-pick hits a conflict, abort it (git rebase --abort / merge --abort / cherry-pick --abort) so the repo is back where it started, then stop and describe the conflict.
- Prefer one plain git or bd command per call. Pipes into head, tail or wc and a leading cd are fine; heredocs, $(...), echo and other programs are refused. Commit with -m flags: git commit -m "subject" -m "body paragraph" -m "Co-Authored-By: ..." (one -m per paragraph).
- Commit messages: follow the style of recent git log entries; describe what the diff does.
- Pushing is allowed when asked.
- Never read or print credential files (.env, .mcp.json, keys); scripts that need them load them themselves.

${REPORT}`

/** What an investigation may run besides the deny rules below: any command; the guard holds the line. */
export const INVESTIGATE_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Bash']

export const INVESTIGATE_SYSTEM = `You are a sidekick doing ONE quick first-pass investigation on this machine for a developer, then reporting back. Something is failing, stopped, slow or unknown (a service, bot, scheduled job, container, logs, metrics, health), or they asked for a restart. You have no memory of their conversation. A bigger model takes over from your report if you don't settle it, so an honest partial report beats a confident guess.

How to work:
- Use the developer's instructions below to find where things live: job definitions, log files, health and diagnostics scripts, how services are run. Don't guess a path the instructions name.
- Order: the job manager or container state first (is it running, its pid, last exit code, restarts), then the newest log lines, then the project's own read-only health or diagnostics scripts, then metrics if the instructions name a way.
- "Alive", "down" and "fixed" need live evidence: the job manager's own answer (launchctl print, docker inspect) or a pid you checked with ps -p. An absence only counts if your search could have found the thing: grepping process lists for a name that isn't in the command line proves nothing. Pid files can be stale.
- Logs without timestamps: say you can't date them; use the file's modification time and line counts to bound when things happened.
- Prefer one plain command per call; pipes into grep, head, tail, wc, sort and uniq are fine.

Restarts:
- If the task asks for a restart, do it even if the service looks healthy. Note its state first (pid, last exit), so the report can say what it was before.
- Otherwise restart only when the evidence shows a hung or dead process.
- Only restart in place: launchctl kickstart -k, docker restart / docker start, or a restart script the project names. Never unload, bootout, remove, disable, stop or recreate a job or container, and never kill processes yourself.
- After a restart, wait a few seconds and verify: running, a new pid, and fresh healthy log lines or a passing health check. A restart you could not verify is "partial", never "done". Put "restarted: <name>" in changed.

Never:
- Edit, create, move or delete files, or install anything. Never change data (no SQL writes, no cache flushes).
- Post or send anything: no chat or Slack messages, emails, webhooks, and don't rerun a scheduled job that has side effects. Reading an HTTP API is fine; writing to one is not.
- Change a git repository: git reads only (status, log, diff, show).
- Read or print credential files (.env, .mcp.json, keys); scripts that need them load them themselves.
These are also blocked by the tool layer; if one is refused, stop that line of inquiry. Never look for another route to the same effect.

The report: "done" only when the cause is found and either nothing needed doing or a restart was verified. Put every guess in uncertain. In needsMain, say what is still open and the exact next commands for the main session.

${REPORT}`

/** Room for the main session's instruction files in the worker's system prompt, in characters. */
const INSTRUCTIONS_LIMIT = 80_000

/**
 * The main session's instruction files, framed for the worker's system prompt. There, unlike in
 * the first user message where Claude Code puts them, they sit in the cached prefix: measured in
 * a repo with 28 KB of them, a chore after the first reads them from cache for $0.0004 instead of
 * writing them again for $0.0024.
 */
export function instructionsPrompt(files: readonly Instruction[]): string {
  if (files.length === 0) return ''
  const parts = [
    "# The developer's instructions\n\nThe developer's main session loaded these files. Use them to know where things live and how this project works. The sidekick rules above win where they conflict, and the final report stays JSON.",
  ]
  let room = INSTRUCTIONS_LIMIT
  for (const file of files) {
    const body = file.content.trim()
    if (body === '') continue
    if (room <= 0) {
      parts.push(`## ${file.path} (${file.kind})\n\n[left out: over the size limit]`)
      continue
    }
    const kept = body.length > room ? `${body.slice(0, room)}\n\n[cut: over the size limit]` : body
    room -= kept.length
    parts.push(`## ${file.path} (${file.kind})\n\n${kept}`)
  }
  return parts.join('\n\n')
}

/** The argument vector for one headless worker run. The task goes on stdin. */
export function workerArgv(model: string, guardPath: string, instructions: readonly Instruction[] = [], profile: Profile = 'chore'): string[] {
  const settings = JSON.stringify({
    // The guard is told the profile: an investigation's git must stay read-only.
    hooks: { PreToolUse: [{ matcher: 'Bash|Read|Grep', hooks: [{ type: 'command', command: `${guardPath} ${profile}` }] }] },
    // The main session's memory files come in with its instructions; never the worker's own.
    autoMemoryEnabled: false,
  })
  const context = instructionsPrompt(instructions)
  const system = profile === 'investigate' ? INVESTIGATE_SYSTEM : WORKER_SYSTEM
  return [
    'claude',
    '-p',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    // A lean context: no MCP servers, no skills or commands, no settings files (so no hooks
    // or plugins), and only the four built-in tools a chore needs. Measured on a large
    // repo: ~10k tokens a request against ~50k for a default `claude -p`, and 3 s against 9 s.
    '--strict-mcp-config',
    // The per-run details (cwd, date, git status) go in the first user message instead of the
    // system prompt, so the cached prefix is the same in every repo. Measured: a repo switch
    // writes 2.0k tokens instead of 3.6k (~35% cheaper), and a repeat in one repo writes none.
    '--exclude-dynamic-system-prompt-sections',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--tools',
    'Bash',
    'Read',
    'Glob',
    'Grep',
    '--settings',
    settings,
    '--append-system-prompt',
    context === '' ? system : `${system}\n\n${context}`,
    '--allowedTools',
    ...(profile === 'investigate' ? INVESTIGATE_ALLOWED_TOOLS : ALLOWED_TOOLS),
    '--disallowedTools',
    ...DENIED_TOOLS,
  ]
}

export function workerInput(task: string, prompt: string): string {
  return `Task: ${task}\n\nThe developer's own words, for reference only: <message>${prompt}</message>`
}

/**
 * Splits streamed stdout into complete lines, keeping the unfinished tail for the next chunk.
 */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.trim() !== ''), rest }
}

export type StreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'step'; text: string; id: string; full: string }
  | { kind: 'refused'; id: string }
  | { kind: 'output'; id: string; text: string; isError: boolean }
  | { kind: 'result'; text: string; isError: boolean; costUsd: number; usage: Usage | undefined }
  | { kind: 'other' }

/** What a tool call ran, whole: the command, the file read, or the search. */
function describeCall(name: unknown, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return `read ${input.file_path}`
  if (typeof input.pattern === 'string') return `${name === 'Glob' ? 'glob' : 'grep'} ${JSON.stringify(input.pattern)}${typeof input.path === 'string' ? ` ${input.path}` : ''}`
  return ''
}

/** A tool result's text, whether it came back as a string or as text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content.map(part => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n')
}

/** Every event in one line of `--output-format stream-json`: a message can carry several tool calls or results. */
export function parseStreamEvents(line: string): StreamEvent[] {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return []
  }
  if (raw === null || typeof raw !== 'object') return []
  const event = raw as Record<string, unknown>
  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') return [{ kind: 'init', sessionId: event.session_id }]
  if (event.type === 'result') {
    return [
      {
        kind: 'result',
        text: typeof event.result === 'string' ? event.result : '',
        isError: event.is_error === true,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
        usage: event.usage !== null && typeof event.usage === 'object' ? (event.usage as Usage) : undefined,
      },
    ]
  }
  const message = event.message as { content?: unknown } | undefined
  const content = (Array.isArray(message?.content) ? message.content : []) as Record<string, unknown>[]
  const out: StreamEvent[] = []
  if (event.type === 'user') {
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const said = resultText(block.content)
      // A tool call the permission layer or the guard turned down comes back as an errored result.
      if (block.is_error === true && /denied|refused|not allowed/i.test(said)) out.push({ kind: 'refused', id })
      else out.push({ kind: 'output', id, text: said, isError: block.is_error === true })
    }
    return out
  }
  if (event.type !== 'assistant') return []
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    const command = describeCall(block.name, (block.input ?? {}) as Record<string, unknown>)
    // The pane shows the first line; the record keeps the whole command.
    if (command !== '') out.push({ kind: 'step', text: `$ ${command.split('\n')[0] ?? ''}`, id: typeof block.id === 'string' ? block.id : '', full: `$ ${command}` })
  }
  return out
}

/**
 * The command that deletes what a finished worker session left on disk. `--no-session-persistence`
 * keeps no transcript, but a large tool output is still saved under the session's folder (an
 * investigation's `ps aux` was 35 KB). Null when the id isn't a session id, so nothing else can be named.
 */
export function cleanupArgv(configRoot: string, sessionId: string): string[] | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null
  return ['find', `${configRoot.replace(/\/+$/, '')}/projects`, '-mindepth', '2', '-maxdepth', '2', '-type', 'd', '-name', sessionId, '-exec', 'rm', '-rf', '{}', '+']
}

/** The first event in a line, or `other`. */
export function parseStreamLine(line: string): StreamEvent {
  return parseStreamEvents(line)[0] ?? { kind: 'other' }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : []

const STATUSES: readonly Outcome['status'][] = ['done', 'partial', 'stopped', 'failed']

/** The worker's final reply, validated. A reply that isn't the JSON asked for still says what it said. */
export function parseOutcome(text: string, isError: boolean): Outcome {
  const raw = firstJson(text)
  if (raw === null || typeof raw !== 'object') {
    const said = text.trim().split('\n')[0]?.slice(0, 200) ?? ''
    return {
      status: isError ? 'failed' : 'partial',
      summary: said === '' ? 'The worker gave no report.' : said,
      commands: [],
      shas: [],
      changed: [],
      uncertain: ['The worker did not return a structured report; check git log and git status.'],
      needsMain: isError ? 'The worker failed.' : '',
    }
  }
  const obj = raw as Record<string, unknown>
  const status = isError ? 'failed' : (STATUSES.find(s => s === obj.status) ?? 'partial')
  return {
    status,
    summary: typeof obj.summary === 'string' && obj.summary.trim() !== '' ? obj.summary.trim().slice(0, 400) : 'No summary given.',
    commands: strings(obj.commands),
    shas: strings(obj.shas).map(sha => sha.slice(0, 12)),
    changed: strings(obj.changed),
    uncertain: strings(obj.uncertain),
    needsMain: typeof obj.needsMain === 'string' ? obj.needsMain.trim().slice(0, 600) : '',
  }
}

const MARK: Record<Outcome['status'], string> = { done: '✓', partial: '◐', stopped: '■', failed: '✗' }

/** The line shown in the transcript where a reply would have been. */
export function chatLine(outcome: Outcome, backend: string, seconds: number, costUsd = 0): string {
  const handBack = outcome.status === 'done' ? '' : ' (pane → give to main)'
  const tail = outcome.needsMain !== '' ? ` → main: ${outcome.needsMain}${handBack}` : outcome.status === 'done' ? '' : ' · see the sidekick pane'
  const cost = costUsd > 0 ? ` · ≈${usd(costUsd)}` : ''
  return `${MARK[outcome.status]} ${outcome.summary} · ${backend} · ${seconds}s${cost}${tail}`
}

const HANDOFF_LIMIT = 700

/** The note the main session reads with its next prompt, so it knows what the sidekick did. */
export function handoffNote(prompt: string, outcome: Outcome, backend: string, dumpPath = ''): string {
  const parts = [
    `[sidekick] The user's message "${prompt}" was handled by the sidekick mod (${backend}) in a separate session, not by you. Result: ${outcome.status}. ${outcome.summary}`,
  ]
  if (outcome.shas.length > 0) parts.push(`SHAs: ${outcome.shas.join(', ')}.`)
  if (outcome.changed.length > 0) parts.push(`Changed: ${outcome.changed.join(', ')}.`)
  if (outcome.uncertain.length > 0) parts.push(`Unsure about: ${outcome.uncertain.join('; ')}.`)
  if (outcome.needsMain !== '') parts.push(`Needs you: ${outcome.needsMain}`)
  // The pointer and the closing line are never cut; the body gives way.
  const tail = [
    ...(dumpPath !== '' ? [`Full record (every command and its output): ${dumpPath}.`] : []),
    'Treat this as already done; take over only if the user asks or it needs you.',
  ].join(' ')
  const body = parts.join(' ')
  const room = HANDOFF_LIMIT - tail.length - 1
  return `${body.length > room ? `${body.slice(0, room - 1)}…` : body} ${tail}`
}

/**
 * The prompt "give to main" sends. A finished assist is handed over for context, not as work to
 * redo; a stopped, failed or partial one asks the main session to take over.
 */
export function giveToMainPrompt(prompt: string, outcome: Outcome | null, steps: readonly string[], dumpPath = ''): string {
  const isDone = outcome !== null && outcome.status === 'done'
  const lines = [
    isDone
      ? `The sidekick mod did my request "${prompt}". Here is its report, for your context; it is already done, so don't redo it.`
      : `The sidekick mod tried my request "${prompt}" and handed it back. Please take over.`,
  ]
  if (outcome !== null) {
    lines.push(`Its report: ${outcome.status} — ${outcome.summary}`)
    if (outcome.shas.length > 0) lines.push(`SHAs: ${outcome.shas.join(', ')}`)
    if (outcome.changed.length > 0) lines.push(`Changed: ${outcome.changed.join(', ')}`)
    if (outcome.uncertain.length > 0) lines.push(`Unsure about: ${outcome.uncertain.join('; ')}`)
    if (outcome.needsMain !== '') lines.push(`${isDone ? 'Still open' : 'Why it stopped'}: ${outcome.needsMain}`)
  }
  if (steps.length > 0) lines.push(`Commands it ran: ${steps.slice(-8).join(' ; ')}`)
  if (dumpPath !== '') lines.push(`Full record (every command and its output): ${dumpPath}`)
  return lines.join('\n')
}
