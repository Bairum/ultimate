import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runLanderCheck } from '../../extensions/workspaces/lander.ts'
import { context } from '../../server/harness.ts'
import { removeTemp, temp } from '../helpers.ts'

it('kills a silent process group on stall and a printing process on the total cap', async () => {
  const directory = await temp('ultimate-lander-watchdog-')
  try {
    for (const printing of [false, true]) {
      const pidFile = join(directory, 'pid')
      const childFile = join(directory, 'child')
      const command = `echo $$ > '${pidFile}'; sleep 10 & echo $! > '${childFile}'; ${printing ? 'while true; do echo progress; sleep 0.02; done' : 'wait'}`
      const result = await runLanderCheck(directory, command, context, { stall: 0.2, total: 0.5 })
      expect(result.failure).toContain(printing ? 'Timed out after' : 'Stalled: no output for')
      expect(result.failure?.includes('progress')).toBe(printing)
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow('ESRCH')
      const child = Number(await readFile(childFile, 'utf8'))
      // A killed orphan may remain a zombie until init reaps it; it must not still be running.
      const stat = await readFile(`/proc/${child}/stat`, 'utf8').catch(() => '')
      expect(stat === '' || stat.split(' ')[2] === 'Z').toBe(true)
    }
  } finally {
    await removeTemp(directory)
  }
})
