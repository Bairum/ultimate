/** Runs git in the checkout: resolves stdout, rejects with an Error naming the command and its output. */
export type Git = (...args: string[]) => Promise<string>

/**
 * The same GitHub repository over the other transport: SSH (`git@github.com:o/r.git`, `ssh://git@github.com/o/r`)
 * becomes `https://github.com/o/r.git` and HTTPS becomes `git@github.com:o/r.git`; undefined for any other remote.
 */
export function otherTransport(url: string): string | undefined {
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
    url.trim(),
  )
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`
  const https = /^https:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
    url.trim(),
  )
  if (https) return `git@github.com:${https[1]}/${https[2]}.git`
  return undefined
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Fetch origin; when that fails and origin is on GitHub, fetch once over the other transport into origin's refs,
 * without touching the remote's configuration (a machine may have only an SSH key or only an HTTPS login). After a
 * fallback, a missing `origin/HEAD` is set from the other transport's HEAD. Both failures are named when both fail.
 */
export async function fetchOrigin(git: Git): Promise<void> {
  try {
    await git('fetch', '--quiet', 'origin')
    return
  } catch (error) {
    const alternative = otherTransport(await git('remote', 'get-url', 'origin').catch(() => ''))
    if (!alternative) throw error
    try {
      await git('fetch', '--quiet', alternative, '+refs/heads/*:refs/remotes/origin/*')
    } catch (second) {
      throw new Error(`${message(error)}\nRetry over ${alternative}: ${message(second)}`, {
        cause: second,
      })
    }
    const head = await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').catch(() => '')
    if (head) return
    // `git remote set-head origin --auto` would ask origin's failing transport, so ask the working one.
    const symref = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(
      await git('ls-remote', '--symref', alternative, 'HEAD').catch(() => ''),
    )
    if (symref)
      await git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${symref[1]}`)
  }
}
