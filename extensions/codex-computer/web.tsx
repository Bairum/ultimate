import { defineWebExtension } from '@/sdk'
import { Line, Operate } from './cards.tsx'

export default defineWebExtension({
  tools: { codex_operate: Operate },
  toolLines: { codex_operate: Line },
})
