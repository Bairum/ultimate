import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { requestSwap } from '../../server/supervisor-protocol.ts'

import type { ExtensionHost } from '../../server/extensions.ts'

export default (host: ExtensionHost) =>
  defineExtension({
    name: 'self',
    tools: [
      defineTool({
        name: 'restart',
        description:
          'Apply changes to server/ or shared/ with a verified core swap. Not needed for web/, extensions/, or agents/.',
        parameters: Type.Object({}),
        replay: 'safe',
        async execute(_args, api, context) {
          const key = `restart:${api.taskId}`
          const done = await api.memo<{ generation: number; build: string }>(key, context)
          if (done)
            return {
              content: [
                {
                  type: 'text',
                  text: `Restarted. Now running generation ${process.env.ULTIMATE_GENERATION ?? done.generation} (pid ${process.pid}), build ${done.build} → ${host.build().id}.`,
                },
              ],
            }
          const error = await awaitWithContext(
            requestSwap(async (generation) => {
              await api.memo(key, { generation, build: host.build().id }, context)
            }, host.build()),
            context,
          )
          return { isError: true, content: [{ type: 'text', text: error }] }
        },
      }),
    ],
  })
