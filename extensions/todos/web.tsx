import { ListTodoIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import { Todos } from './panel.tsx'

export default defineWebExtension({
  panels: [{ id: 'todos', title: 'To-dos', icon: ListTodoIcon, component: Todos, order: -4 }],
  commands: [
    {
      id: 'todos.open',
      title: 'Show to-dos',
      run: (context) => context.openPanel('todos'),
    },
  ],
})
