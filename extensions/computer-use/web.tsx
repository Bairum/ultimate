import { GraduationCapIcon, MonitorIcon } from 'lucide-react'
import { defineWebExtension, getConversation, getState } from '@/sdk'
import { Act, Apps, Line, Observe } from './cards.tsx'
import { ComputerStatus } from './status.tsx'
import { TaskCall } from './task-cards.tsx'
import { SessionView } from './session-view.tsx'
import { TeachCall, TeachDocument } from './teach-cards.tsx'
import { TeachComposer, TeachDialog, TeachToolbar, teachDialog } from './teach-live.tsx'

export default defineWebExtension({
  tools: {
    computer_observe: Observe,
    computer_act: Act,
    computer_apps: Apps,
    computer_task: TaskCall,
    computer_teach: TeachCall,
  },
  toolLines: {
    computer_observe: Line,
    computer_act: Line,
    computer_apps: Line,
    computer_task: Line,
    computer_teach: Line,
  },
  composer: TeachComposer,
  slots: {
    'statusline.right': [{ component: ComputerStatus, order: -4, phone: true }],
    'composer.toolbar': [{ component: TeachToolbar, order: 2 }],
    overlay: [TeachDialog],
  },
  commands: [
    {
      id: 'computer-use.teach',
      title: 'Teach the computer agent…',
      // Only the computer operator drafts from a recording, so teaching starts in its conversation.
      when: ({ conversationId }) =>
        getState().conversations.some(
          (c) =>
            c.id === (conversationId ?? getConversation().id) && c.label === 'computer-operator',
        ),
      run: (context) => context.open(teachDialog),
    },
  ],
  documents: [
    { kind: 'computer.session', title: 'Computer use', icon: MonitorIcon, component: SessionView },
    {
      kind: 'computer.teach',
      title: 'Teaching',
      icon: GraduationCapIcon,
      component: TeachDocument,
    },
  ],
})
