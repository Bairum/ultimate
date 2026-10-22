import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { projectHome } from './project.ts'
import type { Source } from './project.ts'
import { compareExtensions } from './discovery.ts'
import { acquireLock } from './lock.ts'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import { UiState } from './ui-state.ts'
import { listModels } from './models.ts'
import { guardToolArguments, modelTrace } from './tool-arguments.ts'
import { callTrace } from './trace.ts'
import { projectSkills } from './skills.ts'
import { requestSwap } from './supervisor-protocol.ts'
import type {
  ConversationId,
  Cursor,
  EnvTarget,
  Extension,
  HarnessSettings,
  ModelRef,
  ReportInfo,
  CompactionPolicy,
  Page,
  SubmissionQuery,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createBuild } from './build.ts'
import { applyHttpProxySettings, configureHttpDispatcher } from './http.ts'
import type { Notice } from '../shared/protocol.ts'

export { context }

/** A notice of a Pi Durable report, led by what failed: the task and conversation, extension or host callback. */
export function reportMessage(error: unknown, info: ReportInfo): string {
  const parts: string[] = []
  if ('task' in info && info.task)
    parts.push(`task #${info.task.id} (${info.task.kind}) in #${info.task.conversationId}`)
  else if ('conversationId' in info && info.conversationId !== undefined)
    parts.push(`#${info.conversationId}`)
  if ('extension' in info && info.extension) parts.push(`extension ${info.extension}`)
  if (info.type === 'host_error') parts.push(`host callback ${info.callback}`)
  const reason = 'reason' in info ? ` (${info.reason.replaceAll('_', ' ')})` : ''
  const about = parts.length > 0 ? `: ${parts.join(', ')}` : ''
  return `${info.type.replaceAll('_', ' ')}${reason}${about}. ${String(error)}`
}

/**
 * Compaction per model, from its context window and answer size, over Pi's defaults (reserve 16k, keep 20k, background
 * 32k), which suit a ~200k window. Larger windows keep more room for the answer, more recent context verbatim, and
 * start the background compaction earlier, so a long turn rarely waits on a blocking one. A `compaction.modelOverrides`
 * entry in Pi's settings files replaces these field by field.
 */
const large = { reserveTokens: 32768, keepRecentTokens: 60000, backgroundTokens: 131072 }
export const compactionOverrides: Record<string, Partial<CompactionPolicy>> = {
  // 128k window, 16k answers: start in the background at ~80k.
  'faux/faux-1': { reserveTokens: 16384, keepRecentTokens: 16000, backgroundTokens: 32768 },
  // 500k window, 128k answers: blocking at ~467k, background from ~400k.
  'openai-codex/gpt-6.1-sol': {
    reserveTokens: 32768,
    keepRecentTokens: 40000,
    backgroundTokens: 65536,
  },
  // 1M windows, 128k answers: blocking at ~967k, background from ~836k.
  'claude-code/default': large,
  'claude-code/claude-opus-5-5': large,
  'claude-code/claude-fable-5-1': large,
  'claude-code/claude-sonnet-5': large,
  'claude-code/claude-sonnet-5-5': large,
  'claude-code/claude-haiku-5-5': large,
  // claude-code/claude-haiku-4-5-20251001 has a 200k window: Pi's defaults fit.
}

