import { mkdir, writeFile } from 'node:fs/promises'
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
  host.resource('receiver.bus', () => {
    const values = []
    const stops = [
      host.events.on('receiver:message', () => { throw new Error('receiver broke') }),
      host.events.on('receiver:message', data => values.push(data)),
    ]
    return { bus: host.events, values, stops }
  })
  return defineExtension({ name: 'receiver' })
}
export const actions = {
  inspect: async (_, { host }) => {
    const state = host.resource('receiver.bus', () => null)
    return { values: state.values, sameBus: state.bus === host.events }
  },
  clear: async (_, { host }) => {
    for (const stop of host.resource('receiver.bus', () => null).stops) stop()
  },
}
`
  await writeFile(join(receiver, 'server.ts'), source)
  await writeFile(
    join(sender, 'server.ts'),
    `
import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: 'sender' })
export const actions = { send: async (data, { host }) => host.events.emit('receiver:message', data) }
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
    expect(inspect.data).toEqual({ result: { values: [{ value: 1 }], sameBus: true } })
    expect(log).toHaveBeenCalledWith(
      'Event handler error (receiver:message):',
      expect.objectContaining({ message: 'receiver broke' }),
    )
    const loaded = server.extensions.info().find((entry) => entry.name === 'receiver')
      ?.server?.loadedAt
    await writeFile(join(receiver, 'server.ts'), source + '\n// reload\n')
    await until(
      () =>
        server.extensions.info().find((entry) => entry.name === 'receiver')?.server?.loadedAt !==
        loaded,
    )
    await post(server, '/api/extensions/sender/actions/send', { args: { value: 2 } })
    const reloaded = await post(server, '/api/extensions/receiver/actions/inspect', { args: {} })
    expect(reloaded.data).toEqual({
      result: { values: [{ value: 1 }, { value: 2 }], sameBus: true },
    })
  } finally {
    await post(server, '/api/extensions/receiver/actions/clear', { args: {} })
    log.mockRestore()
    await server.close()
  }
})
