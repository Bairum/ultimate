import { ActivityIcon } from 'lucide-react'
import { defineWebExtension, useEvents, useExtensions, useNow, useUltimate } from '@/sdk'
import { activityEvents, Feed } from './feed.tsx'

/** What happened in the project, newest first, from the durable event log. */
function ActivityPanel() {
  const events = useEvents({ events: activityEvents, limit: 100 })
  const now = useNow(30_000)
  const actions = useUltimate()
  // The System surface (the `system` extension) shows everything recorded; linked only while it is installed.
  const system = useExtensions().some((record) =>
    record.extension?.surfaces?.some((surface) => surface.id === 'system'),
  )
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Activity
        {events && events.length > 0 && (
          <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
            {events.length} recent
          </span>
        )}
        {system && (
          <button
            className={`${events && events.length > 0 ? '' : 'ml-auto '}cursor-pointer tracking-normal normal-case text-muted-foreground/70 hover:text-foreground`}
            onClick={() => actions.showSurface('system')}
            title="Everything recorded, live, on the System surface"
            type="button"
          >
            System ↗
          </button>
        )}
      </div>
      {events && <Feed events={events} now={now} />}
    </div>
  )
}

export default defineWebExtension({
  panels: [
    { id: 'activity', title: 'Activity', icon: ActivityIcon, component: ActivityPanel, order: -4 },
  ],
  commands: [
    {
      id: 'activity.open',
      title: 'Show recent activity',
      run: (context) => context.openPanel('activity'),
    },
  ],
})
