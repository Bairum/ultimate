import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { decisionChanges } from '../server/project-setup.ts'
import { watchOnce } from '../server/watch-once.ts'

function fakeWatcher() {
  const watcher = Object.assign(new EventEmitter(), {
    added: [] as string[][],
    unwatched: [] as string[][],
    add(paths: string | readonly string[]) {
      watcher.added.push([paths].flat())
      return watcher
    },
    unwatch(paths: string | readonly string[]) {
      watcher.unwatched.push([paths].flat())
      return watcher
    },
  })
  return watcher
}

it('adds a path once, skips paths inside a watched folder, and adds a deleted path again', () => {
  const watcher = fakeWatcher()
  watchOnce(watcher as never)
  watcher.add(['/repo/extensions', '/elsewhere/a.ts'])
  watcher.add('/elsewhere/a.ts')
  watcher.add(['/repo/extensions/x/web.tsx', '/repo/extensions'])
  watcher.add(['/elsewhere/b.ts', '/elsewhere/b.ts'])
  expect(watcher.added).toEqual([['/repo/extensions', '/elsewhere/a.ts'], ['/elsewhere/b.ts']])
  // Chokidar drops a deleted path's listeners; once it is back, adding it must reach chokidar.
  watcher.emit('unlink', '/elsewhere/a.ts')
  watcher.emit('unlinkDir', '/repo/extensions')
  watcher.add(['/elsewhere/a.ts', '/repo/extensions/x/web.tsx', '/elsewhere/b.ts'])
  expect(watcher.added.at(-1)).toEqual(['/elsewhere/a.ts', '/repo/extensions/x/web.tsx'])
  watcher.unwatch('/elsewhere/b.ts')
  watcher.add('/elsewhere/b.ts')
  expect(watcher.unwatched).toEqual([['/elsewhere/b.ts']])
  expect(watcher.added.at(-1)).toEqual(['/elsewhere/b.ts'])
})

it("reports a trust.json change only when this project's decision or its read error changed", async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-trust-changes-'))
  const project = join(home, 'project')
  await mkdir(project)
  const store = new ProjectTrustStore(join(home, '.ultimate'))
  const changed = decisionChanges(project, home)
  store.set(join(home, 'other'), true)
  expect(changed()).toBe(false)
  store.set(project, true)
  expect(changed()).toBe(true)
  expect(changed()).toBe(false)
  store.set(join(home, 'other'), null)
  expect(changed()).toBe(false)
  await writeFile(join(home, '.ultimate/trust.json'), '{bad')
  expect(changed()).toBe(true)
  await writeFile(join(home, '.ultimate/trust.json'), '{}')
  expect(changed()).toBe(true)
})
