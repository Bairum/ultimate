import { createHash } from 'node:crypto'
import { exec } from '../../lib/exec.ts'
import type { Driver, Observation, StepOutcome } from './types.ts'
import { clock, containsLabel, parseRegions, requireVisible } from './perception.ts'
import type { Clock } from './perception.ts'

function keepAwake() {
  const running = exec('caffeinate', ['-d', '-w', String(process.pid)])
  // Terminating our assertion is expected; other failures must remain visible.
  const finished = running.catch((error: NodeJS.ErrnoException & { killed?: boolean }) => {
    if (!error.killed) console.error('computer-use: caffeinate failed:', error)
  })
  return async () => {
    running.child.kill()
    await finished
  }
}
export async function waitFor(options: {
  driver: Driver
  capture(maxDimension: number): Promise<Observation>
  until: { text?: string; gone?: string; stable?: true }
  seconds: number
  signal: AbortSignal
  stopped(): Promise<boolean>
  time?: Clock
  minConfidence?: number
  redact?: (text: string) => string
  awake?: () => () => Promise<void>
}): Promise<StepOutcome> {
  const time = options.time ?? clock
  const deadline = time.now() + options.seconds * 1000
  const release = options.seconds > 60 ? (options.awake ?? keepAwake)() : undefined
  let seen: string[] = []
  let previous: string | undefined
  const outcome = (status: 'satisfied' | 'timeout'): StepOutcome => ({
    status: 'delivered',
    text: '',
    wait: {
      status,
      seen: seen.slice(0, 20).map((s) => (options.redact ? options.redact(s) : s).slice(0, 60)),
    },
  })
  try {
    do {
      if (options.signal.aborted || (await options.stopped())) return { status: 'not_run' }
      const observation = await options.capture(800)
      requireVisible(observation)
      if (options.signal.aborted || (await options.stopped())) return { status: 'not_run' }
      if (observation.degraded && (options.until.text || options.until.gone)) {
        if (!observation.capture) throw new Error('Wait requires a capture')
        const { regions } = await parseRegions(
          options.driver,
          observation.capture.id,
          { kinds: ['text'] },
          options.signal,
        )
        seen = regions
          .filter((r) => r.kind === 'text' && r.confidence >= (options.minConfidence ?? 0.5))
          .map((r) => r.label)
      } else
        seen = observation.elements.flatMap((e) => [e.label ?? '', e.value ?? '']).filter(Boolean)
      const contains = (text: string) => seen.some((s) => containsLabel(s, text))
      const hash = observation.image
        ? createHash('sha256').update(observation.image.data).digest('hex')
        : undefined
      const until = options.until
      const satisfied =
        (!until.text || contains(until.text)) &&
        (!until.gone || !contains(until.gone)) &&
        (!until.stable || (hash !== undefined && hash === previous))
      previous = hash
      if (satisfied) return outcome('satisfied')
      if (time.now() >= deadline) break
      await time.sleep(Math.min(500, deadline - time.now()), options.signal)
    } while (!options.signal.aborted)
    if (options.signal.aborted || (await options.stopped())) return { status: 'not_run' }
    return outcome('timeout')
  } catch (error) {
    if (options.signal.aborted || (await options.stopped())) return { status: 'not_run' }
    throw error
  } finally {
    await release?.()
  }
}
