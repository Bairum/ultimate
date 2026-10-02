import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import type { Source } from '../../server/project.ts'

export interface AgentDefinition {
  name: string
  description: string
  path: string
  instructions: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  tools?: string[]
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
const fields = new Set(['name', 'description', 'model', 'thinking', 'tools'])

/** A definition file: Pi's YAML frontmatter with Ultimate's fields, and the instructions as its body. */
export function parseDefinition(text: string, path: string): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter(text)
  // Without a frontmatter block Pi returns no fields; YAML may also parse to a list or a scalar.
  if (
    typeof frontmatter !== 'object' ||
    Array.isArray(frontmatter) ||
    !Object.keys(frontmatter).length
  )
    throw new Error('Expected frontmatter fields between --- lines')
  const { name, description, model, thinking, tools } = frontmatter
  const unknown = Object.keys(frontmatter).find((key) => !fields.has(key))
  if (unknown) throw new Error(`Unknown field: ${unknown}`)
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error('name must be a nonempty identifier')
  if (typeof description !== 'string' || !description.trim())
    throw new Error('description is required')
  if (thinking !== undefined && (typeof thinking !== 'string' || !Object.hasOwn(levels, thinking)))
    throw new Error(`thinking must be one of ${Object.keys(levels).join(', ')}`)
  const ref = typeof model === 'string' ? /^([^/]+)\/(.+)$/.exec(model) : null
  if (model !== undefined && !ref) throw new Error('model must be provider/modelId')
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string'))
  )
    throw new Error('tools must be a list of tool names')
  if (!body) throw new Error('Instructions are required')
  return {
    name,
    description: description.trim(),
    path,
    instructions: body,
    ...(ref ? { model: { provider: ref[1], modelId: ref[2] } } : {}),
    ...(thinking ? { thinking: thinking as ModelThinkingLevel } : {}),
    ...(tools ? { tools } : {}),
  }
}

/** Definitions from `agents/` in Ultimate's clone, `~/.ultimate/`, and the project's `.ultimate/`; later wins by name. */
export async function discoverAgents(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string,
): Promise<AgentDiscovery> {
  const roots = [
    { source: 'builtin' as const, path: join(ultimateRoot, 'agents') },
    { source: 'user' as const, path: join(userHome, '.ultimate/agents') },
    { source: 'project' as const, path: join(projectRoot, '.ultimate/agents') },
  ]
  const definitions = new Map<string, AgentDefinition & { source: Source }>()
  const errors: AgentDiscovery['errors'] = []
  for (const { source, path: directory } of roots) {
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
        const definition = parseDefinition(await readFile(path, 'utf8'), path)
        definitions.set(definition.name, { ...definition, source })
      } catch (error) {
        errors.push({ name: file.slice(0, -3), path, source, error: String(error) })
      }
    }
  }
  return { definitions: [...definitions.values()], errors }
}
