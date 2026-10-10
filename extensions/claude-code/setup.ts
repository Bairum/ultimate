import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { RunOptions } from './runner.ts'
import { exclusiveSlot } from '../exclusive-commands/server.ts'

export async function pluginDirectory(
  host: Pick<ExtensionHost, 'home' | 'skills'>,
  cwd: string,
  id: string,
) {
  const path = join(host.home, 'claude-code', id, 'plugin')
  await rm(path, { recursive: true, force: true })
  await mkdir(join(path, '.claude-plugin'), { recursive: true })
  await mkdir(join(path, 'skills'))
  await writeFile(
    join(path, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'ultimate', version: '1.0.0' }),
  )
  for (const skill of host.skills(cwd))
    await symlink(dirname(skill.filePath), join(path, 'skills', skill.name), 'dir')
  return path
}

export async function promptAppend(cwd: string, instructions: string, conversation: number) {
  const agents =
    !existsSync(join(cwd, 'CLAUDE.md')) && existsSync(join(cwd, 'AGENTS.md'))
      ? '\n\n' + (await readFile(join(cwd, 'AGENTS.md'), 'utf8'))
      : ''
  return `${instructions}\n\n# Ultimate\nYou are a delegated child of conversation #${conversation}. Answer concisely for the parent.${agents}`
}

export function exclusiveHooks(
  host: Pick<ExtensionHost, 'resource' | 'projectSettings'>,
  signal: AbortSignal,
) {
  const slot = exclusiveSlot(host)
  const held = new Set<string>()
  const release = (id: string | undefined) => {
    if (id && held.delete(id)) slot.release()
    return {}
  }
  const cleanup = () => {
    for (const id of held) release(id)
  }
  signal.addEventListener('abort', cleanup, { once: true })
  const hooks: RunOptions['hooks'] = {
    PreToolUse: [
      {
        matcher: 'Bash',
        timeout: 3600,
        hooks: [
          async (input, id) => {
            if (input.hook_event_name !== 'PreToolUse' || !id) return {}
            const command = (input.tool_input as { command?: string }).command ?? ''
            const configured = (await host.projectSettings()).exclusiveCommands ?? []
            if (!Array.isArray(configured)) return {}
            const matches = configured.some((pattern) => {
              try {
                return typeof pattern === 'string' && new RegExp(pattern).test(command)
              } catch {
                return false
              }
            })
            if (matches) {
              await slot.acquire(command, signal)
              held.add(id)
            }
            return {}
          },
        ],
      },
    ],
    PostToolUse: [{ matcher: 'Bash', hooks: [async (_input, id) => release(id)] }],
    PostToolUseFailure: [{ matcher: 'Bash', hooks: [async (_input, id) => release(id)] }],
  }
  return {
    hooks,
    close() {
      signal.removeEventListener('abort', cleanup)
      cleanup()
    },
  }
}
