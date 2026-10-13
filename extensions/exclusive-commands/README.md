Serialize configured heavy bash commands across all conversations in this Ultimate process.

Set `exclusiveCommands` in `<projectRoot>/.ultimate/settings.json` to an array of regular-expression sources:

```json
{
  "exclusiveCommands": ["\\bpnpm( run)? test\\b", "\\bvp test\\b"]
}
```

Settings are read at each call. Without the key, bash is unrestricted. Invalid expressions are reported in the tool
output and ignored. Only matching commands acquire the shared FIFO slot; other commands run normally. A waiting call
streams one line naming the command holding the slot. Aborting a waiter removes it without releasing another call's
slot; the holder releases in `finally`, including on error or cancellation.

The slot uses `host.resource`, so every conversation shares it and extension reloads preserve it. It is in memory:
a process crash frees it, and Pi reports interrupted calls as usual. There is no cross-process or durable lock.

This wraps the resolved bash tool, composing with other wrappers rather than replacing them.
Codemode's nested `tools.bash` also goes through the wrap: it resolves `api.agent().tools` and invokes the resolved
tool's `execute`. Nested output (including the waiting line) is collected privately by codemode, not streamed to the
outer call. Nested tool hooks do not run, but this is a tool wrapper, not a hook.
