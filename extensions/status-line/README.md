Pi's footer in the status line: cwd and git branch, `↑input ↓output R cacheRead W cacheWrite`, cache hit rate, cost (`(sub)` on a subscription), context use of the model's window (warning above 70 %, error above 90 %), model · thinking · provider, and the connection to the server with its generation.

The Tokens item shows model output tokens per second across all conversations over the last 30 seconds; hover for input and cache rates. Provider reports may arrive late, and tool usage is excluded.

Conversation totals come from `pi.usage`, the model and thinking level from `pi.agent`, the context window from `GET /api/models`, and cwd, branch, and process from system info. Hover an item for details; clicking the model runs the `model.pick` command when an extension provides it.
