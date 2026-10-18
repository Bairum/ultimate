import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../server/harness.ts'
import browserExtension from '../../extensions/browser/server.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { removeTemp, temp } from '../helpers.ts'

it('saves screenshots at the given path, relative to the conversation cwd, creating parents', async () => {
  const directory = await temp('ultimate-browser-path-')
  const closers: (() => Promise<void>)[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: join(directory, 'project'),
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
  } as unknown as ExtensionHost
  const tools = new Map(browserExtension(host).tools!.map((tool) => [tool.name, tool]))
  const cwd = join(directory, 'worktree')
  const api = (env = true) =>
    ({ env: env ? { cwd } : undefined, output() {} }) as unknown as ToolExecutionApi
  const url = 'data:text/html,<title>Shot</title><p>hello</p>'
  const file = async (name: string, args: Record<string, unknown>, env?: boolean) => {
    const result = await tools.get(name)!.execute({ url, waitMs: 0, ...args }, api(env), context)
    expect(result.isError).toBeFalsy()
    // Codemode reads this structured result; the model reads the PNG line of the output.
    const saved = (result as { structuredContent?: { file: string } }).structuredContent!.file
    await access(saved)
    expect(JSON.stringify(result.output)).toContain(`PNG: ${saved}`)
    return saved
  }
  try {
    expect(await file('screenshot', { path: join(directory, 'a/b/absolute.png') })).toBe(
      join(directory, 'a/b/absolute.png'),
    )
    expect(await file('screenshot', { path: 'shots/new/relative.png' })).toBe(
      join(cwd, 'shots/new/relative.png'),
    )
    expect(await file('browser', { path: 'steps/browser.png', steps: [] })).toBe(
      join(cwd, 'steps/browser.png'),
    )
    expect(await file('screenshot', { path: 'no-env.png' }, false)).toBe(
      join(host.projectRoot, 'no-env.png'),
    )
    expect(await file('screenshot', {})).toMatch(new RegExp(`^${host.home}/screenshots/.+\\.png$`))
    const wrong = await tools
      .get('screenshot')!
      .execute({ path: '/?conversation=1' }, api(), context)
    expect(wrong.isError).toBe(true)
    expect(JSON.stringify(wrong.output)).toContain('must end in .png')
  } finally {
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})
