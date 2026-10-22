# Sounds

Short, soft notification sounds when @ultimate talks to you: a question (needs input), a
finished answer, or a failed run. "sounds" in the status bar opens a switch for all of them and a checkbox and a play
button for each; the choices live in `ext.sounds.muted` and `ext.sounds.off`.

Only the primary standing agent sounds, read from the root's documents:

- **Needs input:** its reply-expected `message` to the user (`messages`); every question goes that way.
- **Finished:** its one-way `message` to the user, or its answer to your typed input.
- **Failed:** its run ended in an error (`ultimate.conversation-overview`); a stop or a reset does not.

Nothing else sounds: branches, workers, the lander, other standing agents, messages to you from anyone else, landings,
and @ultimate's answers to other agents' messages (`internalInput`).

Each event sounds once. Whatever the documents show when a tab opens has been heard already, and of several open tabs
the first that may play claims the event under a Web Lock in local storage. Browsers let a page play only after
someone clicked or typed in it, so a tab that never had input leaves the event to another. The notes are synthesized
with Web Audio in `tones.ts`; `cues.ts` decides what sounds.
