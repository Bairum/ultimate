import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Agent, AgentChange } from '@earendil-works/pi-durable'
import { parseFrontmatter, resolveCliModel } from '@earendil-works/pi-coding-agent'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Source } from '../../server/project.ts'
// oxlint-disable-next-line no-restricted-imports -- agent discovery follows the core project trust decision
import { useProjectSetup } from '../../server/project-setup.ts'

export interface AgentDefinition {
  name: string
  description: string
  path: string
  instructions: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  tools?: string[]
  isolate?: 'none' | 'worktree'
  resident?: boolean
  /** What the lander does when a submission fails: explain it, or fix it and land. Only the lander reads it. */
  onFailure?: 'diagnose' | 'fix'
}
export function definitionAgent(
  definition: AgentDefinition | undefined,
  parent: Agent,
  modelRuntime: ModelRuntime,
  {
    excludeTools = [],
    excludeExtensions = [],
    model: overrideModel,
    thinking: overrideThinking,
  }: {
    excludeTools?: string[]
    excludeExtensions?: string[]
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  } = {},
): AgentChange {
  const ref = overrideModel ?? definition?.model ?? parent.model
  const model = ref && modelRuntime.getModel(ref.provider, ref.modelId)
  const thinking = overrideThinking ?? definition?.thinking ?? parent.thinkingLevel
  const tools = [
    ...new Map([...parent.tools, ...parent.deferred].map((tool) => [tool.name, tool])).values(),
  ]
  return {
    modelTools: {
      add: tools.filter((tool) => tool.deferred && definition?.tools?.includes(tool.name)),
    },
    tools: tools.filter(
      (tool) =>
        !excludeTools.includes(tool.name) &&
        (!definition?.tools || definition.tools.includes(tool.name)),
    ),
    extensions: parent.extensions.filter(
      (extension) => !excludeExtensions.includes(extension.name),
    ),
    instructions: definition?.instructions ?? parent.instructions ?? null,
    model: ref ?? null,
    thinkingLevel: thinking && model ? clampThinkingLevel(model, thinking) : (thinking ?? null),
  }
}

export interface AgentDiscovery {
  definitions: (AgentDefinition & { source: Source })[]
  errors: { name: string; path: string; source: Source; error: string }[]
}
// Pi's levels; `satisfies` fails the type check when Pi adds or drops one.
const levels = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} satisfies Record<ModelThinkingLevel, true>
const fields = new Set([
  'name',
  'description',
  'model',
  'thinking',
  'tools',
  'isolate',
  'resident',
  'onFailure',
])

/** A definition file: Pi's YAML frontmatter with Ultimate's fields, and the instructions as its body. */
export function parseDefinition(
  text: string,
  path: string,
): Omit<AgentDefinition, 'model'> & { model?: string } {
  const { frontmatter, body } = parseFrontmatter(text)
  // Without a frontmatter block Pi returns no fields; YAML may also parse to a list or a scalar.
  if (
    typeof frontmatter !== 'object' ||
    Array.isArray(frontmatter) ||
    !Object.keys(frontmatter).length
  )
    throw new Error('Expected frontmatter fields between --- lines')
  const { name, description, model, thinking, tools, isolate, resident, onFailure } = frontmatter
  const unknown = Object.keys(frontmatter).find((key) => !fields.has(key))
  if (unknown) throw new Error(`Unknown field: ${unknown}`)
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error('name must be a nonempty identifier')
  if (typeof description !== 'string' || !description.trim())
    throw new Error('description is required')
  if (thinking !== undefined && (typeof thinking !== 'string' || !Object.hasOwn(levels, thinking)))
    throw new Error(`thinking must be one of ${Object.keys(levels).join(', ')}`)
  if (model !== undefined && (typeof model !== 'string' || !model.trim()))
    throw new Error('model must be a nonempty string')
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string'))
  )
    throw new Error('tools must be a list of tool names')
  if (isolate !== undefined && isolate !== 'none' && isolate !== 'worktree')
    throw new Error('isolate must be none or worktree')
  if (onFailure !== undefined && onFailure !== 'diagnose' && onFailure !== 'fix')
    throw new Error('onFailure must be diagnose or fix')
  if (resident !== undefined && typeof resident !== 'boolean')
    throw new Error('resident must be a boolean')
  if (!body) throw new Error('Instructions are required')
  return {
    name,
    description: description.trim(),
    path,
    instructions: body,
    ...(model !== undefined ? { model } : {}),
    ...(thinking ? { thinking: thinking as ModelThinkingLevel } : {}),
    ...(tools ? { tools } : {}),
    ...(isolate ? { isolate } : {}),
    ...(resident !== undefined ? { resident } : {}),
    ...(onFailure ? { onFailure } : {}),
  }
}

/** A definition file read and its model resolved, as discovery and saving accept it. */
export function readDefinition(
  text: string,
  path: string,
  modelRuntime: ModelRuntime,
): AgentDefinition {
  const { model: cliModel, ...definition } = parseDefinition(text, path)
  const resolved = resolveCliModel({ cliModel, cliThinking: definition.thinking, modelRuntime })
  if (resolved.error || resolved.warning)
    throw new Error(`model: ${resolved.error || resolved.warning}`)
  const thinking = definition.thinking ?? resolved.thinkingLevel
  return {
    ...definition,
    ...(resolved.model
      ? { model: { provider: resolved.model.provider, modelId: resolved.model.id } }
      : {}),
    ...(thinking ? { thinking } : {}),
  }
}

