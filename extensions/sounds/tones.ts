import type { Note, Tune } from './engine.ts'
import type { SoundSet } from './sets.ts'

export type { Note, Tune } from './engine.ts'

let volume = 1
let set: SoundSet = 'glass'
let loaded: Promise<typeof import('./engine.ts')> | undefined

/** The Tone.js engine, loaded on first sound: loading it opens an AudioContext. */
export const engine = () =>
  (loaded ??= import('./engine.ts').then((tone) => {
    tone.setVolume(volume)
    tone.setSet(set)
    return tone
  }))

/** Picks the sound set, without loading the engine for it. */
export function setSet(value: SoundSet) {
  set = value
  loaded
    ?.then((tone) => tone.setSet(value))
    .catch((error: unknown) => console.warn('Set failed', error))
}

/** Sets the volume of every sound from 0 to 1, without loading the engine for it. */
export function setVolume(value: number) {
  volume = value
  loaded
    ?.then((tone) => tone.setVolume(value))
    .catch((error: unknown) => console.warn('Volume failed', error))
}

/** Plays `sound`; a browser lets a page play once someone has clicked or typed in it. */
export const play = async (sound: Tune) => (await engine()).play(sound)

/** Plays `notes` as bells at `volume` (the notification sounds use 0.18); the same rule on clicks applies. */
export const playNotes = async (notes: readonly Note[], level = 0.18) =>
  (await engine()).playNotes(notes, level)
