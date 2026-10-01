import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { arch, cpus, freemem, hostname, platform, release, totalmem, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { relative } from 'node:path'
import { getAgentDir, loadProjectContextFiles, loadSkills } from '@earendil-works/pi-coding-agent'
import type { ViteDevServer } from 'vite-plus'
import type { ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { PreparedHost } from './harness.ts'

const run = promisify(execFile)
async function bytes(path: string) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
export async function createSystem(
  host: PreparedHost,
  vite: ViteDevServer,
  url: string,
  registry: () => ExtensionInfo[],
  emit: (info: SystemInfo) => void,
) {
  const startedAt = new Date().toISOString()
  const agentDir = getAgentDir()
  let coreStale = false
  let code: SystemInfo['code'] = { repoRoot: host.repoRoot, branch: '', sha: '', dirty: false }
  let value: SystemInfo
  let previous = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastGit = 0
  let closed = false
  let chain = Promise.resolve()
  async function refresh(git = false) {
    if (git) {
      const command = async (args: string[]) => {
        try {
          return (await run('git', args, { cwd: host.repoRoot })).stdout.trim()
        } catch {
          return ''
        }
      }
      code = {
        repoRoot: host.repoRoot,
        branch: await command(['branch', '--show-current']),
        sha: await command(['rev-parse', '--short', 'HEAD']),
        dirty: (await command(['status', '--porcelain'])).length > 0,
        coreStale,
      }
      lastGit = Date.now()
    }
    const cpu = cpus()
    value = {
      machine: {
        hostname: hostname(),
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpu[0]?.model ?? '',
        cpuCount: cpu.length,
        totalMemory: totalmem(),
        freeMemory: freemem(),
        user: userInfo().username,
      },
      process: {
        pid: process.pid,
        node: process.version,
        startedAt,
        generation: Number(process.env.ULTIMATE_GENERATION ?? 1),
        url,
      },
      persistence: {
        kind: 'sqlite',
        path: host.database,
        sizeBytes: await bytes(host.database),
        walBytes: await bytes(host.database + '-wal'),
      },
      execution: { kind: 'node-local', defaultCwd: host.repoRoot },
      code,
      extensions: registry(),
      skills: loadSkills({
        cwd: host.repoRoot,
        agentDir,
        skillPaths: host.settings.getSkillPaths(),
        includeDefaults: true,
      }).skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
      })),
      contextFiles: loadProjectContextFiles({ cwd: host.repoRoot, agentDir }).map(
        (file) => file.path,
      ),
      agents: [],
    }
    const json = JSON.stringify(value)
    if (json !== previous) {
      previous = json
      emit(value)
    }
  }
  const schedule = (_event?: string, path?: string | null) => {
    if (path && /^(server|shared)\//.test(relative(host.repoRoot, path))) {
      coreStale = true
      code.coreStale = true
    }
    if (closed || timer) return
    timer = setTimeout(
      () => {
        timer = undefined
        chain = chain.then(() => refresh(true))
      },
      Math.max(100, 2000 - (Date.now() - lastGit)),
    )
  }
  const storageWatcher = watch(host.home, schedule)
  vite.watcher.add(host.repoRoot)
  vite.watcher.on('all', schedule)
  await refresh(true)
  return {
    current: () => value,
    changed() {
      if (!closed) chain = chain.then(() => refresh())
      return chain
    },
    async close() {
      closed = true
      clearTimeout(timer)
      vite.watcher.off('all', schedule)
      storageWatcher.close()
      await chain
    },
  }
}
