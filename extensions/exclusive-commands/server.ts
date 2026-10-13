import { defineExtension, wrapTool } from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import type { ExtensionHost } from '../../server/extensions.ts'
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
                  output: [
                    { type: 'text' as const, text: warnings.join('') },
                    ...(result.output ?? []),
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
