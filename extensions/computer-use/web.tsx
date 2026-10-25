import { MonitorIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import { Act, Apps, Line, Observe } from './cards.tsx'
import { ComputerStatus } from './status.tsx'
import { TaskCall } from './task-cards.tsx'
import { SessionView } from './session-view.tsx'

export default defineWebExtension({
  tools: {
    computer_observe: Observe,
    computer_act: Act,
    computer_apps: Apps,
    computer_task: TaskCall,
  },
  toolLines: {
    computer_observe: Line,
    computer_act: Line,
    computer_apps: Line,
    computer_task: Line,
  },
  slots: { 'statusline.right': [{ component: ComputerStatus, order: -4, phone: true }] },
  documents: [
    { kind: 'computer.session', title: 'Computer use', icon: MonitorIcon, component: SessionView },
  ],
})
