import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Run a program without a shell: resolves `{ stdout, stderr }`, rejects with them attached to execFile's error. */
export const exec = promisify(execFile)
