/** Run a program without a shell: resolves `{ stdout, stderr }`, rejects with them attached to execFile's error. */
export { execFile as exec } from './spawn.ts'

/**
 * This server's environment for a command run in a project, without the `NODE_ENV=development` Vite's dev server sets
 * on this process: inherited, it turns a project's `vite build` into a development bundle. Test runners set their own.
 */
export function projectEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_ENV')),
    ...extra,
  }
}
