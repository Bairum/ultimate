# Phase

Opt-in working-phase labels, classified by Jev after each tool round. Enable `classify` and `phase`; classify needs `TYPESAFE_API_KEY` in Secrets. Transcript excerpts leave the machine (see [classify](../classify/README.md)).

One background durable task per conversation asks over the latest request, 15 tool calls and latest assistant text. Answers are memoized and bound to their run (its first input, which survives Pi's per-round generation handovers); confidence below 0.6 keeps the previous phase within that run. Interrupted requests are abandoned on restart, never resent. Provider errors never fail the main run. Yielding or starting a new run clears the displayed phase in the root `ultimate.conversation-phases` document, retaining the in-flight lock until the task settles.

The phase sits at the right end of the line under the composer. `chip.tsx` exports `usePhase` and `PhaseLabel` for other facets; waiting on subagents and idle are derived locally, not classified, so Waiting shows whenever `phase` is enabled, even without a key; with `phase` disabled `usePhase` returns nothing.
