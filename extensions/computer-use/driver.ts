import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { JsonValue } from '@earendil-works/chord'
import { exec } from '../../lib/exec.ts'
import type { Driver, DriverResult } from './types.ts'

export type DriverOptions = {
  command?: string
  args?: string[]
  expectedVersion: string
  connect?: () => Promise<Transport>
  stopCommand?: () => Promise<void>
  callTimeoutMs?: number
}

export async function createDriver(options: DriverOptions): Promise<Driver> {
  const local = join(homedir(), '.local/bin/cua-driver')
  const command = options.command ?? (existsSync(local) ? local : 'cua-driver')
  let client: Client
  let connected = false
  let closed = false
  let connecting: Promise<void> | undefined

  async function connect() {
    const next = new Client({ name: 'ultimate-computer-use', version: '1.0.0' })
    const transport = options.connect
      ? await options.connect()
      : new StdioClientTransport({ command, args: options.args ?? ['mcp'], stderr: 'pipe' })
    // The Driver normally logs its TCC daemon handoff here. Drain it so the pipe cannot fill.
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
    // MCP exposes a single close callback, not EventTarget listeners.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    next.onclose = () => {
      if (client === next) connected = false
    }
    try {
      await next.connect(transport)
      const server = next.getServerVersion()
      if (server?.name !== 'cua-driver' || server.version !== options.expectedVersion) {
        throw new Error(
          `Expected cua-driver ${options.expectedVersion}; received ${server?.name ?? 'unknown'} ${server?.version ?? 'unknown'}. Install with: CUA_DRIVER_RS_VERSION=${options.expectedVersion} bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`,
        )
      }
      client = next
      connected = true
    } catch (error) {
      await next.close()
      throw error
    }
  }

  async function ensureConnected() {
    if (closed) throw new Error('Driver client is closed')
    if (connected) return
    connecting ??= connect().finally(() => {
      connecting = undefined
    })
    await connecting
  }

  await ensureConnected()
  return {
    version: options.expectedVersion,
    async call(tool, args, signal) {
      await ensureConnected()
      const active = client
      try {
        const result = (await active.callTool({ name: tool, arguments: args }, undefined, {
          signal,
          timeout: options.callTimeoutMs ?? 30_000,
        })) as CallToolResult
        const structured = result.structuredContent as Record<string, JsonValue> | undefined
        const mapped: DriverResult = {
          ok: !result.isError && structured?.status !== 'refused',
          text: '',
          structured,
          images: [],
        }
        const texts: string[] = []
        for (const part of result.content) {
          if (part.type === 'text') texts.push(part.text)
          if (part.type === 'image')
            mapped.images.push({ data: part.data, mimeType: part.mimeType })
        }
        mapped.text = texts.join('\n')
        if (structured?.status === 'refused') {
          const refusal = structured.refusal
          if (refusal && typeof refusal === 'object' && !Array.isArray(refusal)) {
            if (typeof refusal.code === 'string' && typeof refusal.message === 'string') {
              mapped.refusal = {
                code: refusal.code,
                message: refusal.message,
                ...(typeof structured.hint === 'string' ? { hint: structured.hint } : {}),
              }
            }
          }
        }
        return mapped
      } catch (error) {
        if (
          !connected ||
          // The SDK types McpError.code as number, although its constants are an enum.
          // eslint-disable-next-line typescript/no-unsafe-enum-comparison
          (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) ||
          (error instanceof Error && /connection closed|not connected/i.test(error.message))
        ) {
          connected = false
          await active.close()
          throw new Error('connection closed; the step may or may not have run', { cause: error })
        }
        throw error
      }
    },
    async stop() {
      try {
        if (options.stopCommand) await options.stopCommand()
        else await exec(command, ['stop'], { timeout: 5_000 })
      } finally {
        connected = false
        await client.close()
      }
    },
    async close() {
      closed = true
      connected = false
      await client.close()
    },
  }
}
