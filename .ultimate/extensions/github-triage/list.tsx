import { ChevronDownIcon, SearchIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, useAction, useNow } from '@/sdk'
import type { ActionState } from '@/sdk'
import { age, inputClass } from './types.tsx'
import type { Item, Kind, Label, Listing } from './types.tsx'

export type Filters = {
  kind: Kind
  label: string
  search: string
}

/** Issues or pull requests, one label, and a search that applies after a pause in typing. */
function Toolbar({
  repo,
  filters,
  onChange,
}: {
  repo: string
  filters: Filters
  onChange: (filters: Filters) => void
}) {
  const labels = useAction<Label[]>('github-triage', 'labels', { repo })
  const [draft, setDraft] = useState(filters.search)
  useEffect(() => setDraft(filters.search), [filters.search])
  useEffect(() => {
    if (draft.trim() === filters.search) return undefined
    const timer = setTimeout(() => onChange({ ...filters, search: draft.trim() }), 400)
    return () => clearTimeout(timer)
  }, [draft, filters, onChange])
  return (
    <div className="flex flex-col gap-2 border-b border-border/70 px-3 py-2.5">
      <div className="flex items-center gap-1">
        {(['issue', 'pr'] as const).map((kind) => (
          <button
            className={cn(
              'rounded-sm px-1.5 py-0.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground',
              filters.kind === kind && 'bg-accent text-foreground',
            )}
            key={kind}
            onClick={() => onChange({ ...filters, kind })}
            type="button"
          >
            {kind === 'issue' ? 'Issues' : 'Pull requests'}
          </button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              'ml-auto flex max-w-36 items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[11.5px] text-muted-foreground outline-none hover:text-foreground',
              filters.label && 'text-foreground',
            )}
          >
            <span className="truncate">{filters.label || 'all labels'}</span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
            <DropdownMenuRadioGroup
              onValueChange={(label) => onChange({ ...filters, label })}
              value={filters.label}
            >
              <DropdownMenuRadioItem className="text-[12.5px]" value="">
                All labels
              </DropdownMenuRadioItem>
              {labels.data?.map((label) => (
                <DropdownMenuRadioItem
                  className="font-mono text-[12px]"
                  key={label.name}
                  value={label.name}
                >
                  {label.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <label className="relative flex items-center">
        <SearchIcon className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground/70" />
        <input
          aria-label="Search"
          className={cn(inputClass, 'w-full pl-7')}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search"
          value={draft}
        />
      </label>
    </div>
  )
}

function Row({ item, active, onSelect }: { item: Item; active: boolean; onSelect: () => void }) {
  const now = useNow(60000)
  return (
    <button
      className={cn(
        'block w-full px-3 py-2 text-left hover:bg-accent/60',
        active && 'bg-accent hover:bg-accent',
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="line-clamp-2 text-[13px] leading-snug">{item.title}</span>
      <span className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <span>#{item.number}</span>·<span className="truncate">{item.author}</span>·
        <span className="shrink-0">{age(item.createdAt, now)}</span>
        {item.draft && <span className="text-muted-foreground/70">· draft</span>}
      </span>
      {item.labels.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <span
              className="rounded-sm border border-border/70 px-1 font-mono text-[10.5px] text-muted-foreground"
              key={label.name}
            >
              {label.name}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

/** The left column: filters on top, the open items below. */
export function List({
  repo,
  filters,
  onFilters,
  listing,
  selected,
  onSelect,
}: {
  repo: string
  filters: Filters
  onFilters: (filters: Filters) => void
  listing: ActionState<Listing>
  selected: number | null
  onSelect: (number: number) => void
}) {
  const result = listing.data
  const noun = filters.kind === 'issue' ? 'issue' : 'pull request'
  return (
    <nav className="flex w-80 shrink-0 flex-col border-r border-border/70 bg-sidebar">
      <Toolbar filters={filters} onChange={onFilters} repo={repo} />
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!result && listing.loading && (
          <p className="px-3 py-2 font-mono text-[12px] text-muted-foreground">loading…</p>
        )}
        {result?.status === 'error' && (
          <p className="px-3 py-2 text-[12.5px] break-words text-error">{result.message}</p>
        )}
        {result?.status === 'ok' && result.items.length === 0 && (
          <p className="px-3 py-2 text-[12.5px] text-muted-foreground">
            No open {noun}s{filters.label || filters.search ? ' match these filters' : ''}.
          </p>
        )}
        {result?.status === 'ok' &&
          result.items.map((item) => (
            <Row
              active={item.number === selected}
              item={item}
              key={item.number}
              onSelect={() => onSelect(item.number)}
            />
          ))}
      </div>
      {result?.status === 'ok' && result.items.length > 0 && (
        <div className="border-t border-border/70 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {result.items.length === 100 ? 'latest 100' : result.items.length} open {noun}
          {result.items.length === 1 ? '' : 's'}
          {listing.loading && ' · refreshing…'}
        </div>
      )}
    </nav>
  )
}
