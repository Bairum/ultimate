export type ServiceStatus = { state: 'starting' | 'ready' | 'busy' | 'error'; detail?: string }
export type ServiceInfo = ServiceStatus & { extension: string; name: string }
export type ServiceHandle = { update(status: ServiceStatus): void; dispose(): void }

/** Status only: no timers, work ownership or durable state. New facets stage until installation succeeds. */
export function serviceRegistry(changed: (services: ServiceInfo[]) => void) {
  const scopes = new Set<ReturnType<typeof scope>>()
  let visible = false
  const snapshot = () => [...scopes].flatMap((owner) => owner.snapshot())
  let previous = ''
  const publish = () => {
    const services = visible ? snapshot() : []
    const signature = JSON.stringify(services)
    if (signature === previous) return
    previous = signature
    changed(services)
  }
  function scope(extension: string) {
    const entries = new Map<string, ServiceStatus>()
    let disposed = false
    const owner = {
      service(name: string, status: ServiceStatus): ServiceHandle {
        if (disposed) throw new Error('Service facet is disposed')
        if (!name.trim() || entries.has(name))
          throw new Error('Service names must be unique and non-empty')
        let current: ServiceStatus | undefined = { ...status }
        entries.set(name, current)
        if (scopes.has(owner)) publish()
        return {
          update(next) {
            if (disposed || !current) return
            current = { ...next }
            entries.set(name, current)
            if (scopes.has(owner)) publish()
          },
          dispose() {
            if (disposed || !current) return
            current = undefined
            entries.delete(name)
            if (scopes.has(owner)) publish()
          },
        }
      },
      snapshot: () => [...entries].map(([name, status]) => ({ extension, name, ...status })),
      activate() {
        if (disposed) return
        scopes.add(owner)
        publish()
      },
      dispose() {
        disposed = true
        entries.clear()
        if (scopes.delete(owner)) publish()
      },
    }
    return owner
  }
  return {
    scope,
    visible(value: boolean) {
      visible = value
      publish()
    },
    snapshot,
  }
}
