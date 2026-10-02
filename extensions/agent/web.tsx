import { MessagesSquareIcon } from 'lucide-react'
import { Conversation, Header, Panels, Sidebar, StatusLine, defineWebExtension } from '@/sdk'

/** The conversation in a centred column, with the sidebar and the right panel beside it. */
function Agent() {
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header />
          <Conversation />
        </main>
        <Panels />
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'agent',
      title: 'Agent',
      icon: MessagesSquareIcon,
      description: 'The conversation, with panels beside it',
      component: Agent,
    },
  ],
})
