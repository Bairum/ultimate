import { execFile } from 'node:child_process'
import type { JsonValue } from '@earendil-works/chord'
import type { ExtensionHost } from './extensions.ts'

export interface ActionContext {
  host: ExtensionHost
  conversationId?: number
  signal: AbortSignal
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string }>
}
export type ExtensionAction = (
  args: JsonValue,
  ctx: ActionContext,
) => JsonValue | Promise<JsonValue>
export function actionExec(projectRoot: string, signal: AbortSignal): ActionContext['exec'] {
  return (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd ?? projectRoot,
          signal,
          timeout: Math.max(1, Math.min(options.timeout ?? 30000, 30000)),
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) reject(error)
          else resolve({ stdout, stderr })
        },
      )
    })
}
