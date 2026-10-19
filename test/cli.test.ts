import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cliArgs } from '../bin/cli.ts'
import { removeTemp, temp } from './helpers.ts'

let home: string
afterEach(() => removeTemp(home))

async function setup() {
  home = await temp()
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'AGENTS.md'), 'Project rule: keep it small.')
  await mkdir(join(home, '.ultimate/skills/mine'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/skills/mine/SKILL.md'),
    '---\nname: mine\ndescription: A personal skill\n---\n',
  )
  return { ultimateRoot: resolve('.'), projectRoot, userHome: home, home: join(home, 'state') }
}

it("gives Pi Ultimate's context, skills and Claude Code instead of Pi's personal ones", async () => {
  const host = await setup()
  const args = cliArgs(host, ['--model', 'anthropic/claude-opus-5-5', 'why is it broken'])
  const flag = (name: string) => args.filter((_, i) => args[i - 1] === name)
  expect(args).toEqual(
    expect.arrayContaining(['--no-context-files', '--no-skills', '--no-extensions']),
  )
  expect(flag('--skill')).toContain(join(home, '.ultimate/skills/mine/SKILL.md'))
  expect(flag('--extension')).toEqual([expect.stringMatching(/pi-claude-code\/src\/index\.ts$/)])
  expect(flag('--session-dir')).toEqual([join(host.home, 'cli-sessions')])
  // The user's own arguments come last, so they override ours and keep their first message.
  expect(args.slice(-3)).toEqual(['--model', 'anthropic/claude-opus-5-5', 'why is it broken'])

  const [prompt] = flag('--append-system-prompt')
  expect(prompt).toContain("Ultimate's emergency terminal agent")
  expect(prompt).toContain('Project rule: keep it small.')
  expect(prompt).toContain(`Project home: ${host.home}: \`state.sqlite\``)
  expect(prompt).toContain('sqlite3 -readonly')
  // Mentioned only once the reset script exists in this checkout.
  expect(prompt.includes('`pnpm reset`')).toBe(
    'reset' in (await import('../package.json', { with: { type: 'json' } })).default.scripts,
  )
})