/** The `agents/` folders discovery reads, in order; the project's only once its setup is chosen as local. */
export function agentRoots(ultimateRoot: string, projectRoot: string, userHome: string) {
  return [
    { source: 'builtin' as const, path: join(ultimateRoot, 'agents') },
    { source: 'user' as const, path: join(userHome, '.ultimate/agents') },
    ...(useProjectSetup(projectRoot, userHome)
      ? [{ source: 'project' as const, path: join(projectRoot, '.ultimate/agents') }]
      : []),
  ]
}

/** Definitions from `agents/` in Ultimate's clone, `~/.ultimate/`, and the project's `.ultimate/`; later wins by name. */
export async function discoverAgents(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string,
  modelRuntime: ModelRuntime,
): Promise<AgentDiscovery> {
  const definitions = new Map<string, AgentDefinition & { source: Source }>()
  const errors: AgentDiscovery['errors'] = []
  for (const { source, path: directory } of agentRoots(ultimateRoot, projectRoot, userHome)) {
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        errors.push({ name: directory, path: directory, source, error: String(error) })
      continue
    }
    for (const file of files.filter((entry) => entry.endsWith('.md')).toSorted()) {
      const path = join(directory, file)
      try {
        const definition = readDefinition(await readFile(path, 'utf8'), path, modelRuntime)
        definitions.set(definition.name, { ...definition, source })
      } catch (error) {
        errors.push({ name: file.slice(0, -3), path, source, error: String(error) })
      }
    }
  }
  return { definitions: [...definitions.values()], errors }
}

/** The fields a definition file's frontmatter may carry besides its name; `model` is `provider/id`. */
export interface DefinitionFields {
  description: string
  model?: string
  thinking?: string
  tools?: string[]
  isolate?: 'none' | 'worktree'
  resident?: boolean
  onFailure?: 'diagnose' | 'fix'
}

/** A YAML scalar: plain when it reads back as the same string, else JSON, which YAML reads as a quoted string. */
function scalar(value: string) {
  try {
    if (parseFrontmatter(`---\nvalue: ${value}\n---\n`).frontmatter.value === value) return value
  } catch {
    // Invalid plain YAML is serialized as a quoted JSON string below.
  }
  return JSON.stringify(value)
}

/** The Markdown file of a definition, in the shape of the built-in ones. */
export function serializeDefinition(
  name: string,
  frontmatter: DefinitionFields,
  instructions: string,
) {
  const lines = [
    `name: ${scalar(name)}`,
    `description: ${scalar(frontmatter.description.trim())}`,
    ...(frontmatter.model ? [`model: ${scalar(frontmatter.model)}`] : []),
    ...(frontmatter.thinking ? [`thinking: ${scalar(frontmatter.thinking)}`] : []),
    // In a flow list, commas and brackets end an item too.
    ...(frontmatter.tools
      ? [
          `tools: [${frontmatter.tools.map((tool) => (/^[\w.-]+$/.test(tool) ? scalar(tool) : JSON.stringify(tool))).join(', ')}]`,
        ]
      : []),
    ...(frontmatter.isolate === 'worktree' ? ['isolate: worktree'] : []),
    ...(frontmatter.resident !== undefined ? [`resident: ${frontmatter.resident}`] : []),
    ...(frontmatter.onFailure ? [`onFailure: ${frontmatter.onFailure}`] : []),
  ]
  return `---\n${lines.join('\n')}\n---\n\n${instructions.trim()}\n`
}

/** The folder a user or project definition is written to; the project's only once its setup is chosen as local. */
export function scopeRoot(scope: 'user' | 'project', projectRoot: string, userHome: string) {
  if (scope === 'user') return join(userHome, '.ultimate/agents')
  if (!useProjectSetup(projectRoot, userHome))
    throw new Error("Choose this project's local setup before saving project definitions")
  return join(projectRoot, '.ultimate/agents')
}

/**
 * Write `<scope>/agents/<name>.md` atomically, after it reads back as discovery reads it; an invalid definition
 * throws and writes nothing. A built-in is never changed: saving one writes an override into the scope.
 */
export async function saveDefinition(
  roots: { projectRoot: string; userHome: string },
  modelRuntime: ModelRuntime,
  scope: 'user' | 'project',
  name: string,
  frontmatter: DefinitionFields,
  instructions: string,
) {
  const directory = scopeRoot(scope, roots.projectRoot, roots.userHome)
  const text = serializeDefinition(name, frontmatter, instructions)
  // Reading it back checks the name before it becomes a path.
  const definition = readDefinition(text, join(directory, `${name}.md`), modelRuntime)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${name}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, text)
    await rename(temporary, definition.path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { ...definition, source: scope }
}

/** Remove a user or project definition file; a built-in of the same name applies again. */
export async function deleteDefinition(
  roots: { projectRoot: string; userHome: string },
  scope: 'user' | 'project',
  name: string,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('name must be a nonempty identifier')
  const path = join(scopeRoot(scope, roots.projectRoot, roots.userHome), `${name}.md`)
  try {
    await rm(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`No ${scope} definition named ${name}`, { cause: error })
    throw error
  }
  return { path }
}
