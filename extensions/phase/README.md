# Phase

Working-phase labels, classified by Jev after each tool round. It needs `classify`, which needs `TYPESAFE_API_KEY` in Secrets. Transcript excerpts leave the machine (see [classify](../classify/README.md)).

One background durable task per conversation asks over the latest request and the work since it: up to its last 15 tool calls and latest assistant text (never earlier runs or a branch's inherited history). Answers are memoized and bound to their run (its first input, which survives Pi's per-round generation handovers); confidence below 0.6 keeps the previous phase within that run. Interrupted requests are abandoned on restart, never resent. Provider errors never fail the main run. Yielding or starting a new run clears the displayed phase in the root `ultimate.conversation-phases` document, retaining the in-flight lock until the task settles.

The phase sits at the right end of the line under the composer, on busy branch rows, and in lower case in place of "working" on the top-bar @ultimate button and the standing-agent rows (@lander, @sync). `chip.tsx` exports `usePhase` and `PhaseLabel` for other facets; waiting on subagents and idle are derived locally, not classified, so Waiting shows whenever `phase` is enabled, even without a key; with `phase` disabled `usePhase` returns nothing.
