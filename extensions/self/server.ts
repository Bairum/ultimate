import { realpath } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { workspaces } from '../workspaces/workspaces.ts'
import { git } from '../workspaces/git.ts'

export default function self(host: ExtensionHost) {
  const service = workspaces(host)
  return defineExtension({
    name: 'self',
    sections: [
      section('self', async (input, context) => {
        const own = await service.get(input.conversationId, context)
        const cwd = input.env?.cwd ?? input.agent.cwd ?? host.projectRoot
        const sourceRoot =
          own && host.projectRoot === host.ultimateRoot ? own.path : host.ultimateRoot
        return [
          `Project (your work): ${cwd}`,
          `Host project: ${host.projectRoot}`,
          `Ultimate (running host): ${host.ultimateRoot}`,
          ...(host.projectRoot === host.ultimateRoot
            ? ['The host project is Ultimate itself.']
            : []),
          `Direct project edits to ${cwd}; project-specific extensions, agents, skills, and surfaces belong in ${cwd}/.ultimate/.`,
          `The running host loads project config and extensions from ${host.projectRoot}/.ultimate/ and built-ins from ${host.ultimateRoot}/extensions/. These are host-scoped, not switched by your work cwd.`,
          `Before changing Ultimate, read ${sourceRoot}/AGENTS.md (layers, reloads, durability) and ${sourceRoot}/extensions/README.md (new UI is a new extension folder).`,
          'UI and extension changes in the running host reload live. Call restart only after editing server/ or shared/, never for web/, extensions/, or agents/.',
          ...(own
            ? [
                `Land your workspace into ${own.source} first; restart requires the running clone to be clean at that landed commit.`,
              ]
            : []),
        ].join('\n')
      }),
    ],
    tools: [
      defineTool({
        name: 'restart',
        description:
          'Restart the shared Ultimate host after authorized changes to server/ or shared/. Land an isolated workspace into the running clone first.',
        parameters: Type.Object({}),
        replay: 'safe',
        async execute(_args, api, context): Promise<ToolExecutionResult> {
          const own = await service.get(api.conversationId, context)
          if (
            own &&
            ((await realpath(own.source)) !== (await realpath(host.ultimateRoot)) ||
              !own.landed ||
              (await git(host.ultimateRoot, 'status', '--porcelain')) ||
              (await git(host.ultimateRoot, 'rev-parse', 'HEAD')) !== own.landed)
          ) {
            const error = `Restart refused: land your workspace into ${own.source} first`
            return {
              isError: true,
              details: { refused: true, error },
              content: [{ type: 'text', text: error }],
            }
          }
          const key = `restart:${api.taskId}`
          const done = await api.memo<{
            generation: number
            fromGeneration: number
            build: string
          }>(key, context)
          if (done && Number(process.env.ULTIMATE_GENERATION) !== done.generation)
            return {
              isError: true,
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: Number(process.env.ULTIMATE_GENERATION),
                fromBuild: done.build,
                toBuild: host.build().id,
                rolledBack: true,
                error: host.system().process.activationError ?? 'Activation failed',
              },
              content: [
                {
                  type: 'text',
                  text: `Restart failed during activation; rolled back to generation ${process.env.ULTIMATE_GENERATION}. ${host.system().process.activationError ?? ''}`,
                },
              ],
            }
          if (done)
            return {
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: done.generation,
                fromBuild: done.build,
                toBuild: host.build().id,
              },
              content: [
                {
                  type: 'text',
                  text: `Restarted. Now running generation ${process.env.ULTIMATE_GENERATION ?? done.generation} (pid ${process.pid}), build ${done.build} → ${host.build().id}.`,
                },
              ],
            }
          const error = await awaitWithContext(
            host.restart(async (generation) => {
              await api.memo(
                key,
                {
                  generation,
                  fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
                  build: host.build().id,
                },
                context,
              )
            }),
            context,
          )
          return {
            isError: true,
            details: {
              fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              toGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              fromBuild: host.build().id,
              toBuild: host.build().id,
              error,
            },
            content: [{ type: 'text', text: error }],
          }
        },
      }),
    ],
  })
}
