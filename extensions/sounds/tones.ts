import type { Sound } from './cues.ts'

/** Notes as [start in seconds, frequency in Hz, length in seconds]: soft bells, synthesized, no audio files. */
const tunes: Record<Sound, [number, number, number][]> = {
  // A fifth up, asking: D5, A5.
  input: [
    [0, 587.33, 0.5],
    [0.16, 880, 0.9],
  ],
  // A rising major chord, resolved: C5, E5, G5.
  finished: [
    [0, 523.25, 0.45],
    [0.09, 659.25, 0.45],
    [0.18, 783.99, 1],
  ],
  // A low minor third down: E4, C♯4.
  failed: [
    [0, 329.63, 0.5],
    [0.2, 277.18, 1],
  ],
}

/** Partials over the fundamental as [ratio, gain]: a sine with a little shimmer, like a small bell. */
const partials = [
  [1, 1],
  [2, 0.12],
  [3, 0.04],
] as const

let context: AudioContext | undefined

/** Plays `sound`; a browser lets a page play once someone has clicked or typed in it. */
export async function play(sound: Sound) {
  context ??= new AudioContext()
  if (context.state === 'suspended') await context.resume()
  const now = context.currentTime + 0.02
  const out = context.createGain()
  out.gain.value = 0.18
  out.connect(context.destination)
  for (const [start, frequency, length] of tunes[sound]) {
    for (const [ratio, level] of partials) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = frequency * ratio
      const at = now + start
      // Higher partials fade sooner, so each note softens as it rings.
      const end = at + length / ratio
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(level, at + 0.006)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain).connect(out)
      oscillator.start(at)
      oscillator.stop(end)
    }
  }
}
