import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent'
import {
  defineDoc,
  defineEntry,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { isolatable } from '../workspaces/git.ts'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'
import { save, updateSettings } from './settings.ts'
import type { SubagentsService } from '../subagents/server.ts'
import type { LineageService } from '../lineage/server.ts'
import type { WorkspaceService } from '../workspaces/server.ts'

export const Starts = defineDoc<{ roots: Record<string, number> }>({
  kind: 'onboarding.starts',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: {} }),
})
const ChoiceRequests = defineDoc<{ payloads: Record<string, JsonObject> }>({
  kind: 'onboarding.choice-requests',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ payloads: {} }),
})
export const docs = [Starts]
export const StartEntry = defineEntry<{
  root: number
  instructions?: string
  facts: {
    project: { name: string; path: string }
    firstRun: boolean
    projectUndecided: boolean
    gitReason?: string
    root: number
    rootEmpty: boolean
  }
}>('onboarding.start')

function lists(value: JsonObject) {
  const extensions = value.extensions ?? {}
  if (typeof extensions !== 'object' || Array.isArray(extensions))
    throw new Error('extensions must be a JSON object')
  const result = extensions
  for (const key of ['enable', 'disable']) {
    const names = result[key]
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    )
      throw new Error(`extensions.${key} must be an array of names`)
  }
  value.extensions = result
  return result
}
function toggle(extensions: JsonObject, name: string, enabled: boolean) {
  const key = enabled ? 'enable' : 'disable'
  const opposite = enabled ? 'disable' : 'enable'
  extensions[key] = [...new Set([...((extensions[key] as string[]) ?? []), name])]
  if (extensions[opposite] !== undefined)
    extensions[opposite] = (extensions[opposite] as string[]).filter((entry) => entry !== name)
}
/** Names of the project's own agents and skills, read but never loaded, so an undecided project can show them. */
async function adds(projectRoot: string) {
  const directory = join(projectRoot, '.ultimate/agents')
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  const agents = await Promise.all(
    files
      .filter((file) => file.endsWith('.md'))
      .toSorted()
      .map(async (file) => {
        try {
          const { name } = parseFrontmatter(
            await readFile(join(directory, file), 'utf8'),
          ).frontmatter
          if (typeof name === 'string' && name.trim()) return name.trim()
        } catch {
          // An invalid definition still shows by its file name; the subagents extension reports the error.
        }
        return basename(file, '.md')
      }),
  )
  const skills = loadSkillsFromDir({
    dir: join(projectRoot, '.ultimate/skills'),
    source: 'project',
  })
    .skills.map((skill) => skill.name)
    .toSorted()
  return { agents, skills, ...(await declared(join(projectRoot, '.ultimate/settings.json'))) }
}

const names = (value: unknown) =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []

/**
 * The extension names a settings file enables and disables, read only to show them: a project's settings apply once
 * the project is chosen, so the host's gated settings are empty until then.
 */
async function declared(path: string) {
  try {
    const { extensions } = JSON.parse(await readFile(path, 'utf8')) as {
      extensions?: { enable?: unknown; disable?: unknown }
    }
    return { enable: names(extensions?.enable), disable: names(extensions?.disable) }
  } catch {
    return { enable: [], disable: [] }
  }
}

const marker = (userHome: string) => join(userHome, '.ultimate/onboarding.json')

export const userActions = [
  'start',
  'choose',
  'decide',
  'setExtension',
  'adoptProjectSetup',
  'applyFirstRun',
  'firstRunDone',
]

