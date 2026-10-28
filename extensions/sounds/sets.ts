/** The notification sound sets, for the preview round: each one instrument and one motif. */
export const soundSets = [
  { id: 'kalimba', label: 'A · Kalimba', detail: 'Woody tine in G, the motif falling home' },
  { id: 'glass', label: 'B · Glass', detail: 'Pure glass chime in C, rising to the octave' },
  { id: 'felt', label: 'C · Felt', detail: 'Muted felt piano in F, warm and low' },
] as const
export type SoundSet = (typeof soundSets)[number]['id']
