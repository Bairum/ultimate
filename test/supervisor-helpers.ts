import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { temp, removeTemp, sourceCopy, cleanEnv, until, attach as attachStream } from './helpers.ts'
import { join } from 'node:path'
import type { ConversationView } from '@earendil-works/pi-durable'
import { afterEach } from 'vitest'

export const children: ChildProcess[] = []
export const homes: string[] = []
const streams: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  for (const home of homes.splice(0)) await removeTemp(home)
})
export const copies = new Map<string, string>()
export async function launch(home: string) {
  const ultimateRoot = copies.get(home) ?? (await sourceCopy(home))
  copies.set(home, ultimateRoot)
  const child = spawn(
    process.execPath,
    [join(ultimateRoot, 'bin/ultimate.ts'), ultimateRoot, '--no-open'],
    {
      cwd: ultimateRoot,
      env: {
        ...cleanEnv(),
        HOME: home,
        ULTIMATE_HOME: home,
        ULTIMATE_PORT: '0',
        ULTIMATE_FAUX: '1',
        ULTIMATE_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  return { child, ultimateRoot, output: () => output }
}
export async function fixture() {
  const home = await temp('ultimate-supervisor-')
  homes.push(home)
  const running = await launch(home)
  await until(() => running.output().includes('Ultimate: http://'))
  return { ...running, home, url: /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1] }
}
export async function attach(url: string) {
  const stream = await attachStream(url)
  streams.push(stream)
  return stream
}
export async function activationFailure(root: string) {
  const file = join(root, 'server/main.ts')
  await writeFile(
    join(root, 'server/activation.ts'),
    "export async function activate(): Promise<void> { throw new Error('Injected activation failure') }\n",
  )
  await writeFile(
    file,
    "import { activate } from './activation.ts'\n" +
      (await readFile(file, 'utf8')).replace(
        'opened = await host.open(false)',
        'opened = await host.open(false); await activate()',
      ),
  )
}
export function transcript(view: ConversationView) {
  return JSON.stringify(view.entries)
}
