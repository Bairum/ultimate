import { defineWebExtension, formatTime, useNow } from '@/sdk'

function Clock() {
  return <span>{formatTime(useNow(60_000))}</span>
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Clock, order: -1 }] },
})
