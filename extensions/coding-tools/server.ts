import { defineExtension, wrapTool } from '@earendil-works/pi-durable'
import { CodingTools, createBashTool } from '@earendil-works/pi-durable/tools'

export function defaultBashTimeout() {
  const seconds = Number(process.env.ULTIMATE_BASH_TIMEOUT ?? 3600)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('ULTIMATE_BASH_TIMEOUT must be a positive finite number of seconds')
  return seconds
}

export const bashTripwireMessage = (seconds: number) =>
  `Tripwire: bash ran past the ${seconds} s default limit and was stopped. Pass timeout for longer commands.`

export default defineExtension({
  ...CodingTools,
  name: 'coding-tools',
  wraps: [
    wrapTool(createBashTool(), (bash) => ({
      ...bash,
      async execute(args, api, context) {
        if (args.timeout !== undefined) return bash.execute(args, api, context)
        const timeout = defaultBashTimeout()
        try {
          return await bash.execute({ ...args, timeout }, api, context)
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === `Command timed out after ${timeout} seconds`
          )
            throw new Error(bashTripwireMessage(timeout), { cause: error })
          throw error
        }
      },
    })),
  ],
})
