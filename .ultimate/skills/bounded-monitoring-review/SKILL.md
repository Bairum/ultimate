---
name: bounded-monitoring-review
description: Run the A6 daily or A7 weekly advisor monitoring review across projects with bounded, read-only sources and an honest statement of what they cover. Use when an advisor review automation fires, or when asked how the advisor, classify or tool calls have been doing over the last days.
---

# Bounded monitoring review

A review reads; it changes nothing. Every source has a window and a cap: say them, and never turn a gap into "none".

## 1. Read the contracts first

In codemode, `ultimate.api('advisor')` and `ultimate.api('classify')`, then call only what they document:

- `advisor.stats` takes only `{days}` and covers **this host only**;
- other projects: `ultimate.doc('advisor.state', 1, {project})`, per project from `ultimate.projects()`;
- `classify.stats` accepts `project`.

## 2. Deeper reads, bounded

`ultimate.trace` returns only the newest 1000 rows. When that is not enough, run **exactly one** read-only
aggregate per affected project on its active chapter's `trace.sqlite` (`chapterFiles` in `lib/chapters.ts`;
the schema is `calls` in `server/trace.ts`, `at` in epoch ms):

```bash
sqlite3 -readonly "$TRACE" "
WITH w AS (SELECT * FROM calls WHERE at > (strftime('%s','now') - 48*3600) * 1000)
SELECT strftime('%Y-%m-%d %H:00', at/1000, 'unixepoch') h, count(*), sum(ok = 0), round(avg(ms)), sum(ms > 1000)
  FROM w GROUP BY h ORDER BY h;
SELECT kind, name, datetime(at/1000, 'unixepoch'), substr(error, 1, 160)
  FROM calls WHERE ok = 0 AND at > (strftime('%s','now') - 48*3600) * 1000 ORDER BY at DESC LIMIT 50;"
```

Never select `args` or `result`, and never read secrets. Read history in small pages
(`ultimate.entries(id, {limit: 20})`, `ultimate.search` with `limit`): large pages from busy projects exceed the
1 MiB response limit.

## 3. State coverage honestly

- The window each source actually covers: trace retention is about 7 days and capped around 200k rows
  (`callTrace` in `server/trace.ts`), so busy projects keep fewer days; the notes list is capped.
- A failed remote read is a verification gap, not "no activity".
- Skip counters are cumulative and undated: no rate or trend from them.
- A spot-check of N items is a sample: "none in 20 checked", never a categorical "none".
- Correlation is not cause.

## 4. Costs

Advisor spend is nominal, subscription-equivalent, not billed; TypeSafe classify spend is billed. The cap per
project per day is in memory `advisor-monitoring`.

## 5. Not defects

Standing decisions, not findings: the idle-@ultimate advisor wake is once per run (the user approved it on card
1343), and find being off on one of the user's machines, whose `~/.ultimate/settings.json` disables it. The rest is in
memory `advisor-routing-to-parent`.

## 6. Limits

No model calls, provider probes, tests, benchmarks or polling; no settings or code changes; no attaching to live
processes.

## 7. Report

Coverage and limits first (sources, windows, gaps), then findings with evidence, then one line
`Divergence: …` naming any read beyond these bounds, or "None".
