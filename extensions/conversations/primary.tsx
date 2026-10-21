import { useSystem } from '@/sdk'
import { primaryAgent } from '../../lib/machine.ts'

/** The home's primary standing agent: @ultimate, or none in the machine home. */
export const usePrimaryAgent = () => {
  const system = useSystem()
  return system ? primaryAgent(system.project.root, system.machine.home) : 'ultimate'
}
