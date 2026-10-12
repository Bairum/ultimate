import { PassThrough } from 'node:stream'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { dashboard } from '../bin/dashboard.ts'
import { temp, removeTemp } from './helpers.ts'

for (const tty of [true, false]) {
  it(`renders ${tty ? 'TTY dashboard' : 'plain redirected output'} and retains diagnostics`, async () => {
    const home = await temp()
    try {
      const stream = new PassThrough() as unknown as NodeJS.WriteStream
      Object.assign(stream, { isTTY: tty, columns: 100, rows: 30 })
      let output = ''
      stream.on('data', (chunk) => {
        output += chunk
      })
      const path = join(home, 'supervisor.log')
      const view = dashboard(path, stream)
      view.url('http://127.0.0.1:1234')
      view.lifecycle('ready', { generation: 2, pid: 123 })
      view.report({ type: 'web', state: 'ready' })
      view.report({
        type: 'services',
        services: [
          {
            extension: 'automations',
            name: 'scheduler',
            state: 'ready',
            detail: 'durable scheduler',
          },
        ],
      })
      view.log('info', 'web', 'hmr update /web/test.tsx')
      view.log('warn', 'web', '\x1b[31mwarning marker\x1b[0m')
      view.log('error', 'core', 'error marker\nstack line')
      view.close()
      expect(output.includes('[info] web: hmr update')).toBe(!tty)
      expect(output).toContain('warning marker')
      expect(output).toContain('error marker\nstack line')
      expect(output.includes('\x1b[')).toBe(tty)
      expect(output.includes('generation 2 · PID 123')).toBe(tty)
      expect(output.includes('embedded Vite')).toBe(tty)
      expect(output).toContain('automations/scheduler')
      expect(output.includes('http://127.0.0.1:1234')).toBe(tty)
      const records = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(records.some((r) => r.text.includes('hmr update'))).toBe(true)
      expect(records.at(-1)).toMatchObject({
        level: 'error',
        source: 'core',
        text: 'error marker\nstack line',
      })
      expect(records.at(-2).text).toBe('warning marker')
      expect(records.every((r) => !Number.isNaN(Date.parse(r.at)))).toBe(true)
    } finally {
      await removeTemp(home)
    }
  })
}

it('reports an unwritable detailed log once without taking down presentation', async () => {
  const home = await temp()
  try {
    const path = join(home, 'directory')
    await mkdir(path)
    const stream = new PassThrough() as unknown as NodeJS.WriteStream
    let output = ''
    stream.on('data', (chunk) => {
      output += chunk
    })
    const view = dashboard(path, stream)
    expect(() => {
      view.log('warn', 'core', 'first')
      view.log('error', 'core', 'second')
      view.close()
    }).not.toThrow()
    expect(output.match(/cannot write detailed log/g)).toHaveLength(1)
    expect(output).toContain('first')
    expect(output).toContain('second')
  } finally {
    await removeTemp(home)
  }
})
