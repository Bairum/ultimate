import { TimerIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { defineWebExtension, useToolDuration, useUltimate } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { AutomationsPanel } from './panel.tsx'
import { ScheduledSection } from './sidebar.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** One `automation` call: the action and the automation it touched, with a way to the overview. */
function AutomationCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { openPanel } = useUltimate()
  const action = text(call.args.action) || '…'
  const target = text(call.args.name) || text(call.args.id)
  const schedule = text(call.args.schedule)
  const prompt = text(call.args.prompt)
  const title: ReactNode = (
    <>
      {action === 'run' ? 'run now' : action}
      {target && <span className="text-foreground/85"> {target}</span>}
      {action === 'abort' && text(call.args.runId) && ` run ${text(call.args.runId)}`}
    </>
  )
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              {schedule && <span className="max-w-48 truncate">{schedule}</span>}
              {duration && <span>{duration}</span>}
            </>
          }
          name="automation"
          state={call.status}
          title={title}
        />
        <Button
          className="mr-1 h-6 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => openPanel('automations')}
          size="sm"
          title="Show the Automations overview"
          variant="ghost"
        >
          <TimerIcon className="size-3" />
          automations
        </Button>
      </div>
      <ToolContent>
        {prompt && (
          <ToolSection label="Prompt">
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {prompt}
            </p>
          </ToolSection>
        )}
        <ToolOutput isError={call.status === 'error'} output={call.output} />
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({
  tools: { automation: AutomationCall },
  slots: { 'sidebar.top': [{ component: ScheduledSection, order: -10 }] },
  panels: [
    {
      id: 'automations',
      title: 'Automations',
      icon: TimerIcon,
      component: AutomationsPanel,
      order: 7,
      // Opened from the sidebar's SCHEDULED rows and ⌘K.
      tab: false,
    },
  ],
  commands: [
    {
      id: 'automations.open',
      title: 'Automations…',
      run: (context) => context.openPanel('automations'),
    },
  ],
})
