import type { ExtensionHost } from '../../server/extensions.ts'

/** One FIFO slot shared by heavy commands of every conversation and the lander's checks. */
export class Slot {
  command?: string
  queue: { command: string; grant: () => void }[] = []

  async acquire(command: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.command === undefined) {
      this.command = command
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        command,
        grant: () => {
          signal?.removeEventListener('abort', abort)
          resolve()
        },
      }
      const abort = () => {
        this.queue.splice(this.queue.indexOf(waiter), 1)
        reject(signal!.reason)
      }
      this.queue.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  release() {
    const next = this.queue.shift()
    this.command = next?.command
    next?.grant()
  }
}

export const exclusiveSlot = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('exclusive-commands.slot', () => new Slot())
