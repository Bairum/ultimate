# Sounds

Short, soft notification sounds when a top-level conversation needs you: a question (needs input), a finished task,
or a failed run. "sounds" in the status bar opens a switch for all of them and a checkbox and a play button for each;
the choices live in `ext.sounds.muted` and `ext.sounds.off`.

The sounds follow the conversations extension's overview on the root (`ultimate.conversation-overview`). A reply
waits for its assessment by the summary model, which tells a question (`needs_input`) from a finished task; a reply
without an assessment in flight sounds as finished after two seconds. A run that ended in an error sounds as failed;
a stop or a reset does not. Subagents and the lander stay quiet: their owner hears about them.

Each event sounds once. Whatever the overview shows when a tab opens has been heard already, and of several open tabs
the first that may play claims the event under a Web Lock in local storage. Browsers let a page play only after
someone clicked or typed in it, so a tab that never had input leaves the event to another. The notes are synthesized
with Web Audio in `tones.ts`; `cues.ts` decides what sounds.
