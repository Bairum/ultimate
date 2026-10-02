import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const agents = readFileSync(new URL('AGENTS.md', root), 'utf8')
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const borrowed = agents
  .split('## Borrowed from Pi\n')[1]
  .split('\n## ')[0]
  .split('\n')
  .filter((line) => line.startsWith('- '))
  .join('\n')
for (const [, file] of borrowed.matchAll(/`([^`]+)`/g)) {
  it(`${file}: listed Pi coupling is tracked and marked`, () => {
    expect(files, `${file}: remove stale AGENTS.md entry`).toContain(file)
    expect(readFileSync(new URL(file, root), 'utf8')).toMatch(/Pi upstream: @earendil-works\//)
  })
}

for (const file of files) {
  const text = readFileSync(new URL(file, root), 'utf8')
  for (const [, pkg, version] of text.matchAll(
    /Pi upstream: (@earendil-works\/[\w-]+)@([\d.\w+-]+)/g,
  )) {
    it(`${file}: recheck ${pkg} on upgrade and list it in AGENTS.md`, () => {
      const installed = JSON.parse(
        readFileSync(new URL(`node_modules/${pkg}/package.json`, root), 'utf8'),
      )
      expect(version, `${file}: recheck Pi upstream before updating the marker`).toBe(
        installed.version,
      )
      expect(borrowed, `${file}: document the coupling`).toContain(`\`${file}\``)
    })
  }
}
