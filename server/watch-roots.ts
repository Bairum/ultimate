import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'

/** Watch missing roots through their nearest existing parent, without scanning siblings. */
export function watchRoots(roots: string[], appeared: (root: string) => void) {
  const cleanups = roots.map((root) => {
    let closed = false
    let present = existsSync(root)
    let watcher: ReturnType<typeof watch>
    const attach = () => {
      let ancestor = dirname(root)
      while (!existsSync(ancestor)) ancestor = dirname(ancestor)
      for (;;) {
        try {
          watcher = watch(ancestor, () => {
            if (closed) return
            watcher.close()
            attach()
          })
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          ancestor = dirname(ancestor)
        }
      }
      const next = existsSync(root)
      if (next && !present) appeared(root)
      present = next
    }
    attach()
    return () => {
      closed = true
      watcher.close()
    }
  })
  return () => cleanups.forEach((close) => close())
}
