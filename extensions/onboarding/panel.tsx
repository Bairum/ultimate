import { CircleAlertIcon, CopyPlusIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, cn, elidePath, shortenPath, useExtensions, useSystem, useUltimate } from '@/sdk'
import type { ExtensionInfo, SystemInfo } from '@/sdk'
import {
  Heading,
  Line,
  Segmented,
  Switch,
  message,
  projectDialog,
  projectLists,
  sources,
  useLines,
} from './parts.tsx'

type Scope = 'project' | 'user'

const without =
  (name: string) =>
  <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== name))

/** Turning these off takes this panel away with them, so they ask first. */
const holds: Record<string, string> = {
  onboarding: 'This panel goes with it; turn it back on in settings.json.',
  agent: 'The window falls back to a bare conversation, without this panel.',
}

/** Which layer decided an extension's state: a short label and the sentence behind it. */
function decided(extension: ExtensionInfo, local: boolean): [string, string] {
  const state = extension.enabled ? 'On' : 'Off'
  const verb = extension.enabled ? 'enables' : 'disables'
  if (extension.source === 'project' && !local)
    return ['setup not in use', "Part of this project's setup, which is not in use"]
  if (extension.layer === 'default')
    return extension.enabled
      ? ['default', 'On: part of the default set']
      : ['opt-in', 'Off: built-ins outside the default set are opt-in']
  if (extension.layer === 'user')
    return ['your settings', `${state}: ~/.ultimate/settings.json ${verb} it`]
  if (extension.layer === 'project')
    return ['project settings', `${state}: this project's .ultimate/settings.json ${verb} it`]
  return ['its folder', 'On: extension folders of yours and of this project are on by default']
}

