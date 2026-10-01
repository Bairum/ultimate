import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

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
  definitions: AgentDefinition[]
  errors: { name: string; description: string; path: string; error: string }[]
}
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const scalar = (text: string) => {
  const value = text.trim()
  if (value.startsWith('"')) return JSON.parse(value) as string
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('Unclosed quoted value')
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}
export function parseDefinition(text: string, path: string): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!match) throw new Error('Expected frontmatter delimited by ---')
  const fields: Record<string, string | string[]> = {}
  let list: string | undefined
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s+-\s+(.+)$/.exec(line)
    if (item && list) {
      ;(fields[list] as string[]).push(scalar(item[1]))
      continue
    }
    const field = /^(name|description|model|thinking|tools):\s*(.*)$/.exec(line)
    if (!field) throw new Error(`Invalid frontmatter: ${line}`)
    const [, key, value] = field
    if (Object.hasOwn(fields, key)) throw new Error(`Duplicate field: ${key}`)
    list = undefined
    if (key === 'tools') {
      if (!value.trim()) {
        fields[key] = []
        list = key
      } else {
        if (!/^\[.*\]$/.test(value.trim())) throw new Error('tools must be a list')
        fields[key] = value
          .trim()
          .slice(1, -1)
          .split(',')
          .filter((v) => v.trim())
          .map(scalar)
      }
    } else fields[key] = scalar(value)
  }
  if (typeof fields.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(fields.name))
    throw new Error('name must be a nonempty identifier')
  if (typeof fields.description !== 'string' || !fields.description.trim())
    throw new Error('description is required')
  if (fields.thinking !== undefined && !levels.includes(fields.thinking as string))
    throw new Error('Invalid thinking level')
  let model: AgentDefinition['model']
  if (fields.model !== undefined) {
    const ref = /^([^/]+)\/(.+)$/.exec(fields.model as string)
    if (!ref) throw new Error('model must be provider/modelId')
    model = { provider: ref[1], modelId: ref[2] }
  }
  if (!match[2].trim()) throw new Error('Instructions are required')
  return {
    name: fields.name,
    description: fields.description,
    path,
    instructions: match[2].trim(),
    ...(model ? { model } : {}),
    ...(fields.thinking ? { thinking: fields.thinking as ModelThinkingLevel } : {}),
    ...(fields.tools ? { tools: fields.tools as string[] } : {}),
  }
}
export async function discoverAgents(
  repoRoot: string,
  cwd: string,
  home = join(homedir(), '.ultimate'),
): Promise<AgentDiscovery> {
  const definitions = new Map<string, AgentDefinition>()
  const errors: AgentDiscovery['errors'] = []
  for (const directory of new Set([
    join(repoRoot, 'agents'),
    join(home, 'agents'),
    join(cwd, '.ultimate', 'agents'),
  ])) {
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      errors.push({ name: directory, description: '', path: directory, error: String(error) })
      continue
    }
    for (const file of files.filter((entry) => entry.endsWith('.md')).toSorted()) {
      const path = join(directory, file)
      try {
        const definition = parseDefinition(await readFile(path, 'utf8'), path)
        definitions.set(definition.name, definition)
      } catch (error) {
        errors.push({ name: file.slice(0, -3), description: '', path, error: String(error) })
      }
    }
  }
  return { definitions: [...definitions.values()], errors }
}
