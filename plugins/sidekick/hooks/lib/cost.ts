/**
 * API-equivalent cost estimates. On a subscription nothing is billed per token; these say what
 * the same calls would cost on the API, so the sidekick's spend can be compared and watched.
 * Prices are dollars per million tokens (Anthropic first-party rates, 2026-10).
 *
 * Prompt caching is priced as the API prices it: a cache read at 0.1x the input rate, a cache
 * write at 1.25x for the 5-minute cache and 2x for the 1-hour cache. Checked against Claude
 * Code's own figure for a worker run (`modelUsage.costUSD`): equal to the last digit.
 */
import type { Tally } from '../../types'

const PRICES: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.1, output: 0.5 },
  sonnet: { input: 2, output: 10 },
  opus: { input: 4, output: 20 },
  fable: { input: 10, output: 50 },
}

const CACHE_READ = 0.1
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2

/** The price row for a model alias or id, or null when it names none we know. */
export function priceOf(model: string): { input: number; output: number } | null {
  const name = model.toLowerCase()
  const family = Object.keys(PRICES).find(key => name.includes(key))
  return family === undefined ? null : (PRICES[family] ?? null)
}

/** A call's `usage`, as the Messages API and `claude -p`'s result both report it. */
export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

export const NO_SPEND: Tally = { usd: 0, savedUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

/**
 * One call's tokens and dollars. `savedUsd` is what caching changed against sending every input
 * token uncached: reads save 0.9x, writes cost 0.25x or 1x extra, so it can be negative on a
 * first call that only writes.
 */
export function tallyOf(model: string, usage: Usage | undefined): Tally {
  if (usage === undefined) return NO_SPEND
  const written = usage.cache_creation_input_tokens ?? 0
  const split = usage.cache_creation
  // Without the 5m/1h split, a write is taken as the 5-minute kind (the API's default).
  const write1h = split?.ephemeral_1h_input_tokens ?? 0
  const write5m = split === undefined ? written : (split.ephemeral_5m_input_tokens ?? 0)
  const tally: Tally = {
    usd: 0,
    savedUsd: 0,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  }
  const price = priceOf(model)
  if (price === null) return tally
  const inputUnits = tally.input + tally.cacheRead * CACHE_READ + write5m * CACHE_WRITE_5M + write1h * CACHE_WRITE_1H
  const uncachedUnits = tally.input + tally.cacheRead + write5m + write1h
  tally.usd = (inputUnits * price.input + tally.output * price.output) / 1_000_000
  tally.savedUsd = ((uncachedUnits - inputUnits) * price.input) / 1_000_000
  return tally
}

export function addTally(a: Tally, b: Tally): Tally {
  return {
    usd: a.usd + b.usd,
    savedUsd: a.savedUsd + b.savedUsd,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  }
}

/** `$0.0042`, `$0.031`, `$1.20`: enough digits to tell small sums apart; a minus for a net cost. */
export function usd(dollars: number): string {
  const sign = dollars < 0 ? '-' : ''
  const size = Math.abs(dollars)
  if (size === 0) return '$0'
  if (size < 0.01) return `${sign}$${size.toFixed(4)}`
  if (size < 1) return `${sign}$${size.toFixed(3)}`
  return `${sign}$${size.toFixed(2)}`
}

/** `1.6k`, `15.1k`, `2.3M`. */
export function tokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** One line: `in 4 · out 160 · cache read 15.1k · write 1.6k (1h) · ≈$0.00056 · caching saved ≈$0.0011`. */
export function tallyLine(tally: Tally): string {
  const writes = [
    tally.cacheWrite5m > 0 ? `${tokens(tally.cacheWrite5m)} (5m)` : '',
    tally.cacheWrite1h > 0 ? `${tokens(tally.cacheWrite1h)} (1h)` : '',
  ].filter(part => part !== '')
  return [
    `in ${tokens(tally.input)}`,
    `out ${tokens(tally.output)}`,
    `cache read ${tokens(tally.cacheRead)}`,
    `write ${writes.length === 0 ? '0' : writes.join(' + ')}`,
    `≈${usd(tally.usd)}`,
    `caching ${tally.savedUsd >= 0 ? 'saved' : 'cost'} ≈${usd(Math.abs(tally.savedUsd))}`,
  ].join(' · ')
}
