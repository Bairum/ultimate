import { BrainIcon, CheckIcon, ChevronDownIcon, CpuIcon } from 'lucide-react'
import { useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  getConversation,
  getState,
  useDialog,
  useUltimate,
} from '@/sdk'
import { LoginDialog } from './login.tsx'
import { ModelPicker } from './picker.tsx'
import { dialogs, nextThinking, openLogin, useCurrentModel } from './state.tsx'
import type { ThinkingLevel } from './state.tsx'

const toolbarButton =
  'flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground'

function ModelButton() {
  const { ref, loading } = useCurrentModel()
  const actions = useUltimate()
  return (
    <button
      className={toolbarButton}
      disabled={loading}
      aria-label={loading ? 'Loading model' : undefined}
      onClick={() => actions.open(dialogs.picker)}
      title={loading ? 'Loading model' : 'Pick a model'}
      type="button"
    >
      <CpuIcon className="size-3.5 shrink-0" />
      <span
        className={cn(
          'truncate',
          loading ? undefined : ref ? 'text-foreground/85' : 'text-warning',
        )}
      >
        {loading ? 'model…' : (ref?.modelId ?? 'no model')}
      </span>
      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
    </button>
  )
}

function ThinkingButton() {
  const { model, thinking, loading } = useCurrentModel()
  const [open, setOpen] = useDialog(dialogs.thinking)
  const [error, setError] = useState<string>()
  if (loading)
    return (
      <button
        className={toolbarButton}
        disabled
        aria-label="Loading thinking level"
        title="Loading thinking level"
        type="button"
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <span>thinking…</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </button>
    )
  if (!model?.reasoning) return null
  const levels = model.thinkingLevels
  const current = thinking ?? 'off'
  const choose = (level: ThinkingLevel) => {
    setError(undefined)
    api.configure({ thinkingLevel: level }).then(
      () => setOpen(false),
      (failure: unknown) => setError(errorMessage(failure)),
    )
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button className={toolbarButton} title="Thinking level (Shift+Tab cycles)" type="button">
          <BrainIcon className={cn('size-3.5 shrink-0', current !== 'off' && 'text-brand')} />
          <span className={current !== 'off' ? 'text-foreground/85' : undefined}>{current}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1 font-mono" side="top">
        <div className="px-2 pt-1 pb-1.5 text-[10.5px] tracking-wider text-muted-foreground uppercase">
          Thinking
        </div>
        {levels.map((level) => (
          <button
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] transition-colors hover:bg-accent',
              level === current && 'text-brand',
            )}
            key={level}
            onClick={() => choose(level)}
            type="button"
          >
            <CheckIcon className={cn('size-3.5', level !== current && 'opacity-0')} />
            {level}
          </button>
        ))}
        <div className="mt-1 flex items-center gap-1.5 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
          {error ? (
            <span className="text-error">{error}</span>
          ) : (
            <>
              <Kbd>⇧ Tab</Kbd> cycles
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'composer.toolbar': [ModelButton, ThinkingButton], overlay: [ModelPicker, LoginDialog] },
  commands: [
    {
      id: 'model.pick',
      title: 'Pick a model',
      run: (context) => context.open(dialogs.picker),
    },
    {
      id: 'model.thinking',
      title: 'Set the thinking level',
      run: (context) => context.open(dialogs.thinking),
    },
    {
      id: 'model.thinking.cycle',
      title: 'Cycle the thinking level',
      keys: 'shift+tab',
      whileTyping: true,
      run: () => {
        const { agent, loading } = getConversation()
        if (loading) return undefined
        const model = getState().models?.models.find(
          (candidate) =>
            candidate.provider === agent.model?.provider && candidate.id === agent.model.modelId,
        )
        if (!model?.reasoning) return undefined
        return api.configure({ thinkingLevel: nextThinking(agent.thinkingLevel, model) })
      },
    },
    {
      id: 'auth.login',
      title: 'Log in to a provider',
      run: (context) => openLogin(context),
    },
  ],
})
