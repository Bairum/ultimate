import { defineWebExtension, useNow } from '@/sdk'

function Clock() {
  const now = new Date(useNow(60_000))
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return <span>{time}</span>
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Clock, order: -1 }] },
})
