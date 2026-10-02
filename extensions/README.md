# Writing extensions

Almost everything in Ultimate is an extension: tools, prompt sections, tool renderers, the status line, panels, whole
app views. The web core only provides the frame (layout with slots, the live data layer, transcript, composer, command
palette). New UI is a new extension folder. Copy the closest existing extension and change it:

| Want                                              | Copy                                              |
| ------------------------------------------------- | ------------------------------------------------- |
| A status-line item                                | `status-line`                                     |
| Tool renderers (diffs, terminals, images)         | `coding-tools`, `browser`, `instance`             |
| A right-panel tab                                 | `info` (key/value sections), `tasks`, `subagents` |
| Toolbar buttons, dialogs, commands, a popover     | `models`                                          |
| A header badge, an entry renderer that wraps core | `self`                                            |
| An extension document in the UI (`useDoc`)        | `codemode`                                        |
| Toasts or other global overlays                   | `notices`                                         |

An extension is a folder `extensions/<name>/`:

| File        | Facet                                                                                                   | Goes live                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `server.ts` | Agent: a Pi Durable extension (tools, prompt sections, hooks, documents)                                | Reinstalled on save; running tool calls finish on old code |
| `web.tsx`   | UI: `export default defineWebExtension({ … })`                                                          | Vite hot reload, no page reload                            |
| `README.md` | What it does; the first paragraph is shown in the UI, so open with a sentence, not a heading. Required. | Read on change                                             |

Files ending in `.ts` belong to the server facet, files ending in `.tsx` to the web facet: split a large `web.tsx` into
more `.tsx` files in the same folder (see `coding-tools/diff.tsx`). The folder name is the extension name; a
`server.ts` extension must use it as its `name`.

Each web facet loads on its own. If it fails to compile or throws, an error card names it and the rest of the UI keeps
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

`defineWebExtension({ slots, panels, views, tools, entries, commands })`; every key is optional. Extensions load in
folder-name order; give a slot item `{ component, order }` to move it (default order 0, lower first).

### Slots

Components mounted in named places of the shell.

| Slot               | Where                                                       |
| ------------------ | ----------------------------------------------------------- |
| `sidebar`          | Left column; it disappears while nothing is in it           |
| `header.right`     | Right side of the header, before the palette button         |
| `statusline.left`  | Bottom status line, left; monospace, one line               |
| `statusline.right` | Bottom status line, right                                   |
| `composer.toolbar` | Left of the composer's footer, beside the send button       |
| `overlay`          | Always mounted at the root: dialogs, toasts, global effects |

```tsx
slots: { 'header.right': [Badge], sidebar: { component: Conversations, order: -1 } }
```

### Panels

Tabs of the right panel (toggle: `mod+alt+b`).

```tsx
import { InfoIcon } from 'lucide-react'
panels: [{ id: 'info', title: 'Info', icon: InfoIcon, component: InfoPanel }]
```

Open one from code with `useUltimate().openPanel('info')`.

### Views

A whole app in the main area. While a view shows, the conversation moves to a collapsible dock beside it, with the
composer. The header lists views as tabs; the palette gets a "Show …" command for each.

```tsx
views: [{ id: 'board', title: 'Board', icon: KanbanIcon, component: Board }]
```

View ids are global; prefix generic ones with the extension name.

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

`run(context)` gets the shell actions (below) and the shown `conversationId`; return a promise to have a failure
reported as a notice. `when(context)` hides the command when it returns false; a `when` that throws hides it too and
reports a notice naming your extension. Commands run outside React: read the current state with `getConversation()`
and `getState()`, not hooks.

