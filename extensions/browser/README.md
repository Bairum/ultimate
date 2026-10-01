# Browser

Look at Ultimate's UI and drive fresh headless Chromium pages with `screenshot` and `browser`. After UI changes, inspect the returned image rather than assuming the page renders.

Install Chromium separately; playwright-core does not download browsers. Resolution checks `ULTIMATE_CHROMIUM`, `/usr/bin/chromium`, `/usr/bin/google-chrome-stable`, then `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`. A browser is launched lazily and closed when the host shuts down. Each call has its own isolated context, closed on completion or cancellation.

`screenshot` accepts URL/path, viewport dimensions (1440 × 900 by default), selector, fullPage, waitMs (1500 by default) and light/dark theme. The conversation argument is ignored: the shell uses durable `shell.conversation` state, not a URL parameter. PNG originals live in `$ULTIMATE_HOME/screenshots`; returned JPEGs are capped at 1600 pixels on the longest side. Loading console and page errors accompany the title and PNG path.

`browser` accepts click/fill/press/wait/eval steps and an optional final screenshot (default true). JavaScript eval runs inside the page. Calls stream progress; screenshot is replay-safe, browser is not because interactions may submit prompts. Both are automatically available in codemode's `tools`; use `const shot = await tools.screenshot({}); image(shot.image)` to display its image. Structured nested results include title, PNG file path, outcomes, and an image data URI.
