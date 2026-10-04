import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fauxServer, post, temp, until } from './helpers.ts'

it('shares Pi events between server extensions across reloads and isolates a throwing handler', async () => {
  const home = await temp('ultimate-bus-')
  const projectRoot = join(home, 'project')
  const receiver = join(home, '.ultimate/extensions/receiver')
  const sender = join(home, '.ultimate/extensions/sender')
  await mkdir(projectRoot)
  await mkdir(receiver, { recursive: true })
  await mkdir(sender, { recursive: true })
  const source = `
import { defineExtension } from '@earendil-works/pi-durable'
export default host => {
  const values = host.resource('receiver.values', () => [])
  host.events.on('receiver:message', () => { throw new Error('receiver broke') })
  host.events.on('receiver:message', data => values.push({ handler: 'first', data }))
  return defineExtension({ name: 'receiver' })
}
export const actions = {
  inspect: async (_, { host }) => {
    return { values: host.resource('receiver.values', () => null) }
  },
}
`
  await writeFile(join(receiver, 'server.ts'), source)
  await writeFile(
    join(sender, 'server.ts'),
    `
import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: 'sender' })
export const actions = {
  send: async (data, { host }) => host.events.emit('receiver:message', data),
  inspect: async (_, { host }) => host.resource('receiver.values', () => null),
}
`,
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const send = await post(server, '/api/extensions/sender/actions/send', { args: { value: 1 } })
    expect(send.status).toBe(200)
    const inspect = await post(server, '/api/extensions/receiver/actions/inspect', { args: {} })
    expect(inspect.data).toEqual({ result: { values: [{ handler: 'first', data: { value: 1 } }] } })
    expect(log).toHaveBeenCalledWith(
      'Event handler error (receiver:message):',
      expect.objectContaining({ message: 'receiver broke' }),
    )
    const loaded = server.extensions.info().find((entry) => entry.name === 'receiver')
      ?.server?.loadedAt
    await writeFile(
      join(receiver, 'server.ts'),
      source.replace("handler: 'first'", "handler: 'second'"),
    )
    await until(
      () =>
        server.extensions.info().find((entry) => entry.name === 'receiver')?.server?.loadedAt !==
        loaded,
    )
    await post(server, '/api/extensions/sender/actions/send', { args: { value: 2 } })
    const reloaded = await post(server, '/api/extensions/receiver/actions/inspect', { args: {} })
    expect(reloaded.data).toEqual({
      result: {
        values: [
          { handler: 'first', data: { value: 1 } },
          { handler: 'second', data: { value: 2 } },
        ],
      },
    })
    await rm(receiver, { recursive: true })
    await until(() => !server.extensions.info().some((entry) => entry.name === 'receiver'))
    log.mockClear()
    await post(server, '/api/extensions/sender/actions/send', { args: { value: 3 } })
    expect(log).not.toHaveBeenCalled()
    const removed = await post(server, '/api/extensions/sender/actions/inspect', { args: {} })
    expect(removed.data).toEqual({ result: reloaded.data.result.values })
  } finally {
    log.mockRestore()
    await server.close()
  }
})
