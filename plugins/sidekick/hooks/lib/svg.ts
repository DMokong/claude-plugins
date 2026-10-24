/**
 * The desktop's graphics: tiles, the where-it-went bar, the 7-day chart and the progress sweep as
 * SVG documents for the `Svg` element. Plain strings; the hooks module puts them in the tree.
 *
 * Every drawing keeps inside its own viewBox (text is measured and clipped to its room), and the
 * surface caps an `Svg` at its slot and scales it down, so nothing here can run past the pane.
 * Colours read on a light or a dark desktop: the accents, a mid grey for words, and a translucent
 * grey for cards and tracks.
 */
import type { Day } from './history'
import { tileMoney } from './draw'

export const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
export const MUTED = '#8a8a8a'
const CARD = 'rgba(127,127,127,0.12)'
const TRACK = 'rgba(127,127,127,0.22)'

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** A generous estimate of text's width at `size` px: every glyph counted as wide as a wide one. */
export function textWidth(text: string, size: number, isBold = false): number {
  return [...text].length * size * (isBold ? 0.64 : 0.6)
}

/** `text` cut with an ellipsis to fit `room` px at `size`. */
export function fitText(text: string, size: number, room: number, isBold = false): string {
  if (textWidth(text, size, isBold) <= room) return text
  const chars = [...text]
  let n = chars.length
  while (n > 0 && textWidth(`${chars.slice(0, n).join('')}…`, size, isBold) > room) n -= 1
  return n === 0 ? '' : `${chars.slice(0, n).join('').trimEnd()}…`
}

/** The largest size up to `max` at which `text` fits `room` px. */
export function fitSize(text: string, max: number, room: number, isBold = true): number {
  const one = textWidth(text, 1, isBold)
  return one === 0 ? max : Math.max(8, Math.min(max, Math.floor(room / one)))
}

/** The accents are pale for a light page: words in them take a deeper shade there. */
const DEEPER: Readonly<Record<string, string>> = {
  '#e8c170': '#9a6b12',
  '#7fe0b8': '#1f8a5f',
  '#a9b8ff': '#4256c9',
  '#f0a070': '#b0561c',
  '#f0719b': '#c2335f',
  '#c9a0ff': '#7a4fc2',
}

/** A class for words in `color` that deepens on a light page, and the rule that does it. */
function ink(color: string): { cls: string; rule: string } {
  const deep = DEEPER[color.toLowerCase()]
  // Named for the colour, so drawings that share a document never restyle each other.
  const name = `ink-${color.slice(1).toLowerCase()}`
  return deep === undefined ? { cls: '', rule: '' } : { cls: ` class="${name}"`, rule: `@media (prefers-color-scheme: light){.${name}{fill:${deep}}}` }
}

function svg(width: number, height: number, body: string, rules = ''): string {
  const style = rules === '' ? '' : `<style>${rules}</style>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT)}">${style}${body}</svg>`
}

/** A trend line with the area under it, across `w` × `h` from the bottom-left at (x, y + h). */
function spark(values: readonly number[], x: number, y: number, w: number, h: number, color: string): string {
  const top = Math.max(...values, 0)
  if (values.length < 2 || !(top > 0)) return `<line x1="${x}" y1="${y + h - 1}" x2="${x + w}" y2="${y + h - 1}" stroke="${color}" stroke-opacity="0.35" stroke-width="1.5"/>`
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(x + i * step).toFixed(1)} ${(y + h - 2 - (v / top) * (h - 4)).toFixed(1)}`)
  return (
    `<path d="M${pts.join(' L')} L${x + w} ${y + h} L${x} ${y + h}Z" fill="${color}" fill-opacity="0.16"/>` +
    `<path d="M${pts.join(' L')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`
  )
}

export const TILE = { width: 140, height: 92, pad: 12 } as const

/** One tile: a small title, the figure large, a caption, and the last seven days as a trend. */
export function tileSvg(t: { title: string; value: string; caption: string; color: string; series: readonly number[] }): string {
  const { width, height, pad } = TILE
  const room = width - pad * 2
  const size = fitSize(t.value, 28, room)
  const value = ink(t.color)
  return svg(
    width,
    height,
    `<rect width="${width}" height="${height}" rx="12" fill="${CARD}"/>` +
      `<text x="${pad}" y="22" font-size="10.5" font-weight="600" letter-spacing="0.8" fill="${MUTED}">${esc(fitText(t.title, 10.5, room, true))}</text>` +
      `<text x="${pad}" y="51" font-size="${size}" font-weight="700" fill="${t.color}"${value.cls}>${esc(t.value)}</text>` +
      `<text x="${pad}" y="66" font-size="10.5" fill="${MUTED}">${esc(fitText(t.caption, 10.5, room))}</text>` +
      spark(t.series, 0, height - 20, width, 20, t.color),
    value.rule,
  )
}

export type Part = { label: string; n: number; usd: number; color: string }

