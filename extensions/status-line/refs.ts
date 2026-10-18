/** The status line in the browser: token rates and spend across every conversation of this host. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Tokens by kind. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
/**
 * Tokens per second over the last 30 seconds at most, measured over `elapsed` seconds, and the totals since the server
 * opened with their cost in dollars.
 */
export type RateSample = { rates: Tokens; elapsed: number; totals: Tokens & { cost: number } }

/** No arguments → the latest rate sample, or null until two samples within 5 seconds of each other exist. */
export const RatesAction = actionRef<null, RateSample | null>('status-line', 'rates')
