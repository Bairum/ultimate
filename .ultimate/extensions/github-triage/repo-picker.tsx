import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/sdk'
import { inputClass } from './types.tsx'

const repoPattern = /^[\w.-]+\/[\w.-]+$/

/** The repository in the header: click to type any owner/repo, or go back to the project's own. */
export function RepoPicker({
  repo,
  defaultRepo,
  onChange,
}: {
  repo: string | null
  defaultRepo: string | null
  onChange: (repo: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  // Accept pasted URLs too: https://github.com/owner/repo/issues → owner/repo.
  const value = draft
    .trim()
    .replace(/^(https?:\/\/)?github\.com\//, '')
    .split('/')
    .slice(0, 2)
    .join('/')
    .replace(/\.git$/, '')
  const valid = repoPattern.test(value)
  const choose = (next: string | null) => {
    onChange(next === defaultRepo ? null : next)
    setOpen(false)
  }
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setDraft(repo ?? '')
      }}
      open={open}
    >
      <PopoverTrigger className="flex min-w-0 items-center gap-1 rounded-sm px-1 font-mono text-[12px] text-foreground/85 outline-none hover:bg-accent hover:text-foreground">
        <span className="truncate">{repo ?? 'choose a repository'}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3" sideOffset={8}>
        <label className="text-[12.5px] text-muted-foreground" htmlFor="github-triage-repo">
          Repository
        </label>
        <input
          autoComplete="off"
          autoFocus
          className={cn(inputClass, 'mt-1.5 w-full font-mono')}
          id="github-triage-repo"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || !valid) return
            event.preventDefault()
            choose(value)
          }}
          placeholder="owner/repo"
          value={draft}
        />
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {draft.trim() && !valid ? 'Type owner/repo or paste a GitHub URL.' : 'Enter to open.'}
        </p>
        {defaultRepo && repo !== defaultRepo && (
          <button
            className="mt-2 w-full rounded-sm px-1.5 py-1 text-left text-[12.5px] hover:bg-accent"
            onClick={() => choose(null)}
            type="button"
          >
            Back to this project's{' '}
            <span className="font-mono text-[12px] text-muted-foreground">{defaultRepo}</span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
