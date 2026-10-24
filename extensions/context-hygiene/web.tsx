import type { ReactNode } from 'react'
import { defineWebExtension, useDoc } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { LedgerDoc } from './refs.ts'

function Elided({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const ledger = useDoc(LedgerDoc)
  const decision = ledger?.decisions[call.id]
  if (decision?.state !== 'applied') return core
  return (
    <div>
      {core}
      <div className="px-3 py-1 text-xs text-muted-foreground">
        elided from context · ~
        {decision.tokens >= 1000 ? `${(decision.tokens / 1000).toFixed(1)}k` : decision.tokens}{' '}
        tokens
      </div>
    </div>
  )
}
export default defineWebExtension({
  tools: { read: Elided, bash: Elided, grep: Elided, edit: Elided },
})
