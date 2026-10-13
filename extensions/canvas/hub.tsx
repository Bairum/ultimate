import { Handle, Position, useStore as useFlow } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import { PlusIcon } from 'lucide-react'
import { memo } from 'react'
import { cn, NewConversationComposer } from '@/sdk'
import { FAR } from './panel.tsx'

export type HubData = {
  started: (id: number) => void
}
export type HubNode = Node<HubData, 'hub'>
export const HUB_INPUT = 'canvas-hub-input'

/** Start a conversation with the same composer used in the Agent surface. */
export const Hub = memo(function Hub({ data }: NodeProps<HubNode>) {
  const far = useFlow((state) => state.transform[2] < FAR)
  return (
    <div
      className={cn(
        'flex size-full flex-col border-2 border-brand/45 bg-card shadow-[0_0_60px_-18px_var(--color-brand)]',
        far ? 'items-center justify-center gap-4 rounded-[3rem]' : 'rounded-2xl p-3',
      )}
      data-hub
    >
      {far ? (
        <>
          <PlusIcon className="size-12 text-brand" />
          <span className="text-[30px] font-medium text-foreground/85">Start a conversation</span>
        </>
      ) : (
        <>
          <div className="flex h-5 shrink-0 items-center gap-2 px-1">
            <span className="font-mono text-[10.5px] tracking-[0.2em] text-brand uppercase">
              Ultimate
            </span>
          </div>
          <NewConversationComposer inputId={HUB_INPUT} onStarted={data.started} />
        </>
      )}
      <Handle
        className="opacity-0"
        isConnectable={false}
        position={Position.Bottom}
        type="source"
      />
    </div>
  )
})
