# Agent evals

Run `pnpm eval` explicitly; `pnpm test` does not discover these files.
Pi's normal shared auth supplies OpenAI Codex; no credentials are copied into fixtures.
The default is `openai-codex/gpt-6-luna` with `high` thinking.
Override with `ULTIMATE_EVAL_MODEL` and `ULTIMATE_EVAL_THINKING`.
Write a `*.eval.ts` file under `evals/`, using Vitest and `./fixture.ts`.
Call `start({ project: { files, git }, extensions: { enable, disable } })`.
Create a conversation with `conversation({ history: [user(...), assistant(...)] })`.
Attach to an action-created conversation with `conversation({ id })`; it uses the selected eval model.
List conversations with `await ultimate.conversations()` (a snapshot from the existing HTTP event stream).
Opt-in extensions override the fixture's default disabled set, so workspace and conversation evals can enable them.
Use `assistant('', [toolCall])` and `toolResult(id, name, text, isError)` for tool history.
Seeds append actual Durable entries without running a model.
Call `c.run(input)` to submit through HTTP and wait for idle; call it again to continue.
Assert on `turn.text`, `turn.toolCalls`, files, git, or extension HTTP actions.
Use `ultimate.file`, `ultimate.exec`, and `ultimate.action` to inspect outcomes.
Always `await ultimate.stop()` in `finally`; every test gets temporary project, config, and state.
Each measured turn prints wall time and model usage, excluding seeded history usage.
Prefer evals for tool choice and completing user requests, not exact wording.
Keep faux tests for crashes, races, storage, durability, browser, and process semantics.
