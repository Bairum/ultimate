/**
 * Tailscale: publishes this server on the user's tailnet over HTTPS. Other extensions read where it is reachable.
 */
import { defineApi } from '../../shared/extension-api.ts'

/** The publication state, the tailnet `url` once ready, and a `hint` when something blocks it. */
export type Status = {
  state:
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'not-installed'
    | 'not-running'
    | 'not-operator'
    | 'https-disabled'
    | 'port-conflict'
    | 'error'
  url?: string
  allow: string[]
  hint?: string
}

/** What the `tailscale` service gives other extensions: this server's status, `url` once it is published. */
export interface TailscaleService {
  /** This server's current publication status; read `url` for its tailnet address. */
  status(): Status
}
/** Tailnet publication; `want` it, since tailscale is optional. */
export const TailscaleApi = defineApi<TailscaleService>()('tailscale')
