import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { acquireLock } from './lock.ts'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import { UiState } from './ui-state.ts'
import type {
  ConversationId,
  EnvTarget,
  Extension,
  HarnessSettings,
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
  repoRoot: string
  home?: string
  faux?: boolean
  report?: (notice: Notice) => void
}
export async function prepareHarness(options: HostOptions) {
  const { repoRoot } = options
  const builds = createBuild(repoRoot)
  const home = options.home ?? process.env.ULTIMATE_HOME ?? join(homedir(), '.ultimate')
  await mkdir(home, { recursive: true })
  const database = join(home, 'state.sqlite')
  const modelRuntime = await ModelRuntime.create()
  const settings = SettingsManager.create(repoRoot)
  applyHttpProxySettings(settings.getGlobalSettings().httpProxy)
  configureHttpDispatcher(settings.getHttpIdleTimeoutMs())
  const registry = createRegistry()
  const extensionOrders = new Map<string, number>()
  const envs = new Map<string, NodeExecutionEnv>()
  const env = ({ cwd = repoRoot }: EnvTarget) => {
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
    const scratch = join(home, 'demo.txt')
    const shellPath = "'" + scratch.replaceAll("'", "'\\''") + "'"
    await writeFile(scratch, 'before\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const demo: FauxResponseFactory = (transcript) => {
      faux.appendResponses([demo])
      const last = transcript.messages.findLast((message) => message.role !== 'system')
      if (last?.role === 'user' && last.content === 'delegate to scout') {
        return fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              action: 'start',
              agent: 'scout',
              task: 'Return the word SCOUT.',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'user' && last.content === 'Return the word SCOUT.') {
        return fauxAssistantMessage([fauxText('SCOUT')])
      }
      if (last?.role === 'toolResult' && last.toolName === 'subagent') {
        return fauxAssistantMessage([
          fauxText(last.content.map((block) => (block.type === 'text' ? block.text : '')).join('')),
        ])
      }
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content === 'codemode demo'
      ) {
        return fauxAssistantMessage(
          [
            fauxToolCall('codemode', {
              code: `const source = await tools.read({ path: ${JSON.stringify(scratch)} }); text(source); return await tools.bash({ command: "echo codemode; sleep 0.3" });`,
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'toolResult' && last.toolName === 'codemode') {
        return fauxAssistantMessage([fauxText('Codemode demo complete.')])
      }
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content === 'restart yourself'
      ) {
        return fauxAssistantMessage([fauxToolCall('restart', {})], { stopReason: 'toolUse' })
      }
      if (last?.role === 'toolResult' && last.toolName === 'restart') {
        return fauxAssistantMessage([
          fauxText(last.content.map((block) => (block.type === 'text' ? block.text : '')).join('')),
        ])
      }
      if (last?.role === 'toolResult' && last.toolName === 'bash') {
        return fauxAssistantMessage(
          [fauxToolCall('edit', { path: scratch, oldText: 'before', newText: 'after' })],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'toolResult') {
        return fauxAssistantMessage([
          fauxText(
            '## Complete\n\nThe scratch file was updated.\n\n```ts\nconsole.log("Ultimate")\n```',
          ),
        ])
      }
      return fauxAssistantMessage(
        [
          fauxThinking('I will demonstrate a streamed shell command and a file edit.'),
          fauxToolCall('bash', {
            command: `printf 'before\\n' > ${shellPath}; echo starting; sleep 0.3; echo finished`,
          }),
        ],
        { stopReason: 'toolUse' },
      )
    }
    faux.setResponses([demo])
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
    repoRoot,
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
            cwd: repoRoot,
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
