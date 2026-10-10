export type IssueInfo = { title: string; status: string }

function parseArray(stdout: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseShow(stdout: string): IssueInfo | null {
  const first = parseArray(stdout)?.[0]
  if (!isRecord(first) || typeof first.title !== 'string') return null
  return { title: first.title, status: typeof first.status === 'string' ? first.status : 'unknown' }
}

export function parseLastComment(stdout: string): number | null {
  const rows = parseArray(stdout)
  if (rows === null) return null
  let newest: number | null = null
  for (const row of rows) {
    if (!isRecord(row)) continue
    const at = Date.parse(String(row.created_at))
    if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at
  }
  return newest
}
