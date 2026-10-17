import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Board } from '../extensions/board/server.ts'
import { Branch, Roots, rootOf } from '../extensions/lineage/server.ts'
import { Standing } from '../extensions/subagents/server.ts'
import { parseDefinition } from '../extensions/subagents/agents.ts'
import { fauxServer, seedTally, sourceCopy, temp, removeTemp, until, post } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
const homes: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const home of homes.splice(0)) await removeTemp(home)
})
function textOf(content: unknown): string {
  return typeof content === 'string'
    ? content
    : ((content as { type: string; text?: string }[]) ?? [])
        .flatMap((p) => (p.type === 'text' ? [p.text!] : []))
        .join('')
}
async function fixture(onRequest?: (text: string, home: string) => Promise<void>) {
  const home = await temp('ultimate-agent-')
  homes.push(home)
  const root = await sourceCopy(home)
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\ntools: [message]\n---\nAnswer concisely.',
  )
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
  const requests: string[] = []
  const open = async () => {
    const server = await fauxServer({
      ultimateRoot: root,
      home: join(home, 'state'),
      userHome: home,
    })
    servers.push(server)
    const route: FauxResponseFactory = async (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      const text = textOf(last.content)
      requests.push(text)
      await onRequest?.(text, home)
      if (last.role === 'user' && text.startsWith('BRANCH '))
        return fauxAssistantMessage([fauxToolCall('branch', JSON.parse(text.slice(7)))], {
          stopReason: 'toolUse',
        })
      if (last.role === 'user' && text.startsWith('SEND '))
        return fauxAssistantMessage([fauxToolCall('message', JSON.parse(text.slice(5)))], {
          stopReason: 'toolUse',
        })
      return fauxAssistantMessage(
        last.role === 'toolResult' ? `Tool result: ${text}` : `Answer: ${text}`,
      )
    }
    server.host.faux!.setResponses([route])
    return server
  }
  const server = await open()
  const subagents = {
    standing: async (name: string, _ctx: typeof context) => {
      const response = await post(server, '/api/extensions/board/actions/post', {
        args: { to: `@${name}`, text: 'Initial greeting' },
      })
      expect(response.status).toBe(200)
      const index = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
      return index![name]
    },
  }
  return { home, root, server, subagents, requests, open }
}
async function entries(server: Server, id: ConversationId) {
  return server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: id }, 1000)).items,
    context,
  )
}
async function log(server: Server) {
  return (await server.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!.messages
}
async function ask(server: Server, id: ConversationId, text: string) {
  const conversation = (await server.harness.conversation(id, context))!
  await (await conversation.submit({ type: 'input', content: text }, context)).wait(context)
}

it('ships a resident Ultimate definition with valid tools; standing addresses create recipients and name both sides', async () => {
  const f = await fixture()
  const definition = parseDefinition(
    await readFile(resolve('agents/ultimate.md'), 'utf8'),
    'ultimate',
  )
  expect(definition.resident).toBe(true)
  const ultimate = await f.subagents.standing('ultimate', context)
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(agent.tools.map((tool) => tool.name).toSorted()).toEqual(definition.tools!.toSorted())
  expect((await f.server.root.agent(context)).tools.map((tool) => tool.name)).not.toContain(
    'branch',
  )
  expect(
    (await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.dice,
  ).toBeUndefined()
  await ask(f.server, ultimate, 'SEND ' + JSON.stringify({ to: '@dice', text: 'Roll' }))
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) => entry.kind === 'board.reply'),
  )
  const dice = (await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.dice
  expect((await entries(f.server, dice)).some((entry) => entry.kind === 'board.message')).toBe(true)
  expect(f.requests.some((text) => text.startsWith(`Message from #${ultimate} (@ultimate):`))).toBe(
    true,
  )
  await until(() =>
    f.requests.some((text) => text.startsWith(`Reply from #${dice} (@dice) to your message`)),
  )
  expect(
    (await (await f.server.harness.conversation(dice, context))!.agent(context)).tools.map(
      (tool) => tool.name,
    ),
  ).not.toContain('branch')
})

