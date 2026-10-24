import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, defineWebExtension, formatBytes } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { OpenAction } from './refs.ts'

// Generic tools still show the marker; these built-ins commonly produce long logs or page dumps.
const decoratedTools = ['bash', 'browser', 'web_search', 'web_fetch']

function Offloaded({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const details = call.details as { offload?: { path: string; bytes: number } } | undefined
  const output = details?.offload
  if (!output) return core
  async function show() {
    setOpen(!open)
    if (open || text !== undefined || loading) return
    setLoading(true)
    setError(undefined)
    try {
      setText(await api.action(OpenAction, { path: output!.path }))
    } catch (failure) {
      setError(String(failure))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="space-y-1">
      {core}
      <button
        type="button"
        className="px-3 py-1 font-mono text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => void show()}
      >
        {open ? 'Close full output' : `Open full output (${formatBytes(output.bytes)})`}
      </button>
      {open && (
        <div className="overflow-hidden rounded-md border border-border/70 font-mono text-xs">
          {loading && <div className="px-3 py-2 text-muted-foreground">Loading full output…</div>}
          {error && (
            <div role="alert" className="px-3 py-2 text-error">
              {error}
            </div>
          )}
          {text !== undefined && (
            <pre className="max-h-96 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85">
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export default defineWebExtension({
  tools: Object.fromEntries(decoratedTools.map((name) => [name, Offloaded])),
})
