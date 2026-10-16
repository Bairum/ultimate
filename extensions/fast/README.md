Fast mode runs the OpenAI models named in `fastModels` on the priority service tier, about twice the output speed.

Set `fastModels` to `"provider/id"` names in `~/.ultimate/settings.json`, or in a project's `.ultimate/settings.json`,
which replaces the user's list:

```json
{ "fastModels": ["openai/gpt-6.1-sol"] }
```

The composer toolbar shows a **fast** toggle while an `openai/` model is selected. It adds that model to the user's
`fastModels` or removes it (the `set` action), so it applies to every request to the model, not just the shown
conversation. While a project's settings set the list, the toggle is disabled and the project file decides.

Every request to a listed model goes fast: conversations, subagents whose definition names it (workers, the lander,
reviewers), and summaries. The list is read at each request, so a change applies to the next one. Only `openai/`
models are accepted; any other entry turns fast mode off with a notice.

The extension registers an overlay on the `openai` provider whose stream adds `service_tier: "priority"` to the
Responses payload of listed models and leaves every other request unchanged. pi-ai's simple stream options drop
`serviceTier`, so it is set through `onPayload`, after the caller's own hook. Sign in with ChatGPT rejects the
documented `"fast"` value and accepts `"priority"`, the same tier.

Fast mode costs more. With Sign in with ChatGPT it uses the plan's included usage at 2.5× the Standard rate; with an API
key it is billed at 2× Standard. Sign in with ChatGPT reports `service_tier: "default"` even for priority requests,
so displayed costs stay at Standard list prices.

Verification: `pnpm vitest run test/fast.test.ts`.
