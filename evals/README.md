# Agent evals

Run `pnpm eval` explicitly; `pnpm test` does not discover these files.
Pi's normal shared auth supplies OpenAI; no credentials are copied into fixtures.
The default is `openai/gpt-6-luna` with `high` thinking.
Override with `ULTIMATE_EVAL_MODEL` and `ULTIMATE_EVAL_THINKING`.
Write a `*.eval.ts` file under `evals/`, using Vitest and `./fixture.ts`.
Call `start({ project: { files, git }, extensions: { enable, disable } })`.
Create a conversation with `conversation({ history: [user(...), assistant(...)] })`.
Attach to an action-created conversation with `conversation({ id })`; it uses the selected eval model.
List conversations with `await ultimate.conversations()` (a snapshot from the existing HTTP event stream).
The fixture runs a fixed base set (the coding agent without workspaces, conversations, status line, browser or faux); `enable` adds extensions to it, so each eval loads only what it measures.
Use `assistant('', [toolCall])` and `toolResult(id, name, text, isError)` for tool history.
Seeds append actual Durable entries without running a model.
Call `c.run(input)` to submit through HTTP and wait for idle; call it again to continue.
Assert on `turn.text`, `turn.toolCalls`, files, git, or extension HTTP actions.
Use `ultimate.file`, `ultimate.exec`, and `ultimate.action` to inspect outcomes.
Always `await ultimate.stop()` in `finally`; every test gets temporary project, config, and state.
Eval files run in parallel (up to four workers), with up to four concurrent tests per file.
Fixtures use separate temporary directories and ephemeral ports; turns within a conversation remain sequential.
Each measured turn prints wall time and model usage, excluding seeded history usage.
The reporter collects usage across workers, including turns whose assertions fail.
After Vitest's results, it prints elapsed and summed turn time (a sequential-time comparison,
not a separate sequential run), then ends with one total cost line:
`Evals: 14 turns · 345,000 tokens · $0.42 · openai/gpt-6-luna`.
Totals cover fixture conversation turns, not background summaries or delegated subagent usage.
Prefer evals for tool choice and completing user requests, not exact wording.
Keep faux tests for crashes, races, storage, durability, and process semantics.
