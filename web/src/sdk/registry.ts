import type { ComponentType } from 'react'
import type {
  CommandContribution,
  Contribution,
  EntryRenderer,
  PanelContribution,
  SlotName,
  ToolRenderer,
  ViewContribution,
  WebExtension,
} from './types.ts'

/** Lazily imports one `extensions/<name>/web.tsx`; the key of its loader is the file path. */
export type ExtensionLoader = () => Promise<unknown>

export interface ExtensionRecord {
  name: string
  /** The installed version; kept when a later load fails, like the server facet. */
  extension?: WebExtension
  /** Why the latest load failed. */
  error?: string
  loading: boolean
  /** Bumped on every install, so error boundaries reset. */
  version: number
}

export interface SlotItem {
  key: string
  extension: string
  version: number
  component: ComponentType
}
export interface PanelItem extends PanelContribution {
  extension: string
  version: number
}
export interface ViewItem extends ViewContribution {
  extension: string
  version: number
}
export interface CommandItem extends CommandContribution {
  extension: string
}

export function extensionName(path: string): string | undefined {
  return /extensions\/([^/]+)\/web\.tsx(?:\?.*)?$/.exec(path)?.[1]
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function validate(module: unknown): WebExtension {
  const extension =
    module && typeof module === 'object' && 'default' in module ? module.default : undefined
  if (!extension || typeof extension !== 'object')
    throw new Error('web.tsx must default-export defineWebExtension({ … })')
  return extension
}

/**
 * The installed web facets. Each loads on its own: a broken one records its error and leaves the others (and its own
 * previous version) running.
 */
export function createRegistry() {
  let records: readonly ExtensionRecord[] = []
  const tokens = new Map<string, object>()
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const update = (name: string, change: (record: ExtensionRecord) => ExtensionRecord) => {
    records = records.map((record) => (record.name === name ? change(record) : record))
    emit()
  }
  const install = (name: string, module: unknown) => {
    try {
      const extension = validate(module)
      update(name, (record) =>
        record.extension === extension && !record.error && !record.loading
          ? record
          : { name, extension, loading: false, version: record.version + 1 },
      )
    } catch (error) {
      fail(name, error)
    }
  }
  const fail = (name: string, error: unknown) =>
    update(name, (record) => ({ ...record, loading: false, error: message(error) }))

  return {
    getSnapshot: () => records,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Load every facet in `loaders`, drop facets that are gone, and settle when all loads have. */
    async setLoaders(loaders: Readonly<Record<string, ExtensionLoader>>) {
      const entries = Object.entries(loaders)
        .flatMap(([path, loader]) => {
          const name = extensionName(path)
          return name ? [{ name, loader }] : []
        })
        .toSorted((a, b) => a.name.localeCompare(b.name))
      const previous = new Map(records.map((record) => [record.name, record]))
      records = entries.map(({ name }) => previous.get(name) ?? { name, loading: true, version: 0 })
      emit()
      await Promise.allSettled(
        entries.map(async ({ name, loader }) => {
          const token = {}
          tokens.set(name, token)
          try {
            const module = await loader()
            if (tokens.get(name) === token) install(name, module)
          } catch (error) {
            if (tokens.get(name) === token) fail(name, error)
          }
        }),
      )
    },
    /** Install a facet that hot-reloaded on its own. */
    replace(name: string, module: unknown) {
      tokens.set(name, {})
      install(name, module)
    },
    /** Record a failed hot reload; the previous version stays installed. */
    fail(name: string, error: unknown) {
      if (records.some((record) => record.name === name)) fail(name, error)
    },
  }
}
export type Registry = ReturnType<typeof createRegistry>

function normalize(value: Contribution | readonly Contribution[] | undefined) {
  if (!value) return []
  const list: readonly Contribution[] = Array.isArray(value) ? value : [value as Contribution]
  return list.map((item) =>
    typeof item === 'function' ? { component: item, order: 0 } : { order: 0, ...item },
  )
}

/** Components for a slot, by `order`, then folder name, then position. */
export function slotItems(records: readonly ExtensionRecord[], slot: SlotName): SlotItem[] {
  return records
    .flatMap(({ name, extension, version }) =>
      normalize(extension?.slots?.[slot]).map((item, index) => ({
        key: `${name}:${index}`,
        extension: name,
        version,
        component: item.component,
        order: item.order ?? 0,
      })),
    )
    .toSorted((a, b) => a.order - b.order)
    .map(({ order: _order, ...item }) => item)
}

export function panelItems(records: readonly ExtensionRecord[]): PanelItem[] {
  return records
    .flatMap(({ name, extension, version }) =>
      (extension?.panels ?? []).map((panel) => ({ ...panel, extension: name, version })),
    )
    .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function viewItems(records: readonly ExtensionRecord[]): ViewItem[] {
  return records
    .flatMap(({ name, extension, version }) =>
      (extension?.views ?? []).map((view) => ({ ...view, extension: name, version })),
    )
    .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function commandItems(records: readonly ExtensionRecord[]): CommandItem[] {
  return records.flatMap(({ name, extension }) =>
    (extension?.commands ?? []).map((command) => ({ ...command, extension: name })),
  )
}

/** The renderer for a tool or entry kind; the last extension in folder order wins. */
export function rendererFor<K extends 'tools' | 'entries'>(
  records: readonly ExtensionRecord[],
  kind: K,
  key: string,
):
  | {
      extension: string
      version: number
      component: K extends 'tools' ? ToolRenderer : EntryRenderer
    }
  | undefined {
  for (const record of records.toReversed()) {
    const component = record.extension?.[kind]?.[key]
    if (component)
      return {
        extension: record.name,
        version: record.version,
        component: component as K extends 'tools' ? ToolRenderer : EntryRenderer,
      }
  }
  return undefined
}
