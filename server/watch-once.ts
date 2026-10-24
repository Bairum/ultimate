import { dirname, resolve } from 'node:path'
import type { ViteDevServer } from 'vite-plus'

type Watcher = Pick<ViteDevServer['watcher'], 'add' | 'unwatch' | 'on'>

/**
 * Add each path to the watcher once. Vite's chokidar 3 attaches another listener to its fsevents stream for every
 * `add`, even of a path it already watches, and keeps it until the path is removed. Tailwind re-adds every scanned
 * source on each CSS rebuild, so without this a long-lived host ends up running a million listeners per file event.
 */
export function watchOnce(watcher: Watcher) {
  const added = new Set<string>()
  const covered = (path: string) => {
    for (let current = path; ; current = dirname(current)) {
      if (added.has(current)) return true
      if (dirname(current) === current) return false
    }
  }
  const forget = (path: string) => {
    for (const watched of added)
      if (watched === path || watched.startsWith(path + '/')) added.delete(watched)
  }
  const add = watcher.add.bind(watcher)
  const unwatch = watcher.unwatch.bind(watcher)
  watcher.add = (paths) => {
    const fresh = [...new Set([paths].flat().map((path) => resolve(path)))].filter(
      (path) => !covered(path),
    )
    for (const path of fresh) added.add(path)
    return fresh.length ? add(fresh) : (watcher as ReturnType<typeof add>)
  }
  watcher.unwatch = (paths) => {
    for (const path of [paths].flat()) forget(resolve(path))
    return unwatch(paths)
  }
  // Chokidar drops the listeners of a deleted path, so a path that comes back must be added again.
  watcher.on('unlink', forget)
  watcher.on('unlinkDir', forget)
}
