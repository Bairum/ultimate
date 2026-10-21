/**
 * Reads of another project's stored history, for codemode's `{ project }` option: only from a running instance of it,
 * over that instance's own API (loopback here, the tailnet address its last backup registered elsewhere). Nothing
 * falls back to a copy.
 */
import type { JsonValue } from '@earendil-works/chord'
import { cloudConfig, fetchRegister } from '../../lib/cloud.ts'
import type { Register } from '../../lib/cloud.ts'
import { projectIdentity } from '../../lib/project-identity.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/** What `codemode.read` answers: the same reads codemode offers for its own project. */
export const READS = ['conversations', 'entries', 'search', 'trace', 'traceTree'] as const
export type Read = (typeof READS)[number]
/** At most this much JSON comes back from another project; a larger answer asks for a smaller `limit`. */
export const READ_BYTES = 1024 * 1024

type LocalProject = { name: string; root?: string; current: boolean; running?: { url: string } }
type Target = { current: true } | { url: string; label: string }

const naming = (project: string) => (item: { name?: string; key?: string }) =>
  [item.name, item.key].some((value) => value?.toLowerCase() === project.toLowerCase())

/**
 * Where `project` (a name such as `poe2-rust` or a key such as `github.com/hazat/poe2-rust`) answers: this project, a
 * running project on this machine, or the tailnet address of the machine that last backed it up. Throws a sentence
 * naming that machine when it registered no address.
 */
export function resolveProject(
  project: string,
  local: (LocalProject & { key?: string })[],
  register: Register | undefined,
): Target {
  const named = naming(project)
  const here = local.filter(named)
  if (here.length > 1)
    throw new Error(
      `${project} names ${here.length} projects on this machine: ${here.map((item) => item.root).join(', ')}; use its key`,
    )
  const [found] = here
  if (found?.current) return { current: true }
  if (found?.running) return { url: found.running.url, label: `${found.name} on this machine` }
  const entry = register?.projects.find(named)
  if (entry) {
    const { machine } = entry.latest
    const tailnet =
      entry.latest.tailnet ??
      register!.machines.find((item) => item.machine === machine)?.projects[entry.hash]?.tailnet
    if (tailnet) return { url: tailnet, label: `${entry.name} on ${machine}` }
    throw new Error(
      `${entry.name} was last backed up from ${machine}, which registered no tailnet address`,
    )
  }
  if (found) throw new Error(`${found.name} is not running on this machine; start it to query it`)
  const known = [
    ...new Set([
      ...local.map((item) => item.name),
      ...(register?.projects ?? []).map((item) => item.name),
    ]),
  ]
  throw new Error(
    `Unknown project ${project}${register ? '' : ' on this machine (cloud backups are off, so other machines are not listed)'}. Known: ${known.join(', ') || 'none'}`,
  )
}

/** Run read `op` in `project`: undefined when it is this project, so the caller reads its own storage. */
export async function readProject(
  host: ExtensionHost,
  project: string,
  op: Read,
  args: JsonValue[],
  signal?: AbortSignal,
): Promise<{ value: unknown } | undefined> {
  const projects = await host.projects()
  const local = await Promise.all(
    projects.map(async (item) => ({
      ...item,
      key: project.includes('/') && item.root ? (await projectIdentity(item.root))?.key : undefined,
    })),
  )
  // A project this machine runs needs no cloud; anything else asks the register where it was last backed up.
  const cloud = local.some((item) => naming(project)(item) && (item.current || item.running))
    ? undefined
    : await cloudConfig(host)
  // A failing cloud is an error: the register is the only map of the other machines.
  const register = cloud ? await fetchRegister(cloud) : undefined
  const target = resolveProject(project, local, register)
  if ('current' in target) return undefined
  return { value: await post(target, op, args, signal) }
}

/** Ask `target`'s `codemode.read`. */
async function post(
  target: { url: string; label: string },
  op: Read,
  args: JsonValue[],
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${target.url}/api/extensions/codemode/actions/read`, {
    method: 'POST',
    // The instance admits its own origin; on the tailnet, Serve's identity header names who asks.
    headers: { Origin: new URL(target.url).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: { op, args } }),
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
  }).catch((error: unknown) => {
    throw new Error(`${target.label} did not answer at ${target.url}: ${String(error)}`)
  })
  const text = await response.text()
  if (Buffer.byteLength(text) > READ_BYTES)
    throw new Error(`${target.label} answered more than 1 MiB; ask for a smaller limit`)
  const body = (() => {
    try {
      return JSON.parse(text) as { result?: unknown; error?: string }
    } catch {
      return { error: text.slice(0, 200) }
    }
  })()
  if (response.status === 403)
    throw new Error(
      `${target.label} refused the read (403): your tailnet login is not in its tailscale.allow`,
    )
  if (!response.ok) throw new Error(`${target.label}: ${body.error ?? response.status}`)
  return body.result
}
