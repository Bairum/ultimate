import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api } from '@/sdk'
import type { JsonObject } from '@/sdk'
import type { OverviewRow } from '../conversations/types.ts'
import type { Workspace } from '../workspaces/types.ts'
import type { CanvasAgent, CanvasTree, Conclusion } from './types.ts'

const CANVAS = 'ultimate.canvas'
const OVERVIEW = 'ultimate.conversation-overview'
const WORKSPACES = 'ultimate.workspaces'

/** The root documents the map reads, replaced immutably: a row that did not change keeps its identity. */
export type Feed = {
  agents: Readonly<Record<string, CanvasAgent>>
  trees: Readonly<Record<string, CanvasTree>>
  rows: Readonly<Record<string, OverviewRow>>
  workspaces: Readonly<Record<string, Workspace>>
  /** Every streamed document has arrived. */
  loaded: boolean
}
const empty: Feed = { agents: {}, trees: {}, rows: {}, workspaces: {}, loaded: false }
let feed = empty
let docs: Record<string, JsonObject | null> = {}
let kinds: string[] = []
const listeners = new Set<() => void>()
let stream: EventSource | undefined

function publish() {
  feed = {
    agents: (docs[CANVAS]?.agents ?? {}) as Feed['agents'],
    trees: (docs[CANVAS]?.trees ?? {}) as Feed['trees'],
    rows: (docs[OVERVIEW]?.conversations ?? {}) as Feed['rows'],
    workspaces: (docs[WORKSPACES]?.items ?? {}) as Feed['workspaces'],
    loaded: kinds.length > 0 && kinds.every((kind) => kind in docs),
  }
  for (const notify of listeners) notify()
}

/** One stream on the root conversation carries every document, however many panels show. */
function open() {
  if (stream || !listeners.size || !kinds.length) return
  stream = new EventSource(`/api/events?conversation=1&docs=${kinds.join(',')}`)
  stream.addEventListener('doc', (event) => {
    const data = JSON.parse(event.data) as { kind: string; value: JsonObject | null }
    if (!kinds.includes(data.kind)) return
    docs = { ...docs, [data.kind]: data.value }
    publish()
  })
  stream.addEventListener('docOps', (event) => {
    const data = JSON.parse(event.data) as { kind: string; ops: Op[] }
    const value = docs[data.kind]
    if (!kinds.includes(data.kind) || !value) return
    docs = { ...docs, [data.kind]: applyImmutable(value, data.ops) }
    publish()
  })
}
function close() {
  stream?.close()
  stream = undefined
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  open()
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    close()
    docs = {}
    feed = empty
  }
}

/** Streams the canvas feed, plus the overview and workspaces documents of the extensions that are enabled. */
export function useFeedDocuments(overview: boolean, workspaces: boolean) {
  const wanted = [CANVAS, ...(overview ? [OVERVIEW] : []), ...(workspaces ? [WORKSPACES] : [])]
  const key = wanted.join(',')
  useEffect(() => {
    if (kinds.join(',') === key) return
    kinds = key.split(',')
    docs = Object.fromEntries(Object.entries(docs).filter(([kind]) => kinds.includes(kind)))
    close()
    open()
    publish()
  }, [key])
}

export type Totals = {
  input: number
  output: number
  cacheRead: number
  cost: number
  agents: number
}
/** Spend added up over `ids`; re-renders only when a sum changes. */
export function useTotals(ids: readonly number[]): Totals {
  const key = useSyncExternalStore(subscribe, () => {
    const sum = { input: 0, output: 0, cacheRead: 0, cost: 0, agents: ids.length }
    for (const id of ids) {
      const usage = feed.agents[id]?.usage
      if (!usage) continue
      sum.input += usage.input
      sum.output += usage.output
      sum.cacheRead += usage.cacheRead
      sum.cost += usage.cost
    }
    return JSON.stringify(sum)
  })
  return useMemo(() => JSON.parse(key) as Totals, [key])
}

export const getFeed = () => feed
export const useFeed = () => useSyncExternalStore(subscribe, getFeed)
/** One agent's activity; re-renders only when its own row changes. */
export const useAgentFeed = (id: number): CanvasAgent | undefined =>
  useSyncExternalStore(subscribe, () => feed.agents[id])

/** Full conclusions fetched so far, by conversation, with when each concluded. */
const conclusions = new Map<number, { at: number; value: Promise<Conclusion | null> }>()
/**
 * A tree's full conclusion (summary, commits, thumbnail), fetched once per conclusion while its card shows: the map
 * document carries only the small fields.
 */
export function useConclusion(id: number, at: number | undefined) {
  const [value, setValue] = useState<Conclusion | null>()
  useEffect(() => {
    if (at === undefined) return undefined
    let known = conclusions.get(id)
    if (known?.at !== at) {
      known = {
        at,
        value: api.action<Conclusion | null>('canvas', 'conclusion', { id }).catch(() => null),
      }
      conclusions.set(id, known)
    }
    let current = true
    void known.value.then((fetched) => {
      if (current) setValue(fetched)
    })
    return () => {
      current = false
    }
  }, [id, at])
  return at === undefined || value?.at !== at ? undefined : value
}
