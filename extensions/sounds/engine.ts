/**
 * Everything audible, on Tone.js: the notification cues and the three bands of the sound of agents. Loaded on first
 * use (`import('./engine.ts')`): Tone opens an AudioContext when it loads, and a page plays only after a click.
 */
import * as Tone from 'tone'
import type { Sound } from './cues.ts'
import type { Happening, Role, Tool, Variant } from './agents.ts'

/** A note as [start in seconds, frequency in Hz, length in seconds]. */
export type Note = readonly [number, number, number]

// One bus for everything: volume, a soft limiter so chords never clip, and a light shared reverb.
const master = new Tone.Volume(-6)
master.chain(new Tone.Limiter(-3), Tone.getDestination())
const reverb = new Tone.Reverb({ decay: 3.5, wet: 0.28 }).connect(master)

/** Sets the volume from 0 (silent) to 1. */
export function setVolume(volume: number) {
  master.mute = volume <= 0
  master.volume.rampTo(Tone.gainToDb(volume) - 6, 0.05)
}

/** Starts audio; the browser allows it only during a click or key press, until the page had one. */
export const unlock = () => Tone.start()
export const running = () => Tone.getContext().state === 'running'

// Soft bells for the cues and other extensions' notes: FM with a gentle bell ratio, through the reverb.
const bells = new Tone.PolySynth(Tone.FMSynth, {
  harmonicity: 3.01,
  modulationIndex: 1.6,
  oscillator: { type: 'sine' },
  envelope: { attack: 0.005, decay: 1.2, sustain: 0, release: 1.2 },
  modulation: { type: 'sine' },
  modulationEnvelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.4 },
}).connect(reverb)
bells.maxPolyphony = 24
// A warm pad under each cue: the chord the bells sit in.
const cuePad = new Tone.PolySynth(Tone.Synth, {
  oscillator: { type: 'fatsine', count: 3, spread: 18 },
  envelope: { attack: 0.08, decay: 0.6, sustain: 0.3, release: 1.4 },
}).connect(reverb)

const hz = (midi: number) => Tone.mtof(midi as Tone.Unit.MidiNote)

/** Each cue keeps its old melody, now as bells over a chord. */
const cues: Record<Sound, { bells: [number, number, number][]; chord: number[] }> = {
  // A fifth up, asking, over an open D: D5, A5.
  input: {
    bells: [
      [0, 74, 0.5],
      [0.16, 81, 0.9],
    ],
    chord: [50, 57, 64],
  },
  // A rising C major, resolved, over C and G below.
  finished: {
    bells: [
      [0, 72, 0.45],
      [0.09, 76, 0.45],
      [0.18, 79, 1],
      [0.3, 84, 1.2],
    ],
    chord: [48, 55, 64],
  },
  // A low minor third down over a dark A minor.
  failed: {
    bells: [
      [0, 64, 0.5],
      [0.2, 61, 1],
    ],
    chord: [45, 48, 52],
  },
}

/** Plays notification sound `sound`. */
export async function play(sound: Sound) {
  await Tone.start()
  const now = Tone.now() + 0.03
  const cue = cues[sound]
  cuePad.triggerAttackRelease(cue.chord.map(hz), 0.9, now, 0.18)
  for (const [start, midi, length] of cue.bells)
    bells.triggerAttackRelease(hz(midi), length, now + start, 0.5)
}

/** Plays `notes` as bells at `volume` (the notification cues use 0.18). */
export async function playNotes(notes: readonly Note[], volume = 0.18) {
  await Tone.start()
  const now = Tone.now() + 0.03
  for (const [start, frequency, length] of notes)
    bells.triggerAttackRelease(frequency, length, now + start, Math.min(1, volume * 3))
}

// The key and the harmony every band plays in: D major, I–vi–IV–V, a bar each, as MIDI chords around the third octave.
const progression = [
  [50, 54, 57],
  [47, 50, 54],
  [43, 47, 50],
  [45, 49, 52],
]
const pentatonic = [0, 2, 4, 7, 9]
/** The `degree`th note of D major pentatonic from `base`. */
const scale = (degree: number, base = 62) =>
  base + Math.floor(degree / 5) * 12 + pentatonic[((degree % 5) + 5) % 5]

