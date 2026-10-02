# Writing extensions

Almost everything in Ultimate is an extension: tools, prompt sections, tool renderers, the status line, panels, and
whole apps, called surfaces. Even the Agent surface, the conversation you probably talk to Ultimate in, is one
(`agent`). The web core only provides the frame: a surface host, the primitives surfaces are built from, the live data
layer, the transcript, the composer, and the command palette. New UI is a new extension folder. Copy the closest
existing extension and change it:

| Want                                              | Copy                                                |
| ------------------------------------------------- | --------------------------------------------------- |
| A full-screen app with the agent docked beside it | [the Commits example](#example-a-commits-app) below |
| Server data in the UI (actions)                   | [the Commits example](#example-a-commits-app) below |
| A surface made of the shell's own parts           | `agent`                                             |
| A status-line item                                | `status-line`                                       |
| Tool renderers (diffs, terminals, images)         | `coding-tools`, `browser`, `instance`               |
| A right-panel tab                                 | `info` (key/value sections), `tasks`, `subagents`   |
| Toolbar buttons, dialogs, commands, a popover     | `models`                                            |
| A header badge, an entry renderer that wraps core | `self`                                              |
| An extension document in the UI (`useDoc`)        | `codemode`                                          |
| A prompt section from durable UI state            | `surfaces`                                          |
| Toasts or other global overlays                   | `notices`                                           |

## Where extensions live

Ultimate looks for extension folders in three places. When two have the same folder name, the later place wins and
replaces the whole extension, both facets:

| Source    | Folder                            | For                                                                |
| --------- | --------------------------------- | ------------------------------------------------------------------ |
| `builtin` | `extensions/` in Ultimate's clone | Ultimate's own features, shipped with it                           |
| `user`    | `~/.ultimate/extensions/`         | Your additions, in every project                                   |
| `project` | `<project>/.ultimate/extensions/` | One project's tools and apps, committed with the project; wins all |

The project is the directory Ultimate was started in (`ultimate [dir]`); the Info panel lists every extension with its
source, and the system prompt names both roots. Put a project's app in its `.ultimate/extensions/<name>/`. When the
project is Ultimate itself, that is `.ultimate/extensions/` in the clone, not `extensions/`, which holds the built-ins.

Extensions outside the clone import exactly what built-ins import (`@/sdk`, `@/components/…`, `react`,
`lucide-react`, any package installed in the clone): Ultimate resolves those from its clone, and Tailwind picks up their
classes. In the clone, `pnpm check` type-checks and lints `extensions/` and `.ultimate/extensions/`; extensions of
other projects are not checked by anything, so try them in the browser. Agents live in the same three places
(`agents/`); skills come from Pi (`~/.pi/agent/skills/`, the project's `.pi/skills/`), then `~/.ultimate/skills/`, then
`<project>/.ultimate/skills/`, later winning by name. A project's `.ultimate/settings.json` may set `defaultSurface` (see
[Surfaces](#surfaces)).

## Extension host

Server factories receive exactly these `ExtensionHost` fields (import its type only from `server/extensions.ts`):

- `ultimateRoot`, `projectRoot`, `userHome`, `home`: source, work, user and instance-state roots.
- `modelRuntime`, `settings`: Pi model/auth runtime and settings.
- `models()`: model descriptors, including availability and the faux model when enabled.
- `skills(cwd)`: merged Pi, user and project skills for a working directory.
- `restart(approved)`: request a verified core swap; the async callback records the approved generation before activation.
- `faux`: Pi's faux provider handle in dev mode, otherwise undefined. Demo scripting belongs to the `faux` extension.
- `build()`, `system()`, `extensions()`: current build, system and extension inspection.
- `harness()`, `uiState(context)`, `doc(kind)`: durable harness, root UI snapshot and exported conversation document token.
- `metadata`: the core's `ultimate.metadata` conversation document, `{ title?, label? }`; the shell names a conversation
  by them, so set them on conversations you create (`subagents` labels each child with its definition).
- `resource(key, create)`, `onClose(cleanup)`: shared reload-stable resources and async shutdown cleanup.

Core runtime modules must not be imported by extensions; use host capabilities instead.

## An extension's files

An extension is a folder `<name>/` in one of those places:

| File        | Facet                                                                                                   | Goes live                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `server.ts` | Agent and server: a Pi Durable extension (tools, prompt sections, hooks, documents) and its `actions`   | Reinstalled on save; running tool calls finish on old code |
| `web.tsx`   | UI: `export default defineWebExtension({ … })`                                                          | Vite hot reload, no page reload                            |
| `README.md` | What it does; the first paragraph is shown in the UI, so open with a sentence, not a heading. Required. | Read on change                                             |

Files ending in `.ts` belong to the server facet, files ending in `.tsx` to the web facet: split a large `web.tsx` into
more `.tsx` files in the same folder (see `coding-tools/diff.tsx`). The folder name is the extension name; a
`server.ts` extension must use it as its `name`.

Each web facet loads on its own. If it fails to compile, throws, or exports a contribution of the wrong shape (such as
`surfaces: {}` instead of an array, or a command without `run`), an error card names it and the rest of the UI keeps
running; its previous version stays installed until the fix lands. Every contribution renders inside its own error
boundary, so a crashing component shows a compact card where it was.

## A first extension

```tsx
// extensions/hello/web.tsx
import { defineWebExtension, useConversation } from '@/sdk'

function Entries() {
  const { entries } = useConversation()
  return <span>{entries.length} entries</span>
}

export default defineWebExtension({
  slots: { 'statusline.left': [Entries] },
})
```

Save it and the item appears in the status line. No restart, no reload.

## Contributions

`defineWebExtension({ slots, panels, surfaces, tools, entries, commands })`; every key is optional. Extensions load in
folder-name order; give a slot item `{ component, order }` to move it (default order 0, lower first).

### Slots

Components mounted in named places of the shell, on every surface that renders the primitive holding them.

| Slot               | Where                                                                            |
| ------------------ | -------------------------------------------------------------------------------- |
| `sidebar`          | Left column (`<Sidebar />`); it disappears while nothing is in it                |
| `header.right`     | Right side of the header, before the palette button (`<Header>`)                 |
| `statusline.left`  | Bottom status line, left; monospace, one line (`<StatusLine />`)                 |
| `statusline.right` | Bottom status line, right (`<StatusLine />`)                                     |
| `composer.toolbar` | Left of the composer's footer, beside the send button (`<Conversation />`)       |
| `overlay`          | Always mounted at the root, above every surface: dialogs, toasts, global effects |

```tsx
slots: { 'header.right': [Badge], sidebar: { component: Conversations, order: -1 } }
```

### Panels

Tabs of the right panel (toggle: `mod+alt+b`).

```tsx
import { InfoIcon } from 'lucide-react'
panels: [{ id: 'info', title: 'Info', icon: InfoIcon, component: InfoPanel }]
```

Open one from code with `useUltimate().openPanel('info')`. Panels show on surfaces that render `<Panels />`, such
as Agent.

### Surfaces (apps)

Full-screen apps the user switches between, with the agent one keystroke away; [Surfaces](#surfaces) below explains
them, with the primitives and a complete example.

```tsx
surfaces: [{ id: 'commits', title: 'Commits', icon: GitCommitHorizontalIcon, component: Commits }]
```

### Tool renderers

How a tool call looks in the transcript, by tool name. Without one, a generic card shows name, arguments, and output.

```tsx
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai/tool'
import type { ToolCallView } from '@/sdk'

function Grep({ call }: { call: ToolCallView }) {
  return (
    <Tool>
      <ToolHeader name="grep" state={call.status} title={String(call.args.pattern ?? '')} />
      <ToolContent>
        <ToolOutput output={call.output} isError={call.status === 'error'} />
      </ToolContent>
    </Tool>
  )
}
tools: {
  grep: Grep
}
```

`ToolCallView`: `id`, `name`, `args` (partial while the model streams them), `status` (`streaming`, `pending`,
`running`, `done`, `error`, `interrupted`), `output` (streamed while running, the result's text when done), `images`
(the result's images, such as screenshots), `details` (the tool's `details()`; cast to its shape), `diagnostics`,
`dropped`, `startedAt`/`endedAt`, and `result`. `useToolDuration(call)` gives a ticking duration. `ToolImages` (or one
`ToolImage`) from `@/components/ai/tool` shows images as thumbnails that open full size; the generic card already does.
To put a button beside the header (such as "open"), wrap `ToolHeader` in a flex row inside `Tool`: a button inside the
header would toggle it.

### Entry renderers

How an entry kind looks in the transcript. Extensions that append their own entries render them here; a renderer for a
`pi.*` kind replaces the core one (which then serves as the fallback if yours throws). Unknown kinds show as JSON.

```tsx
entries: { 'notes.pinned': ({ entry }) => <div className="text-muted-foreground">📌 {String(entry.data)}</div> }
```

A renderer also gets `core`, the core's rendering of the same entry: return it for the entries you leave alone, wrap
it, or return `null` to hide the entry. `self` renders `pi.system` entries that change the build section as a reload
marker and returns `core` for the rest.

### Commands

Entries of the command palette (`mod+k`), optionally with a shortcut. `mod` is ⌘ on macOS and Ctrl elsewhere. Most
commands need none: the palette finds them by title. A sequence such as `mod+k m` runs when `m` follows the palette
shortcut, which takes that letter away from palette search (typing "models" would run it), so use sequences only for
something you reach for constantly.

```tsx
commands: [
  { id: 'hello.compact', title: 'Compact now', keys: 'mod+shift+c', run: () => api.compact() },
]
```

`run(context)` gets the shell actions (below), the shown `conversationId`, and the shown `surface` id; return a promise
to have a failure reported as a notice. `when(context)` hides the command when it returns false, such as
`when: (context) => context.surface === 'commits'` for a command of one surface; a `when` that throws hides it too and
reports a notice naming your extension. Commands run outside React: read the current state with `getConversation()`
and `getState()`, not hooks.

Plain keys and Shift+letter never fire while the user types; chords with `mod`, `alt`, or `ctrl` do. A plain key that
must work in the composer too sets `whileTyping: true`, as Escape (`agent.stop`) and Shift+Tab
(`model.thinking.cycle`) do; it still leaves the key to an open dialog, which closes or moves focus with it. To let a
command open UI an extension renders, such as a popover, use a dialog id: the command calls `context.open(id)` and the
component reads `useDialog(id)` as its open state (see `models`).

Command ids are global and resolve like surface ids: a later facet in folder-name order wins an id, in the place of the
command it replaces. The shell itself has only the palette (`ultimate.palette`), the panel and sidebar toggles
(`ultimate.panel`, `ultimate.sidebar`), and a `ultimate.surface.<id>` switch per surface; the conversation commands
(stop, compact, focus the composer, show the main conversation) come from `agent`, the theme toggle from `theme`. To
replace one, declare its id; to drop it, replace or delete its extension.

## Actions

A web facet runs in the browser; its server facet runs in Ultimate's Node process, next to the project's files, its
command-line tools, and the network. Actions connect the two: `server.ts` exports `actions`, plain async functions, and
the UI calls them by extension and action name, JSON in and JSON out.

```ts
// server.ts
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'

export default defineExtension({ name: 'todos' })

export const actions = {
  async list(_args: JsonValue, ctx: ActionContext) {
    const { stdout } = await ctx.exec('git', ['grep', '-n', 'TODO'])
    return stdout.split('\n').filter(Boolean)
  },
}
```

```tsx
// web.tsx
const todos = useAction<string[]>('todos', 'list')
// todos.data, todos.error, todos.loading, todos.refetch()
```

An action is `(args, ctx)`; `ctx` has:

| Field                                     | What it is                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec(command, args, { cwd?, timeout? })` | Runs a program without a shell, in the project root unless `cwd` says otherwise. Resolves `{ stdout, stderr }`; rejects on a non-zero exit, after `timeout` (default and maximum 30 s), or past 1 MiB of output. |
| `signal`                                  | Aborted when the UI stops waiting (a newer call, an unmount, a closed tab); `exec` honours it. Pass it on to your own `fetch`.                                                                                   |
| `conversationId`                          | The conversation the UI showed when it called.                                                                                                                                                                   |
| `host`                                    | The extension host: `projectRoot`, `ultimateRoot`, `system()`, `uiState(context)`, `harness()`, and more (see `AGENTS.md`).                                                                                      |

The `ActionContext` import is type-only. The path above is right for `.ultimate/extensions/<name>/` in Ultimate's clone
(built-ins use `../../server/actions.ts`); in another project nothing type-checks it and the import is erased, so it
runs either way.

- **Arguments come from the browser**: validate them before they reach a command line. `exec` takes an argument list,
  never a shell string, so quoting is never the problem; meaning is.
- **Return small JSON shaped for the UI**, not raw command output. Ask CLIs for JSON (`gh … --json`) and limit how much
  they return.
- **Throw clear messages; return states as data.** A thrown error's message, up to 500 characters, reaches the UI as
  `error.message` and in the notice (`todos/list: <message>`, HTTP 500); the whole error goes to the server log. Throw
  for faults, with a message that says what went wrong. Return states the user should see and act on as data instead,
  such as `{ status: 'setup', reason: 'gh is not installed' }`, and render them as a screen of their own.
- **Live**: saving `server.ts` reinstalls it and the next call runs the new code. No restart.
- **Quick**: an action holds a request open, and `exec` stops at 30 s. Hand long work to the agent (`api.submit`).

Call actions from the UI in one of two ways:

- `useAction(extension, name, args?, { enabled?, onError? })` reads. It calls on mount and again whenever `extension`,
  `name`, or `args` (compared as JSON) change, unless `enabled` is false; a newer call aborts the older one. It returns
  `{ data, error, loading, refetch }`: `data` stays while a refetch runs and resets when the args change; `refetch()`
  calls again, also when not `enabled`. A failure shows as a notice unless you pass `onError`.
- `api.action(extension, name, args?, { conversationId?, signal? })` acts, once: a click that saves, closes, or
  labels something. It returns a promise of the result; afterwards, `refetch()` what changed. A rejection (an `ActionError`
  with `extension`, `action`, `status`, `message`) that nothing catches shows as a notice; catch it to handle it
  yourself.

```tsx
<Button
  onClick={async () => {
    await api.action('todos', 'resolve', { line })
    await todos.refetch()
  }}
>
  Resolve
</Button>
```

Actions are browser-only: requests require `Sec-Fetch-Site: same-origin` or a loopback `Origin` matching the server's
port. A plain agent `curl` receives 403. This prevents accidental calls, not deliberate header forgery. For an intentional
local test, emulate the browser:
`curl -s -X POST -H 'Sec-Fetch-Site: same-origin' -H 'Content-Type: application/json' -d '{"args":null}' <url>/api/extensions/todos/actions/list`
answers `{"result": …}` or `{"error": …}` (the URL is in the system prompt and the Info panel).

## Surfaces

The window shows one surface at a time. **Agent** is the built-in home surface (`extensions/agent`): the conversation
with the sidebar and the right panel. An app surface puts its own UI first and keeps the agent one keystroke away,
usually docked beside it.

- **Switching**: the brand at the top left opens the switcher (Agent first, then by `order`, then title); ⌘K has
  "Switch to …"; `mod+1…9` select the first nine (Ctrl+1…9 off macOS, which Chrome lets the page take before its tab
  switching). In code: `useUltimate().showSurface(id)` or
  `context.showSurface(id)` in a command. Switching never interrupts the agent: the run goes on, and the transcript and
  the composer's draft are where they were.
- **Durable**: the choice is UI state `shell.surface`; it survives reloads and restarts and follows every tab. Until the
  user picks one, a project's `.ultimate/settings.json` (`{ "defaultSurface": "commits" }`) chooses, if that surface
  is installed.
- **The agent knows**: the main conversation's system prompt names the surface ("The user is looking at the Commits
  surface (commits).", from `extensions/surfaces`), so "this list" in a message means yours. The line changes only
  when the surface does.
- **Failure**: if the chosen surface is not installed, or its component throws, Agent shows instead, with a notice; a
  fixed version comes back on its own. If even Agent fails, a bare header, conversation, and status line remain. The
  prompt, the window title, and `surface` below name what is on screen, so Agent while it stands in.
- `useUltimate().surface` and `context.surface` give the id of the surface on screen.

The contribution:

| Field         | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `id`          | Global and stored in `shell.surface`: use the extension name (`commits`) or prefix it (`commits.graph`) |
| `title`       | Shown in the switcher, the header, ⌘K, and the window title                                             |
| `icon`        | A `lucide-react` icon                                                                                   |
| `description` | One line under the title in the switcher                                                                |
| `order`       | Position after Agent; lower first (default 0), then by title. It decides which `mod+<n>` selects it     |
| `component`   | The surface itself                                                                                      |

### Layout

The host renders the surface inside a column that fills the window (`flex h-dvh flex-col`). Compose it top to bottom,
and make the middle row `flex min-h-0 flex-1` so it takes the rest and scrolls inside, not the page:

```tsx
function MyApp() {
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        {/* your columns; a scrolling one gets min-h-0 (or min-w-0) and overflow-y-auto */}
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}
```

### Primitives

Import them from `@/sdk`. Each is a thin wrapper over the shell's own parts; the Agent surface is nothing but these.

| Primitive                                 | What it renders                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Header>`                                | The top bar: the brand with the surface switcher, then its children (by default the shown conversation's trail), the `header.right` slot, and the palette button. It adds the sidebar and panel toggles when the surface renders them.                                                              |
| `<StatusLine />`                          | The bottom line with the `statusline.left` and `statusline.right` slots                                                                                                                                                                                                                             |
| `<Conversation variant="main" \| "dock">` | The shown conversation: transcript and composer, filling their box. `main` centres a reading column; `dock` fits a narrow region.                                                                                                                                                                   |
| `<Dock title? side?>`                     | A collapsible, resizable side region, `right` by default; `title` (default `conversation`) labels it. Drag the inner edge to resize, double-click it to reset. Collapsed, it is a rail that pulses while the agent works. Open state and width persist per surface (`shell.dock.<surface>.<side>`). |
| `<Sidebar />`                             | The `sidebar` slot as a left column, toggled with `mod+b`; nothing while the slot is empty                                                                                                                                                                                                          |
| `<Panels />`                              | The right panel with every extension's panel tabs, toggled with `mod+alt+b`                                                                                                                                                                                                                         |
| `<Slot name variant? />`                  | Any slot by name, each item in its own error boundary; `variant="inline"` for one-line places                                                                                                                                                                                                       |

Everything else on a surface is your own components, styled like the rest of Ultimate (see [Styling](#styling)).
Pass the header your own title or controls as children: `<Header><span className="text-[13px]">12 open</span></Header>`.

### Example: a Commits app

A complete app: the project's recent commits in a list, the selected one beside it with a button that hands it to the
agent, and the agent docked on the right. It needs nothing but `git`. Put the three files in
`<project>/.ultimate/extensions/commits/`; on save, Commits appears in the switcher (`mod+2`).

`server.ts`, the data:

```ts
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'

export default defineExtension({ name: 'commits' })

/** The UI calls these with `useAction('commits', name, args)`; each returns JSON. */
export const actions = {
  /** The latest 50 commits of the project. */
  async list(_args: JsonValue, ctx: ActionContext) {
    const format = '--format=%H%x1f%s%x1f%an%x1f%ar'
    const { stdout } = await ctx.exec('git', ['log', '-n', '50', format])
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, author, when] = line.split('\x1f')
        return { sha, subject, author, when }
      })
  },
  /** One commit: its message and the files it changed. */
  async show(sha: JsonValue, ctx: ActionContext) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('Expected a sha')
    const { stdout } = await ctx.exec('git', ['show', '--stat', '--format=%B', sha])
    return { sha, text: stdout.trim() }
  },
}
```

`web.tsx`, the surface:

```tsx
import { GitCommitHorizontalIcon, MessageSquarePlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Conversation,
  Dock,
  Header,
  StatusLine,
  api,
  cn,
  defineWebExtension,
  useAction,
  useExtensionUiState,
} from '@/sdk'

interface Commit {
  sha: string
  subject: string
  author: string
  when: string
}

/** One commit, and a button that hands it to the agent. */
function Detail({ sha, text }: { sha: string; text: string }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-[13px] text-muted-foreground">{sha.slice(0, 12)}</h1>
        <Button
          className="ml-auto"
          onClick={() => void api.submit(`Review commit ${sha}.`, 'followUp')}
          size="sm"
          variant="outline"
        >
          <MessageSquarePlusIcon />
          Ask the agent
        </Button>
      </div>
      <pre className="mt-4 font-mono text-[12px] whitespace-pre-wrap text-foreground/90">
        {text}
      </pre>
    </>
  )
}

/** Recent commits on the left, the selected one in the middle, the agent docked on the right. */
function Commits() {
  const commits = useAction<Commit[]>('commits', 'list')
  const [selected, setSelected] = useExtensionUiState<string | null>('selected', null)
  const sha = selected ?? commits.data?.[0]?.sha ?? null
  const commit = useAction<{ sha: string; text: string }>('commits', 'show', sha, {
    enabled: sha !== null,
  })
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1">
          {commits.loading && !commits.data && (
            <p className="px-3 py-2 font-mono text-[12px] text-muted-foreground">loading…</p>
          )}
          {commits.data?.map((item) => (
            <button
              className={cn(
                'block w-full px-3 py-1.5 text-left hover:bg-accent/60',
                item.sha === sha && 'bg-accent',
              )}
              key={item.sha}
              onClick={() => setSelected(item.sha)}
              type="button"
            >
              <span className="block truncate text-[13px]">{item.subject}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {item.sha.slice(0, 7)} · {item.author} · {item.when}
              </span>
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {commit.data && <Detail {...commit.data} />}
        </main>
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'commits',
      title: 'Commits',
      icon: GitCommitHorizontalIcon,
      description: 'Recent commits; hand one to the agent',
      component: Commits,
    },
  ],
})
```

`README.md`:

```md
Browse the project's recent commits and hand one to the agent.
```

What it shows: `useAction` loads the list on mount and the detail whenever the selection changes (disabled until there
is one); the selection lives in `useExtensionUiState`, so it survives reloads; `api.submit(text, 'followUp')` sends a
message to the shown conversation, queued as a follow-up if the agent is busy, and the dock shows it arrive.

### Build an app, step by step

For a request such as "build a triage surface for this repo's GitHub issues":

1. **Place it.** One folder, `<project>/.ultimate/extensions/<name>/` (in Ultimate's own repository:
   `.ultimate/extensions/<name>/`). The surface id is `<name>`.
2. **Find the data first.** Run the commands in a shell (`gh issue list --limit 50 --json number,title,labels`), prefer
   JSON output and bounded results, and find out what happens when the tool is missing or logged out.
3. **Write `server.ts`**: `defineExtension({ name })` and `actions` that wrap those commands with `ctx.exec`, validate
   their args, and return small JSON shaped for the UI. Return setup states (missing tool, no login, no repository)
   as data, so the UI can say what to do.
4. **Check each action with `curl`** (see [Actions](#actions)) before any UI exists.
5. **Write `web.tsx`** from the Commits example: keep `Header`, `Dock` with `Conversation variant="dock"`, and
   `StatusLine`; replace the list and the detail. Read with `useAction`, act with `api.action` then `refetch`, keep
   the selection and filters in `useExtensionUiState`, and hand work to the agent with `api.submit(text, 'followUp')`,
   saying exactly what to do with which item.
6. **Write `README.md`**, opening with one sentence; the Info panel shows it.
7. **Look at it.** Switch to it, take a screenshot, and go through every state: loading, empty, error, setup, many
   items, a long title; then the light theme (⌘K, "Toggle light and dark theme"). Fix what looks off.
8. **Verify and commit**: `pnpm check` in the clone (it covers `.ultimate/extensions/`), then commit the folder with the
   project.

Keep in mind:

- Ids are global: surface ids, command ids, and dialog ids start with your extension name.
- Keep the agent on screen: a surface without a `Dock` holding `Conversation` makes the user switch away to talk.
- Reach your server only through actions: no `fetch` to your own endpoints, no secrets in the browser.
- One extension stays one folder: do not import another extension's files.
- The Agent surface is an extension too: to change it for one project, copy `extensions/agent` to the project's
  `.ultimate/extensions/agent/`.

## SDK (`@/sdk`)

Import only from `@/sdk`, `@/components/ui/*`, `@/components/ai/*`, `react`, and `lucide-react`. Never call `fetch` or
open an `EventSource` yourself: the SDK keeps one live stream per shown conversation and replays its changes, and your
server code is reached through [actions](#actions). The surface primitives are in [Surfaces](#primitives).

| Hook                                                                      | Returns                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useConversation()`                                                       | The shown conversation: `id`, `entries`, `agent` (`pi.agent`), `usage`, `live` (`pi.live`), `inbox`, `busy`, `loading`                                                                                                  |
| `useSystem()`                                                             | Build identity, machine, process (pid, generation, url), persistence, code (branch, sha, dirty, coreStale), extensions, skills, context files                                                                           |
| `useConversations()`                                                      | Summaries of every conversation: id, parent, owner task, label (what its creator calls it, such as a subagent's definition), title, cwd, busy                                                                           |
| `useTasks()`                                                              | The live task graph                                                                                                                                                                                                     |
| `useModels()`                                                             | `GET /api/models`: providers with auth status, models with context window, reasoning, cost                                                                                                                              |
| `useAuthFlows()`                                                          | Login flows by id: status, the pending prompt, events                                                                                                                                                                   |
| `useDoc(kind)`                                                            | An extension document of the shown conversation (`export const docs` in `server.ts`); `undefined` until the stream delivers it (subscribing creates it with its initial value)                                          |
| `useUiState(key, initial)`                                                | Durable UI state, stored with the main conversation: survives reloads and restarts, shared by every tab. `[value, set]`, JSON values only                                                                               |
| `useExtensionUiState(key, initial)`                                       | `useUiState` under `ext.<your extension>.<key>`; use it for your own UI state                                                                                                                                           |
| `useUltimate()`                                                           | `conversationId`, `surface`, actions (`switchConversation`, `showSurface`, `openPanel`, `closePanel`, `togglePanel`, `toggleSidebar`, `runCommand`, `open`/`close(dialog)`, `openPalette`, `focusComposer`, `setTheme`) |
| `useAction(extension, name, args?, options?)`                             | A server action's result, called on mount and when its args change: `{ data, error, loading, refetch }` (see [Actions](#actions))                                                                                       |
| `useDialog(id)`                                                           | `[open, setOpen]` for a dialog an `overlay` component renders; `useUltimate().open(id)` opens it anywhere                                                                                                               |
| `useConnection()`                                                         | Stream status: `connecting`, `open`, `reconnecting`                                                                                                                                                                     |
| `useRestart()`                                                            | `api.restart()` with its outcome: `run`, `busy`, `pending` generation, and `error` when a check or boot failed or an activation was rolled back                                                                         |
| `getConversation()`, `getState()`                                         | The same data now, outside React: in commands and callbacks. Components use the hooks.                                                                                                                                  |
| `useNotices()`, `useCommands()`, `useExtensions()`, `useNow(ms, active?)` | Server and client notices, all commands, installed web facets, a clock ticking every `ms` while `active`                                                                                                                |
| `useStore(select)`                                                        | Any slice of the client state (`State`), re-rendering when it changes                                                                                                                                                   |

`api` sends commands: `submit(text, whenBusy?)`, `abort()`, `configure({ model, thinkingLevel })`, `compact()`,
`createConversation()`, `login(provider, type)`, `answer(flowId, value)`, `cancel(flowId)`, `logout(provider)`,
`restart()`, and `action(extension, name, args?)`. Conversation commands default to the shown conversation.

`api.cancelSubmission(submissionId, conversationId?)` withdraws one queued input without stopping the run.

Helpers: `cn()` for class names, `formatTokens`, `formatBytes`, `formatDuration`, `shortenPath(path, { cwd, home })`
(`home` is `useSystem().machine.home`), `elidePath`, `formatKeys`. Types for everything above are exported too
(`EntryRecord`, `AssistantMessage`, `SystemInfo`, …).

Keep UI state that should survive a reload in `useExtensionUiState`; keep throwaway state (hover, an open menu) in
`useState`. The shell keeps its own layout there too (`shell.conversation`, `shell.surface`, `shell.shownSurface`,
`shell.panel`, `shell.panelOpen`, `shell.sidebarOpen`, `shell.dock.<surface>.<side>`).

## Styling

- Use the components first: `@/components/ui/*` (shadcn: button, collapsible, command, dialog, dropdown-menu, kbd,
  popover, tooltip) and `@/components/ai/*` (code block, conversation, message, reasoning, shimmer, tool, prompt
  input). Need another shadcn component? `pnpm dlx shadcn@latest add <component>` writes it to
  `web/src/components/ui`.
- Style with Tailwind utilities and the theme tokens: `bg-background`, `bg-card`, `bg-muted`, `bg-terminal`,
  `text-foreground`, `text-muted-foreground`, `border-border`, `text-brand` (the one accent), `text-success`,
  `text-warning`, `text-error`, `text-diff-add`, `text-diff-del`. Opacity modifiers work: `bg-error/10`. They follow
  the light and dark themes; never hard-code colours.
- No new CSS files, no inline style objects for colours.
- Dense and quiet: 12–14 px, monospace (`font-mono`) for meta such as paths, counts, ids, and durations; proportional
  for prose. Subtle borders (`border-border/70`), little motion.

## Conventions

- One feature per folder; the folder name is the extension name; a README is required. Keep it small.
- Do not import another extension's files; share through documents, commands, or the SDK.
- Server facets: see `prompt/` for prompt sections and `coding-tools/server.ts` for tools; the root `AGENTS.md` explains
  reloads and durability. Server facets may `export const order = -100`: lower values come first, with the default 0
  keeping folder-name order; changing it reorders the prompt and tools once.
