import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { doneText, fireText, trimLog } from '../extensions/subscriptions/types.ts'
import type { Subscription } from '../extensions/subscriptions/types.ts'
import { context } from '../server/harness.ts'
import { fauxServer, removeTemp, temp, until } from './helpers.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})

it('accepts loose FIRE text, including JSON and an empty payload, only on stdout', () => {
  expect(fireText('FIRE done', true)).toBe('done')
  expect(fireText('FIRE {"status":"ok"}', true)).toBe('{"status":"ok"}')
  expect(fireText('FIRE', true)).toBe('')
  expect(fireText('FIRE\tfinished', true)).toBe('finished')
  for (const text of ['progress', 'FIREWORKS', ' FIRE done', 'fire done'])
    expect(fireText(text, true)).toBeUndefined()
  expect(fireText('FIRE not a notification', false)).toBeUndefined()
})

it('reads DONE with optional text only on stdout', () => {
  expect(doneText('DONE', true)).toBe('')
  expect(doneText('DONE all merged', true)).toBe('all merged')
  for (const text of ['DONEZO', 'done', ' DONE']) expect(doneText(text, true)).toBeUndefined()
  expect(doneText('DONE', false)).toBeUndefined()
})

it('retains the newest output within both line and byte limits', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join('')
  const trimmed = trimLog(text)
  expect(trimmed.split('\n')).toHaveLength(2001)
  expect(trimmed.startsWith('line 1000\n')).toBe(true)
  expect(trimmed.endsWith('line 2999\n')).toBe(true)
  const long = trimLog('x'.repeat(300 * 1024) + '\nend\n')
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(256 * 1024)
  expect(long.endsWith('\nend\n')).toBe(true)
  expect(trimLog('progress\n')).toBe('progress\n')
})

// A project extension outside the clone cannot import api.ts; the token is its name, which is all `want` needs.
const consumer = `
import { defineExtension } from '@earendil-works/pi-durable'
const Subscriptions = { name: 'subscriptions' }
export default () => defineExtension({ name: 'prs' })
export const actions = {
  call: async ({ method, id }, { host }) => {
    const subscriptions = host.want(Subscriptions)
    if (!subscriptions) return 'missing'
    try { return await subscriptions[method](id) } catch (error) { return String(error) }
  },
}`

it('lets a project extension read, stop and start a subscription through the service', async () => {
  const home = await temp('ultimate-subscriptions-service-')
  homes.push(home)
  const projectRoot = join(home, 'project')
  const definitions = join(home, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  await writeFile(
    join(definitions, 'subscription.md'),
    '---\nname: subscription\ndescription: Test\nmodel: faux/faux-1\ntools: []\n---\nShort.\n',
  )
  const folder = join(projectRoot, '.ultimate/extensions/prs')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server.ts'), consumer)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const caller = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const sub = (await server.extensions.invoke(
    'subscriptions',
    'create',
    { ask: 'Watch ship/* PRs', once: false },
    new AbortController().signal,
    caller.id,
  )) as Subscription
  await until(() => !!server.extensions.action('prs', 'call'))
  const call = (method: string, id = sub.id) =>
    server.extensions.invoke('prs', 'call', { method, id }, new AbortController().signal)

  expect(await call('status')).toMatchObject({ id: sub.id, state: 'writing', alive: false })
  expect(await call('stop')).toMatchObject({ id: sub.id, state: 'stopped', enabled: false })
  // Start checks the executable before it changes anything: the subscription stays stopped.
  expect(await call('start')).toContain('Missing or non-executable')
  expect(await call('status')).toMatchObject({ state: 'stopped' })
  expect(await call('status', 'S99')).toBe('Error: Unknown subscription: S99')
  expect(await call('status', 'nope')).toBe('Error: id must be S<n>')
  expect(server.extensions.catalogue().apis.find((api) => api.name === 'subscriptions')).toEqual({
    name: 'subscriptions',
    provider: 'subscriptions',
    needs: [],
    wants: ['prs'],
  })
})
