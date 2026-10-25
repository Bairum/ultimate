Live voice pairs GPT-Live's audio with a fast Luna agent that decides what to pass to @ultimate.

Nothing is billable until a session starts or the Voice agent receives input. GPT-Live uses `OPENAI_API_KEY` from
Secrets (⌘K → Secrets), or Pi's OpenAI **API key**, never its OAuth login. The key stays on the server. The Voice
agent uses `openai-codex/gpt-6-luna` through Pi's existing ChatGPT login, low thinking and the fast tier.

## Flow

1. The browser acquires the microphone, adds its track to a peer connection and creates `oai-events` before its
   offer. `start` looks up `subagents.standing('voice')` and exchanges SDP through OpenAI's live sessions endpoint
   (`gpt-live-1`, voice `marin`). It seeds at most ten recent Voice lines, each clipped to 200 characters.
2. After `session.started`, remote audio plays through an autoplay element. GPT-Live only listens, backchannels
   and speaks received commentary. It never handles work questions or decides to delegate.
3. `Relay` joins transcript fragments after 1,200 ms quiet. Every finished Daniel line goes through `heard` as a
   `voice.heard` input to Voice (`whenBusy: 'steer'`). GPT-Live's own speech can be logged as `live` lines;
   commentary output is not logged twice. Delegation events are ignored.
4. `agents/voice.md` configures the standing agent with exactly three deferred tools:
   - `voice_say {text}` writes an `ultimate` `voice.line` with `speech: true`. The browser sends it as commentary.
   - `voice_ask_ultimate {request}` writes a forwarded Daniel line and schedules the durable answer task. It answers
     @ultimate's newest open question through Messages, or submits a typed `voice.utterance` with the clean request.
     The task follows that specific input receipt, including Messages delivery, not idle or an arbitrary delay.
   - `voice_note {text}` writes a quiet `note` line, forwarded by the browser as `session.thinking.append`.
     Tool names are prefixed to avoid colliding with other agents' tools (especially lineage's `note`).
5. The answer task sends @ultimate's full answer back as a `voice.answer` input to Voice. A tool-terminated message
   uses its user-facing text and numbered questions/options. Voice speaks the conclusion in 2–4 short sentences,
   preserving decisions without reading Markdown, paths or code aloud. There is no summary-model speech rewrite.
   Failed/unanswered inputs leave a notice linked to the forwarded line and tell Voice to explain the failure.
   `voice_say` derives `re` from the input preceding its own tool round, so speech answers the right forwarded line.
   Request ids and a transactional scheduling receipt keep forwards and answer delivery safe across task replay.

## Browser and transcript

`Standing.voice` is the only Voice conversation index. Its `Unlisted` provider removes it from other sidebar lists;
the Voice row nests under @ultimate. Daniel's heard inputs are plain bubbles, forwarded requests have working,
answered and failed states, and speech has its own line. Tool cards are hidden and ordinary agent prose is quiet.

Voice mode outlasts individual sessions. After two quiet minutes the session closes and listening pauses; an answer
wakes it (or waits for a tap if browser activation blocks it). A pending forwarded request gets a short “Still on it”
after 20 seconds, then every 45 seconds. Acknowledgements do not clear that pending state. Mute, End, the level meter,
front/back sheet and ready/pause/end tones remain browser-side. Closing waits for `session.closed`, records usage
seconds and releases the microphone even on failure. No session survives its page.

`test/voice-live.test.ts` exercises the agent/Ultimate round trip with faux models, including spoken question answers.
`test/voice-live-relay.test.ts` exercises quiet-line joining, commentary suppression and idle tracking with a supplied
clock. Neither contacts OpenAI.
