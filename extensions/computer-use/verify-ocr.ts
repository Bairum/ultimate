import { saveEvidence } from './evidence-files.ts'
import type { Driver, Observation, Predicate, Evidence } from './types.ts'
import { parseRegions, matchLabel, visibleWindow, normalizeLabel } from './perception.ts'
import type { PixelSettings } from './perception.ts'

/** OCR proof is produced only from the Driver's capture, never from planner claims. */
export async function verifyOcr(
  driver: Driver,
  observation: Observation,
  predicates: Predicate[],
  config: PixelSettings,
  signal: AbortSignal,
  redact: (text: string) => string,
) {
  if (visibleWindow(observation)) return { verdict: 'unknown' as const }
  if (!observation.capture || !observation.image || observation.image.mimeType !== 'image/png')
    return { verdict: 'unknown' as const }
  const { regions } = await parseRegions(
    driver,
    observation.capture.id,
    { kinds: ['text'] },
    signal,
  )
  const excerpts: string[] = []
  for (const predicate of predicates.filter((p) => p.ocr)) {
    const ocr = predicate.ocr
    if (!ocr || typeof ocr !== 'object' || Array.isArray(ocr))
      return { verdict: 'unknown' as const }
    const appears = ocr.appears ?? []
    const disappears = ocr.disappears ?? []
    if (
      !Array.isArray(appears) ||
      !Array.isArray(disappears) ||
      (!appears.length && !disappears.length) ||
      ![...appears, ...disappears].every((v) => typeof v === 'string' && v.trim())
    )
      return { verdict: 'unknown' as const }
    for (const label of appears as string[]) {
      const matched = regions.find(
        (region) =>
          !normalizeLabel(region.label)
            .split(' ')
            .some((token) => token === 'not' || token === 'failed') &&
          matchLabel([region], label, undefined, config.labelRadius, config.minConfidence).match,
      )
      if (!matched) return { verdict: 'unsatisfied' as const }
      excerpts.push(redact(matched.label))
    }
    for (const label of disappears as string[]) {
      const matched = matchLabel(
        regions,
        label,
        undefined,
        config.labelRadius,
        config.minConfidence,
      )
      if (matched.match || matched.ambiguous) return { verdict: 'unsatisfied' as const }
      excerpts.push(`Absent: ${redact(label)}`)
    }
  }
  const other = predicates.filter((p) => !p.ocr)
  if (other.length) {
    const checked = await driver.call(
      'verify_state',
      { pid: observation.pid, window_id: observation.windowId, expect: other, timeout_ms: 0 },
      signal,
    )
    const verdict = checked.structured?.verdict ?? checked.structured?.status
    if (!checked.ok || verdict !== 'satisfied')
      return {
        verdict: verdict === 'unsatisfied' ? ('unsatisfied' as const) : ('unknown' as const),
      }
  }
  return { verdict: 'satisfied' as const, excerpt: excerpts.join('\n') }
}
export async function ocrEvidence(
  home: string,
  conversation: number,
  observation: Observation,
  predicates: Predicate[],
  ref: string,
  excerpt: string,
  criterion?: string,
): Promise<Evidence> {
  const path = await saveEvidence(
    home,
    conversation,
    Buffer.from(observation.image!.data, 'base64'),
  )
  return {
    kind: 'verify',
    predicates,
    verdict: 'satisfied',
    ref,
    app: observation.app,
    path,
    excerpt,
    captureId: observation.capture!.id,
    ...(criterion ? { criterion } : {}),
  }
}
