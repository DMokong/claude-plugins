import { usd } from './cost'
import type { Usage } from './cost'
import { firstJson } from './judge'
import type { Outcome } from '../../types'

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
]

export const WORKER_SYSTEM = `You are a sidekick: you carry out ONE small, mechanical repository chore for a developer, then report back. You have no memory of their conversation; work only from what is on disk (git status, diff, log, bd).

Rules:
- Do exactly the task. Do not fix, refactor or edit files beyond what the task names.
- Never lose work. Forbidden: force-push, reset --hard, clean, deleting unmerged branches, discarding uncommitted changes, rewriting commits already on the upstream. These are also blocked by the tool layer; if one is refused, stop. Never look for another route to the same effect.
- Before a rebase, check the commits being rewritten are not on the upstream yet (git rev-list @{u}..HEAD and git log @{u}). If they are, stop and say the main session should handle it.
- If a rebase, merge, pull or cherry-pick hits a conflict, abort it (git rebase --abort / merge --abort / cherry-pick --abort) so the repo is back where it started, then stop and describe the conflict.
- Prefer one plain git or bd command per call. Pipes into head, tail or wc and a leading cd are fine; heredocs, $(...), echo and other programs are refused. Commit with -m flags: git commit -m "subject" -m "body paragraph" -m "Co-Authored-By: ..." (one -m per paragraph).
- Commit messages: follow the style of recent git log entries; describe what the diff does.
- Pushing is allowed when asked.

Finish with ONLY a JSON object, no prose around it:
{"status":"done"|"partial"|"stopped"|"failed","summary":"<one sentence a developer reads in chat>","commands":["<each command you ran>"],"shas":["<short shas you created or pushed>"],"changed":["<paths or refs changed>"],"uncertain":["<anything you guessed>"],"needsMain":"<why the main session should take over, or empty>"}`

/** The argument vector for one headless worker run. The task goes on stdin. */
export function workerArgv(model: string, guardPath: string): string[] {
  const settings = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: guardPath }] }] },
  })
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
    WORKER_SYSTEM,
    '--allowedTools',
    ...ALLOWED_TOOLS,
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
  | { kind: 'step'; text: string }
  | { kind: 'result'; text: string; isError: boolean; costUsd: number; usage: Usage | undefined }
  | { kind: 'other' }

/** One line of `--output-format stream-json`, reduced to what the pane shows. */
export function parseStreamLine(line: string): StreamEvent {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  if (raw === null || typeof raw !== 'object') return { kind: 'other' }
  const event = raw as Record<string, unknown>
  if (event.type === 'result') {
    return {
      kind: 'result',
      text: typeof event.result === 'string' ? event.result : '',
      isError: event.is_error === true,
      costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
      usage: event.usage !== null && typeof event.usage === 'object' ? (event.usage as Usage) : undefined,
    }
  }
  if (event.type !== 'assistant') return { kind: 'other' }
  const message = event.message as { content?: unknown } | undefined
  const content = Array.isArray(message?.content) ? message.content : []
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>
      const command = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? `read ${input.file_path}` : ''
      if (command !== '') return { kind: 'step', text: `$ ${command.split('\n')[0]}` }
    }
  }
  return { kind: 'other' }
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
    needsMain: typeof obj.needsMain === 'string' ? obj.needsMain.trim().slice(0, 300) : '',
  }
}

const MARK: Record<Outcome['status'], string> = { done: '✓', partial: '◐', stopped: '■', failed: '✗' }

/** The line shown in the transcript where a reply would have been. */
export function chatLine(outcome: Outcome, backend: string, seconds: number, costUsd = 0): string {
  const tail = outcome.status === 'done' ? '' : outcome.needsMain !== '' ? ` · ${outcome.needsMain} (pane → give to main)` : ' · see the sidekick pane'
  const cost = costUsd > 0 ? ` · ≈${usd(costUsd)}` : ''
  return `${MARK[outcome.status]} ${outcome.summary} · ${backend} · ${seconds}s${cost}${tail}`
}

const HANDOFF_LIMIT = 700

/** The note the main session reads with its next prompt, so it knows what the sidekick did. */
export function handoffNote(prompt: string, outcome: Outcome, backend: string): string {
  const parts = [
    `[sidekick] The user's message "${prompt}" was handled by the sidekick mod (${backend}) in a separate session, not by you. Result: ${outcome.status}. ${outcome.summary}`,
  ]
  if (outcome.shas.length > 0) parts.push(`SHAs: ${outcome.shas.join(', ')}.`)
  if (outcome.changed.length > 0) parts.push(`Changed: ${outcome.changed.join(', ')}.`)
  if (outcome.uncertain.length > 0) parts.push(`Unsure about: ${outcome.uncertain.join('; ')}.`)
  if (outcome.needsMain !== '') parts.push(`Needs you: ${outcome.needsMain}`)
  parts.push('Treat this as already done; take over only if the user asks or it needs you.')
  const note = parts.join(' ')
  return note.length > HANDOFF_LIMIT ? `${note.slice(0, HANDOFF_LIMIT - 1)}…` : note
}

/** The prompt that hands a stopped or failed assist to the main session. */
export function giveToMainPrompt(prompt: string, outcome: Outcome | null, steps: readonly string[]): string {
  const lines = [`The sidekick mod tried my request "${prompt}" and handed it back. Please take over.`]
  if (outcome !== null) {
    lines.push(`Its report: ${outcome.status} — ${outcome.summary}`)
    if (outcome.needsMain !== '') lines.push(`Why it stopped: ${outcome.needsMain}`)
  }
  if (steps.length > 0) lines.push(`Commands it ran: ${steps.slice(-8).join(' ; ')}`)
  return lines.join('\n')
}
