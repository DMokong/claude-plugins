/**
 * The full record of an investigation: every command the worker ran and what came back, for the
 * main session to read when the one-line summary isn't enough. The mod writes it from the stream
 * it already reads, so the worker itself never gets a way to write files.
 */
import type { Outcome } from '../../types'

/** How many records are kept; older ones are deleted when a new one is written. */
export const DUMP_KEEP = 50

/** Room for each command's output in the record, in characters. */
const OUTPUT_LIMIT = 4_000

export type Call = { command: string; output: string; isError: boolean }

// Credentials a log line or a config dump could print: API keys, tokens, and a password in a URL.
const SECRETS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-or-v1-[A-Za-z0-9]{8,}/g,
  /xox[abpr]-[A-Za-z0-9-]{8,}/g,
  /xapp-[A-Za-z0-9-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /sbp_[A-Za-z0-9]{16,}/g,
  /glc_[A-Za-z0-9+/=_-]{16,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
]

// `password=…`, `token: …`, `Authorization: Bearer …`: keep the name, drop the value.
const NAMED = /\b((?:[A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth)[A-Za-z0-9_]*)\s*[=:]\s*["']?)(?!\[redacted\]|(?:Bearer|Basic)\b)[^\s"',;]{4,}/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g

/** The text with every credential it recognises replaced by `[redacted]`. */
export function redact(text: string): string {
  let out = text
  for (const pattern of SECRETS) out = out.replace(pattern, '[redacted]')
  out = out.replace(BEARER, '$1 [redacted]').replace(NAMED, '$1[redacted]')
  // scheme://user:password@host keeps the user and host.
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@')
}

function cut(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n[cut: ${text.length - OUTPUT_LIMIT} more chars]`
}

/** The record as Markdown. Everything in it has been through `redact`. */
export function dumpText(entry: { prompt: string; createdAt: number }, calls: readonly Call[], outcome: Outcome, cost: string): string {
  const parts = [
    `# sidekick investigation: ${entry.prompt}`,
    `${new Date(entry.createdAt).toISOString()} · ${outcome.status} · ${cost}`,
    `## Summary\n\n${outcome.summary}`,
  ]
  if (outcome.needsMain !== '') parts.push(`## For the main session\n\n${outcome.needsMain}`)
  if (outcome.uncertain.length > 0) parts.push(`## Not sure about\n\n${outcome.uncertain.map(u => `- ${u}`).join('\n')}`)
  parts.push(`## What it ran (${calls.length})`)
  for (const call of calls) {
    const output = call.output.trim() === '' ? '(no output)' : cut(call.output)
    const [first = '', ...more] = call.command.split('\n')
    const whole = more.length > 0 ? `\n\n\`\`\`sh\n${call.command.replace(/^\$ /, '')}\n\`\`\`` : ''
    parts.push(`### ${first}${more.length > 0 ? ' …' : ''}${call.isError ? ' (error)' : ''}${whole}\n\n\`\`\`\n${output.replace(/```/g, '`\u200b``')}\n\`\`\``)
  }
  parts.push(`## Report\n\n\`\`\`json\n${JSON.stringify(outcome, null, 2)}\n\`\`\``)
  return redact(parts.join('\n\n'))
}

/** Claude's config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function configRoot(home: string, configDir: string | undefined): string {
  return (configDir !== undefined && configDir !== '' ? configDir : `${home}/.claude`).replace(/\/+$/, '')
}

/** Where records live: outside any repository, so nothing in them can be committed by accident. */
export function dumpDir(home: string, configDir: string | undefined): string {
  return `${configRoot(home, configDir)}/sidekick/investigations`
}

/** `2026-10-23-<id>.md`: sorts oldest first, so retention can drop from the front. */
export function dumpName(now: number, id: string): string {
  return `${new Date(now).toISOString().slice(0, 10)}-${id.replace(/[^A-Za-z0-9-]/g, '')}.md`
}
