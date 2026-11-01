/**
 * The pets on a desktop: one illustrated pose per mood, from assets/pets/, moved with SMIL. The
 * pictures are data: URIs, so the caller draws this as a plain image: the sandboxed frame shows
 * pictures blank, and SMIL runs in an image as well.
 */
import type { PetName } from './pets'

export type Pose = { uri: string; w: number; h: number }

/** The moods a pet has no picture of, and the nearest one it has. */
const STAND_INS: Record<string, string> = { work: 'haul', alert: 'look', success: 'hop', drink: 'eat', sweep: 'walk', fix: 'look', bath: 'smug' }
const OWN_POSES: Record<PetName, readonly string[]> = {
  mochi: ['idle', 'wave', 'walk', 'look', 'eat', 'hop', 'smug', 'sleep', 'haul'],
  tater: ['idle', 'wave', 'walk', 'work', 'look', 'eat', 'drink', 'hop', 'sweep', 'fix', 'success', 'smug', 'bath', 'sleep', 'alert', 'haul'],
}

/** The picture a mood draws, which is the mood's name where the pet has one. */
export function poseOf(pet: PetName, animation: string): string {
  if (OWN_POSES[pet].includes(animation)) return animation
  const stand = STAND_INS[animation]
  return stand !== undefined && OWN_POSES[pet].includes(stand) ? stand : 'idle'
}

const FOREVER = 'repeatCount="indefinite"'
/** The moods that go somewhere: up and down the lane, turning at each end. The poses face left. */
const WALKS = new Set(['haul', 'hop', 'sweep', 'walk'])
const WALK_S = 9

function motion(animation: string, w: number, h: number): string {
  const feet = `${w / 2} ${h}`
  switch (animation) {
    case 'hop':
    case 'success':
      return `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${Math.round(h * 0.12)};0 0;0 0" keyTimes="0;.3;.6;1" dur="0.8s" ${FOREVER}/>`
    case 'wave':
    case 'alert':
      return `<animateTransform attributeName="transform" type="rotate" values="-3 ${feet};3 ${feet};-3 ${feet}" dur="0.7s" ${FOREVER}/>`
    case 'haul':
    case 'walk':
    case 'sweep':
    case 'work':
    case 'fix':
    case 'eat':
    case 'drink':
      return `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${Math.max(1, Math.round(h * 0.03))};0 0" dur="0.5s" ${FOREVER}/>`
    case 'sleep':
      return `<animateTransform attributeName="transform" type="scale" values="1 1;1 1.02;1 1" dur="4s" ${FOREVER}/>`
    default:
      return `<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="3s" ${FOREVER}/>`
  }
}

/** The SVG document of one pet, `height` px tall, in a lane `lane` px wide. */
export function petSvg(pose: Pose, animation: string, height: number, lane: number): { source: string; width: number; height: number } {
  // A wide pose fits the lane rather than widening it, and lies on the same floor.
  const drawn = Math.min(height, Math.round(pose.h * (lane / pose.w)))
  const w = Math.round(pose.w * (drawn / pose.h))
  // One width for every pose, so what sits beside the pet stays put as its mood changes.
  const width = Math.max(w, Math.round(lane))
  const home = width - w
  const inner = `<g>${motion(animation, w, height)}<image href="${pose.uri}" y="${height - drawn}" width="${w}" height="${drawn}"/></g>`
  // Walking back it faces the way it goes: a turn on the spot, about its own middle.
  const body =
    WALKS.has(animation) && home > 0
      ? `<g><animateTransform attributeName="transform" type="translate" values="${home} 0;0 0;0 0;${home} 0;${home} 0" keyTimes="0;.48;.5;.98;1" dur="${WALK_S}s" ${FOREVER}/>` +
        `<g transform="translate(${w / 2} 0)"><g><animateTransform attributeName="transform" type="scale" calcMode="discrete" values="1 1;-1 1;1 1" keyTimes="0;.49;.99" dur="${WALK_S}s" ${FOREVER}/>` +
        `<g transform="translate(${-w / 2} 0)">${inner}</g></g></g></g>`
      : `<g transform="translate(${home / 2} 0)">${inner}</g>`
  // Its head room is the hop's, so nothing leaves the viewBox.
  const room = Math.round(height * 0.14)
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + room}" viewBox="0 ${-room} ${width} ${height + room}">${body}</svg>`,
    width,
    height: height + room,
  }
}
