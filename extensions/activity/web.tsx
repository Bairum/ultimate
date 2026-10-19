import { ActivityIcon } from 'lucide-react'
import { defineWebExtension, useEvents, useNow } from '@/sdk'
import { activityEvents, Feed } from './feed.tsx'

/** What happened in the project, newest first, from the durable event log. */
function ActivityPanel() {
  const events = useEvents({ events: activityEvents, limit: 100 })
  const now = useNow(30_000)
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Activity
        {events && events.length > 0 && (
          <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
            {events.length} recent
          </span>
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