export function createHarnessSettings(
  settings: SettingsManager,
  extensions: () => Extension[],
): HarnessSettings {
  return {
    get extensions() {
      return extensions()
    },
    get stream() {
      const provider = settings.getProviderRetrySettings()
      const idle = settings.getHttpIdleTimeoutMs()
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      }
    },
    get compaction() {
      const configured = settings.getSettings().compaction?.modelOverrides ?? {}
      const modelOverrides = { ...compactionOverrides }
      for (const [model, entry] of Object.entries(configured))
        modelOverrides[model] = { ...modelOverrides[model], ...entry }
      return { ...settings.getCompactionSettings(), modelOverrides }
    },
    get retry() {
      return settings.getRetrySettings()
    },
    get steeringMode() {
      return settings.getSteeringMode()
    },
    // Every follow-up queued while a run works starts the next run together, whatever Pi's one-at-a-time default.
    followUpMode: 'all',
  }
}
export interface HostOptions {
  ultimateRoot: string
  projectRoot?: string
  userHome?: string
  home?: string
  faux?: boolean
  report?: (notice: Notice) => void
}
export async function prepareHarness(options: HostOptions) {
  const { ultimateRoot } = options
  const projectRoot = await realpath(options.projectRoot ?? ultimateRoot)
  const userHome = options.userHome ?? homedir()
  const builds = createBuild(ultimateRoot)
  const home = options.home ?? process.env.ULTIMATE_HOME ?? projectHome(projectRoot, userHome)
  await mkdir(home, { recursive: true })
  const database = join(home, 'state.sqlite')
  const runtime = await ModelRuntime.create()
  const settings = SettingsManager.create(projectRoot)
  applyHttpProxySettings(settings.getGlobalSettings().httpProxy)
  configureHttpDispatcher(settings.getHttpIdleTimeoutMs())
  const registry = createRegistry()
  const extensionOrders = new Map<string, number>()
  const extensionSources = new Map<string, Source>()
  const envs = new Map<string, NodeExecutionEnv>()
  const env = ({ cwd = projectRoot }: EnvTarget) => {
    let found = envs.get(cwd)
    if (!found) {
      found = new NodeExecutionEnv({ cwd })
      envs.set(cwd, found)
    }
    return found
  }
  const fauxMode = options.faux ?? process.env.ULTIMATE_FAUX === '1'
  // Here, not with the extensions: model calls are traced through the models the harness opens with, and through the
  // runtime extensions call directly (health's pings), so `modelRuntime` below is the guarded one too.
  const trace = callTrace(join(home, 'trace.sqlite'))
  const modelCalls = modelTrace(trace)
  registry.install(modelCalls.extension)
  const modelRuntime = guardToolArguments(runtime, modelCalls)
  let fauxHandle: ReturnType<typeof fauxProvider> | undefined
  let models: Parameters<typeof Harness.open>[1]['models'] = modelRuntime
  if (fauxMode) {
    const collection = createModels()
    const faux = fauxProvider({ tokensPerSecond: 350 })
    fauxHandle = faux
    collection.setProvider(faux.provider)
    models = guardToolArguments(collection, modelCalls)
  }
  const available = fauxMode ? [] : await modelRuntime.getAvailable()
  const preferred =
    available.find(
      (m) => m.provider === settings.getDefaultProvider() && m.id === settings.getDefaultModel(),
    ) ?? available[0]
  let active:
    | {
        harness: Harness
        root: { id: ConversationId }
        storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>
      }
    | undefined
  return {
    async uiState(caller: Context) {
      if (!active) throw new Error('Harness is not open')
      return (await active.harness.snapshot(UiState, active.root.id, caller)) ?? {}
    },
    /** Committed submission records; exists until Pi Durable exposes submission scans publicly. */
    scanSubmissions(
      query: SubmissionQuery,
      limit: number,
      cursor: Cursor | undefined,
      caller: Context,
    ): Promise<Page<SubmissionRecord, Cursor>> {
      if (!active) throw new Error('Harness is not open')
      return active.storage.scanSubmissions(query, limit, cursor, caller)
    },
    models: async () => (await listModels(modelRuntime, fauxHandle)).models,
    model: (ref: ModelRef) => models.getModel(ref.provider, ref.modelId),
    skills: (cwd: string) => projectSkills({ ultimateRoot, projectRoot, userHome }, cwd),
    restart: (approved: (generation: number) => Promise<void>) =>
      requestSwap(approved, builds.current()),
    ultimateRoot,
    projectRoot,
    userHome,
    builds,
    build: builds.current,
    home,
    database,
    /** The call trace of this home, which extensions read as `host.trace`; open while the harness is. */
    callTrace: trace,
    modelRuntime,
    settings,
    registry,
    extensionOrders,
    extensionSources,
    faux: fauxHandle,
    async open(resume = true) {
      const owner = await acquireLock(
        join(home, 'storage.lock'),
        { pid: process.pid },
        process.env.ULTIMATE_SUPERVISED === '1' ? 10000 : 0,
      )
      let harness: Harness | undefined
      let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined
      try {
        // An interrupted `pnpm reset` or `pnpm restore` left the home half moved: no path opens it until it finishes.
        if (existsSync(join(home, 'reset.json')))
          throw new Error(
            `A reset or restore of ${home} was interrupted; rerun pnpm reset or pnpm restore`,
          )
        storage = await openNodeSqliteStorage(database)
        harness = await Harness.open(
          storage,
          {
            models,
            registry,
            settings: createHarnessSettings(settings, () =>
              registry
                .snapshot()
                .installed()
                .toSorted((a, b) =>
                  compareExtensions(
                    {
                      name: a.name,
                      source: extensionSources.get(a.name) ?? 'builtin',
                      order: extensionOrders.get(a.name),
                    },
                    {
                      name: b.name,
                      source: extensionSources.get(b.name) ?? 'builtin',
                      order: extensionOrders.get(b.name),
                    },
                  ),
                ),
            ),
            env,
            onReport: (error, info) =>
              options.report?.({ level: 'error', message: reportMessage(error, info) }),
          },
          context,
        )
        const root = await harness.root(context, {
          agent: {
            cwd: projectRoot,
            ...(fauxMode
              ? { model: { provider: 'faux', modelId: 'faux-1' } }
              : preferred
                ? { model: { provider: preferred.provider, modelId: preferred.id } }
                : {}),
            thinkingLevel: settings.getDefaultThinkingLevel(),
          },
        })
        await root.commit(async (tx) => {
          await tx.doc(UiState, root.id)
        }, context)
        active = { harness, root, storage }
        const openedHarness = harness
        if (resume) openedHarness.resume()
        return {
          harness: openedHarness,
          root,
          async close() {
            active = undefined
            await openedHarness.close(context)
            for (const execution of envs.values()) await execution.cleanup(context)
            envs.clear()
            await owner.close()
          },
        }
      } catch (error) {
        active = undefined
        if (harness) await harness.close(context)
        else await storage?.close(context)
        await owner.close()
        throw error
      }
    },
  }
}
export type PreparedHost = Awaited<ReturnType<typeof prepareHarness>>
export type OpenHost = Awaited<ReturnType<PreparedHost['open']>>
