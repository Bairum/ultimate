# Phase

Opt-in working-phase labels, classified by Jev after each tool round. Enable `classify` and `phase`; classify needs `TYPESAFE_API_KEY` in Secrets. Transcript excerpts leave the machine (see [classify](../classify/README.md)).

One background durable task per conversation asks over the latest request, 15 tool calls and latest assistant text. Answers are memoized; confidence below 0.6 keeps the previous phase. Provider errors never fail the main run. Yielding clears the row in the root `ultimate.conversation-phases` document.

The composer pill sits above its left edge, alongside the plan pill. `chip.tsx` exports `usePhase` and `PhaseLabel` for other facets; waiting on subagents and idle are derived locally, not classified.