/** The `index`th tone of `chord` counting up through octaves: 0 the root, 1 the third, 3 the root an octave up. */
const tone = (chord: readonly number[], index: number) =>
  chord[((index % 3) + 3) % 3] + 12 * Math.floor(index / 3)

/**
 * Each role's motif: a contour over the current chord's tones that its tool calls walk one step per call. A role's
 * calls then form a recognisable phrase that follows the harmony, instead of random chord tones.
 */
const contours: Record<Role, readonly number[]> = {
  ultimate: [0, 2, 1, 2],
  coordinator: [0, 1, 2, 1],
  worker: [0, 1, 2, 3, 2, 1],
  scout: [3, 2, 1, 2],
  reviewer: [2, 1, 0, 1],
  lander: [0, 0, 1, 2],
  other: [0, 1, 0, 2],
}
function walker() {
  const at: Partial<Record<Role, number>> = {}
  return (role: Role) => {
    const index = at[role] ?? 0
    at[role] = index + 1
    return contours[role][index % contours[role].length]
  }
}

/**
 * A monophonic voice refuses a start at or before its last one; two happenings on one 16th would. Each call gets a
 * time just after the voice's previous one.
 */
function later() {
  let last = 0
  return (time: number) => (last = Math.max(time, last + 0.012))
}

type Part = {
  /** The one tempo: busier work plays more notes, never a faster beat. */
  bpm: number
  /** Happenings a 16th may play; the rest wait for the next. */
  cap: number
  play: (happening: Happening, time: number, bar: number) => void
  /** Each sixteenth, for effects that change between happenings; nothing sounds without one. */
  tick?: (time: number) => void
  nodes: Tone.ToneAudioNode[]
}

/** A playing band: hand it what happens; it quantizes it to its beat. */
export type Band = {
  hit: (happening: Happening) => void
  dispose: () => void
}

export function band(variant: Variant): Band {
  const part = parts[variant]()
  const queue: Happening[] = []
  let step = 0
  const transport = Tone.getTransport()
  // Set once, before the transport starts: Tone keeps every tempo change on a timeline it never prunes and searches
  // on every tick, and ramping it at runtime once hung a renderer.
  transport.bpm.value = part.bpm
  const loop = new Tone.Loop((time) => {
    const bar = Math.floor(step / 16)
    // A hidden tab throttles the clock, which then catches up in one go with steps already past: drop what they hold
    // instead of playing it all at once.
    if (time < Tone.now() - 0.1) queue.length = 0
    for (const happening of queue.splice(0, part.cap)) part.play(happening, time, bar)
    // A burst bigger than a few beats' worth is noise: keep the newest.
    queue.splice(0, Math.max(0, queue.length - part.cap * 8))
    part.tick?.(time)
    step++
  }, '16n').start(0)
  transport.start('+0.05')
  return {
    hit: (happening) => void queue.push(happening),
    dispose: () => {
      loop.dispose()
      transport.stop()
      transport.cancel()
      // Let held notes release and reverb tails ring out before the voices go: a release scheduled on a disposed
      // synth throws inside Tone.
      setTimeout(() => {
        for (const node of part.nodes) node.dispose()
      }, 12_000)
    },
  }
}

const parts: Record<Variant, () => Part> = {
  chiptune,
  orchestra,
  crazy,
}

/** A phrase as [start in sixteenths, MIDI note, length in sixteenths, velocity]. */
type Phrase = readonly (readonly [number, number, number, number?])[]

/**
 * A chip channel plays one note at a time, as on the NES. A phrase books the channel until it ends and the next waits
 * for it; one that would wait more than a beat is dropped, unless it `must` play (a commit, a landing, a failure).
 */
function channel(sound: (midi: number, seconds: number, time: number, velocity: number) => void) {
  let free = 0
  return (phrase: Phrase, time: number, must = false) => {
    const sixteenth = Tone.Time('16n').toSeconds()
    const start = Math.max(time, free)
    if (!must && start > time + sixteenth * 4) return
    let end = start
    for (const [at, midi, steps, velocity = 0.7] of phrase) {
      sound(midi, steps * sixteenth * 0.85, start + at * sixteenth, velocity)
      end = Math.max(end, start + (at + steps) * sixteenth)
    }
    free = end
  }
}

