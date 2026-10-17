// Harness tests use the faux provider without token pacing.
import { temp, removeTemp } from './helpers.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import subagents, { Standing } from '../extensions/subagents/server.ts'
import type { SubagentsService } from '../extensions/subagents/server.ts'
import { Metadata } from '../server/metadata.ts'
import { parseDefinition, saveDefinition } from '../extensions/subagents/agents.ts'

const ctx = BACKGROUND_CONTEXT
const directories: string[] = []
const opened: OpenHost[] = []
afterEach(async () => {
  for (const host of opened.splice(0)) await host.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
const definition = (body: string, extra = '') =>
  `---\nname: x\ndescription: Test\nresident: true\ntools: [read, t]\nisolate: worktree\n${extra}---\n${body}\n`
async function fixture() {
  const path = await temp('ultimate-standing-')
  directories.push(path)
  const prepared = await prepareHarness({
    ultimateRoot: path,
    userHome: path,
    home: join(path, 'state'),
    faux: true,
  })
  const tool = defineTool({
    name: 't',
    description: 'Owned tool',
    deferred: true,
    parameters: Type.Object({}),
    execute: async () => ({ output: [] }),
  })
  prepared.registry.install(CodingTools)
  prepared.registry.install(defineExtension({ name: 'owned', tools: [tool] }))
  let host!: OpenHost
  let service!: SubagentsService
  const backend = subagents({
    ...prepared,
    harness: () => host.harness,
    metadata: Metadata,
    projectSettings: async () => ({}),
    provide: (_name, value) => {
      service = value as SubagentsService
    },
    use: () => undefined,
    resource: (_key, create) => create(),
    extensions: () => [],
    notice: () => {},
    onOpen: () => {},
    onClose: () => {},
  })
  prepared.registry.install(backend)
  host = await prepared.open()
  opened.push(host)
  await mkdir(join(path, 'agents'))
  const file = join(path, 'agents/x.md')
  await writeFile(file, definition('Original'))
  return { path, prepared, host, service, file }
}

it('parses and saves the resident field, refusing non-booleans', async () => {
  const { path, prepared } = await fixture()
  expect(parseDefinition(definition('Instructions'), 'test').resident).toBe(true)
  expect(() =>
    parseDefinition(
      definition('Instructions').replace('resident: true', 'resident: "yes"'),
      'test',
    ),
  ).toThrow('resident must be a boolean')
  const saved = await saveDefinition(
    { projectRoot: path, userHome: path },
    prepared.modelRuntime,
    'user',
    'saved',
    { description: 'Saved', resident: true },
    'Instructions',
  )
  expect(saved.resident).toBe(true)
  expect(parseDefinition(await readFile(saved.path, 'utf8'), saved.path).resident).toBe(true)
})

it('keeps one ownerless standing conversation, refreshes its definition and recreates deleted records', async () => {
  const { service, host, prepared, path, file } = await fixture()
  expect(await service.residents(ctx)).toEqual([{ name: 'x', description: 'Test' }])
  const ids = await Promise.all([service.standing('x', ctx), service.standing('x', ctx)])
  expect(ids[0]).toBe(ids[1])
  const id = ids[0]
  expect(await service.standing('x', ctx)).toBe(id)
  const conversation = (await host.harness.conversation(id, ctx))!
  const record = await host.harness.commit((tx) => tx.conversation(id), ctx)
  expect(record?.owner).toBeUndefined()
  expect(await conversation.agent(ctx)).toMatchObject({ cwd: path, instructions: 'Original' })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toMatchObject({
    label: 'agent',
    title: '@x',
  })
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({ x: id })
  await writeFile(file, definition('Edited', 'model: anthropic/claude-opus-4-8\n'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Edited',
    model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
  })
  await expect(service.standing('missing', ctx)).rejects.toThrow('Standing agents: @x')
  await writeFile(
    join(path, 'agents/ordinary.md'),
    '---\nname: ordinary\ndescription: Ordinary\n---\nInstructions',
  )
  await expect(service.standing('ordinary', ctx)).rejects.toThrow('Standing agents: @x')
  // No public delete API: remove the record to exercise a stale standing index.
  const database = new DatabaseSync(prepared.database)
  database.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  database.close()
  expect(await service.standing('x', ctx)).not.toBe(id)
})

it('keeps a model chosen in the standing conversation across refreshes unless the definition pins one', async () => {
  const { service, host, file } = await fixture()
  await host.harness.commit(async (tx) => {
    await configure(tx, ROOT_CONVERSATION_ID, {
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
    })
  }, ctx)
  const id = await service.standing('x', ctx)
  const conversation = (await host.harness.conversation(id, ctx))!
  expect(await conversation.agent(ctx)).toMatchObject({
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'low',
  })
  const chosen = { provider: 'openai', modelId: 'gpt-6-astra' }
  await host.harness.commit(async (tx) => {
    await configure(tx, id, { model: chosen, thinkingLevel: 'high' })
  }, ctx)
  await writeFile(file, definition('Edited'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Edited',
    model: chosen,
    thinkingLevel: 'high',
  })
  await writeFile(
    file,
    definition('Pinned', 'model: anthropic/claude-opus-4-8\nthinking: minimal\n'),
  )
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Pinned',
    model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
    thinkingLevel: 'minimal',
  })
})

it('offers deferred tools only when named by the definition, and removes them on refresh', async () => {
  const { service, host, file } = await fixture()
  expect((await host.root.agent(ctx)).tools.map((tool) => tool.name)).not.toContain('t')
  const id = await service.standing('x', ctx)
  const conversation = (await host.harness.conversation(id, ctx))!
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read', 't'])
  await writeFile(file, definition('No owned tool').replace('tools: [read, t]', 'tools: [read]'))
  await service.standing('x', ctx)
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read'])
  expect((await host.root.agent(ctx)).tools.map((tool) => tool.name)).not.toContain('t')
  await host.harness.commit(async (tx) => {
    await configure(tx, id, { tools: [] })
  }, ctx)
  await service.standing('x', ctx)
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read'])
})
