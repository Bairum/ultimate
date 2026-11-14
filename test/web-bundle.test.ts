import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWeb } from '../server/web.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

// The bundle server checked a requested path only as text, so a symlink inside the bundle served any file (#95583).
it('serves bundle files but not what a symlink inside the bundle points at', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const home = join(root, 'home')
  const bundle = join(home, 'web', 'b1')
  await mkdir(join(bundle, 'assets'), { recursive: true })
  await writeFile(join(bundle, 'index.html'), '<html><head></head></html>')
  await writeFile(join(bundle, 'assets', 'app.js'), 'app')
  await writeFile(join(root, 'secret.txt'), 'secret')
  await symlink(join(root, 'secret.txt'), join(bundle, 'assets', 'leak.js'))
  const manifest = { id: 'b1', at: Date.now() + 60_000, inputs: [], facets: [], broken: [] }
  await writeFile(join(home, 'web', 'manifest.json'), JSON.stringify(manifest))
  const web = await createWeb({
    ultimateRoot: join(root, 'repo'),
    projectRoot: join(root, 'project'),
    userHome: join(root, 'user'),
    home,
    watch: () => () => {},
    before: async () => true,
    pages: () => 0,
    changed: () => {},
    notice: () => {},
  })
  cleanup.push(async () => web.close())
  const server = createServer((request, response) => void web.handle(request, response))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise((done) => server.close(() => done())))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  expect(await (await fetch(url + '/assets/app.js')).text()).toBe('app')
  const leak = await fetch(url + '/assets/leak.js')
  expect(leak.status).toBe(404)
  expect(await leak.text()).not.toContain('secret')
})

// #116515: a gate failing because packages are not the lockfile's must hold every build, the first one too.
it('holds a build while `before` fails: the old bundle keeps serving, and without one pages get a 503', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const home = join(root, 'home')
  let builds = 0
  const web = await createWeb({
    ultimateRoot: join(root, 'repo'),
    projectRoot: join(root, 'project'),
    userHome: join(root, 'user'),
    home,
    watch: () => () => {},
    before: async () => {
      builds++
      return false
    },
    pages: () => 0,
    changed: () => {},
    notice: () => {},
  })
  cleanup.push(async () => web.close())
  const server = createServer((request, response) => void web.handle(request, response))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise((done) => server.close(() => done())))
  const page = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
  expect(page.status).toBe(503)
  expect(await page.text()).toContain('waiting for its packages')
  expect(builds).toBe(1)
  expect(web.info().id).toBe('')
})