/**
 * (A) 8-bit, NES style: two pulse channels, a triangle bass and a noise drum, four voices in all, dry and upbeat. Small
 * wins ring like coins, an agent starting is a 1-up, a landing a power-up, a failure a bump that ends unresolved.
 */
function chiptune(): Part {
  const bus = new Tone.Volume(-10)
  bus.chain(new Tone.Filter(7000, 'lowpass'), master)
  const pulse = (width: number) =>
    new Tone.Synth({
      oscillator: { type: 'pulse', width },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0.45, release: 0.05 },
    }).connect(bus)
  // Width 0.5 is a 25% duty cycle, the bright classic lead; 0 a square, rounder, for the second voice.
  const lead = pulse(0.5)
  const second = pulse(0)
  second.volume.value = -4
  const triangle = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 0.05, sustain: 0.9, release: 0.03 },
  }).connect(bus)
  triangle.volume.value = 2
  const noise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.07, sustain: 0 },
  }).connect(bus)
  noise.volume.value = -8
  const note =
    (synth: Tone.Synth) => (midi: number, seconds: number, time: number, velocity: number) =>
      synth.triggerAttackRelease(hz(midi), seconds, time, velocity)
  const ch = {
    lead: channel(note(lead)),
    second: channel(note(second)),
    triangle: channel(note(triangle)),
    // The noise channel's "note" is its length only: low numbers a thud, high ones a tick.
    noise: channel((midi, seconds, time, velocity) =>
      noise.triggerAttackRelease(Math.min(seconds, midi > 60 ? 0.03 : 0.12), time, velocity),
    ),
  }
  // Each role in its own octave, so a scout's coin is higher than a coordinator's.
  const octave: Record<Role, number> = {
    ultimate: 12,
    coordinator: 0,
    worker: 12,
    scout: 24,
    reviewer: 12,
    lander: 12,
    other: 24,
  }
  const step = walker()
  return {
    bpm: 150,
    cap: 2,
    nodes: [lead, second, triangle, noise, bus],
    play: (h, time, bar) => {
      const chord = progression[bar % 4]
      if (h.kind === 'tool') {
        const at = step(h.role)
        const n = tone(chord, at) + octave[h.role] + 12
        // A small coin: the role's next motif note, then the chord tone above it, a 32nd later.
        if (h.tool === 'edit' || h.tool === 'other')
          ch.lead(
            [
              [0, n, 0.5, 0.35],
              [0.5, tone(chord, at + 1) + octave[h.role] + 12, 1, 0.35],
            ],
            time,
          )
        // Commands are the drum: a noise tick on the triangle's root.
        else if (h.tool === 'bash') {
          ch.noise([[0, 30, 1, 0.5]], time)
          ch.triangle([[0, chord[0] - 12, 1, 0.8]], time)
        }
        // Reading is a quiet blip on the second voice; the browser a quick run up three chord tones.
        else if (h.tool === 'read') ch.second([[0, n, 0.5, 0.25]], time)
        else
          ch.second(
            [0, 1, 2].map(
              (i) => [i * 0.5, tone(chord, i) + octave[h.role] + 12, 0.5, 0.3] as const,
            ),
            time,
          )
        return
      }
      if (h.kind === 'start') {
        // A 1-up: up a third, up a fifth, a step back, then over the octave, on the role's chord tones.
        const base = octave[h.role] + 12
        ch.second(
          [0, 1, 2, 1, 3, 4].map((i, at) => [at, tone(chord, i) + base, 1, 0.4] as const),
          time,
        )
      } else if (h.kind === 'stop')
        // The answer: down from the fifth to the root.
        ch.second(
          [
            [0, chord[2] + octave[h.role] + 12, 1, 0.3],
            [1, chord[0] + octave[h.role] + 12, 2, 0.3],
          ],
          time,
        )
      else if (h.kind === 'commit')
        // The coin: the dominant A5, then the tonic D6 a fourth up, ringing.
        ch.lead(
          [
            [0, 81, 0.75, 0.6],
            [0.75, 86, 5, 0.6],
          ],
          time,
          true,
        )
      else if (h.kind === 'landed') {
        // A power-up: arpeggios of I, IV and V climbing in 32nds, then a held tonic over the bass: V–I, resolved.
        const climb = [
          [62, 66, 69, 74],
          [67, 71, 74, 79],
          [69, 73, 76, 81],
        ]
        ch.lead(
          [...climb.flat().map((midi, i) => [i * 0.5, midi, 0.5, 0.55] as const), [6, 86, 6, 0.6]],
          time,
          true,
        )
        ch.second([[6, 78, 6, 0.4]], time, true)
        ch.triangle(
          [
            [0, 50, 2],
            [2, 55, 2],
            [4, 57, 2],
            [6, 50, 6],
          ],
          time,
          true,
        )
        ch.noise(
          [
            [4, 70, 0.5, 0.4],
            [5, 70, 0.5, 0.5],
            [6, 30, 2, 0.7],
          ],
          time,
          true,
        )
      } else {
        // A bump: a thud, then the lead sliding down by half steps to G♯, a tritone over the bass's D, unresolved.
        ch.noise([[0, 30, 2, 0.9]], time, true)
        ch.lead(
          [
            [0, 70, 1, 0.55],
            [1, 69, 1, 0.55],
            [2, 68, 4, 0.55],
          ],
          time,
          true,
        )
        ch.triangle(
          [
            [0, 50, 1],
            [2, 38, 4],
          ],
          time,
          true,
        )
      }
    },
  }
}

