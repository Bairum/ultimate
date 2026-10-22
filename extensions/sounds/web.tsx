import { PlayIcon, Volume2Icon, VolumeOffIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { cn, defineWebExtension, useDocOf, useExtensionUiState } from '@/sdk'
import { MessagesDoc, emptyMessages } from '../messages/ui.tsx'
import { OverviewDoc } from '../conversations/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { listener, sounds } from './cues.ts'
import type { Cue, Sound } from './cues.ts'
import { play } from './tones.ts'

const playedKey = 'ultimate.sounds.played'

function useSettings() {
  const [muted, setMuted] = useExtensionUiState('muted', false)
  const [off, setOff] = useExtensionUiState<Sound[]>('off', [])
  return { muted, setMuted, off, setOff }
}

/**
 * Sounds `cue` in one tab only: every open tab sees the same event, and the first that may play claims it under a
 * lock, in this origin's storage. A tab nobody has clicked in yet may not play, so it leaves the event to another.
 */
async function announce(cue: Cue) {
  if (!navigator.userActivation.hasBeenActive) return
  const claimed = await navigator.locks.request(playedKey, () => {
    const played: string[] = JSON.parse(localStorage.getItem(playedKey) ?? '[]')
    if (played.includes(cue.key)) return false
    localStorage.setItem(playedKey, JSON.stringify([...played, cue.key].slice(-100)))
    return true
  })
  if (claimed) await play(cue.sound)
}

/**
 * Watches @ultimate and sounds what it newly tells the user: a question, a finished answer,
 * a failed run. Whatever it shows when this tab opens has been heard already.
 */
function Player() {
  const overview = useDocOf(1, OverviewDoc)
  const log = useDocOf(1, MessagesDoc)
  const agent = useDocOf(1, StandingDoc)?.ultimate
  const { muted, off } = useSettings()
  const [hear] = useState(listener)
  useEffect(() => {
    if (!overview || agent === undefined) return
    const due = hear({
      agent,
      row: overview.conversations[agent],
      messages: (log ?? emptyMessages).messages,
    })
    for (const cue of due)
      if (!muted && !off.includes(cue.sound))
        announce(cue).catch((error: unknown) => console.warn('Sound failed', error))
  }, [hear, overview, log, agent, muted, off])
  return null
}

const preview = (sound: Sound) =>
  play(sound).catch((error: unknown) => console.warn('Sound failed', error))

/** The status-bar entry: a switch for all sounds and a checkbox and a preview for each. */
function Control() {
  const { muted, setMuted, off, setOff } = useSettings()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Notification sounds"
          className={cn(
            '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            muted && 'text-muted-foreground/60',
          )}
          type="button"
        >
          {muted ? <VolumeOffIcon className="size-3" /> : <Volume2Icon className="size-3" />}
          sounds
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-1 font-mono" side="top">
        <label className="flex h-8 cursor-pointer items-center justify-between px-2 text-[12px]">
          Sounds
          <Switch checked={!muted} onCheckedChange={(on) => setMuted(!on)} />
        </label>
        <div className="border-t border-border/70 pt-1">
          {sounds.map(({ sound, label }) => (
            <div
              className={cn('flex h-7 items-center gap-2 px-2 text-[12px]', muted && 'opacity-50')}
              key={sound}
            >
              <label className="flex flex-1 cursor-pointer items-center gap-2">
                <Checkbox
                  checked={!off.includes(sound)}
                  disabled={muted}
                  onCheckedChange={(on) => {
                    setOff((previous) =>
                      on ? previous.filter((other) => other !== sound) : [...previous, sound],
                    )
                    // oxlint-disable-next-line typescript/no-floating-promises -- preview catches and logs playback failures.
                    if (on) void preview(sound)
                  }}
                />
                {label}
              </label>
              <button
                aria-label={`Play ${label}`}
                className="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => void preview(sound)}
                type="button"
              >
                <PlayIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-1 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
          For @ultimate only
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { overlay: [Player], 'statusline.right': [{ component: Control, order: -1 }] },
})
