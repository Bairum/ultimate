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

/** Who provides and who consumes each API, as `host.catalogue()` reports it. */
export type Catalogue = {
  apis: { name: string; provider?: string; needs: string[]; wants: string[] }[]
  /** Needed APIs no enabled extension provides. */
  missing: string[]
  /** Groups of extensions that depend on each other in a cycle over needs and wants, each sorted. */
  cycles: string[][]
}
