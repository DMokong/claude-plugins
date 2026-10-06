import { test, expect } from 'claude-code/testing'

import { detect, isExempt } from './lib/detect'

const bash = (command: string) => detect({ tool: 'Bash', command })

test('a claim in a plain command', () => {
  expect(bash('bd update app-12a.32 --claim --actor exampleapp')).toEqual({ kind: 'claim', ids: ['app-12a.32'] })
})

test('a claim inside a compound command', () => {
  expect(bash('cd ~/projects/exampleapp && bd update app-1 --claim --actor exampleapp')).toEqual({ kind: 'claim', ids: ['app-1'] })
})

test('an update without --claim is nothing', () => {
  expect(bash('bd update app-1 --notes "more"')).toBe(null)
})

test('both comment spellings', () => {
  expect(bash('bd comment app-1 "gates green"')).toEqual({ kind: 'comment', ids: ['app-1'] })
  expect(bash('bd comments add app-1 "gates green"')).toEqual({ kind: 'comment', ids: ['app-1'] })
})

test('reading comments is not a comment', () => {
  expect(bash('bd comments app-1 --json')).toBe(null)
})

test('closing several at once', () => {
  expect(bash('bd close app-1 app-2 --reason=done')).toEqual({ kind: 'close', ids: ['app-1', 'app-2'] })
})

test('global flags before the subcommand are skipped', () => {
  expect(bash('bd --actor exampleapp close app-1')).toEqual({ kind: 'close', ids: ['app-1'] })
})

test('other commands are nothing', () => {
  expect(bash('git status')).toBe(null)
  expect(bash('bd list --status=in_progress')).toBe(null)
})

test('the Beads MCP tools', () => {
  expect(detect({ tool: 'mcp__claude_ai_Beads_MCP__claim', issue_id: 'app-1' })).toEqual({ kind: 'claim', ids: ['app-1'] })
  expect(detect({ tool: 'mcp__claude_ai_Beads_MCP__comment', issue_id: 'app-1', text: 'x' })).toEqual({ kind: 'comment', ids: ['app-1'] })
  expect(detect({ tool: 'mcp__claude_ai_Beads_MCP__close', issue_id: 'app-1' })).toEqual({ kind: 'close', ids: ['app-1'] })
  expect(detect({ tool: 'mcp__claude_ai_Beads_MCP__show', issue_id: 'app-1' })).toBe(null)
})

test('file edits', () => {
  expect(detect({ tool: 'Edit', file_path: '/repo/a.ts' })).toEqual({ kind: 'edit', path: '/repo/a.ts' })
  expect(detect({ tool: 'Write', file_path: '/repo/b.ts' })).toEqual({ kind: 'edit', path: '/repo/b.ts' })
  expect(detect({ tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb' })).toEqual({ kind: 'edit', path: '/repo/n.ipynb' })
  expect(detect({ tool: 'Read', file_path: '/repo/a.ts' })).toBe(null)
})

test('exempt paths', () => {
  const home = '/home/me'
  expect(isExempt('/tmp/x', home)).toBe(true)
  expect(isExempt('/private/tmp/claude-501/s/scratchpad/x.html', home)).toBe(true)
  expect(isExempt('/home/me/.claude/dev-mods/a/b.ts', home)).toBe(true)
  expect(isExempt('/home/me/projects/exampleapp/a.ts', home)).toBe(false)
})
