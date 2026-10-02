import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createServer } from '../server/main.ts'
import { context } from '../server/harness.ts'
import { actions } from '../.ultimate/extensions/github-triage/server.ts'
import type { ActionContext } from '../server/actions.ts'

const shimDir = resolve('.ultimate/extensions/github-triage/bin')
const message =
  "Blocked: Ultimate's agent does not write to GitHub. Propose with triage_propose; the user applies it in the Triage surface."

it('guards argv and ordinary shell indirection without executing any real GitHub command', async () => {
  const home = await mkdtemp(join(tmpdir(), 'triage-shim-'))
  const log = join(home, 'argv')
  await writeFile(
    join(home, 'gh'),
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2)))\n',
  )
  await chmod(join(home, 'gh'), 0o755)
  await writeFile(
    join(home, 'curl'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n',
  )
  await chmod(join(home, 'curl'), 0o755)
  await writeFile(join(home, 'script.sh'), 'gh issue comment 1 --body test')
  const env = { ...process.env, PATH: `${shimDir}:${home}:${process.env.PATH}`, RECORD: log }
  const allowed = [
    '--version',
    'auth status',
    'issue list',
    'issue view 1',
    'pr diff 1',
    'pr checks 1',
    'pr status',
    'label list',
    'repo view',
    'search issues test',
    'release list',
    'release view v1',
    'run list',
    'run view 1',
    'api user',
    'api user -X GET',
    'api user -XGET',
    'api user --method GET',
    'api user --method=GET',
  ]
  const denied = [
    'auth token',
    'auth login',
    'repo fork',
    'release create v1',
    'pr update-branch 1',
    'issue develop 1',
    'workflow run ci',
    'issue comment 1',
    'pr merge 1',
    'label create x',
    'api user -X POST',
    'api user -XPOST',
    'api user --method PUT',
    'api user --method=PUT',
    'api user --method=DELETE',
    'api user -f x=y',
    'api user -fx=y',
    'api user -F x=y',
    'api user -F=x=y',
    'api user --field x=y',
    'api user --field=x=y',
    'api user --raw-field=x=y',
    'api user --input=x',
    'api user --input x',
    'api user -X GET --method=POST',
  ]
  try {
    for (const command of allowed) {
      const result = spawnSync('bash', ['-c', `gh ${command}`], { env, encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(JSON.parse(await readFile(log, 'utf8'))).toEqual(command.split(' '))
    }
    for (const command of [
      ...denied.map((form) => `gh ${form}`),
      'gh api user \\\n --method=PUT',
      "'gh' issue comment 1",
      'GH=gh; $GH issue comment 1',
      'bash script.sh',
    ]) {
      await rm(log, { force: true })
      const result = spawnSync('bash', ['-c', command], { cwd: home, env, encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(message)
      await expect(readFile(log)).rejects.toThrow('ENOENT')
    }
    const curl = spawnSync(
      'bash',
      ['-c', 'curl -H "Authorization: token $(gh auth token)" https://api.github.com/test'],
      { env, encoding: 'utf8' },
    )
    expect(curl.stderr).toContain(message)
    expect(JSON.parse(curl.stdout)).toEqual([
      '-H',
      'Authorization: token ',
      'https://api.github.com/test',
    ])
    await expect(readFile(log)).rejects.toThrow('ENOENT')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('refuses unlisted repositories before exec, rejects dot segments, and preserves label arrays while refusing unknown names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'triage-actions-'))
  let calls = 0
  const ctx = {
    host: { projectRoot: home },
    signal: new AbortController().signal,
    exec: async () => {
      calls++
      return { stdout: '[{"name":"bug","color":"fff"}]', stderr: '' }
    },
  } as unknown as ActionContext
  try {
    expect(
      await actions.comment({ repo: 'public/repo', number: 1, body: 'test' }, ctx),
    ).toMatchObject({ status: 'error' })
    expect(
      await actions.label({ repo: 'public/repo', number: 1, add: ['bug'] }, ctx),
    ).toMatchObject({ status: 'error' })
    expect(calls).toBe(0)
    for (const repo of ['./repo', '../repo', 'owner/.', 'owner/..'])
      await expect(actions.labels({ repo }, ctx)).rejects.toThrow('Expected repo')
    expect(calls).toBe(0)
    await mkdir(join(home, '.ultimate'))
    await writeFile(
      join(home, '.ultimate/settings.json'),
      JSON.stringify({ githubTriage: { writableRepos: ['private/repo'] } }),
    )
    expect(
      await actions.label(
        { repo: 'private/repo', number: 1, add: ['typo'], remove: ['missing'] },
        ctx,
      ),
    ).toEqual({ status: 'error', message: 'Unknown repository labels: typo, missing' })
    expect(calls).toBe(1)
    ctx.exec = async () => {
      throw new Error('labels unavailable')
    }
    expect(await actions.labels({ repo: 'private/repo' }, ctx)).toEqual([])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('loads the bash wrap into agent.tools and requires browser headers on actions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'triage-server-'))
  await writeFile(join(home, 'gh'), '#!/bin/sh\necho FAKE_GH\n')
  await chmod(join(home, 'gh'), 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${home}:${oldPath}`
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home,
    faux: true,
    port: 0,
  })
  try {
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'GH=gh; $GH repo fork' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Complete'),
    ])
    await server.root.submit({ type: 'input', content: 'Test guard' }, context)
    await server.harness.waitForIdle(context)
    const state = await server.root.viewState(context)
    try {
      const entry = state.value.entries.findLast((item) => item.kind === 'pi.tool-result')!
      expect(JSON.stringify(entry)).toContain(message)
      expect(JSON.stringify(entry)).not.toContain('FAKE_GH')
    } finally {
      state.dispose()
    }
    const endpoint = `${server.url}/api/extensions/github-triage/actions/comment`
    const body = JSON.stringify({ args: { repo: 'public/repo', number: 1, body: 'test' } })
    expect((await fetch(endpoint, { method: 'POST', body })).status).toBe(403)
    for (const headers of [
      new Headers({ 'Sec-Fetch-Site': 'same-origin' }),
      new Headers({ Origin: server.url }),
    ]) {
      const response = await fetch(endpoint, { method: 'POST', body, headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ result: { status: 'error' } })
    }
  } finally {
    await server.close()
    process.env.PATH = oldPath
    await rm(home, { recursive: true, force: true })
  }
})
