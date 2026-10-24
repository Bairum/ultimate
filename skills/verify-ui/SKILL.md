---
name: verify-ui
description: Check a UI change in Ultimate by looking at it with the screenshot and browser tools, on the running host or a preview. Use after changing anything a person sees (web/, a web.tsx, a card, a renderer) and before reporting it done or asking for approval.
---

# Look at the change

Never claim a UI change works without an image of it.

## Where to look

- `web/` and built-in `extensions/` changes in the host's own checkout reload in the running host: omit `url`.
- A worktree, a branch or a project `.ultimate/extensions/` change does not reach the host: start a preview of the
  checkout (`instance start`) and pass its URL. `server/` or `shared/` changes need a fresh preview.

## How

- `screenshot {url}` for a still image; `selector` for one element, `fullPage` for long pages, `width: 390` for phone,
  `theme: 'light'` and `'dark'` for both themes. Omit `path` so the PNG stays outside your checkout.
- `browser {url, steps}` to drive a state: `click`, `fill` (`#composer-input` is the composer), `press`
  (`Control+k` opens ⌘K), `wait`, `eval`. The result lists console errors and failed requests: read them.
- Wait on Ultimate's state, never a guessed time: `{send: 'prompt'}` submits without the composer, then
  `{until: 'idle'}` returns when that turn is done, `{until: 'quiet'}` when nothing runs (branches and subagents
  included), `{until: {entry: 'pi.tool-result'}}` or `{until: {event: 'workspaces.landed', where: {…}}}` when that
  appears. A timeout says what was still busy. `conversation: <id>` targets another conversation. Click and fill only
  when the interaction itself is under test.
- Open a conversation with `?conversation=<id>`. Right-panel section titles are uppercased by CSS: find them with
  `textContent.startsWith('Skills')`, not by their shown text.
- Seed real state with real prompts on a preview; do not inject entries.

## What to check

1. Every state: loading, empty, error, one item, many items, a long title.
2. It matches its neighbours: an existing card or panel next to it, theme tokens, spacing.
3. Transcript UI, on a long conversation:
   1. scrollback: scroll up and back down; nothing jumps or reflows;
   2. live streaming: watch a reply and its tool calls stream in;
   3. folding: fold and unfold tool calls and update groups;
   4. phone width: a screenshot at `width: 390`.
4. No new console errors.

Say what you could not reach as unverified, with the reason.
