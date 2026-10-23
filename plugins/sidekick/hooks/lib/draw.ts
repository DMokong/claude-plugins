/**
 * Drawing math for the control panel and the dashboard: segment digits, bars, day blocks and the
 * short money the tiles show. Plain strings and numbers; the hooks module turns them into a tree.
 */

export const COLORS = {
  yellow: '#e8c170',
  blue: '#a9b8ff',
  green: '#7fe0b8',
  pink: '#f0719b',
  orange: '#f0a070',
  purple: '#c9a0ff',
  claude: '#d97757',
  line: '#3a3f4b',
  dim: '#6b7280',
  /** Text on a filled chip or pill. */
  ink: '#16161a',
} as const

type Glyph = readonly [string, string, string, string, string]

/** Hero digits, five rows tall, drawn with light box lines. `$` is a small mark on the top row. */
export const DIGITS: Readonly<Record<string, Glyph>> = {
  '0': ['╭──╮', '│  │', '│  │', '│  │', '╰──╯'],
  '1': ['  ╷ ', '  │ ', '  │ ', '  │ ', '  ╵ '],
  '2': ['╶──╮', '   │', '╭──╯', '│   ', '╰──╴'],
  '3': ['╶──╮', '   │', ' ──┤', '   │', '╶──╯'],
  '4': ['╷  ╷', '│  │', '╰──┤', '   │', '   ╵'],
  '5': ['╭──╴', '│   ', '╰──╮', '   │', '╶──╯'],
  '6': ['╭──╴', '│   ', '├──╮', '│  │', '╰──╯'],
  '7': ['╶──╮', '   │', '   │', '   │', '   ╵'],
  '8': ['╭──╮', '│  │', '├──┤', '│  │', '╰──╯'],
  '9': ['╭──╮', '│  │', '╰──┤', '   │', '╶──╯'],
  '.': [' ', ' ', ' ', ' ', '•'],
  $: ['$', ' ', ' ', ' ', ' '],
  k: ['   ', '│ ╱', '├┤ ', '│ ╲', '   '],
}

/** `text` as five rows of hero digits, one space between glyphs; characters without a glyph are skipped. */
export function bigText(text: string): string[] {
  const glyphs = [...text].map(ch => DIGITS[ch]).filter((g): g is Glyph => g !== undefined)
  return [0, 1, 2, 3, 4].map(row => glyphs.map(g => g[row]).join(' '))
}

export function bigWidth(text: string): number {
  return bigText(text)[0]?.length ?? 0
}

/** Money as a tile shows it: `$0`, `$.004`, `$4.18`, `$42`, `$1.2k`. Never negative. */
export function tileMoney(usd: number): string {
  if (!(usd > 0)) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(3).replace(/^0/, '')}`
  if (usd < 10) return `$${usd.toFixed(2)}`
  if (usd < 1000) return `$${Math.round(usd)}`
  return `$${(usd / 1000).toFixed(1)}k`
}

/** A bar `width` cells long, on a scale where `max` fills it; anything above zero gets a cell. */
export function barCells(value: number, max: number, width: number): { filled: number; empty: number } {
  if (!(value > 0) || !(max > 0)) return { filled: 0, empty: width }
  const filled = Math.min(width, Math.max(1, Math.round((value / max) * width)))
  return { filled, empty: width - filled }
}

/** How many of `levels` blocks each day fills, on one scale; a day with anything shows at least one. */
export function dayLevels(values: readonly number[], levels = 4): number[] {
  const top = Math.max(0, ...values)
  return values.map(v => (v > 0 && top > 0 ? Math.max(1, Math.round((v / top) * levels)) : 0))
}

/** `S I D E K I C K`: the panel's spaced capitals. */
export function spaced(word: string): string {
  return [...word].join(' ')
}
