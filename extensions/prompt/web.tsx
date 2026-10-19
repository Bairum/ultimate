import { defineWebExtension } from '@/sdk'

export default defineWebExtension({
  // The agent's note that it was hot-swapped; the user sees builds in the status line.
  entries: { 'prompt.build': () => null },
})
