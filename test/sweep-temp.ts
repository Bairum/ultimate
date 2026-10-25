import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive } from '../server/lock.ts'

/** Each test file's temporary directory, named after the worker that owns it so a later run can tell it is stale. */
export const testTempPrefix = 'ultimate-test-temp-'

/**
 * Remove the temporary directories of test workers that are gone: a run that was interrupted (Ctrl-C, a killed
 * lander check, a teardown timeout) never reaches its `afterAll`, and the leftovers filled the machine's `/tmp`.
 */
export default function sweep() {
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^ultimate-test-temp-(\d+)-/.exec(name)?.[1])
    if (pid && !alive(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
}