export const actions: Record<string, ExtensionAction> = {
  start: async (args, { host, conversationId }) => {
    const input = args as { root?: number; instructions?: string } | null
    if (
      input !== null &&
      (typeof input !== 'object' ||
        Array.isArray(input) ||
        (input.root !== undefined && (!Number.isSafeInteger(input.root) || input.root < 1)) ||
        (input.instructions !== undefined && typeof input.instructions !== 'string'))
    )
      throw new Error('Expected root id and optional instructions')
    const lineage = host.use<LineageService>('lineage')
    const root =
      input?.root ??
      (conversationId === undefined ? undefined : await lineage?.rootOf(conversationId, context)) ??
      1
    const harness = host.harness()
    const existing = (await harness.snapshot(Starts, ROOT_CONVERSATION_ID, context))?.roots[
      String(root)
    ]
    if (existing !== undefined) return { id: existing }
    if (!lineage || (await lineage.rootOf(root, context)) !== root)
      throw new Error('Expected a project root')
    const service = host.use<SubagentsService>('subagents')
    if (!service) throw new Error('Subagents are required for onboarding')
    const id = await service.standing('ultimate', context)
    const project = await host.projectSetup()
    const checkout = await isolatable(host.projectRoot)
    const facts = {
      project: { name: basename(host.projectRoot), path: host.projectRoot },
      firstRun: !existsSync(marker(host.userHome)),
      projectUndecided: project.config && project.decision === null,
      ...('reason' in checkout ? { gitReason: checkout.reason } : {}),
      root,
      rootEmpty: await harness.commit(
        async (tx) =>
          !(await tx.scanEntries({ conversationId: root as ConversationId }, 1)).items.length,
        context,
      ),
    }
    const instructions = input?.instructions
    const conversation = (await harness.conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content: [
          'Onboarding started.',
          `Project: ${facts.project.name}`,
          `Path: ${facts.project.path}`,
          `First run: ${facts.firstRun}`,
          `Project setup undecided: ${facts.projectUndecided}`,
          `Git isolation: ${facts.gitReason ?? 'ready'}`,
          `Root: ${root}; empty: ${facts.rootEmpty}`,
          ...(instructions === undefined ? [] : [`User instructions:\n${instructions}`]),
        ].join('\n'),
        entry: {
          kind: StartEntry.kind,
          data: { root, ...(instructions === undefined ? {} : { instructions }), facts },
        },
        requestId: `onboarding:${root}`,
        whenBusy: 'followUp',
      },
      context,
    )
    await harness.commit(async (tx) => {
      ;(await tx.doc(Starts, ROOT_CONVERSATION_ID)).roots[String(root)] = id
    }, context)
    return { id }
  },
  choose: async (args, actionContext) => {
    const { host, conversationId } = actionContext
    if (conversationId === undefined) throw new Error('A conversation is required')
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      typeof args.toolCallId !== 'string' ||
      !args.toolCallId.trim()
    )
      throw new Error('Expected card and toolCallId')
    const { card, toolCallId } = args
    let payload: JsonObject
    let summary: string
    if (card === 'extensions') {
      const choices = args.extensions
      if (
        !choices ||
        typeof choices !== 'object' ||
        Array.isArray(choices) ||
        Object.entries(choices).some(
          ([name, enabled]) => !name.trim() || typeof enabled !== 'boolean',
        )
      )
        throw new Error('Expected extensions as names to booleans')
      const extensions = Object.fromEntries(
        Object.entries(choices).toSorted(([a], [b]) => a.localeCompare(b)),
      )
      payload = { card, extensions }
      const namesFor = (enabled: boolean) =>
        Object.keys(extensions)
          .filter((name) => extensions[name] === enabled)
          .join(', ') || 'none'
      summary = `enabled ${namesFor(true)}; disabled ${namesFor(false)}`
    } else if (card === 'project' && typeof args.local === 'boolean') {
      payload = { card, local: args.local }
      summary = args.local ? 'Using project setup' : 'Keeping global setup'
    } else if (card === 'git' && typeof args.initialize === 'boolean') {
      payload = { card, initialize: args.initialize }
      summary = args.initialize
        ? 'Git is ready'
        : 'Let @ultimate set up Git: write a project-appropriate .gitignore and make the first commit without secrets, dependencies, build output or generated files. Do not add a remote or push.'
    } else throw new Error('Expected extensions, project with local, or git with initialize')
    // Keep competing tabs serialized through settings reloads, including the gap before submit.
    const queue = host.resource('onboarding.choose', () => ({ tail: Promise.resolve() }))
    const operation = queue.tail.then(async () => {
      const harness = host.harness()
      const id = conversationId as ConversationId
      const requestId = `onboarding-choice:${toolCallId}`
      const existing = await harness.commit((tx) => tx.submissionByRequest(id, requestId), context)
      if (existing) {
        const saved = (await harness.snapshot(ChoiceRequests, id, context))?.payloads[toolCallId]
        if (JSON.stringify(saved) !== JSON.stringify(payload))
          throw new Error('This setup card already has a different choice')
      }
      const conversation = await harness.conversation(id, context)
      if (!conversation) throw new Error('Conversation not found')
      if (!existing) {
        if (card === 'extensions')
          await actions.applyFirstRun({ extensions: payload.extensions! }, actionContext)
        else if (card === 'project') await actions.decide({ local: payload.local! }, actionContext)
        else if (payload.initialize) {
          const workspaces = host.use<WorkspaceService>('workspaces')
          if (!workspaces) throw new Error('Git setup requires workspaces')
          await workspaces.setupGit()
        }
        // Persist the payload before admission: queued submissions have no transcript entry yet.
        await harness.commit(async (tx) => {
          ;(await tx.doc(ChoiceRequests, id)).payloads[toolCallId] = payload
        }, context)
      }
      await conversation.submit(
        {
          type: 'input',
          content: `Setup choice (${card}): ${summary}`,
          entry: { kind: ChoiceEntry.kind, data: { card, summary, toolCallId } },
          requestId,
          whenBusy: 'followUp',
        },
        context,
      )
      return { sent: true }
    })
    queue.tail = operation.then(
      () => {},
      () => {
        // This caller receives its failure; the next choice must still be able to retry.
      },
    )
    return operation
  },
  status: async (_args, { host }) => {
    const folders = await host.projectExtensions()
    return {
      firstRun: !existsSync(marker(host.userHome)),
      project: await host.projectSetup(),
      // The user's own lists, for the first run's checkboxes.
      user: await declared(join(host.userHome, '.ultimate/settings.json')),
      adds: {
        ...(await adds(host.projectRoot)),
        extensions: folders.filter((entry) => !entry.replaces).map((entry) => entry.name),
        replaces: folders.filter((entry) => entry.replaces).map((entry) => entry.name),
      },
    }
  },
  firstRunDone: async (_args, { host }) => {
    await save(marker(host.userHome), { firstRunDone: true })
    return { firstRun: false }
  },
  /**
   * The first run's choices in one step: checked names join the user's `extensions.enable` (and leave `disable`),
   * unchecked names join `disable`; `local`, when given, is the project decision. Records the first run, then applies
   * it all with one reload.
   */
  applyFirstRun: async (args, { host }) => {
    const choices =
      args && typeof args === 'object' && !Array.isArray(args) ? args.extensions : undefined
    if (
      !choices ||
      typeof choices !== 'object' ||
      Array.isArray(choices) ||
      Object.entries(choices).some(
        ([name, enabled]) => !name.trim() || typeof enabled !== 'boolean',
      ) ||
      ((args as JsonObject).local !== undefined && typeof (args as JsonObject).local !== 'boolean')
    )
      throw new Error(
        'Expected extensions as non-empty names to booleans, and local as a boolean if given',
      )
    const { local } = args as { local?: boolean }
    await updateSettings(join(host.userHome, '.ultimate/settings.json'), (value) => {
      const extensions = lists(value)
      for (const [name, enabled] of Object.entries(choices as Record<string, boolean>))
        toggle(extensions, name, enabled)
    })
    await save(marker(host.userHome), { firstRunDone: true })
    if (local === undefined) await host.reloadExtensions()
    else await host.setProjectDecision(local)
    return { firstRun: false }
  },
  decide: async (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.local !== 'boolean')
      throw new Error('local must be a boolean')
    await host.setProjectDecision(args.local)
    return { project: await host.projectSetup() }
  },
  setExtension: async (args, { host }) => {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      typeof args.name !== 'string' ||
      !args.name.trim() ||
      typeof args.enabled !== 'boolean' ||
      (args.scope !== 'project' && args.scope !== 'user')
    )
      throw new Error('Expected name, enabled boolean, and scope project or user')
    if (args.scope === 'project' && (await host.projectSetup()).decision !== true)
      throw new Error("Choose this project's local setup before changing project extensions")
    const path = join(
      args.scope === 'project' ? host.projectRoot : host.userHome,
      '.ultimate/settings.json',
    )
    await updateSettings(path, (value) =>
      toggle(lists(value), args.name as string, args.enabled as boolean),
    )
    await host.reloadExtensions()
    return { ok: true }
  },
  adoptProjectSetup: async (_args, { host }) => {
    if ((await host.projectSetup()).decision !== true)
      throw new Error("Choose this project's local setup before adopting project extensions")
    const project = lists(await host.projectSettings())
    if (
      !(project.enable as string[] | undefined)?.length &&
      !(project.disable as string[] | undefined)?.length
    )
      return { ok: true }
    const path = join(host.userHome, '.ultimate/settings.json')
    await updateSettings(path, (value) => {
      const extensions = lists(value)
      for (const [key, enabled] of [
        ['enable', true],
        ['disable', false],
      ] as const)
        for (const name of (project[key] as string[]) ?? []) toggle(extensions, name, enabled)
    })
    await host.reloadExtensions()
    return { ok: true }
  },
  extensions: async (_args, { host }) => {
    const project = await host.projectExtensions()
    return Promise.all(
      [
        ...host
          .extensions()
          .filter((entry) => !project.some((folder) => folder.name === entry.name)),
        ...project,
      ].map(async (entry) => {
        const readme = await readFile(join(entry.path, 'README.md'), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return ''
          },
        )
        const paragraph =
          readme
            .replace(/^#+ .*\n+/u, '')
            .trim()
            .split(/\n\s*\n/u)[0] ?? ''
        return {
          name: entry.name,
          source: entry.source,
          ...(entry.replaces ? { replaces: entry.replaces } : {}),
          enabled: entry.enabled,
          layer: entry.layer,
          readme: paragraph.match(/^.*?[.!?](?:\s|$)/su)?.[0].trim() ?? paragraph,
        }
      }),
    )
  },
}

