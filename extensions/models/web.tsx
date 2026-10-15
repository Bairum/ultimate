import { BrainIcon, CheckIcon, ChevronDownIcon, CpuIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  cn,
  defineWebExtension,
  errorMessage,
  getConversation,
  getState,
  getNewConversationConfiguration,
  useDialog,
  useComposer,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { LoginDialog } from './login.tsx'
import { ModelPicker } from './picker.tsx'
import {
  configureTarget,
  dialogs,
  nextThinking,
  openLogin,
  openPicker,
  useCurrentModel,
} from './state.tsx'
import type { ThinkingLevel } from './state.tsx'
import { switchAt } from './switches.ts'

const toolbarButton =
  'flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground'

function ModelButton() {
  const { target, source } = useComposer()
  const { ref, loading } = useCurrentModel()
  const actions = useUltimate()
  return (
    <button
      className={toolbarButton}
      disabled={loading}
      aria-label={loading ? 'Loading model' : undefined}
      onClick={() => openPicker(actions, target, source)}
      title={
        loading
          ? 'Loading model'
          : ref
            ? `${ref.modelId} · ${ref.provider} — pick a model`
            : target === 'new'
              ? 'Use the default model — pick a model'
              : 'Pick a model'
      }
      type="button"
    >
      <CpuIcon className="size-3.5 shrink-0" />
      <span
        className={cn(
          'truncate',
          loading ? undefined : ref ? 'text-foreground/85' : 'text-warning',
        )}
      >
        {loading ? 'model…' : (ref?.modelId ?? (target === 'new' ? 'default model' : 'no model'))}
      </span>
      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
    </button>
  )
}

function ThinkingButton() {
  const { target } = useComposer()
  const { model, thinking, loading } = useCurrentModel()
  const [open, setOpen] = useDialog(target === 'new' ? 'models.newThinking' : dialogs.thinking)
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
    configureTarget({ thinkingLevel: level }, target).then(
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

/** A response that ran on another model or thinking level than the one before it, marked above it. */
function Switched({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const change = switchAt(useTranscript(), entry)
  if (!change) return core
  const Icon = change.model ? CpuIcon : BrainIcon
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
        data-models-switch
        title="The model and thinking level from this response on"
      >
        <span className="flex max-w-[80%] min-w-0 items-center gap-1.5">
          <Icon className="size-3 shrink-0" />
          <span className="truncate">
            {[
              change.model && `${change.model.from} → ${change.model.to}`,
              change.thinking && `thinking ${change.thinking.from} → ${change.thinking.to}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </div>
      {core}
    </div>
  )
}

export default defineWebExtension({
  entries: { 'pi.assistant': Switched },
  slots: { 'composer.toolbar': [ModelButton, ThinkingButton], overlay: [ModelPicker, LoginDialog] },
  commands: [
    {
      id: 'model.pick',
      title: 'Pick a model',
      run: (context) => {
        if (!getConversation().loading) openPicker(context)
      },
    },
    {
      id: 'model.thinking',
      title: 'Set the thinking level',
      run: (context) =>
        context.open(
          document.activeElement?.closest('[data-composer-target="new"]')
            ? 'models.newThinking'
            : dialogs.thinking,
        ),
    },
    {
      id: 'model.thinking.cycle',
      title: 'Cycle the thinking level',
      keys: 'shift+tab',
      whileTyping: true,
      run: async () => {
        const { agent, loading } = getConversation()
        const composer = document.activeElement?.closest<HTMLElement>(
          '[data-composer-target="new"]',
        )
        const target = composer ? 'new' : 'conversation'
        if (loading) return undefined
        const source = composer?.dataset.composerSource
        const configuration = composer
          ? await getNewConversationConfiguration(source ? Number(source) : undefined)
          : agent
        const ref = configuration.model
        const thinking = configuration.thinkingLevel
        const model = getState().models?.models.find(
          (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
        )
        if (!model?.reasoning) return undefined
        return configureTarget({ thinkingLevel: nextThinking(thinking, model) }, target)
      },
    },
    {
      id: 'auth.login',
      title: 'Log in to a provider',
      run: (context) => openLogin(context),
    },
  ],
})
