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

A matching call's effective `args.timeout` covers waiting plus execution. The default-timeout wrapper
(default server order 0) runs outside this wrapper (`order = -10`) and supplies the default budget (600 seconds, overridden
by `ULTIMATE_BASH_TIMEOUT`). This extension reads only args and its own settings: it neither injects a timeout nor
formats tripwire errors. If no wrapper or caller supplies a timeout, waiting and execution have no time limit.
A deadline while waiting fails with an error naming the current holder and the limit; the waiting command never
starts. After acquisition, bash receives the remaining seconds rounded up, with a minimum of one second.
Execution timeout errors pass through to the outer wrapper, which reports the tripwire for default budgets
and leaves explicit timeout errors unchanged.

The slot uses `host.resource`, so every conversation shares it and extension reloads preserve it. It is in memory:
a process crash frees it, and Pi reports interrupted calls as usual. There is no cross-process or durable lock.

This wraps the resolved bash tool, composing with other wrappers rather than replacing them.
Codemode's nested `tools.bash` also goes through the wrap: it resolves `api.agent().tools` and invokes the resolved
tool's `execute`. Nested output (including the waiting line) is collected privately by codemode, not streamed to the
outer call. Nested tool hooks do not run, but this is a tool wrapper, not a hook.
