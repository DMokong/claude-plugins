/**
 * The control panel's settings. Only what the person changed in the panel is stored, so a setting
 * they never touched keeps following the plugin's option; Reset to defaults clears the lot.
 */
import type { Settings } from '../../types'
import { toPetChoice } from './pets'

export const SETTINGS_KEY = 'settings'

/** The models the panel offers, as chip label and alias. */
export const JUDGE_CHIPS: readonly (readonly [string, string])[] = [
  ['Haiku 5.5', 'haiku'],
  ['Sonnet 5.5', 'sonnet'],
]
// No Opus: a worker exists to be cheaper than the main session, and an Opus worker isn't. A
// chore worth Opus belongs in the main session.
export const WORKER_CHIPS: readonly (readonly [string, string])[] = JUDGE_CHIPS

/** The settings before any change in the panel: the plugin's options, else the defaults. */
export function defaultsFrom(options: Readonly<Record<string, unknown>>): Settings {
  const model = (value: unknown) => (typeof value === 'string' && value !== '' ? value : 'haiku')
  return {
    judgeModel: model(options.judgeModel),
    workerModel: model(options.workerModel),
    investigations: true,
    draftJudging: true,
    reviews: true,
    notifications: true,
    maxConcurrent: Math.min(4, Math.max(1, Number(options.maxConcurrent) || 1)),
    pet: 'off',
  }
}

/** The settings in force: each stored field of the right type over the defaults. */
export function effective(defaults: Settings, stored: unknown): Settings {
  if (stored === null || typeof stored !== 'object') return defaults
  const raw = stored as Record<string, unknown>
  const out: Settings = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    const value = raw[key]
    if (typeof value !== typeof defaults[key]) continue
    if (key === 'pet') out.pet = toPetChoice(value, defaults.pet)
    else if (key === 'maxConcurrent') out.maxConcurrent = Math.min(4, Math.max(1, Math.round(value as number)))
    else if (typeof value === 'string' && value !== '') (out[key] as string) = value
    else if (typeof value === 'boolean') (out[key] as boolean) = value
  }
  return out
}

/** The stored changes with one more: what the store keeps after a press in the panel. */
export function withChange<K extends keyof Settings>(stored: unknown, key: K, value: Settings[K]): Partial<Settings> {
  const prior = stored !== null && typeof stored === 'object' ? (stored as Partial<Settings>) : {}
  return { ...prior, [key]: value }
}

/** The chips for a model row, with the current model added when no chip names it. */
export function chipsFor(list: readonly (readonly [string, string])[], current: string): (readonly [string, string])[] {
  return list.some(([, alias]) => alias === current) ? [...list] : [...list, [current, current] as const]
}
