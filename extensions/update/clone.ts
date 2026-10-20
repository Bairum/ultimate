/** The Ultimate clone against origin: what it lacks, what that touches, and fetching it at most hourly. */
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Git } from '../../lib/fast-forward.ts'
import { fetchOrigin, standing } from '../../lib/fast-forward.ts'
import type { Layers, UpdateState } from './refs.ts'

/** Origin is fetched when the last fetch of the clone, by any Ultimate on it, is older than this. */
export const FETCH_EVERY = 60 * 60_000

/** Which layers `files` (paths from the repository root) touch. */
export function layersOf(files: string[]): Layers {
  const layers = { core: false, bin: false, lockfile: false, live: false }
  for (const file of files)
    if (/^(server|shared)\//.test(file)) layers.core = true
    else if (file.startsWith('bin/')) layers.bin = true
    else if (file === 'pnpm-lock.yaml') layers.lockfile = true
    else layers.live = true
  return layers
}

/** When origin was last fetched into the clone (`FETCH_HEAD`'s mtime), or undefined before the first fetch. */
export async function fetchedAt(git: Git, root: string) {
  const path = await git('rev-parse', '--git-path', 'FETCH_HEAD')
  return stat(isAbsolute(path) ? path : join(root, path)).then(
    (info) => info.mtimeMs,
    () => undefined,
  )
}

/** Fetch origin when the last fetch is older than `FETCH_EVERY`; the error of a failed fetch, else undefined. */
export async function fetchIfDue(git: Git, root: string, now: number) {
  const last = await fetchedAt(git, root)
  if (last !== undefined && now - last < FETCH_EVERY) return undefined
  return fetchOrigin(git).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

/** The clone against `origin/<default branch>` as of the last fetch: commits behind, what they touch, refusals. */
export async function cloneState(
  git: Git,
  root: string,
): Promise<
  Pick<UpdateState, 'branch' | 'behind' | 'commits' | 'layers' | 'refused' | 'fetchedAt'> & {
    head: string
    remoteHead?: string
  }
> {
  const head = await git('rev-parse', 'HEAD')
  const at = await fetchedAt(git, root)
  const state = await standing(git)
  const result = {
    head,
    branch: state.branch,
    behind: state.behind,
    commits: [] as UpdateState['commits'],
    ...(state.refused ? { refused: state.refused } : {}),
    ...(at !== undefined ? { fetchedAt: at } : {}),
  }
  if (!state.behind) return result
  const range = `HEAD..${state.remote}`
  const log = await git('log', '-5', '--format=%h%x09%s', range)
  const files = await git('diff', '--name-only', 'HEAD', state.remote)
  return {
    ...result,
    remoteHead: await git('rev-parse', state.remote),
    commits: log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split('\t')
        return { sha, subject: subject.join('\t') }
      }),
    layers: layersOf(files.split('\n').filter(Boolean)),
  }
}
