import { MessagesSquareIcon } from 'lucide-react'
import {
  Conversation,
  Header,
  Panels,
  Sidebar,
  StatusLine,
  api,
  defineWebExtension,
  getConversation,
} from '@/sdk'
import type { CommandContribution } from '@/sdk'
import { getRoots } from '../lineage/roots.tsx'

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

/** Commands for the shown conversation, on every surface; the palette lists them under Ultimate, with the shell's. */
const commands: CommandContribution[] = [
  {
    id: 'agent.stop',
    title: 'Stop the run',
    keys: 'escape',
    whileTyping: true,
    when: () => getConversation().busy,
    run: () => api.abort(),
  },
  {
    id: 'agent.compact',
    title: 'Compact the context',
    // @ultimate compacts a root's tally with `compact_tally`.
    when: (context) =>
      context.conversationId === undefined || !getRoots()?.includes(context.conversationId),
    run: () => api.compact(),
  },
  {
    id: 'agent.composer',
    title: 'Focus the composer',
    when: (context) =>
      context.conversationId === undefined || !getRoots()?.includes(context.conversationId),
    run: (context) => context.focusComposer(),
  },
  {
    id: 'agent.main',
    title: 'Show the main conversation',
    when: (context) => context.conversationId !== 1,
    run: (context) => context.switchConversation(1),
  },
]

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
  commands: commands.map((command) => ({ group: 'Ultimate', ...command })),
})
