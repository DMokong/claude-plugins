export type BdEvent =
  | { kind: 'claim'; ids: string[] }
  | { kind: 'comment'; ids: string[] }
  | { kind: 'close'; ids: string[] }
  | { kind: 'edit'; path: string }

const ISSUE_ID = /^[a-z][a-z0-9]*-[a-z0-9]+(\.[0-9]+)*$/
const MCP_PREFIX = 'mcp__claude_ai_Beads_MCP__'
const MCP_KINDS: Record<string, 'claim' | 'comment' | 'close'> = {
  claim: 'claim',
  comment: 'comment',
  close: 'close',
}

/** The tokens after `bd` and its global flags, or null when the segment is not a bd call. */
function bdArgs(segment: string): string[] | null {
  const tokens = segment.trim().split(/\s+/)
  const at = tokens.indexOf('bd')
  if (at === -1) return null
  // Only env assignments may precede `bd` (FOO=1 bd ...); anything else is another command.
  if (!tokens.slice(0, at).every(token => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token))) return null
  const rest = tokens.slice(at + 1)
  let i = 0
  for (let flag = rest[i]; flag !== undefined && flag.startsWith('-'); flag = rest[i]) {
    // `--actor exampleapp` takes a value; `--readonly` and `--actor=x` do not.
    i += flag === '--actor' || flag === '--db' ? 2 : 1
  }
  return rest.slice(i)
}

function fromSegment(segment: string): BdEvent | null {
  const args = bdArgs(segment)
  if (args === null || args.length === 0) return null
  const [sub, ...rest] = args
  if (sub === 'update') {
    const id = rest.find(token => ISSUE_ID.test(token))
    return id !== undefined && rest.includes('--claim') ? { kind: 'claim', ids: [id] } : null
  }
  if (sub === 'comment') {
    return rest[0] !== undefined && ISSUE_ID.test(rest[0]) ? { kind: 'comment', ids: [rest[0]] } : null
  }
  if (sub === 'comments') {
    return rest[0] === 'add' && rest[1] !== undefined && ISSUE_ID.test(rest[1])
      ? { kind: 'comment', ids: [rest[1]] }
      : null
  }
  if (sub === 'close') {
    const ids: string[] = []
    for (const token of rest) {
      if (token.startsWith('-')) break
      if (ISSUE_ID.test(token)) ids.push(token)
    }
    return ids.length > 0 ? { kind: 'close', ids } : null
  }
  return null
}

export function detect(call: Record<string, unknown>): BdEvent | null {
  const tool = String(call.tool)
  if (tool === 'Bash' && typeof call.command === 'string') {
    for (const segment of call.command.split(/&&|\|\||;|\||\n/)) {
      const found = fromSegment(segment)
      if (found !== null) return found
    }
    return null
  }
  if (tool.startsWith(MCP_PREFIX) && typeof call.issue_id === 'string') {
    const kind = MCP_KINDS[tool.slice(MCP_PREFIX.length)]
    return kind === undefined ? null : { kind, ids: [call.issue_id] }
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof call.file_path === 'string') {
    return { kind: 'edit', path: call.file_path }
  }
  if (tool === 'NotebookEdit' && typeof call.notebook_path === 'string') {
    return { kind: 'edit', path: call.notebook_path }
  }
  return null
}

export function isExempt(path: string, home: string): boolean {
  return (
    path.startsWith('/tmp/') ||
    path.startsWith('/private/tmp/') ||
    (home !== '' && path.startsWith(`${home}/.claude/`))
  )
}
