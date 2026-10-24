import { test, expect } from 'claude-code/testing'

import { NO_SPEND, addTally, modelName, priceOf, tallyLine, tallyOf, tokens, usd } from './lib/cost'

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(1e-10)

// A real worker run's result.usage (claude -p --model haiku), and Claude Code's own figure for it.
const WORKER_USAGE = {
  input_tokens: 4,
  cache_creation_input_tokens: 1642,
  cache_read_input_tokens: 15068,
  output_tokens: 160,
  cache_creation: { ephemeral_1h_input_tokens: 1642, ephemeral_5m_input_tokens: 0 },
}
const CLAUDE_CODE_COST_USD = 0.00055948

test('a worker run is priced as Claude Code prices it: 1h cache writes at 2x, reads at 0.1x', async () => {
  const tally = tallyOf('haiku', WORKER_USAGE)
  expect(Math.abs(tally.usd - CLAUDE_CODE_COST_USD)).toBeLessThan(1e-10)
  expect(tally.cacheWrite1h).toBe(1642)
  expect(tally.cacheWrite5m).toBe(0)
})

test('caching savings: reads save 0.9x input, writes cost 0.25x (5m) or 1x (1h) extra', async () => {
  const reads = tallyOf('haiku', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 })
  near(reads.usd, 0.01)
  near(reads.savedUsd, 0.09)
  const write5m = tallyOf('haiku', { cache_creation_input_tokens: 1_000_000 })
  near(write5m.usd, 0.125)
  near(write5m.savedUsd, -0.025)
  const write1h = tallyOf('haiku', { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })
  near(write1h.usd, 0.2)
  near(write1h.savedUsd, -0.1)
})

test('models are priced by family; an unknown one counts tokens but no dollars', async () => {
  expect(priceOf('claude-haiku-5-5')).toEqual({ input: 0.1, output: 0.5 })
  expect(priceOf('sonnet')).toEqual({ input: 2, output: 10 })
  const unknown = tallyOf('mystery-model', { input_tokens: 10, output_tokens: 5 })
  expect(unknown.usd).toBe(0)
  expect(unknown.input).toBe(10)
})

test('tallies add up, and read as one line', async () => {
  const sum = addTally(NO_SPEND, addTally(tallyOf('haiku', WORKER_USAGE), tallyOf('haiku', WORKER_USAGE)))
  expect(sum.cacheRead).toBe(30136)
  expect(tallyLine(tallyOf('haiku', WORKER_USAGE))).toBe('in 4 · out 160 · cache read 15.1k · write 1.6k (1h) · ≈$0.0006 · caching saved ≈$0.0012')
  expect(usd(0.00055948)).toBe('$0.0006')
  // A judge call stays visible rather than rounding to zero.
  expect(usd(tallyOf('haiku', { input_tokens: 312, output_tokens: 1 }).usd)).toBe('$0.000032')
  expect(usd(0.0312)).toBe('$0.031')
  expect(usd(-0.025)).toBe('-$0.025')
  expect(tokens(15068)).toBe('15.1k')
})

test('a model reads as its family, whatever the spelling', async () => {
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus')
  expect(modelName('Haiku 5.5')).toBe('Haiku')
  expect(modelName('sonnet')).toBe('Sonnet')
  expect(modelName('mystery-model')).toBe('mystery-model')
})
