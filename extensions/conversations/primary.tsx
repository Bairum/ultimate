import { useSystem } from '@/sdk'
import { primaryAgent } from '../../lib/machine.ts'

/** The home's primary standing agent: @sync in the machine home, else @ultimate. */
export const usePrimaryAgent = () => {
  const system = useSystem()
  return system ? primaryAgent(system.project.root, system.machine.home) : 'ultimate'
}
