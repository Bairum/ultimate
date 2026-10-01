/** Compact token counts, as Pi's footer prints them: 950, 1.2k, 18k, 1.4M. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 420ms, 3.2s, 1m 04s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** The home directory of `user` as it prefixes `path`, if it does: /home/<user> or /Users/<user>. */
export function homeOf(path: string, user: string | undefined): string | undefined {
  if (!user) return undefined
  return [`/home/${user}`, `/Users/${user}`].find(
    (home) => path === home || path.startsWith(home + '/'),
  )
}

/** Show `path` relative to `cwd` when inside it, else with `~` for the home directory. */
export function shortenPath(path: string, options: { cwd?: string; user?: string } = {}): string {
  const { cwd, user } = options
  if (cwd && path.startsWith(cwd.replace(/\/$/, '') + '/'))
    return path.slice(cwd.replace(/\/$/, '').length + 1)
  const home = homeOf(path, user)
  return home ? '~' + path.slice(home.length) : path
}

/** Elide the middle of a path to at most `max` characters, keeping its first and last segments. */
export function elidePath(path: string, max = 40): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  let head = parts.slice(0, parts[0] === '~' || parts[0] === '' ? 2 : 1).join('/')
  let tail = parts.at(-1) ?? ''
  for (let index = parts.length - 2; index > 1; index--) {
    const next = `${parts[index]}/${tail}`
    if (head.length + next.length + 2 > max) break
    tail = next
  }
  if (head.length + tail.length + 2 > max) head = head.slice(0, Math.max(1, max - tail.length - 2))
  return `${head}/…/${tail}`
}
