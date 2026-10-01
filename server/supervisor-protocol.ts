import { randomUUID } from 'node:crypto'

export type ChildMessage =
  | { type: 'prepared'; port: number }
  | { type: 'ready' | 'released' }
  | { type: 'failed'; error: string }
  | { type: 'swap'; requestId: string }
  | { type: 'swap-ack'; requestId: string }
export type SupervisorMessage =
  | { type: 'go' | 'release' }
  | { type: 'swap-result'; requestId: string; ok: false; error: string }
  | { type: 'swap-result'; requestId: string; ok: true; generation: number }

// Success is acknowledged only after the caller has durably recorded its replay result.
export async function requestSwap(
  approved: (generation: number) => Promise<void>,
): Promise<string> {
  if (!process.send) return 'Restart requires pnpm start (the supervisor).'
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const listener = (message: SupervisorMessage) => {
      if (message.type !== 'swap-result' || message.requestId !== requestId) return
      process.off('message', listener)
      if (!message.ok) return resolve(message.error.slice(-4096))
      void approved(message.generation).then(
        () => {
          process.send?.({ type: 'swap-ack', requestId } satisfies ChildMessage)
        },
        (error) => resolve(String(error)),
      )
    }
    process.on('message', listener)
    process.send?.({ type: 'swap', requestId } satisfies ChildMessage)
  })
}
