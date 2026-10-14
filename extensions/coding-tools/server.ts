import { defineExtension, type ToolExecutionApi, wrapTool } from '@earendil-works/pi-durable'
import {
  type BashExecution,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'

function defaultBashTimeout() {
  const seconds = Number(process.env.ULTIMATE_BASH_TIMEOUT ?? 3600)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('ULTIMATE_BASH_TIMEOUT must be a positive finite number of seconds')
  return seconds
}

const bashTripwireMessage = (seconds: number) =>
  `Tripwire: bash ran past the ${seconds} s default limit and was stopped. Pass timeout for longer commands.`

export function prepareBash(
  execution: BashExecution,
  api: Pick<ToolExecutionApi, 'conversationId'>,
) {
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
  execution.env.GIT_CONFIG_COUNT = String(count + 2)
  execution.env[`GIT_CONFIG_KEY_${count}`] = 'hook.ultimate.event'
  execution.env[`GIT_CONFIG_VALUE_${count}`] = 'prepare-commit-msg'
  execution.env[`GIT_CONFIG_KEY_${count + 1}`] = 'hook.ultimate.command'
  execution.env[`GIT_CONFIG_VALUE_${count + 1}`] =
    `git interpret-trailers --in-place --if-exists replace --trailer "Ultimate-Conversation: ${api.conversationId}" "$1" #`
}

export default defineExtension({
  name: 'coding-tools',
  tools: [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool({ prepare: prepareBash }),
  ],
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
            /^Command timed out after [\d.e+-]+ seconds$/.test(error.message)
          )
            throw new Error(bashTripwireMessage(timeout), { cause: error })
          throw error
        }
      },
    })),
  ],
})
