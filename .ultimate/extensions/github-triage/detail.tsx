import { ExternalLinkIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { useNow } from '@/sdk'
import { age } from './types.tsx'
import type { Detail as DetailData } from './types.tsx'

function Body({ text }: { text: string }) {
  if (!text.trim())
    return <p className="text-[13px] text-muted-foreground italic">No description.</p>
  return <MessageResponse className="text-[13.5px]">{text}</MessageResponse>
}

/** One comment or the opening post: who, when, and the markdown. */
function Post({ author, createdAt, body }: { author: string; createdAt: string; body: string }) {
  const now = useNow(60000)
  return (
    <article className="rounded-md border border-border/70">
      <header className="flex items-center gap-1.5 border-b border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground">
        <span className="text-foreground/85">{author}</span>·
        <time dateTime={createdAt} title={new Date(createdAt).toLocaleString()}>
          {age(createdAt, now)} ago
        </time>
      </header>
      <div className="px-3.5 py-3">
        <Body text={body} />
      </div>
    </article>
  )
}

/** The selected issue or pull request: what it is, then the conversation on it. */
export function Detail({ item, actions }: { item: DetailData; actions?: ReactNode }) {
  const now = useNow(60000)
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-start gap-3">
        <h1 className="min-w-0 flex-1 text-[16px] leading-snug font-medium">
          {item.title} <span className="font-normal text-muted-foreground">#{item.number}</span>
        </h1>
        <a
          aria-label="Open on GitHub"
          className="mt-0.5 shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          href={item.url}
          rel="noreferrer"
          target="_blank"
          title="Open on GitHub"
        >
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
        <span>
          {item.kind === 'pr' ? (item.draft ? 'draft pull request' : 'pull request') : 'issue'}
        </span>
        ·<span className="text-foreground/85">{item.author}</span>·
        <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
          opened {age(item.createdAt, now)} ago
        </time>
        {item.branch && (
          <>
            ·
            <span className="truncate">
              {item.branch.head} → {item.branch.base}
            </span>
          </>
        )}
        {item.diff && (
          <>
            ·
            <span className="whitespace-nowrap">
              <span className="text-diff-add">+{item.diff.additions}</span>{' '}
              <span className="text-diff-del">−{item.diff.deletions}</span>
            </span>
          </>
        )}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1">
        {item.labels.length === 0 && (
          <span className="font-mono text-[11px] text-muted-foreground/70">no labels</span>
        )}
        {item.labels.map((label) => (
          <span
            className="rounded-sm border border-border/70 px-1.5 font-mono text-[11px] text-foreground/85"
            key={label.name}
          >
            {label.name}
          </span>
        ))}
      </div>
      {actions && <div className="mt-4">{actions}</div>}
      <div className="mt-5 flex flex-col gap-3">
        <Post author={item.author} body={item.body} createdAt={item.createdAt} />
        {item.comments.length > 0 && (
          <h2 className="mt-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
            {item.comments.length} comment{item.comments.length === 1 ? '' : 's'}
          </h2>
        )}
        {item.comments.map((comment) => (
          <Post key={comment.id} {...comment} />
        ))}
      </div>
    </div>
  )
}
