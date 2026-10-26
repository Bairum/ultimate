Stop check continues a subagent or coordinator once when its final answer announces work it is about to do ("Let me run
the tests now.") and then ends the turn without doing it.

On each final answer (an `onYield` hook on the generation), it asks classify (`ClassifyApi`, Jev) one `noul` question
over `{ request, message }`: the text of the input that started the run (≤ 4000 characters) and the end of the final
answer (≤ 4000 characters). At a probability of 0.9 or more it returns a continuation ("Your last message said you
would do more work but the turn ended. Continue with it now, or say plainly why you stopped.") and writes a
`stop-check.continued` card with the probability and the last 300 characters of the answer. The card carries no model
message; the agent only sees the continuation.

- **Who**: only conversations with an agent definition (subagents, coordinators: the `Profile` definition or the
  conversation's label). Never @ultimate, roots, side chats or a user's own conversations.
- **Once per run**: the decision is memoized per run (its first input) in the generation, so a replay after a crash
  repeats it without asking or writing again; the `stop-check.run` document on the conversation records the continued
  run, so the continuation's own generation is never continued again.
- **Failure**: without classify (disabled or no `TYPESAFE_API_KEY`), on an error or after 5 seconds it does nothing.
  The request and answer text leave the machine for TypeSafe, as with every classify call.
- **Off**: set `"stopCheck": false` in `~/.ultimate/settings.json` or a project's `.ultimate/settings.json` (the
  project's value wins).

## Order with the advisor

`onYield` hooks run in the agent's extension order and the harness stops at the first `continue`
(`answer()` in pi-durable's `harness/generation.js`). That order is `compareExtensions` (`server/discovery.ts`): `order`,
then source, then folder name, passed to the harness as `settings.extensions` (`server/harness.ts`). The built-ins with
an `onYield` hook therefore run advisor → messages → phase → stop-check → conversations (order 100). When the
advisor's `continueOn` sends an answer back, stop-check is not asked for that answer, so one answer is never continued
twice.
