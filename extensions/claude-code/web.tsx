import { RefreshCwIcon, TerminalIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { defineWebExtension, refreshModels, useAction } from '@/sdk'

interface Status {
  available: boolean
  loggedIn: boolean
  subscription: boolean
  plan: string | null
}

function ClaudeCodePanel() {
  const { data, error, loading, refetch } = useAction<Status>('claude-code', 'status', null, {
    onError: () => {},
  })
  useEffect(() => {
    if (data) void refreshModels()
  }, [data])
  const title = loading
    ? 'Checking CLI…'
    : error
      ? 'Status check failed'
      : !data?.available
        ? 'CLI not installed'
        : !data.loggedIn
          ? 'Login not confirmed'
          : data.subscription
            ? 'Subscription connected'
            : 'CLI connected · no subscription reported'
  return (
    <div className="space-y-6 p-4 text-sm">
      <div className="space-y-2 border-b pb-4">
        <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          External provider / experimental
        </p>
        <h2 className="text-lg font-medium">Claude Code</h2>
        <p className="text-muted-foreground">
          Claude owns the login. Ultimate owns the conversation and tool execution.
        </p>
      </div>
      <section className="space-y-3">
        <p aria-live="polite" className="font-medium">
          {title}
        </p>
        {error && (
          <p className="text-muted-foreground">
            Could not refresh provider availability. Try again; check the CLI in a terminal if this
            persists.
          </p>
        )}
        <Button
          className="cursor-pointer"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void refetch()}
        >
          <RefreshCwIcon className="size-3.5" /> Refresh status
        </Button>
      </section>
      <section className="space-y-3">
        <h3 className="font-mono text-xs text-muted-foreground uppercase">In your terminal</h3>
        <p>Install Claude Code if needed, then sign in outside Ultimate:</p>
        <pre className="overflow-x-auto rounded-md border bg-background p-3 text-xs">
          <code>
            npm install -g @anthropic-ai/claude-code{'\n'}claude auth login{'\n'}claude auth status
          </code>
        </pre>
        <p className="text-muted-foreground">
          Refresh after login, then select a Claude Code model in the model picker. An unconfirmed
          login can also mean the CLI returned an unreadable status.
        </p>
      </section>
      <section className="space-y-2 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
        <h3 className="font-medium text-foreground">Billing is not guaranteed</h3>
        <p>
          This experimental transport uses your CLI account and its limits. Subscription coverage
          depends on Claude Code. Displayed costs are list-price estimates, not your bill.
        </p>
        <p>
          The upstream guard stops further requests after usage-credit overage is reported; the
          first charged response may already have incurred a charge. No guard override is enabled
          here.
        </p>
        <a
          className="inline-block cursor-pointer underline underline-offset-4"
          href="https://github.com/earendil-works/pi-claude-code"
          target="_blank"
          rel="noreferrer"
        >
          Upstream documentation
        </a>
      </section>
    </div>
  )
}

export default defineWebExtension({
  panels: [
    { id: 'claude-code', title: 'Claude Code', icon: TerminalIcon, component: ClaudeCodePanel },
  ],
  commands: [
    {
      id: 'claude-code.panel',
      title: 'Claude Code setup…',
      run: (context) => context.openPanel('claude-code'),
    },
  ],
})