/** (B) Each role an instrument in one key and tempo, over a I–vi–IV–V progression. */
function orchestra(): Part {
  const hall = new Tone.Reverb({ decay: 4, wet: 0.35 }).connect(master)
  // @ultimate: a warm string pad holding the chord.
  const strings = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
    envelope: { attack: 0.6, decay: 0.4, sustain: 0.7, release: 2 },
  })
  strings.chain(new Tone.Filter(1200, 'lowpass'), hall)
  strings.volume.value = -22
  // Coordinators: a cello-like bass on the beat.
  const cello = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    filter: { Q: 1, type: 'lowpass' },
    envelope: { attack: 0.05, decay: 0.3, sustain: 0.5, release: 0.8 },
    filterEnvelope: { attack: 0.05, decay: 0.4, sustain: 0.4, baseFrequency: 120, octaves: 2.5 },
  }).connect(hall)
  cello.volume.value = -14
  // Workers: plucked strings.
  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.003, decay: 0.35, sustain: 0, release: 0.4 },
  }).connect(hall)
  pluck.volume.value = -10
  // Scouts: a flute, high.
  const flute = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.06, decay: 0.2, sustain: 0.6, release: 0.5 },
  })
  flute.connect(new Tone.Vibrato(5, 0.08).connect(hall))
  flute.volume.value = -16
  // Reviewers: a marimba.
  const marimba = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 4,
    modulationIndex: 3,
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
    modulationEnvelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.2 },
  }).connect(hall)
  marimba.volume.value = -10
  // The lander: brass.
  const brass = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 2, spread: 10 },
    envelope: { attack: 0.08, decay: 0.3, sustain: 0.6, release: 0.6 },
  })
  brass.chain(new Tone.Filter(1800, 'lowpass'), hall)
  brass.volume.value = -14
  const timpani = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3 }).connect(hall)
  timpani.volume.value = -12
  const t = { cello: later(), timpani: later() }
  const voice: Record<Role, { synth: Tone.PolySynth | Tone.MonoSynth; octave: number }> = {
    ultimate: { synth: strings, octave: 12 },
    coordinator: { synth: cello, octave: -12 },
    worker: { synth: pluck, octave: 12 },
    scout: { synth: flute, octave: 24 },
    reviewer: { synth: marimba, octave: 24 },
    lander: { synth: brass, octave: 12 },
    other: { synth: pluck, octave: 24 },
  }
  // A tool is an articulation: bash short and low, edit a two-note figure, read soft and high, browser a run.
  const figures: Record<Tool, { notes: number[]; length: string; velocity: number }> = {
    bash: { notes: [0], length: '16n', velocity: 0.8 },
    edit: { notes: [0, 2], length: '16n', velocity: 0.7 },
    read: { notes: [2], length: '8n', velocity: 0.35 },
    browser: { notes: [0, 1, 2], length: '32n', velocity: 0.55 },
    other: { notes: [1], length: '16n', velocity: 0.5 },
  }
  const step = walker()
  const sound = (role: Role, midi: number, length: string, time: number, velocity: number) => {
    const { synth } = voice[role]
    if (synth === cello) cello.triggerAttackRelease(hz(midi), length, t.cello(time), velocity)
    else (synth as Tone.PolySynth).triggerAttackRelease(hz(midi), length, time, velocity)
  }
  return {
    bpm: 96,
    cap: 3,
    nodes: [strings, cello, pluck, flute, marimba, brass, timpani, hall],
    play: (h, time, bar) => {
      const chord = progression[bar % 4]
      const sixteenth = Tone.Time('16n').toSeconds()
      if (h.kind === 'tool') {
        const { octave } = voice[h.role]
        const figure = figures[h.tool]
        const low = h.tool === 'bash' ? -12 : 0
        // The role's motif, one step per call, so each instrument plays a phrase over the harmony.
        const from = step(h.role)
        figure.notes.forEach((offset, index) =>
          sound(
            h.role,
            tone(chord, from + offset) + octave + low,
            figure.length,
            time + index * sixteenth,
            figure.velocity,
          ),
        )
      } else if (h.kind === 'start')
        // An entrance: the role's instrument plays the chord upward.
        chord.forEach((midi, index) =>
          sound(h.role, midi + voice[h.role].octave, '8n', time + index * sixteenth * 2, 0.6),
        )
      else if (h.kind === 'stop') {
        // An exit answers the entrance: down from the fifth to the root.
        sound(h.role, chord[2] + voice[h.role].octave, '8n', time, 0.4)
        sound(h.role, chord[0] + voice[h.role].octave, '4n', time + sixteenth * 2, 0.35)
      } else if (h.kind === 'commit') {
        // A small close: the leading tone rising to the tonic, the tonic chord with its third on top.
        timpani.triggerAttackRelease(hz(38), '8n', t.timpani(time), 0.7)
        marimba.triggerAttackRelease(hz(85), '16n', time, 0.5)
        marimba.triggerAttackRelease([74, 78, 81].map(hz), '8n', time + sixteenth, 0.6)
      } else if (h.kind === 'landed') {
        // A full cadence: V7 then I, its seventh falling and its leading tone rising, with a timpani roll.
        brass.triggerAttackRelease([57, 61, 64, 67].map(hz), '4n', time, 0.8)
        brass.triggerAttackRelease([62, 62, 66, 69].map(hz), '1m', time + sixteenth * 4, 0.9)
        strings.triggerAttackRelease([50, 57, 62, 66].map(hz), '1m', time + sixteenth * 4, 0.7)
        for (let i = 0; i < 6; i++)
          timpani.triggerAttackRelease(
            hz(i < 5 ? 45 : 38),
            '16n',
            t.timpani(time + (i * sixteenth) / 2),
            0.5 + i * 0.08,
          )
      } else {
        // Suspense: a diminished seventh, the brass cut short; it leans toward D and waits for a landing to resolve it.
        brass.triggerAttackRelease([55, 58, 61, 64].map(hz), '8n', time, 0.8)
        timpani.triggerAttackRelease(hz(36), '4n', t.timpani(time), 0.9)
      }
    },
  }
}

