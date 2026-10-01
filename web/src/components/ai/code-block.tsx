// Adapted from vercel/ai-elements packages/elements/src/code-block.tsx (Apache-2.0, see LICENSE).
// Changes: highlights through Streamdown's shared Shiki plugin, adds `startLine` and `languageFromPath`, drops the
// language selector.
import { createCodePlugin } from '@streamdown/code'
import type { HighlightOptions, HighlightResult } from '@streamdown/code'
import { cn } from 'cn'
import { CheckIcon, CopyIcon } from 'lucide-react'
import type { ComponentProps, CSSProperties, HTMLAttributes } from 'react'
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

/** One highlighter for Streamdown and every code block. */
export const codePlugin = createCodePlugin({ themes: ['vitesse-light', 'vitesse-dark'] })
const themes = codePlugin.getThemes()
/** A Shiki language id such as `ts` or `bash`. */
export type BundledLanguage = HighlightOptions['language']

const extensions: Record<string, string> = {
  cjs: 'js',
  mjs: 'js',
  cts: 'ts',
  mts: 'ts',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  py: 'python',
  rb: 'ruby',
  kt: 'kotlin',
  h: 'c',
  hpp: 'cpp',
}
/** A Shiki language for a file path, `text` when unknown. */
export function languageFromPath(path: string): BundledLanguage {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : ''
  const language = extensions[extension] ?? extension
  return (
    codePlugin.supportsLanguage(language as BundledLanguage) ? language : 'text'
  ) as BundledLanguage
}

type Line = HighlightResult['tokens'][number]
const plain = (code: string): Line[] =>
  code.split('\n').map((content) => (content ? [{ content, offset: 0, color: 'inherit' }] : []))

/** Tokens for `code`: plain lines first, highlighted ones once Shiki has loaded the language. */
function useTokens(code: string, language: BundledLanguage): Line[] {
  const [result, setResult] = useState<{ code: string; language: string; tokens: Line[] }>()
  const sync = useMemo(
    () => codePlugin.highlight({ code, language, themes })?.tokens,
    [code, language],
  )
  useEffect(() => {
    if (sync) return undefined
    let cancelled = false
    codePlugin.highlight({ code, language, themes }, (highlighted) => {
      if (!cancelled) setResult({ code, language, tokens: highlighted.tokens })
    })
    return () => {
      cancelled = true
    }
  }, [code, language, sync])
  if (sync) return sync
  if (result?.code === code && result.language === language) return result.tokens
  return plain(code)
}

const CodeBlockContext = createContext({ code: '' })

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
  /** Number of the first line, for excerpts. */
  startLine?: number
}

export const CodeBlockContent = memo(
  ({
    code,
    language,
    showLineNumbers = false,
    startLine = 1,
    className,
  }: Omit<CodeBlockProps, keyof HTMLAttributes<HTMLDivElement>> & { className?: string }) => {
    const tokens = useTokens(code.replace(/\n$/, ''), language)
    const width = String(startLine + tokens.length - 1).length
    return (
      <pre
        className={cn(
          'shiki m-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.6]',
          className,
        )}
      >
        <code className="grid">
          {tokens.map((line, index) => (
            <span className="flex" key={index}>
              {showLineNumbers && (
                <span
                  className="sticky left-0 mr-3 shrink-0 bg-inherit pr-1 text-right text-muted-foreground/50 select-none"
                  style={{ width: `${width + 1}ch` }}
                >
                  {startLine + index}
                </span>
              )}
              <span className="whitespace-pre">
                {line.length === 0
                  ? ' '
                  : line.map((token, i) => (
                      <span
                        key={i}
                        style={{
                          color: token.color,
                          fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
                          ...(token.htmlStyle as CSSProperties),
                        }}
                      >
                        {token.content}
                      </span>
                    ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    )
  },
)
CodeBlockContent.displayName = 'CodeBlockContent'

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  startLine,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const value = useMemo(() => ({ code }), [code])
  return (
    <CodeBlockContext.Provider value={value}>
      <div
        className={cn(
          'group relative w-full overflow-hidden rounded-md border bg-terminal',
          className,
        )}
        data-language={language}
        {...props}
      >
        {children}
        <CodeBlockContent
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
          startLine={startLine}
        />
      </div>
    </CodeBlockContext.Provider>
  )
}

export const CodeBlockHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex items-center justify-between gap-2 border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground',
      className,
    )}
    {...props}
  />
)

export const CodeBlockTitle = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex min-w-0 items-center gap-2', className)} {...props} />
)

export const CodeBlockFilename = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('truncate font-mono', className)} {...props} />
)

export const CodeBlockActions = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('-my-1 -mr-1 flex items-center gap-1', className)} {...props} />
)

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & { timeout?: number }

export const CodeBlockCopyButton = ({
  timeout = 1500,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const { code } = useContext(CodeBlockContext)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    timer.current = setTimeout(() => setCopied(false), timeout)
  }
  const Icon = copied ? CheckIcon : CopyIcon
  return (
    <Button
      className={cn('size-6 shrink-0', className)}
      onClick={() => void copy()}
      size="icon"
      variant="ghost"
      aria-label="Copy"
      {...props}
    >
      {children ?? <Icon className="size-3" />}
    </Button>
  )
}
