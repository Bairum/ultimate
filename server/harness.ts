import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { projectHome } from './project.ts'
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
import { projectSkills } from './skills.ts'
import { requestSwap } from './supervisor-protocol.ts'
import type {
  ConversationId,
  EnvTarget,
  Extension,
  HarnessSettings,
  ModelRef,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createBuild } from './build.ts'
import { applyHttpProxySettings, configureHttpDispatcher } from './http.ts'
import type { Notice } from '../shared/protocol.ts'

export { context }
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
      return settings.getCompactionSettings()
    },
    get retry() {
      return settings.getRetrySettings()
    },
    get steeringMode() {
      return settings.getSteeringMode()
    },
    get followUpMode() {
      return settings.getFollowUpMode()
    },
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
  const modelRuntime = await ModelRuntime.create()
  const settings = SettingsManager.create(projectRoot)
  applyHttpProxySettings(settings.getGlobalSettings().httpProxy)
  configureHttpDispatcher(settings.getHttpIdleTimeoutMs())
  const registry = createRegistry()
  const extensionOrders = new Map<string, number>()
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
  let fauxHandle: ReturnType<typeof fauxProvider> | undefined
  let models: Parameters<typeof Harness.open>[1]['models'] = modelRuntime
  if (fauxMode) {
    const collection = createModels()
    const faux = fauxProvider({ tokensPerSecond: 350 })
    fauxHandle = faux
    collection.setProvider(faux.provider)
    models = collection
  }
  const available = fauxMode ? [] : await modelRuntime.getAvailable()
  const preferred =
    available.find(
      (m) => m.provider === settings.getDefaultProvider() && m.id === settings.getDefaultModel(),
    ) ?? available[0]
  let active: { harness: Harness; root: { id: ConversationId } } | undefined
  return {
    async uiState(caller: Context) {
      if (!active) throw new Error('Harness is not open')
      return (await active.harness.snapshot(UiState, active.root.id, caller)) ?? {}
    },
    models: async () => (await listModels(modelRuntime, fauxHandle)).models,
    model: (ref: ModelRef) => models.getModel(ref.provider, ref.modelId),
    skills: (cwd: string) => projectSkills({ projectRoot, userHome, settings }, cwd),
    restart: (approved: (generation: number) => Promise<void>) =>
      requestSwap(approved, builds.current()),
    ultimateRoot,
    projectRoot,
    userHome,
    builds,
    build: builds.current,
    home,
    database,
    modelRuntime,
    settings,
    registry,
    extensionOrders,
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
                .toSorted(
                  (a, b) =>
                    (extensionOrders.get(a.name) ?? 0) - (extensionOrders.get(b.name) ?? 0) ||
                    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
                ),
            ),
            env,
            onReport: (error) => options.report?.({ level: 'error', message: String(error) }),
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
        active = { harness, root }
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