/** (C) Every tool call a drum hit or a glitch at a driving 128 bpm; landings drop, failures crunch. */
function crazy(): Part {
  const crush = new Tone.BitCrusher(8)
  const echo = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0.18 })
  const bus = new Tone.Volume(-4)
  bus.chain(crush, echo, reverb)
  crush.wet.value = 0.35
  const kick = new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 6 }).connect(bus)
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0 },
  }).connect(bus)
  snare.volume.value = -10
  const hat = new Tone.MetalSynth({
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
  }).connect(bus)
  hat.volume.value = -26
  const crash = new Tone.MetalSynth({
    harmonicity: 3.1,
    modulationIndex: 16,
    resonance: 3000,
    envelope: { attack: 0.001, decay: 1.4, release: 0.5 },
  }).connect(bus)
  crash.volume.value = -22
  const acid = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    filter: { Q: 8, type: 'lowpass' },
    envelope: { attack: 0.005, decay: 0.15, sustain: 0.2, release: 0.1 },
    filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.1, baseFrequency: 180, octaves: 4 },
  }).connect(bus)
  acid.volume.value = -14
  const zap = new Tone.FMSynth({
    harmonicity: 8,
    modulationIndex: 20,
    envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
    modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
  }).connect(bus)
  zap.volume.value = -14
  const stab = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsquare', count: 3, spread: 30 },
    envelope: { attack: 0.002, decay: 0.2, sustain: 0.1, release: 0.3 },
  })
  stab.chain(new Tone.Distortion(0.4), bus)
  stab.volume.value = -18
  const riser = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.6, decay: 0.05, sustain: 0 },
  })
  const sweep = new Tone.Filter(400, 'bandpass')
  riser.chain(sweep, bus)
  riser.volume.value = -18
  const t = {
    kick: later(),
    snare: later(),
    hat: later(),
    crash: later(),
    acid: later(),
    zap: later(),
    riser: later(),
  }
  let glitch = 0
  // Edits walk an acid riff on the bar's root: root, octave, fifth, root, seventh, octave.
  const riff = [0, 12, 7, 0, 10, 12]
  let edits = 0
  const step = walker()
  return {
    bpm: 128,
    cap: 4,
    nodes: [kick, snare, hat, crash, acid, zap, stab, riser, sweep, crush, echo, bus],
    play: (h, time, bar) => {
      const sixteenth = Tone.Time('16n').toSeconds()
      if (h.kind === 'tool') {
        if (h.tool === 'bash') snare.triggerAttackRelease('16n', t.snare(time), 0.6)
        else if (h.tool === 'edit')
          acid.triggerAttackRelease(
            hz(progression[bar % 4][0] - 12 + riff[edits++ % riff.length]),
            '16n',
            t.acid(time),
            0.9,
          )
        else if (h.tool === 'read') hat.triggerAttackRelease(hz(400), '32n', t.hat(time), 0.9)
        else zap.triggerAttackRelease(hz(scale(step(h.role) + 2, 74)), '32n', t.zap(time), 0.9)
        // Each call nudges the glitch: the crusher bites harder for a moment.
        glitch = Math.min(1, glitch + 0.08)
      } else if (h.kind === 'start') {
        sweep.frequency.setValueAtTime(300, time)
        sweep.frequency.exponentialRampToValueAtTime(5000, time + 0.6)
        riser.triggerAttackRelease(0.6, t.riser(time), 0.7)
      } else if (h.kind === 'stop') zap.triggerAttackRelease(hz(38), '16n', t.zap(time), 0.7)
      else if (h.kind === 'commit') {
        crash.triggerAttackRelease(hz(300), '8n', t.crash(time), 0.6)
        stab.triggerAttackRelease([62, 66, 69].map(hz), '16n', time, 0.6)
      } else if (h.kind === 'landed') {
        // A fill builds the tension for a beat, then the drop releases it.
        for (let i = 0; i < 4; i++)
          snare.triggerAttackRelease('32n', t.snare(time + i * sixteenth), 0.4 + i * 0.15)
        const drop = time + sixteenth * 4
        crash.triggerAttackRelease(hz(250), '2n', t.crash(drop), 0.9)
        kick.triggerAttackRelease(hz(36), '8n', t.kick(drop), 1)
        stab.triggerAttackRelease([50, 57, 62, 66, 69, 74].map(hz), '4n', drop, 0.8)
      } else {
        // A failure crunches: crusher all the way down, a detuned cluster, a stutter.
        crush.bits.setValueAtTime(3, time)
        crush.bits.linearRampToValueAtTime(8, time + 1.2)
        stab.triggerAttackRelease([49, 50, 55, 56].map(hz), '8n', time, 0.9)
        for (let i = 0; i < 4; i++) snare.triggerAttackRelease('64n', t.snare(time + i * 0.06), 0.9)
      }
    },
    // Nothing plays on its own; the glitch only fades between calls.
    tick: (time) => {
      glitch *= 0.97
      crush.wet.setValueAtTime(0.25 + glitch * 0.6, time)
    },
  }
}
