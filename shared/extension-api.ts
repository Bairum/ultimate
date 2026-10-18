/**
 * The typed contract of one extension service: a name plus a phantom service type. Lives in an extension's `api.ts`;
 * the provider passes it to `host.implement`, consumers to `host.need` or `host.want`. Browser-safe.
 */
export type Api<Name extends string, Service> = {
  readonly name: Name
  /** Phantom: carries the service type; never set at runtime. */
  readonly service?: Service
}

/** `defineApi<WorkspaceService>()('workspaces')`: the service type is explicit, the name is inferred. */
export const defineApi =
  <Service>() =>
  <Name extends string>(name: Name): Api<Name, Service> => ({ name })

/**
 * A document the browser reads by kind, typed by its value: the web half of a server facet's `docs`. Lives in an
 * extension's `refs.ts`; `useDoc(ref)` and `useDocOf(conversation, ref)` take it. Browser-safe.
 */
export type DocRef<T> = {
  readonly kind: string
  /** Phantom: carries the value type; never set at runtime. */
  readonly value?: T
}

/** `docRef<WorkspaceIndex>('ultimate.workspaces')`: the document kind with its value type. */
export const docRef = <T>(kind: string): DocRef<T> => ({ kind })

/**
 * An action of an extension's server facet (`export const actions`), typed by its arguments and result. Lives in an
 * extension's `refs.ts`; `api.action(ref, args)` and `useAction(ref, args)` take it. Browser-safe.
 */
export type ActionRef<Args, Result> = {
  readonly extension: string
  readonly name: string
  /** Phantom: carries the argument type; never set at runtime. */
  readonly args?: Args
  /** Phantom: carries the result type; never set at runtime. */
  readonly result?: Result
}

/** `actionRef<{ id: number }, WorkspaceInfo | null>('workspaces', 'info')`; actions without arguments take `null`. */
export const actionRef = <Args, Result>(
  extension: string,
  name: string,
): ActionRef<Args, Result> => ({
  extension,
  name,
})

/** Who provides and who consumes each API, as `host.catalogue()` reports it. */
export type Catalogue = {
  apis: { name: string; provider?: string; needs: string[]; wants: string[] }[]
  /** Needed APIs no enabled extension provides. */
  missing: string[]
  /** Groups of extensions that depend on each other in a cycle over needs and wants, each sorted. */
  cycles: string[][]
}
