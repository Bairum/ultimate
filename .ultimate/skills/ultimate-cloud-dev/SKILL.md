---
name: ultimate-cloud-dev
description: Develop, probe and diagnose Ultimate's own Cloudflare Worker (this repository's `cloud/`). Use when changing Worker or Durable Object code, testing a change on a throwaway Worker, deploying a change that adds Worker→Durable Object calls, resetting a Durable Object class, or digging into Worker telemetry.
---

# Working on Ultimate's Worker

`cloud/README.md` describes what the Worker holds, its protocol, Deploy and Observability. @sync deploys and verifies (`agents/sync.md`, "Your Worker"); this skill adds what developing the Worker itself needs.

## Probe Workers

- Name throwaway Workers `ultimate-probe-*`. They use synthetic data, never production replicas, and return no user data.
- Keep them behind Access; never enable a workers.dev or preview URL. Never touch Access applications: that is the user's dashboard step.
- Record what you created and delete it in the same turn, including on failure (`pnpm exec wrangler delete --name ultimate-probe-…`). A timer is not a cleanup guarantee. Confirm the cleanup in your report.

## Rolling deploys

Durable Objects keep running the previous code for a while after the Worker switches. Before deploying, check every Worker→DO call the diff adds or changes against the DO code now deployed (`git show <deployed sha>:cloud/...`; the deployed sha is the version's `workers/tag`): the old object must refuse the new request harmlessly (a 4xx, never a 500) and the caller must retry. Each such call needs its case in `test/cloud-rolling-deploy.test.ts` ("Rolling deploys" in `cloud/README.md`). Without that, stop and ask.

Errors in the first minutes after a deploy may come from objects that have not restarted yet. Classify them by route and DO version before rolling back: old objects refusing a new route harmlessly mean extending the window, not a rollback.

## Durable Object class resets

Removing a class's data takes two deploys: one moves the binding to a new class while the old stays exported, the next deletes it (see Deploy in `cloud/README.md`). Deleting a class deletes its data: it needs the user's explicit yes. Never use a fresh Durable Object identity to work around a stall without explaining the data implications and getting approval.

## Deep telemetry

`cloudflare_observability` (`extensions/cloudflare/README.md`) queries Workers Observability for the Worker over a narrow `from`–`to` window: `view` `errors` for a baseline and after a deploy, `invocations` for traffic, `traces` for slow or failing requests, then `traceId` to follow one request and `search` (a literal, not a regex) for a route, version id or Durable Object class. Counts for traces and invocations describe the returned sample. Compare a deploy against the error baseline from before it, and query slightly past the window, since telemetry arrives late. The token `CLOUDFLARE_API_TOKEN` (⌘K → Secrets) needs **Workers Observability Write** (the query API requires it) and **Account Settings Read**.

## Known traps

- `wrangler tail` drops Durable Object WebSocket events; use observability instead.
- Deploys do not drop hibernated machine sockets; a deploy alone does not prove reconnect or recovery.
- A fresh hostname gets scanned within minutes; never expose user data, even briefly.
- Build with production `NODE_ENV`; `cloud/build.ts` forces it.
