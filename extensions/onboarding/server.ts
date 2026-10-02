import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'

async function settings(path: string): Promise<JsonObject> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return '{}'
  })
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings must be a JSON object')
  return value
}
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
async function save(path: string, value: JsonObject) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export const actions = {
  status: async (_args, { host }) => ({
    firstRun: !existsSync(join(host.userHome, '.ultimate/onboarding.json')),
    project: await host.projectSetup(),
  }),
  firstRunDone: async (_args, { host }) => {
    await save(join(host.userHome, '.ultimate/onboarding.json'), { firstRunDone: true })
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
    const value = await settings(path)
    toggle(lists(value), args.name, args.enabled)
    await save(path, value)
    await host.reloadExtensions()
    return { ok: true }
  },
  adoptProjectSetup: async (_args, { host }) => {
    const project = lists(await settings(join(host.projectRoot, '.ultimate/settings.json')))
    const path = join(host.userHome, '.ultimate/settings.json')
    const value = await settings(path)
    const extensions = lists(value)
    for (const [key, enabled] of [
      ['enable', true],
      ['disable', false],
    ] as const)
      for (const name of (project[key] as string[]) ?? []) toggle(extensions, name, enabled)
    await save(path, value)
    await host.reloadExtensions()
    return { ok: true }
  },
  extensions: async (_args, { host }) => {
    return Promise.all(
      host.extensions().map(async (entry) => {
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
          enabled: entry.enabled,
          layer: entry.layer,
          readme: paragraph.match(/^.*?[.!?](?:\s|$)/su)?.[0].trim() ?? paragraph,
        }
      }),
    )
  },
} satisfies Record<string, ExtensionAction>

export default defineExtension({ name: 'onboarding' })