it('starts a lineage branch with a board input and caller attribution, returns its answer, and selects roots', async () => {
  const f = await fixture()
  await seedTally(f.server.harness)
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Explore the task', isolated: false }),
  )
  await until(async () =>
    (await log(f.server)).some((m) => m.from === ultimate && m.text === 'Explore the task'),
  )
  const message = (await log(f.server)).find((m) => m.text === 'Explore the task')!
  const branch = message.to as ConversationId
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) => entry.kind === 'board.reply'),
  )
  expect(await f.server.harness.snapshot(Branch, branch, context)).toMatchObject({
    branch: { from: 1, intent: 'Explore the task' },
  })
  expect(
    (await entries(f.server, branch)).filter((entry) => entry.kind === 'board.message'),
  ).toMatchObject([{ data: { from: ultimate, text: 'Explore the task', reply: true } }])
  expect(await f.server.harness.snapshot(Metadata, branch, context)).toMatchObject({
    title: 'Explore the task',
    label: 'coordinator',
  })
  expect(
    (await entries(f.server, ROOT_CONVERSATION_ID)).some((entry) =>
      JSON.stringify(entry).includes(`started by #${ultimate} (@ultimate)`),
    ),
  ).toBe(true)
  const other = await f.server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  await seedTally(f.server.harness, other.id)
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
  }, context)
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Ambiguous', isolated: false }),
  )
  expect(f.requests.some((text) => text.includes(`Choose a root. Roots: #1, #${other.id}`))).toBe(
    true,
  )
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Invalid', root: 999, isolated: false }),
  )
  expect((await log(f.server)).some((m) => m.text === 'Invalid')).toBe(false)
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Explicit root', root: other.id, isolated: false }),
  )
  await until(async () => (await log(f.server)).some((m) => m.text === 'Explicit root'))
  expect(await rootOf({ harness: () => f.server.harness }, branch, context)).toBe(1)
  // A branch caller's tree wins over an ambiguous project root list.
  const branchConversation = (await f.server.harness.conversation(branch, context))!
  const configured = await branchConversation.agent(context)
  const coordinator = parseDefinition(
    await readFile(resolve('agents/coordinator.md'), 'utf8'),
    'coordinator',
  )
  expect(coordinator.resident).not.toBe(true)
  expect(coordinator.tools).toBeUndefined()
  expect(coordinator.model).toBeUndefined()
  expect(configured.instructions).toBe(coordinator.instructions)
  expect(configured.tools.map((tool) => tool.name)).not.toContain('branch')
  const agentBranch = (await f.server.root.agent(context)).deferred.find(
    (tool) => tool.name === 'branch',
  )!
  await f.server.harness.commit(
    (tx) => configure(tx, branch, { modelTools: { add: [agentBranch] } }),
    context,
  )
  await writeFile(
    join(f.home, '.ultimate/agents/coordinator.md'),
    '---\nname: coordinator\ndescription: Custom coordinator\n---\nUse the project procedure.',
  )
  await ask(f.server, branch, 'BRANCH ' + JSON.stringify({ prompt: 'Same tree', isolated: false }))
  await until(async () => (await log(f.server)).some((m) => m.text === 'Same tree'))
  const sameTree = (await log(f.server)).find((m) => m.text === 'Same tree')!
  expect(
    await f.server.harness.snapshot(Branch, sameTree.to as ConversationId, context),
  ).toMatchObject({ branch: { from: 1 } })
  const overridden = await (await f.server.harness.conversation(
    sameTree.to as ConversationId,
    context,
  ))!.agent(context)
  expect(overridden.instructions).toBe('Use the project procedure.')
  expect(overridden.model).toEqual(configured.model)
  expect(overridden.tools.map((tool) => tool.name)).toEqual(
    configured.tools.map((tool) => tool.name),
  )
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = []
  }, context)
  await ask(f.server, ultimate, 'BRANCH ' + JSON.stringify({ prompt: 'No roots', isolated: false }))
  expect(f.requests.some((text) => text.includes('Choose a root. Roots: (none)'))).toBe(true)
})

it('refreshes standing definitions for numeric-address deliveries', async () => {
  const f = await fixture()
  const dice = await f.subagents.standing('dice', context)
  await until(async () => (await log(f.server)).some((m) => m.from === dice && m.re !== undefined))
  await writeFile(
    join(f.home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\ntools: [message]\n---\nEdited numeric recipient.',
  )
  await ask(
    f.server,
    f.server.root.id,
    'SEND ' + JSON.stringify({ to: `#${dice}`, text: 'Fresh delivery' }),
  )
  await until(async () =>
    (await log(f.server)).some((m) => m.from === dice && m.text.includes('Fresh delivery')),
  )
  expect(await (await f.server.harness.conversation(dice, context))!.agent(context)).toMatchObject({
    instructions: 'Edited numeric recipient.',
  })
  await f.server.harness.waitForIdle(context)
})

it('refreshes standing definitions before delivering automatic replies', async () => {
  const f = await fixture(async (text, home) => {
    if (text.startsWith('Message from') && text.includes('\nRoll after edit\n'))
      await writeFile(
        join(home, '.ultimate/agents/ultimate.md'),
        (await readFile(resolve('agents/ultimate.md'), 'utf8')) + '\nEdited reply recipient.',
      )
  })
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(f.server, ultimate, 'SEND ' + JSON.stringify({ to: '@dice', text: 'Roll after edit' }))
  await until(() =>
    f.requests.some((text) => text.startsWith('Reply from') && text.includes('Roll after edit')),
  )
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(agent.instructions).toContain('Edited reply recipient.')
  await f.server.harness.waitForIdle(context)
})

it('keeps Ultimate answers to board replies out of the log, including after reopen', async () => {
  const f = await fixture()
  const ultimate = await f.subagents.standing('ultimate', context)
  const resident = (await f.server.harness.conversation(ultimate, context))!
  await until(async () =>
    (await log(f.server)).some((m) => m.from === ultimate && m.to === 'user' && m.re !== undefined),
  )
  const before = await log(f.server)
  const receipt = await resident.submit(
    {
      type: 'input',
      requestId: 'board-reply:quiet',
      content: 'Branch result',
      entry: {
        kind: 'board.reply',
        data: { id: 100, re: 99, from: 1, text: 'Branch result', failed: false },
      },
    },
    context,
  )
  expect(await receipt.wait(context)).toMatchObject({ status: 'done' })
  expect(
    (await entries(f.server, ultimate)).some((entry) =>
      JSON.stringify(entry).includes('Answer: Branch result'),
    ),
  ).toBe(true)
  expect(await log(f.server)).toEqual(before)
  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  const reopened = await f.open()
  expect(await log(reopened)).toEqual(before)
})
