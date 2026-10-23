import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../server/extensions.ts'
import { spawnGroup, stopGroup } from '../lib/process-group.ts'
import { InstanceApi } from '../extensions/instance/api.ts'
import { WorkspacesApi } from '../extensions/workspaces/api.ts'
import instance, { actions } from '../extensions/instance/server.ts'
import type { ActionContext } from '../server/actions.ts'
import { apis, temp } from './helpers.ts'

vi.mock('../lib/process-group.ts', () => ({
  spawnGroup: vi.fn<typeof spawnGroup>(),
  stopGroup: vi.fn<typeof stopGroup>(async () => {}),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('starts the host project without resolving any conversation workspace, shares the limit, and stops by id', async () => {
  const home = await temp('ultimate-instance-service-')
  const services = apis()
  const get = vi.fn<() => never>(() => {
    throw new Error('No conversation belongs to this instance')
  })
  services.implement(WorkspacesApi, { get } as never)
  const resources = new Map<string, unknown>()
  const host = {
    ...services,
    home,
    projectRoot: '/project',
    ultimateRoot: '/ultimate',
    userHome: '/user',
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    onOpen: () => {},
    onClose: () => {},
  } as unknown as ExtensionHost
  vi.mocked(spawnGroup).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null,
      signalCode: null,
      stdout: {
        on: (_event: string, listener: (chunk: Buffer) => void) =>
          listener(Buffer.from('Ultimate: http://127.0.0.1:12345\n')),
      },
      stderr: new EventEmitter(),
    })
    return { child } as unknown as ReturnType<typeof spawnGroup>
  })
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => new Response('{}')),
  )
  instance(host)
  const service = host.want(InstanceApi)!
  const first = await service.start({ home: join(home, 'scratch1') })
  expect(first).toMatchObject({ url: 'http://127.0.0.1:12345' })
  expect(get).not.toHaveBeenCalled()
  expect(spawnGroup).toHaveBeenCalledWith(
    process.execPath,
    ['server/main.ts'],
    expect.objectContaining({
      cwd: '/ultimate',
      env: expect.objectContaining({
        ULTIMATE_PROJECT: '/project',
        ULTIMATE_HOME: join(home, 'scratch1'),
      }),
    }),
  )
  expect(await actions.list(null, { host } as ActionContext)).toEqual([])
  await service.start({ home: join(home, 'scratch2') })
  await service.start({ home: join(home, 'scratch3') })
  await expect(service.start({ home: join(home, 'scratch4') })).rejects.toThrow('At most three')
  await service.stop(first.id)
  expect(stopGroup).toHaveBeenCalledWith(123, expect.anything())
  await expect(service.stop(first.id)).rejects.toThrow('Unknown instance')
  await expect(service.start({ home })).rejects.toThrow('cannot share the running server home')
})
