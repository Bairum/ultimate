import { defineDoc } from '@earendil-works/pi-durable'
import { diffLines } from 'diff'
import { InMemorySnapshotStore, SnapshotStore, computeFileHash, xxhash32 } from './engine/index.ts'
import type { Snapshot } from './engine/index.ts'

export type Seen = [number, number][] | null
export type Version = { tag: string; hash32: number; seen: Seen }
export type ProvenanceState = {
  paths: Record<string, Version[]>
  registers: { lines?: string[]; named?: Record<string, string[]>; pendingAnonCuts?: string[] }
}
export const Provenance = defineDoc<ProvenanceState>({
  kind: 'hashline.provenance',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ paths: {}, registers: {} }),
})

/** Full 32-bit counterpart of the engine's whitespace-normalized short tag. */
export const hash32 = (text: string) => xxhash32(text.replace(/[ \t\r]+(?=\n|$)/g, ''))
export function ranges(lines: Iterable<number>): [number, number][] {
  const result: [number, number][] = []
  for (const line of [...new Set(lines)].toSorted((a, b) => a - b)) {
    const tail = result.at(-1)
    if (tail && tail[1] + 1 === line) tail[1] = line
    else result.push([line, line])
  }
  return result
}
export function expand(seen: Seen): Set<number> | undefined {
  if (seen === null) return undefined
  const lines = new Set<number>()
  for (const [a, b] of seen) for (let line = a; line <= b; line++) lines.add(line)
  return lines
}

// Text is disposable. Durable provenance gates every lookup, including after rewind/fork.
const texts = new Map<number, InMemorySnapshotStore>()
export function clearTextCache(): void {
  texts.clear()
}
function cache(conversation: number): InMemorySnapshotStore {
  const value = texts.get(conversation) ?? new InMemorySnapshotStore()
  texts.delete(conversation)
  texts.set(conversation, value)
  if (texts.size > 16) texts.delete(texts.keys().next().value!)
  return value
}

export class ConversationSnapshots extends SnapshotStore {
  readonly state: ProvenanceState
  readonly #texts: InMemorySnapshotStore
  readonly #loaded = new Map<string, Snapshot>()
  constructor(conversation: number, state: ProvenanceState) {
    super()
    this.state = state
    this.#texts = cache(conversation)
  }
  #version(path: string, text: string): Version | undefined {
    return this.state.paths[path]?.find(
      (version) => version.hash32 === hash32(text) && version.tag === computeFileHash(text),
    )
  }
  #snapshot(path: string, version: Version | undefined): Snapshot | null {
    if (!version) return null
    const key = `${path}\0${version.hash32}`
    const loaded = this.#loaded.get(key)
    if (loaded) return loaded
    const text = this.#texts
      .findByHash(version.tag)
      .find((snapshot) => snapshot.path === path && hash32(snapshot.text) === version.hash32)
    if (!text) return null
    const snapshot = { ...text, seenLines: expand(version.seen) }
    this.#loaded.set(key, snapshot)
    return snapshot
  }
  head(path: string): Snapshot | null {
    return this.#snapshot(path, this.state.paths[path]?.[0])
  }
  byHash(path: string, tag: string): Snapshot | null {
    return this.#snapshot(
      path,
      this.state.paths[path]?.find((version) => version.tag === tag),
    )
  }
  byContent(path: string, text: string): Snapshot | null {
    return this.#snapshot(path, this.#version(path, text))
  }
  override findByHash(tag: string): Snapshot[] {
    return Object.entries(this.state.paths).flatMap(([path, versions]) =>
      versions
        .filter((version) => version.tag === tag)
        .flatMap((version) => this.#snapshot(path, version) ?? []),
    )
  }
  record(path: string, text: string, seen?: Iterable<number>): string {
    const tag = this.#texts.record(path, text)
    const hash = hash32(text)
    const history = this.state.paths[path] ?? []
    const existing = history.find((version) => version.hash32 === hash && version.tag === tag)
    const snapshot = this.#snapshot(path, existing)
    const lines = snapshot?.seenLines ?? expand(existing?.seen ?? null)
    if (seen !== undefined) {
      const union = lines ?? new Set<number>()
      for (const line of seen) union.add(line)
      if (snapshot) snapshot.seenLines = union
      this.state.paths[path] = [
        { tag, hash32: hash, seen: ranges(union) },
        ...history.filter((version) => version !== existing),
      ].slice(0, 4)
    } else
      this.state.paths[path] = [
        existing ?? { tag, hash32: hash, seen: null },
        ...history.filter((version) => version !== existing),
      ].slice(0, 4)
    return tag
  }
  recordSeenLines(path: string, tag: string, lines: Iterable<number>): void {
    const version = this.state.paths[path]?.find((item) => item.tag === tag)
    if (!version) return
    const snapshot = this.#snapshot(path, version)
    const seen = snapshot?.seenLines ?? expand(version.seen) ?? new Set<number>()
    for (const line of lines) seen.add(line)
    version.seen = ranges(seen)
    if (snapshot) snapshot.seenLines = seen
  }
  /** Explicit write/result provenance replaces, rather than unions, read restrictions. */
  setSeen(path: string, text: string, seen: Iterable<number> | null): void {
    this.record(path, text)
    const version = this.#version(path, text)!
    version.seen = seen === null ? null : ranges(seen)
    this.#loaded.delete(`${path}\0${version.hash32}`)
  }
  /** Rehydrate only text whose full hash was retained by this conversation's history. */
  restore(path: string, text: string): void {
    if (this.#version(path, text)) this.#texts.record(path, text)
  }
  sync(): void {
    for (const snapshot of this.#loaded.values()) {
      const version = this.#version(snapshot.path, snapshot.text)
      if (version)
        version.seen = snapshot.seenLines === undefined ? null : ranges(snapshot.seenLines)
    }
  }
  invalidate(path: string): void {
    delete this.state.paths[path]
  }
  relocate(from: string, to: string): void {
    this.#texts.relocate(from, to)
    this.state.paths[to] = [
      ...(this.state.paths[from] ?? []),
      ...(this.state.paths[to] ?? []),
    ].slice(0, 4)
    delete this.state.paths[from]
  }
  clear(): void {
    this.state.paths = {}
    this.state.registers = {}
    this.#loaded.clear()
    this.#texts.clear()
  }
  override recordNoop(path: string, payload: string): number {
    return this.#texts.recordNoop(path, payload)
  }
  override resetNoop(path: string): void {
    this.#texts.resetNoop(path)
  }
}

/** Carry only unchanged rows whose old and new line numbers are identical. */
export function carriedSeenLines(before: string, after: string, prior: Seen | undefined): number[] {
  const seen = prior === undefined ? undefined : expand(prior)
  const result: number[] = []
  let oldLine = 1,
    newLine = 1
  for (const run of diffLines(before, after)) {
    if (run.added) newLine += run.count
    else if (run.removed) oldLine += run.count
    else {
      if (oldLine === newLine)
        for (let line = newLine; line < newLine + run.count; line++)
          if (!seen || seen.has(line)) result.push(line)
      oldLine += run.count
      newLine += run.count
    }
  }
  return result
}
