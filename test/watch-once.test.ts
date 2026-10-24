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

it('adds a path once, skips paths inside a watched folder, and adds a deleted, unwatched or new path again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-watch-once-'))
  const extensions = join(root, 'extensions'),
    a = join(root, 'a.ts'),
    b = join(root, 'b.ts'),
    web = join(extensions, 'x/web.tsx'),
    later = join(root, 'later')
  await mkdir(join(extensions, 'x'), { recursive: true })
  for (const file of [a, b, web]) await writeFile(file, '')
  const watcher = fakeWatcher()
  watchOnce(watcher as never)
  watcher.add([extensions, a])
  watcher.add(a)
  watcher.add([web, extensions])
  watcher.add([b, b])
  expect(watcher.added).toEqual([[extensions, a], [b]])
  // Without fsevents chokidar drops a deleted path's watcher; once it is back, adding it must reach chokidar.
  watcher.emit('unlink', a)
  watcher.emit('unlinkDir', extensions)
  watcher.add([a, web, b])
  expect(watcher.added.at(-1)).toEqual([a, web])
  watcher.unwatch(b)
  watcher.add(b)
  expect(watcher.unwatched).toEqual([[b]])
  expect(watcher.added.at(-1)).toEqual([b])
  // A root added before it exists is added again when it appears (watch-roots.ts).
  watcher.add(later)
  await mkdir(later)
  watcher.add(later)
  watcher.add(later)
  expect(watcher.added.slice(-2)).toEqual([[later], [later]])
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
