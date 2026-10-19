/**
 * Reads of another project's stored history, for codemode's `{ project }` option: only from a running instance of it,
 * over that instance's own API (loopback here, its writer's tailnet address elsewhere). Nothing falls back to a copy.
 */
import type { JsonValue } from '@earendil-works/chord'
import type { Project } from '../../cloud/directory.ts'
import { cloudConfig, httpBase } from '../../lib/cloud.ts'
import { projectIdentity } from '../../lib/project-identity.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/** What `codemode.read` answers: the same reads codemode offers for its own project. */
export const READS = ['conversations', 'entries', 'search', 'trace', 'traceTree'] as const
export type Read = (typeof READS)[number]
/** At most this much JSON comes back from another project; a larger answer asks for a smaller `limit`. */
export const READ_BYTES = 1024 * 1024
/** `codemode.read`'s error on an instance serving standby, which has no storage open. */
export const STANDBY = 'standby: this instance serves without storage'

type LocalProject = { name: string; root?: string; current: boolean; running?: { url: string } }
type Target = { current: true } | { url: string; label: string }

const ago = (at: number | undefined, now: number) => {
  if (!at) return 'at an unknown time'
  const minutes = Math.round((now - at) / 60000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/**
 * Where `project` (a name such as `poe2-rust` or a key such as `github.com/hazat/poe2-rust`) answers: this project, a
 * running project on this machine, or its writer on the tailnet. Throws a sentence that names the machine when the
 * project is not running anywhere it can be reached.
 */
const naming = (project: string) => (item: { name?: string; key?: string; slug?: string }) =>
  [item.name, item.key, item.slug].some((value) => value?.toLowerCase() === project.toLowerCase())

export function resolveProject(
  project: string,
  local: (LocalProject & { key?: string })[],
  directory: Project[] | undefined,
  now = Date.now(),
): Target {
  const named = naming(project)
  const here = local.filter(named)
  if (here.length > 1)
    throw new Error(
      `${project} names ${here.length} projects on this machine: ${here.map((item) => item.root).join(', ')}; use its key`,
    )
  const listed = directory?.filter(named) ?? []
  const [found] = here
  if (found?.current) return { current: true }
  if (found?.running) return { url: found.running.url, label: `${found.name} on this machine` }
  const [entry] = listed
  const writer = entry?.writer
  if (writer?.machine && writer.online && writer.tailnet)
    return { url: writer.tailnet, label: `${entry.name} on ${writer.machine}` }
  if (writer?.machine && !writer.online)
    throw new Error(
      `${entry.name} runs on ${writer.machine}, which is offline (last seen ${ago(writer.lastSeen, now)}); start Ultimate there to query it`,
    )
  if (writer?.machine)
    throw new Error(
      `${entry.name} runs on ${writer.machine}, which has published no tailnet address; enable the tailscale extension there`,
    )
  if (entry) {
    const last = entry.machines.toSorted((a, b) => b.lastSeen - a.lastSeen)[0]
    throw new Error(
      `${entry.name} is on standby${last ? ` (last on ${last.machine}, ${ago(last.lastSeen, now)})` : ''}; start it there to query it`,
    )
  }
  if (found) throw new Error(`${found.name} is not running on this machine; start it to query it`)
  const known = [
    ...new Set([...local.map((item) => item.name), ...(directory ?? []).map((item) => item.name)]),
  ]
  throw new Error(
    `Unknown project ${project}${directory ? '' : ' on this machine (cloud sync is off, so other machines are not listed)'}. Known: ${known.join(', ') || 'none'}`,
  )
}

/** The fleet directory, or undefined without cloud sync. A failing cloud is an error: it is the only map of the fleet. */
async function fleetDirectory(host: ExtensionHost, signal?: AbortSignal) {
  const cloud = await cloudConfig(host)
  if (!cloud) return undefined
  const response = await fetch(new URL('/sync/directory', httpBase(cloud.url)), {
    headers: { Authorization: `Bearer ${cloud.token}` },
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) throw new Error(`The fleet directory answered ${response.status}`)
  return (await response.json()) as Project[]
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
  // A project this machine runs needs no cloud; anything else asks the fleet where it runs.
  const directory = local.some((item) => naming(project)(item) && (item.current || item.running))
    ? undefined
    : await fleetDirectory(host, signal)
  const target = resolveProject(project, local, directory)
  if ('current' in target) return undefined
  let answer = await post(target, op, args, signal)
  const fleet = answer.standby && directory === undefined && (await fleetDirectory(host, signal))
  if (fleet) {
    // A local instance on standby serves no history: the fleet names the machine that writes the project.
    const parked = local.map((item) =>
      naming(project)(item) ? { ...item, running: undefined } : item,
    )
    const writer = resolveProject(project, parked, fleet)
    if (!('current' in writer)) answer = await post(writer, op, args, signal)
  }
  if (answer.standby) throw new Error(`${project} is on standby here and its writer is unknown`)
  return { value: answer.value }
}

/** Ask `target`'s `codemode.read`; `standby` when that instance serves without storage. */
async function post(
  target: { url: string; label: string },
  op: Read,
  args: JsonValue[],
  signal?: AbortSignal,
): Promise<{ value?: unknown; standby?: true }> {
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
  if (!response.ok && body.error === STANDBY) return { standby: true }
  if (!response.ok) throw new Error(`${target.label}: ${body.error ?? response.status}`)
  return { value: body.result }
}
