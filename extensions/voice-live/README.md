# Live voice

A browser voice relay sends Daniel's words to @ultimate and speaks its answers through OpenAI GPT-Live.

This built-in is default-on by folder discovery; it does nothing billable until `start`. There is deliberately no
`web.tsx` yet. It uses `OPENAI_API_KEY` from Secrets (⌘K → Secrets), or Pi's OpenAI **API key**, never its OAuth login.
The key stays on the server. GPT-Live has no ephemeral browser keys.

## Flow

1. The browser acquires the microphone, adds its track to a peer connection, and creates `oai-events` **before** its
   offer. `StartAction` exchanges the SDP through `POST https://api.openai.com/v1/live/sessions` for `gpt-live-1`, voice
   `marin`, client delegation. It seeds at most ten recent Voice lines (each clipped to 200 characters).
2. The browser applies the SDP answer and waits for `session.started`; it never sends `session.start` on WebRTC.
   Remote tracks play through an autoplay audio element; an `AnalyserNode` exposes microphone levels.
3. `Relay` joins input transcript fragments. After 1,200 ms quiet it sends an utterance with the current delegation
   id, or without one if delegation was missed and it contains at least three words. It does not filter echo.
4. `say` passively writes Daniel's line to Voice. A durable task answers @ultimate's newest open question to the user
   through Messages, or submits a `voice.utterance` input with `whenBusy: 'steer'`. It waits for **that input receipt**,
   not idle or a guessed delay. In the question path it follows Messages' reply delivery to its input receipt.
5. The task reads the assistant answer. If that run instead ended with a message to the user, its message text and
   numbered questions/options are used. Short plain prose (≤60 words, no Markdown/code/paths/URLs) passes through.
   Other content is rewritten with the configured summary model, with memoized responses for replay safety and usage
   accounted to Voice. Without an available summary model, it strips code/links/paths and cuts to roughly sixty
   words plus “Details are on screen.” A configured model that fails is a failed task, not an invented answer.
6. The result is another passive Voice line, `role: 'ultimate', speech: true`. The UI watches **new** such entries and
   calls `session.speak(line.text, line.delegation ?? null)`. Do not replay historical speech on opening the view.

Voice is one ownerless conversation per project, created on first `start`: title **Voice**, label `voice`, automatic
summaries disabled. It runs no turns, and its display-only writes have no model messages. @ultimate keeps its normal
transcript and behaviour. GPT-Live only acknowledges/delegates, never answers requests itself. The literal
`Generate <|SpawnThinking|> when:` instruction and the backchannel/interruption/delegation policies live in
`LIVE_INSTRUCTIONS` in `server.ts`.

## Designer contract

`refs.ts` is browser-safe and exports:

| Ref            | Arguments                               | Result                                                                 |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `StatusAction` | `null`                                  | `VoiceStatus`: `{ available: true }` or `{ available: false, reason }` |
| `StartAction`  | `{ sdp: string }`                       | `{ sdp: string, conversation: number }`                                |
| `SayAction`    | `{ text: string, delegation?: string }` | `{ line: number }` (Daniel's entry id)                                 |
| `EndAction`    | `{ seconds?: number }`                  | `{}`                                                                   |
| `VoiceDoc`     | Read on root, conversation 1            | `VoiceState`: `{ conversation?: number }`                              |

All four actions are **user-only**. No agent tool starts a billable session. `start` writes a `voice.session` divider
`{ phase: 'started', at }`; `end` writes `{ phase: 'ended', at, seconds? }`. `at` is Unix milliseconds.

Entry data types are exported as `VoiceSession`, `VoiceLine`, and `VoiceUtterance`:

```ts
type VoiceSession = { phase: 'started' | 'ended'; at: number; seconds?: number }
type VoiceLine = {
  role: 'daniel' | 'ultimate'
  text: string
  delegation?: string
  source?: { conversation: number; entry: number }
  speech?: true
}
type VoiceUtterance = { text: string; line: number }
```

`voice.line` lives in Voice; `voice.utterance` lives in @ultimate. An ultimate line's `source.entry` is the assistant
answer entry (including when a tool-terminated message supplied its words). The delegation id is carried from Daniel's
line to the answer, so commentary can satisfy the right delegation. `VoiceStatus` is also exported.

`session.ts` exports `startLive(options): Promise<LiveSession>`, `LiveOptions`, and `LiveSession`, with no React or SDK
runtime dependency. Pass `{ action: (ref, args) => api.action(ref, args), onEvent, onError, onLine? }`. `onLine` reports
accepted **Daniel** utterances as `{ line, text, delegation? }`; it is not a subscription to Ultimate's lines.
`onEvent` receives every decoded data-channel event, including expires_at, output transcripts, usage, closure and errors.

The returned session exposes `conversation`, `analyser`, `relay`, `send(event)`, `mute()`, `unmute()`,
`speak(text, delegationId: string | null)`, and asynchronous `close()`. Commentary has a fresh `event_id`.
Mute toggles mic tracks and sends the corresponding input-audio event. Close sends `session.close`, waits for
`session.closed`, records `EndAction`, stops tracks/timers/audio, and closes the peer/audio context. A disconnected peer
or missing close confirmation is reported as an error; cleanup still runs (close confirmation has a five-second deadline).
Use `onError` for visible failures. `send` supports quiet `session.thinking.append` context if the UI needs it.

`relay.ts` exports `Relay`, `QUIET_MS = 1200`, `IDLE_MS = 120000`, `RelaySay`, and `LiveEvent`. Feed
`relay.event(event, now)` and `relay.tick(now)` to receive `{ say, delegation? }[]`; it suppresses duplicate text.
`startLive` already drives this relay and submits its results. The UI should call `close()` when
`session.relay.idleFor(Date.now()) >= IDLE_MS`; activity means input **or output** transcript fragments, not acknowledgements
of protocol events. Also show session expiry/closure and prevent multiple local starts. Do not start from a render effect.

## Costs and verification

GPT-Live costs **$0.05/minute**, with a **15-second minimum per WebRTC session** ($0.0125 minimum). Idle/muted time is
still session time. @ultimate and the optional speech summary model have their normal separate token costs. Closing
from the UI is important; merely hiding a front view must not leave the mic/session running.

`pnpm vitest run test/voice-live*.test.ts` uses synthetic clocks, faux agent/summary responses and a stubbed OpenAI SDP
exchange. It never calls real OpenAI. Real microphone, remote audio and GPT-Live behaviour require Daniel's live test;
they are not verified by the faux server tests.
