import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension, wrapTool } from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import type { ExtensionHost } from '../../server/extensions.ts'

class Slot {
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

export default function exclusiveCommands(host: ExtensionHost) {
  const slot = host.resource('exclusive-commands.slot', () => new Slot())
  return defineExtension({
    name: 'exclusive-commands',
    wraps: [
      wrapTool(createBashTool(), (bash) => ({
        ...bash,
        async execute(args, api, context) {
          let sources: string[] = []
          const warnings: string[] = []
          try {
            const settings = JSON.parse(
              await readFile(join(host.projectRoot, '.ultimate/settings.json'), 'utf8'),
            )
            const configured = settings.exclusiveCommands ?? []
            if (Array.isArray(configured)) sources = configured
            else warnings.push('Invalid exclusiveCommands ignored: expected an array of patterns\n')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          let matches = false
          for (const source of sources) {
            try {
              if (new RegExp(source).test(args.command)) matches = true
            } catch {
              warnings.push(
                `Invalid exclusiveCommands pattern ignored: ${JSON.stringify(source)}\n`,
              )
            }
          }
          for (const warning of warnings) api.output(warning)
          if (matches) {
            if (slot.command !== undefined)
              api.output(`Waiting for exclusive command: ${slot.command.replaceAll('\n', ' ')}\n`)
            await slot.acquire(args.command, context.abortSignal)
          }
          try {
            const result = await bash.execute(args, api, context)
            return warnings.length
              ? {
                  ...result,
                  content: [
                    { type: 'text' as const, text: warnings.join('') },
                    ...(result.content ?? []),
                  ],
                }
              : result
          } finally {
            if (matches) slot.release()
          }
        },
      })),
    ],
  })
}
