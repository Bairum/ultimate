import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'
import { save, updateSettings } from './settings.ts'

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

export const actions = {
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
   * unchecked ones leave `enable`; `local`, when given, is the project decision. Records the first run, then applies
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
        if (enabled) toggle(extensions, name, true)
        else if (extensions.enable !== undefined)
          extensions.enable = (extensions.enable as string[]).filter((entry) => entry !== name)
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
} satisfies Record<string, ExtensionAction>

export default defineExtension({ name: 'onboarding' })
