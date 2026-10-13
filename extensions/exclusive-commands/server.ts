import { defineExtension, wrapTool } from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import type { ExtensionHost } from '../../server/extensions.ts'
import { bashTripwireMessage, defaultBashTimeout } from '../coding-tools/server.ts'
import { exclusiveSlot } from './slot.ts'

export default function exclusiveCommands(host: ExtensionHost) {
  const slot = exclusiveSlot(host)
  return defineExtension({
    name: 'exclusive-commands',
    wraps: [
      wrapTool(createBashTool(), (bash) => ({
        ...bash,
        async execute(args, api, context) {
          let sources: string[] = []
          const warnings: string[] = []
          try {
            const settings = await host.projectSettings()
            const configured = settings.exclusiveCommands ?? []
            if (Array.isArray(configured)) sources = configured as string[]
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
          const limit = matches ? (args.timeout ?? defaultBashTimeout()) : undefined
          const started = performance.now()
          if (matches) {
            const deadline = AbortSignal.timeout(Math.ceil(limit! * 1000))
            const signal = context.abortSignal
              ? AbortSignal.any([context.abortSignal, deadline])
              : deadline
            if (slot.command !== undefined)
              api.output(`Waiting for exclusive command: ${slot.command.replaceAll('\n', ' ')}\n`)
            try {
              await slot.acquire(args.command, signal)
            } catch (error) {
              if (deadline.aborted && !context.abortSignal?.aborted)
                throw new Error(
                  `Timed out after ${limit} s waiting for exclusive command: ${slot.command?.replaceAll('\n', ' ')}`,
                  { cause: error },
                )
              throw error
            }
          }
          const timeout = matches
            ? Math.max(1, Math.ceil(limit! - (performance.now() - started) / 1000))
            : args.timeout
          try {
            const result = await bash.execute({ ...args, timeout }, api, context)
            return warnings.length
              ? {
                  ...result,
                  output: [
                    { type: 'text' as const, text: warnings.join('') },
                    ...(result.output ?? []),
                  ],
                }
              : result
          } catch (error) {
            if (
              matches &&
              args.timeout === undefined &&
              error instanceof Error &&
              error.message === `Command timed out after ${timeout} seconds`
            )
              throw new Error(bashTripwireMessage(limit!), { cause: error })
            throw error
          } finally {
            if (matches) slot.release()
          }
        },
      })),
    ],
  })
}