/** Settings problems of the last reload, such as an unknown name or an invalid file; its last valid state applies. */
function Diagnostics({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null
  return (
    <section className="border-b border-border/60 bg-warning/6 px-3 py-2.5">
      <Heading className="text-warning" meta={messages.length}>
        <TriangleAlertIcon className="size-3" />
        Diagnostics
      </Heading>
      <ul className="mt-1.5 flex flex-col gap-1">
        {messages.map((text) => (
          <li
            className="font-mono text-[11px] leading-snug break-words text-foreground/85"
            key={text}
          >
            {text}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The project's setup: the remembered choice, a way to change it, and taking its setup everywhere. */
function ProjectSetup({ system }: { system: SystemInfo }) {
  const { project } = system
  const ui = useUltimate()
  const [busy, setBusy] = useState<'local' | 'global' | 'adopt'>()
  const [error, setError] = useState<string>()
  const [adopted, setAdopted] = useState(false)
  const { enable, disable } = projectLists(system)
  const copies = enable.length + disable.length
  const run = async (kind: 'local' | 'global' | 'adopt', action: () => Promise<unknown>) => {
    setBusy(kind)
    setError(undefined)
    setAdopted(false)
    try {
      await action()
      if (kind === 'adopt') setAdopted(true)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(undefined)
    }
  }
  const state =
    project.decision === true
      ? "Using this folder's own setup: its extensions, settings, agents, and skills."
      : project.decision === false
        ? "Using your global setup; this folder's own setup stays off."
        : project.config
          ? 'This folder has its own setup. Not chosen yet, so your global setup is in use.'
          : "This folder has no setup of its own. Choose this project's setup to keep changes to this folder only."
  return (
    <section className="border-b border-border/60 px-3 pt-3 pb-3.5">
      <Heading meta={<span className="font-mono">{project.name}</span>}>Project</Heading>
      <p className="mt-2 text-[12px] leading-snug text-muted-foreground">
        {state}
        {project.config && (
          <>
            {' '}
            <button
              className="text-brand outline-none hover:underline focus-visible:underline"
              onClick={() => ui.open(projectDialog)}
              type="button"
            >
              About this setup
            </button>
          </>
        )}
      </p>
      <Segmented
        className="mt-2.5 flex w-full"
        label="Setup for this folder"
        onChange={(value) =>
          void run(value, () => api.action('onboarding', 'decide', { local: value === 'local' }))
        }
        options={[
          {
            value: 'local',
            label: (
              <>
                {busy === 'local' && <LoaderCircleIcon className="size-3 animate-spin" />}
                This project's setup
              </>
            ),
            disabled: busy !== undefined,
          },
          {
            value: 'global',
            label: (
              <>
                {busy === 'global' && <LoaderCircleIcon className="size-3 animate-spin" />}
                Global setup
              </>
            ),
            disabled: busy !== undefined,
          },
        ]}
        // Without a setup of its own, an open question means the global setup.
        value={
          project.decision === null
            ? project.config
              ? null
              : 'global'
            : project.decision
              ? 'local'
              : 'global'
        }
      />
      {project.config && (
        <Button
          className="mt-2 h-7 w-full justify-start gap-1.5 px-2 font-mono text-[11px] text-muted-foreground"
          disabled={busy !== undefined || copies === 0}
          onClick={() => void run('adopt', () => api.action('onboarding', 'adoptProjectSetup'))}
          size="sm"
          title={
            copies === 0
              ? 'Its settings turn no extensions on or off'
              : `Copy its ${copies} extension choices into ~/.ultimate/settings.json`
          }
          variant="outline"
        >
          {busy === 'adopt' ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <CopyPlusIcon className="size-3.5" />
          )}
          Use this project's setup everywhere
        </Button>
      )}
      {error && <p className="mt-2 font-mono text-[11px] leading-snug text-error">{error}</p>}
      {adopted && (
        <p className="mt-2 font-mono text-[11px] leading-snug text-success">
          Copied {copies} choices into ~/.ultimate/settings.json
        </p>
      )}
    </section>
  )
}

function Row({
  extension,
  line,
  local,
  scope,
  pending,
  error,
  note,
  confirming,
  onToggle,
  onConfirm,
}: {
  extension: ExtensionInfo
  line: string
  local: boolean
  scope: Scope
  pending?: boolean
  error?: string
  note?: string
  confirming: boolean
  onToggle: (enabled: boolean) => void
  onConfirm: (confirming: boolean) => void
}) {
  const web = useExtensions().find((record) => record.name === extension.name)
  const [label, reason] = decided(extension, local)
  const unusable = extension.source === 'project' && !local
  const failure =
    extension.enabled &&
    [
      extension.server?.error && `server.ts: ${extension.server.error}`,
      web?.error && `web.tsx: ${web.error}`,
    ]
      .filter(Boolean)
      .join('\n')
  const checked = pending ?? extension.enabled
  return (
    <li className="px-3 py-1.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11.5px]">
            <span
              className={cn(
                'shrink-0',
                failure
                  ? 'text-error'
                  : extension.enabled
                    ? 'text-foreground/90'
                    : 'text-foreground/70',
              )}
            >
              {extension.name}
            </span>
            <span
              className={cn(
                'truncate text-[10.5px]',
                extension.source === 'builtin' ? 'text-muted-foreground/70' : 'text-brand',
              )}
              title={`${extension.path}\n${reason}`}
            >
              {sources[extension.source]}
              <span className="text-muted-foreground/60"> · {label}</span>
            </span>
          </div>
          <Line
            className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground"
            text={line}
          />
        </div>
        <span className="mt-0.5">
          <Switch
            busy={pending !== undefined}
            checked={checked}
            disabled={pending !== undefined || unusable}
            label={`${extension.name} ${scope === 'project' ? 'for this project' : 'everywhere'}`}
            onChange={(next) => (!next && holds[extension.name] ? onConfirm(true) : onToggle(next))}
            title={
              unusable
                ? "Choose this project's setup to use it"
                : `${checked ? 'Turn off' : 'Turn on'} ${scope === 'project' ? 'for this project' : 'everywhere'}`
            }
          />
        </span>
      </div>
      {confirming && (
        <div className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/8 px-2.5 py-2">
          <p className="text-[12px] leading-snug text-foreground/90">{holds[extension.name]}</p>
          <div className="flex justify-end gap-1.5">
            <Button
              className="h-6 text-[11.5px]"
              onClick={() => onConfirm(false)}
              size="xs"
              variant="ghost"
            >
              Keep it on
            </Button>
            <Button
              className="h-6 text-[11.5px]"
              onClick={() => onToggle(false)}
              size="xs"
              variant="outline"
            >
              Turn off
            </Button>
          </div>
        </div>
      )}
      {failure && (
        <p className="mt-1 line-clamp-3 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap text-error/85">
          {failure}
        </p>
      )}
      {error && (
        <p className="mt-1 flex items-start gap-1.5 font-mono text-[11px] leading-snug text-error">
          <CircleAlertIcon className="mt-px size-3 shrink-0" />
          {error}
        </p>
      )}
      {note && (
        <p className="mt-1 font-mono text-[11px] leading-snug text-muted-foreground">{note}</p>
      )}
    </li>
  )
}

/**
 * Every extension, on and available, with its source, the layer that decided it, and a switch that writes the chosen
 * scope's settings. The list follows system info, so a change shows when it is live.
 */
export function ExtensionsPanel() {
  const system = useSystem()
  const line = useLines()
  const [chosen, setChosen] = useState<Scope>()
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string>()
  if (!system)
    return <div className="p-3 font-mono text-[11.5px] text-muted-foreground">connecting…</div>
  const local = system.project.decision === true
  const scope: Scope = local ? (chosen ?? 'project') : 'user'
  const file =
    scope === 'project'
      ? elidePath(
          shortenPath(`${system.project.root}/.ultimate/settings.json`, {
            home: system.machine.home,
          }),
          46,
        )
      : '~/.ultimate/settings.json'
  const toggle = async (extension: ExtensionInfo, enabled: boolean) => {
    const { name } = extension
    setConfirming(undefined)
    setPending((previous) => ({ ...previous, [name]: enabled }))
    setErrors(without(name))
    setNotes(without(name))
    try {
      await api.action('onboarding', 'setExtension', { name, enabled, scope })
      if (scope === 'user' && extension.layer === 'project' && local)
        setNotes((previous) => ({
          ...previous,
          [name]: `Saved everywhere; this project's settings keep it ${extension.enabled ? 'on' : 'off'} here.`,
        }))
    } catch (failure) {
      setErrors((previous) => ({ ...previous, [name]: message(failure) }))
    } finally {
      setPending(without(name))
    }
  }
  const sorted = system.extensions.toSorted((a, b) => a.name.localeCompare(b.name))
  const groups: [string, ExtensionInfo[]][] = [
    ['On', sorted.filter((extension) => extension.enabled)],
    ['Available', sorted.filter((extension) => !extension.enabled)],
  ]
  return (
    <div className="pb-4">
      <Diagnostics messages={system.extensionDiagnostics} />
      <ProjectSetup system={system} />
      <div className="sticky top-0 z-10 border-b border-border/60 bg-sidebar/95 px-3 py-2 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Heading className="flex-1">Changes apply</Heading>
          <Segmented
            label="Where switches save"
            onChange={setChosen}
            options={[
              {
                value: 'project',
                label: 'this project',
                disabled: !local,
                title: local
                  ? "Save to this project's .ultimate/settings.json"
                  : "Choose this project's setup to change extensions for this folder only",
              },
              {
                value: 'user',
                label: 'everywhere',
                title: 'Save to ~/.ultimate/settings.json',
              },
            ]}
            value={scope}
          />
        </div>
        <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/70" title={file}>
          saved in {file}
        </p>
      </div>
      {groups.map(([title, extensions]) => (
        <section className="pt-3" key={title}>
          <Heading className="px-3 pb-1" meta={extensions.length}>
            {title}
          </Heading>
          <ul>
            {extensions.map((extension) => (
              <Row
                confirming={confirming === extension.name}
                error={errors[extension.name]}
                extension={extension}
                key={extension.name}
                line={line(extension.name)}
                local={local}
                note={notes[extension.name]}
                onConfirm={(next) => setConfirming(next ? extension.name : undefined)}
                onToggle={(enabled) => void toggle(extension, enabled)}
                pending={pending[extension.name]}
                scope={scope}
              />
            ))}
          </ul>
          {extensions.length === 0 && (
            <p className="px-3 py-1 text-[12px] text-muted-foreground/70">
              {title === 'On' ? 'Nothing is on.' : 'Everything is on.'}
            </p>
          )}
        </section>
      ))}
    </div>
  )
}