Plain keys and Shift+letter never fire while the user types; chords with `mod`, `alt`, or `ctrl` do, and so do Escape
and Shift+Tab (Pi's thinking toggle) outside dialogs. To let a command open UI an extension renders, such as a
popover, use a dialog id: the command calls `context.open(id)` and the component reads `useDialog(id)` as its open
state (see `models`).

## SDK (`@/sdk`)

Import only from `@/sdk`, `@/components/ui/*`, `@/components/ai/*`, `react`, and `lucide-react`. Never call `fetch` or
open an `EventSource` yourself: the SDK keeps one live stream per shown conversation and replays its changes.

| Hook                                                                      | Returns                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useConversation()`                                                       | The shown conversation: `id`, `entries`, `agent` (`pi.agent`), `usage`, `live` (`pi.live`), `inbox`, `busy`, `loading`                                                                                   |
| `useSystem()`                                                             | Build identity, machine, process (pid, generation, url), persistence, code (branch, sha, dirty, coreStale), extensions, skills, context files, agents                                                    |
| `useConversations()`                                                      | Summaries of every conversation: id, parent, owner task, agent and background (subagents), title, cwd, busy                                                                                              |
| `useTasks()`                                                              | The live task graph                                                                                                                                                                                      |
| `useModels()`                                                             | `GET /api/models`: providers with auth status, models with context window, reasoning, cost                                                                                                               |
| `useAuthFlows()`                                                          | Login flows by id: status, the pending prompt, events                                                                                                                                                    |
| `useDoc(kind)`                                                            | An extension document of the shown conversation (`export const docs` in `server.ts`); `undefined` until the stream delivers it (subscribing creates it with its initial value)                           |
| `useUiState(key, initial)`                                                | Durable UI state, stored with the main conversation: survives reloads and restarts, shared by every tab. `[value, set]`, JSON values only                                                                |
| `useExtensionUiState(key, initial)`                                       | `useUiState` under `ext.<your extension>.<key>`; use it for your own UI state                                                                                                                            |
| `useUltimate()`                                                           | `conversationId` and actions: `switchConversation`, `openView`, `openPanel`, `closePanel`, `togglePanel`, `toggleSidebar`, `runCommand`, `open(dialog)`, `close(dialog)`, `openPalette`, `focusComposer` |
| `useDialog(id)`                                                           | `[open, setOpen]` for a dialog an `overlay` component renders; `useUltimate().open(id)` opens it anywhere                                                                                                |
| `useConnection()`                                                         | Stream status: `connecting`, `open`, `reconnecting`                                                                                                                                                      |
| `useRestart()`                                                            | `api.restart()` with its outcome: `run`, `busy`, `pending` generation, and `error` when a check or boot failed or an activation was rolled back                                                          |
| `getConversation()`, `getState()`                                         | The same data now, outside React: in commands and callbacks. Components use the hooks.                                                                                                                   |
| `useNotices()`, `useCommands()`, `useExtensions()`, `useNow(ms, active?)` | Server and client notices, all commands, installed web facets, a clock ticking every `ms` while `active`                                                                                                 |
| `useStore(select)`                                                        | Any slice of the client state (`State`), re-rendering when it changes                                                                                                                                    |

`api` sends commands: `submit(text, whenBusy?)`, `abort()`, `configure({ model, thinkingLevel })`, `compact()`,
`createConversation()`, `login(provider, type)`, `answer(flowId, value)`, `cancel(flowId)`, `logout(provider)`,
`restart()`. Conversation commands default to the shown conversation.

`api.cancelSubmission(submissionId, conversationId?)` withdraws one queued input without stopping the run.

Helpers: `cn()` for class names, `formatTokens`, `formatBytes`, `formatDuration`, `shortenPath`, `elidePath`, `homeOf`,
`formatKeys`. Types for everything above are exported too (`EntryRecord`, `AssistantMessage`, `SystemInfo`, …).

Keep UI state that should survive a reload in `useExtensionUiState`; keep throwaway state (hover, an open menu) in
`useState`. The shell keeps its own layout there too (`shell.conversation`, `shell.view`, `shell.panel`,
`shell.panelOpen`, `shell.sidebarOpen`, `shell.dockOpen`).

## Styling

- Use the components first: `@/components/ui/*` (shadcn: button, badge, collapsible, command, dialog, kbd, popover,
  separator, tabs, tooltip) and `@/components/ai/*` (code block, conversation, message, reasoning, shimmer, tool,
  prompt input).
  Need another shadcn component? `pnpm dlx shadcn@latest add <component>` writes it to `web/src/components/ui`; then
  import `cn` from `'cn'` in it, as the others do (there is no `@/lib/utils`).
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
