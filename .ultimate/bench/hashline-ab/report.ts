import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Result } from './metrics.ts'

export function report(results: Result[]) {
  const output = [
    '# Edit tooling A/B',
    '',
    'Exploratory measurements, not a statistical confidence interval. N/A means not enough paired data.',
    '',
    'Wrong target counts runs that changed non-blank lines outside the mutated region; blank-line seams (only blank lines changed there) are counted separately.',
    '',
    '| Model | Arm | Runs | Pass | Edit errors | Wrong target | Blank seams | Output/pass | Cost/pass USD | Mean seconds |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  const models = [...new Set(results.map((r) => r.model))]
  const arms = [...new Set(results.toSorted((a, b) => a.armOrder - b.armOrder).map((r) => r.arm))]
  const stats = (rows: Result[]) => {
    const passed = rows.filter((r) => r.pass).length
    const sum = (key: 'output' | 'editCalls' | 'editErrors' | 'wallMs') =>
      rows.reduce((a, r) => a + r[key], 0)
    const calls = sum('editCalls')
    return {
      passed,
      rate: passed / rows.length,
      errors: calls ? sum('editErrors') / calls : null,
      wrong: rows.filter((r) => r.wrongTarget).length,
      seams: rows.filter((r) => !r.wrongTarget && r.blankSeam).length,
      output: passed ? sum('output') / passed : null,
      cost:
        passed && rows.every((r) => r.cost !== null)
          ? rows.reduce((a, r) => a + r.cost!, 0) / passed
          : null,
      seconds: sum('wallMs') / rows.length / 1000,
    }
  }
  const number = (n: number | null, digits = 2) => (n === null ? 'N/A' : n.toFixed(digits))
  for (const model of models)
    for (const arm of arms) {
      const rows = results.filter((r) => r.model === model && r.arm === arm)
      if (!rows.length) continue
      const s = stats(rows)
      output.push(
        `| ${model} | ${arm} | ${rows.length} | ${number(s.rate * 100)}% | ${s.errors === null ? 'N/A' : number(s.errors * 100) + '%'} | ${s.wrong} | ${s.seams} | ${number(s.output)} | ${number(s.cost, 6)} | ${number(s.seconds)} |`,
      )
    }
  output.push('', '## Pass bars', '')
  for (const model of models) {
    const baseline = results.filter((r) => r.model === model && r.arm === arms[0])
    for (const arm of arms.slice(1)) {
      const candidate = results.filter((r) => r.model === model && r.arm === arm)
      const paired =
        baseline.length > 0 &&
        baseline.length === candidate.length &&
        baseline.every((a) => candidate.some((b) => a.task === b.task && a.run === b.run))
      if (!paired) {
        output.push(`- ${model}, ${arm}: N/A — incomplete paired runs.`)
        continue
      }
      const a = stats(baseline),
        b = stats(candidate)
      const verdict = (v: boolean | null) => (v === null ? 'N/A' : v ? 'PASS' : 'FAIL')
      output.push(
        `### ${model}: ${arm} vs ${arms[0]}`,
        '',
        `- Pass rate B ≥ A − 2 pp: ${verdict(b.rate >= a.rate - 0.02)}`,
        `- Edit-tool error rate ≤ 3%: ${verdict(b.errors === null ? null : b.errors <= 0.03)}`,
        `- Zero wrong-target writes: ${verdict(b.wrong === 0)}`,
        `- Output tokens/passed task ≥ 15% lower: ${verdict(a.output === null || b.output === null ? null : b.output <= a.output * 0.85)}`,
        `- Cost/passed task not higher: ${verdict(a.cost === null || b.cost === null ? null : b.cost <= a.cost)}`,
        '',
      )
    }
  }
  if (arms.length < 2) output.push('- N/A — only one arm measured; no A/B verdict.')
  output.push(
    '',
    '## Per-task matrix',
    '',
    '| Model | Task | ' + arms.join(' | ') + ' |',
    '|---|---|' + arms.map(() => '---').join('|') + '|',
  )
  for (const model of models)
    for (const task of [
      ...new Set(results.filter((r) => r.model === model).map((r) => r.task)),
    ].toSorted()) {
      output.push(
        `| ${model} | ${task} | ${arms
          .map(
            (arm) =>
              results
                .filter((r) => r.model === model && r.task === task && r.arm === arm)
                .toSorted((a, b) => a.run - b.run)
                .map(
                  (r) =>
                    `${r.run}:${r.error ? 'ERROR' : r.pass ? 'PASS' : 'FAIL'}${r.wrongTarget ? ' (wrong target)' : r.blankSeam ? ' (blank seam)' : ''}`,
                )
                .join(', ') || '—',
          )
          .join(' | ')} |`,
      )
    }
  for (const result of results.filter((r) => r.error))
    output.push(`\n- ${result.key}: ${result.error}`)
  return output.join('\n') + '\n'
}
export async function regenerate(out: string) {
  const rows = (await readFile(join(out, 'results.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Result)
  await writeFile(join(out, 'report.md'), report(rows))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await regenerate(resolve(process.argv[2] ?? '.'))
