// The commit a deploy tags the Worker version with, so `wrangler versions view` tells whether cloud/ changed since.
export type Git = (...args: string[]) => { status: number | null; stdout: string | null }

/** `--tag <short sha>[-dirty] --message <subject>` for `wrangler deploy`; throws when git cannot tell. */
export function versionArgs(git: Git): string[] {
  const run = (...args: string[]) => {
    const { status, stdout } = git(...args)
    const out = stdout?.trim() ?? ''
    if (status !== 0) throw new Error(`git ${args.join(' ')} failed`)
    return out
  }
  const sha = run('rev-parse', '--short', 'HEAD')
  if (!sha) throw new Error('git rev-parse returned no commit')
  const dirty = run('status', '--porcelain', '--', '.') ? '-dirty' : ''
  return ['--tag', `${sha}${dirty}`, '--message', run('log', '-1', '--format=%s')]
}