export const STACK = { width: 400, height: 14 } as const

/** Where the work went as one bar: each part's share of the cost (of the count while nothing cost). */
export function stackSvg(parts: readonly Part[]): string {
  const { width, height } = STACK
  const byCost = parts.some(p => p.usd > 0)
  const weight = (p: Part) => (byCost ? p.usd : p.n)
  const shown = parts.filter(p => weight(p) > 0)
  const total = shown.reduce((n, p) => n + weight(p), 0)
  if (total === 0) return svg(width, height, `<rect width="${width}" height="${height}" rx="4" fill="${TRACK}"><title>Nothing yet</title></rect>`)
  // A part with any share keeps a sliver of 4 px; the rest share what remains.
  const gaps = (shown.length - 1) * 2
  const min = 4
  const free = width - gaps - min * shown.length
  let x = 0
  const body = shown
    .map((p, i) => {
      const w = i === shown.length - 1 ? width - x : min + (weight(p) / total) * free
      const seg = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w).toFixed(1)}" height="${height}" fill="${p.color}"><title>${esc(`${p.label} · ${p.n} · ${tileMoney(p.usd)}`)}</title></rect>`
      x += w + 2
      return seg
    })
    .join('')
  return svg(width, height, `<clipPath id="r"><rect width="${width}" height="${height}" rx="4"/></clipPath><g clip-path="url(#r)">${body}</g>`)
}

export const DAYS = { width: 400, height: 132 } as const

/** Jobs a day as bars: today in yellow, the best day full blue, the rest lighter, a tooltip on each. */
export function daysSvg(days: readonly Day[], colors: { today: string; bar: string }): string {
  const { width, height } = DAYS
  const base = height - 26
  const top = Math.max(1, ...days.map(d => d.jobs))
  const slot = width / Math.max(1, days.length)
  const barW = Math.min(36, slot - 12)
  const best = days.reduce((b, d) => (d.jobs > (b?.jobs ?? 0) ? d : b), undefined as Day | undefined)
  const today = ink(colors.today)
  const barInk = ink(colors.bar)
  const body = days
    .map((d, i) => {
      const cx = slot * i + slot / 2
      const h = d.jobs > 0 ? Math.max(4, (d.jobs / top) * (base - 18)) : 0
      const color = d.isToday ? colors.today : colors.bar
      const opacity = d.isToday || d === best ? 1 : 0.55
      const label = d.isToday ? 'Today' : d.label
      const tip = `${d.isToday ? 'Today' : d.label} · ${d.jobs === 0 ? 'nothing' : `${d.jobs} ${d.jobs === 1 ? 'job' : 'jobs'}`}${d.savedUsd > 0 ? ` · saved ${tileMoney(d.savedUsd)}` : ''}${d.costUsd > 0 ? ` · cost ${tileMoney(d.costUsd)}` : ''}`
      const bar =
        h > 0
          ? `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${color}" fill-opacity="${opacity}"/>`
          : `<rect x="${(cx - barW / 2).toFixed(1)}" y="${base - 2}" width="${barW.toFixed(1)}" height="2" rx="1" fill="${TRACK}"/>`
      const value = d === best && d.jobs > 0 ? `<text x="${cx.toFixed(1)}" y="${(base - h - 5).toFixed(1)}" font-size="11" text-anchor="middle" fill="${color}"${d.isToday ? today.cls : barInk.cls}>${d.jobs}</text>` : ''
      const name = `<text x="${cx.toFixed(1)}" y="${height - 8}" font-size="11" text-anchor="middle" fill="${d.isToday ? colors.today : MUTED}"${d.isToday ? ` font-weight="600"${today.cls}` : ''}>${esc(fitText(label, 11, slot - 2, d.isToday))}</text>`
      // The hover target is the whole column, so a day with nothing still answers.
      return `<g><title>${esc(tip)}</title><rect x="${(cx - slot / 2).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}" fill="transparent"/>${bar}${value}${name}</g>`
    })
    .join('')
  return svg(width, height, `<line x1="0" y1="${base}" x2="${width}" y2="${base}" stroke="${TRACK}"/>${body}`, today.rule + (barInk.rule === today.rule ? '' : barInk.rule))
}

export const PROGRESS = { width: 600, height: 4 } as const

/** A thin track with a sweep running along it: work under way, no promise of how far. */
export function progressSvg(color: string): string {
  const { width, height } = PROGRESS
  const sweep = Math.round(width * 0.28)
  return svg(
    width,
    height,
    `<rect width="${width}" height="${height}" rx="2" fill="${TRACK}"/>` +
      `<clipPath id="t"><rect width="${width}" height="${height}" rx="2"/></clipPath>` +
      `<rect clip-path="url(#t)" y="0" width="${sweep}" height="${height}" rx="2" fill="${color}"><animate attributeName="x" values="${-sweep};${width}" dur="1.6s" repeatCount="indefinite"/></rect>`,
  )
}
