import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import tasks from '../../extensions/tasks/web.tsx'
import { store, uiState } from '../../web/src/sdk/client.ts'
import { ExtensionNameContext } from '../../web/src/sdk/hooks.ts'
import '../../web/src/index.css'

let source, workspaces
window.EventSource = class extends EventTarget {
  readyState = 1
  constructor(url) {
    super()
    if (url.includes('ultimate.workspaces')) workspaces = this
    else source = this
  }
  close() {}
}
const workspace = (state, extra = {}) => ({
  path: '/fixture',
  branch: 'worker-branch',
  source: '/source',
  target: 'main',
  base: 'base',
  state,
  ...extra,
})
const items = {
  2: workspace('ready', { landed: 'abcdef0', ahead: 0 }),
  3: workspace('failed', { error: 'Checkout failed', ahead: null }),
  4: workspace('preparing', { ahead: null }),
  5: workspace('ready', { ahead: 2 }),
}
store.start()
const send = (name, data) =>
  source.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }))
const summaries = [
  { id: 1, title: 'Plan the release', busy: false },
  {
    id: 2,
    title:
      'Landed worker with a very long title that must truncate without pushing its identity out of the panel',
    label: 'worker',
    parentConversationId: 1,
    busy: false,
  },
  { id: 3, title: 'Failed checkout', parentConversationId: 2, busy: false },
  { id: 4, parentConversationId: 1, busy: true },
  { id: 5, title: 'Review changes', parentConversationId: 1, busy: true },
  { id: 6, busy: false },
]
send('conversations', summaries)
const task = (id, conversationId, owner, conversations = []) => ({
  id,
  conversationId,
  owner,
  conversations,
  kind: 'pi.run',
  state: { status: 'running', phase: 'working' },
})
const graph = {
  tasks: {
    10: task(10, 1, null, [2, 4, 5]),
    20: task(20, 2, null, [3]),
    30: task(30, 3, null),
    40: task(40, 4, null),
    50: {
      ...task(50, 5, null),
      state: { status: 'waiting', phase: 'review', on: [40], policy: 'all' },
      background: true,
      abortRequested: true,
    },
    60: task(60, 6, null),
  },
}
send('tasks', graph)
const root = createRoot(document.querySelector('#app'))
flushSync(() =>
  root.render(
    h(
      'div',
      { className: 'flex gap-6 bg-background p-6 text-foreground', style: { minHeight: '100vh' } },
      h(
        'section',
        { style: { width: 320 }, 'data-panel': 'tasks' },
        h(ExtensionNameContext.Provider, { value: 'tasks' }, h(tasks.panels[0].component)),
      ),
    ),
  ),
)
flushSync(() =>
  workspaces.dispatchEvent(
    new MessageEvent('doc', {
      data: JSON.stringify({ kind: 'ultimate.workspaces', value: { items } }),
    }),
  ),
)
window.fixture = {
  summaries: (rows = summaries) => flushSync(() => send('conversations', rows)),
  graph: (value) => flushSync(() => send('tasks', value ?? graph)),
  archive: (ids) => flushSync(() => uiState.receive({ 'ext.conversations.archived': ids })),
}
