import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

function service(host: Pick<ExtensionHost, 'workspaces'>) {
  const workspaces = host.workspaces
  if (!workspaces?.doc || !workspaces.info || !workspaces.runLifecycle)
    throw new Error(
      'workspaces requires core workspace info and lifecycle; upgrade and restart the Ultimate core before loading this facet',
    )
  return workspaces
}

const finish = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
})

function workspaceId(args: JsonValue) {
  const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected a workspace conversation id')
  return id as ConversationId
}

export const actions = {
  info(args: JsonValue, { host }: ActionContext) {
    return service(host).info(workspaceId(args), context)
  },
  land(args: JsonValue, { host, conversationId }: ActionContext) {
    const id = workspaceId(args)
    return service(host).runLifecycle((conversationId ?? id) as ConversationId, id, 'land', context)
  },
  discard(args: JsonValue, { host, conversationId }: ActionContext) {
    const id = workspaceId(args)
    if (!args || typeof args !== 'object' || Array.isArray(args) || args.confirm !== true)
      throw new Error('Confirm clean-only discard; the branch and history will be kept')
    return service(host).runLifecycle(
      (conversationId ?? id) as ConversationId,
      id,
      'discard',
      context,
    )
  },
}

export default function workspaceExtension(
  host: Pick<ExtensionHost, 'workspaces' | 'harness' | 'projectRoot'>,
) {
  const workspaces = service(host)
  if (!workspaces.createLifecycle || !workspaces.snapshot)
    throw new Error(
      'workspaces requires core workspace info and lifecycle; upgrade and restart the Ultimate core before loading this facet',
    )
  return defineExtension({
    name: 'workspaces',
    tools: [
      defineTool({
        name: 'workspace',
        description:
          'Top-level main only: inspect your workspace and live source revision, or explicitly land your verified own tip into its captured original checkout/branch. Worker landing into your workspace is only an intermediate step. No automatic update, cleanup, push or host apply.',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('status'), Type.Literal('land')]),
        }),
        replay: 'safe',
        async execute({ action }, api, caller) {
          await api.commit(async (tx) => {
            const row = await tx.conversation(api.conversationId)
            if (!row || row.owner || row.parent)
              throw new Error('Only a top-level main conversation can use the workspace tool')
          }, caller)
          if (action === 'status') {
            const workspace = await workspaces.info(api.conversationId, caller)
            return finish({
              conversationId: api.conversationId,
              workspace,
              source: workspace?.source ?? host.projectRoot,
            })
          }
          const task = await api.commit(
            (tx) =>
              workspaces.createLifecycle(
                tx,
                api.conversationId,
                api.conversationId,
                'land',
                { kind: 'task', taskId: api.taskId },
                `workspace:${api.conversationId}:${api.callId}`,
              ),
            caller,
          )
          const outcome = (await api.waitForTask(task, caller)).state.outcome
          if (outcome.status === 'completed') return finish(outcome.result)
          if (outcome.status === 'failed' || outcome.status === 'faulted')
            throw new Error(outcome.error.message)
          throw new Error('Own workspace landing was aborted')
        },
      }),
    ],
    sections: [
      section('workspace_workflow', async (input, caller) => {
        const row = await host
          .harness()
          .commit((tx) => tx.conversation(input.conversationId), caller)
        if (!row || row.owner || row.parent) return undefined
        const own = await workspaces.snapshot(input.conversationId, caller)
        const has = (name: string) => input.agent.tools?.some((tool) => tool.name === name)
        return [
          own
            ? `You are the main integration agent in workspace ${own.path}. Final destination: ${own.source}, captured branch: ${own.targetBranch ?? '(detached; landing blocked)'}. Preparation ${own.preparation}, state ${own.state}${own.landed ? `, last landed ${own.landed} (historical, not proof of current application)` : ''}.`
            : `You are the main integration agent in the shared checkout ${host.projectRoot}. There is no own workspace to land.`,
          has('subagent')
            ? 'Verify each worker report, diff and checks yourself, then use subagent land to integrate verified workers into your current checkout. Stop active work and previews before landing.'
            : 'Verify all changes and stop competing work and previews before integration.',
          own
            ? 'Worker landing into your workspace is intermediate, not Done. Review and verify the final combined committed workspace tip (checks, tests and preview where relevant), then explicitly call workspace land to fast-forward the captured original checkout/branch. Call workspace status and verify its live tip equals sourceTip and the returned landed SHA, currentBranch matches your saved workspace branch, and sourceBranch still matches targetBranch.'
            : 'After integrating all verified work, review and verify the final combined committed source revision with checks, tests and preview where relevant.',
          'If the source advanced, update the isolate onto it and reverify before retrying; never auto-rebase. Dirty, busy, diverged, detached or changed-branch destinations are blockers, not completion. Do not stop at a conversation branch unless the user requested branch-only work. Never automatically discard work, delete branches, push or deploy.',
          ...(has('restart')
            ? [
                own
                  ? 'For server/ or shared/ changes to Ultimate, only after final own landing into the actual running Ultimate checkout, deliberately call restart with applyHost: true if authorized. Core proof must still match the clean own tip, recorded landing and clean source tip on the captured branch. Other projects are not generic deployments.'
                  : 'For server/ or shared/ changes to Ultimate, deliberately call restart if authorized after final source verification; web/, extensions/ and agents/ reload without it.',
              ]
            : []),
          'Applying Ultimate affects the shared host for every conversation. Honor coordinator/user and supervisor-owned rollout restrictions: report ready or the explicit apply blocker rather than performing an unauthorized host change. Report final completion only after the requested destination is verified and any required authorized host application is verified; never claim Done at an intermediate workspace.',
        ].join('\n')
      }),
    ],
  })
}
