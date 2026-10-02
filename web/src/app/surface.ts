import { createContext, useContext, useSyncExternalStore } from 'react'
import { layout } from '../sdk/actions.ts'
import { HOME } from '../sdk/registry.ts'

/** The id of the surface that is rendering; the host provides it. */
export const SurfaceContext = createContext<string>(HOME)
export const useSurfaceId = () => useContext(SurfaceContext)

/** Whether the shown surface renders `region` (`Sidebar` or `Panels`). */
export function useRegion(region: 'sidebar' | 'panels') {
  return useSyncExternalStore(layout.subscribe, () => layout.has(region))
}