export const ChoiceEntry = defineEntry<{ card: string; summary: string; toolCallId: string }>(
  'onboarding.choice',
)

export default function onboarding(host: ExtensionHost) {
  return defineExtension({
    name: 'onboarding',
    tools: [
      defineTool({
        name: 'setup',
        deferred: true,
        description:
          'Show an inline setup card for the user to choose. Wait for the onboarding.choice input; only the user can apply choices.',
        parameters: Type.Object({
          card: Type.Union([
            Type.Literal('extensions'),
            Type.Literal('project'),
            Type.Literal('git'),
          ]),
        }),
        // Read-only inspection: repeating a card changes no state.
        replay: 'safe',
        async execute({ card }) {
          const project = await host.projectSetup()
          if (card === 'project' && (!project.config || project.decision !== null))
            throw new Error(
              !project.config
                ? 'This project has no .ultimate/ setup'
                : 'Project setup is already decided',
            )
          const checkout = card === 'git' ? await isolatable(host.projectRoot) : undefined
          if (checkout && !('reason' in checkout))
            throw new Error('This folder is already isolatable')
          const text =
            card === 'git' && checkout && 'reason' in checkout
              ? checkout.reason
              : card === 'project'
                ? `Project has a .ultimate/ setup; undecided. ${JSON.stringify(await adds(host.projectRoot))}`
                : 'Choose recommended extensions. Settings apply only when the user continues.'
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
