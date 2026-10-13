import { defineExtension, type ToolExecutionApi } from '@earendil-works/pi-durable'
import {
  type BashExecution,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'

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
})
