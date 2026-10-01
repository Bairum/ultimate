// Adapted from vercel/ai-elements packages/elements/src/tool.tsx (Apache-2.0, see LICENSE).
// Changes: Pi Durable call states instead of `ai` tool parts; a dense one-line header with title and meta.
import { cn } from 'cn'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  XIcon,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CodeBlock } from './code-block.tsx'

export type ToolState = 'streaming' | 'pending' | 'running' | 'done' | 'error' | 'interrupted'

export const Tool = ({ className, ...props }: ComponentProps<typeof Collapsible>) => (
  <Collapsible
    className={cn(
      'group/tool not-prose w-full overflow-hidden rounded-md border border-border/80 bg-card/50 font-mono text-[12px]',
      className,
    )}
    {...props}
  />
)

const labels: Record<ToolState, string> = {
  streaming: 'writing call',
  pending: 'queued',
  running: 'running',
  done: 'done',
  error: 'failed',
  interrupted: 'interrupted',
}

const icons = {
  streaming: [CircleDashedIcon, 'text-muted-foreground'],
  pending: [CircleDashedIcon, 'text-muted-foreground'],
  running: [LoaderCircleIcon, 'animate-spin text-brand'],
  done: [CheckIcon, 'text-success'],
  error: [XIcon, 'text-error'],
  interrupted: [MinusCircleIcon, 'text-warning'],
} as const

export const ToolStatusIcon = ({ state, className }: { state: ToolState; className?: string }) => {
  const [Icon, tone] = icons[state]
  return <Icon aria-label={labels[state]} className={cn('size-3.5 shrink-0', tone, className)} />
}

export type ToolHeaderProps = Omit<ComponentProps<typeof CollapsibleTrigger>, 'title'> & {
  name: string
  state: ToolState
  /** What the call works on: a path, a command. */
  title?: ReactNode
  /** Right-aligned facts: duration, size, exit code. */
  meta?: ReactNode
}

export const ToolHeader = ({ className, name, state, title, meta, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      'flex h-8 w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-accent/40',
      className,
    )}
    {...props}
  >
    <ToolStatusIcon state={state} />
    <span className="shrink-0 font-medium text-foreground">{name}</span>
    <span className="min-w-0 flex-1 truncate text-muted-foreground">{title}</span>
    {meta && (
      <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
        {meta}
      </span>
    )}
    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/tool:rotate-90" />
  </CollapsibleTrigger>
)

export const ToolContent = ({ className, ...props }: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent className={cn('border-t border-border/80', className)} {...props} />
)

export const ToolSection = ({
  className,
  label,
  children,
  ...props
}: ComponentProps<'div'> & { label?: string }) => (
  <div className={cn('space-y-1 px-2.5 py-2', className)} {...props}>
    {label && (
      <div className="text-[10px] tracking-wider text-muted-foreground/80 uppercase">{label}</div>
    )}
    {children}
  </div>
)

export const ToolInput = ({ input, ...props }: ComponentProps<'div'> & { input: unknown }) => (
  <ToolSection label="Arguments" {...props}>
    <CodeBlock className="border-none" code={JSON.stringify(input, null, 2)} language="json" />
  </ToolSection>
)

export const ToolOutput = ({
  output,
  isError,
  ...props
}: ComponentProps<'div'> & { output: string; isError?: boolean }) =>
  output ? (
    <ToolSection label={isError ? 'Error' : 'Output'} {...props}>
      <pre
        className={cn(
          'max-h-80 overflow-auto rounded-sm bg-terminal px-2.5 py-2 leading-[1.55] whitespace-pre-wrap',
          isError ? 'text-error' : 'text-foreground/90',
        )}
      >
        {output}
      </pre>
    </ToolSection>
  ) : null

export const ToolDiagnostics = ({
  diagnostics,
  ...props
}: ComponentProps<'div'> & {
  diagnostics: readonly { severity: 'info' | 'warn' | 'error'; message: string }[]
}) =>
  diagnostics.length ? (
    <ToolSection {...props}>
      {diagnostics.map((diagnostic, index) => (
        <div
          className={cn(
            'break-words',
            diagnostic.severity === 'error'
              ? 'text-error'
              : diagnostic.severity === 'warn'
                ? 'text-warning'
                : 'text-muted-foreground',
          )}
          key={index}
        >
          {diagnostic.message}
        </div>
      ))}
    </ToolSection>
  ) : null
