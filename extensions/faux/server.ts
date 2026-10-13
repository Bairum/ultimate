import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ExtensionHost } from '../../server/extensions.ts'

export default async function fauxExtension(host: ExtensionHost) {
  const faux = host.faux
  if (faux) {
    const scratch = join(host.home, 'demo.txt')
    const shellPath = "'" + scratch.replaceAll("'", "'\\''") + "'"
    await writeFile(scratch, 'before\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const demo: FauxResponseFactory = (transcript) => {
      faux.appendResponses([demo])
      const last = transcript.messages.findLast((message) => message.role !== 'system')
      const system = transcript.messages[0]
      if (
        system?.role === 'system' &&
        typeof system.content === 'string' &&
        system.content.startsWith('Write the brief')
      ) {
        return fauxAssistantMessage([
          fauxText(
            '## Idea\n\nUltimate is one tree of conversations: a root and its branches (#1/11).\n\n## For this branch\n\n- Keep it minimal; reuse the existing card language.\n- Open: how notes reach an idle conversation.',
          ),
        ])
      }
      if (last?.role === 'user' && last.content === 'delegate to scout') {
        return fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              action: 'start',
              agent: 'scout',
              task: 'Return the word SCOUT.',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'user' && last.content === 'Return the word SCOUT.') {
        return fauxAssistantMessage([fauxText('SCOUT')])
      }
      if (last?.role === 'toolResult' && last.toolName === 'subagent') {
        return fauxAssistantMessage([
          fauxText(last.content.map((block) => (block.type === 'text' ? block.text : '')).join('')),
        ])
      }
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content === 'codemode demo'
      ) {
        return fauxAssistantMessage(
          [
            fauxToolCall('codemode', {
              code: `const source = await tools.read({ path: ${JSON.stringify(scratch)} }); text(source); return await tools.bash({ command: "echo codemode; sleep 0.3" });`,
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'toolResult' && last.toolName === 'codemode') {
        return fauxAssistantMessage([fauxText('Codemode demo complete.')])
      }
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content === 'restart yourself'
      ) {
        return fauxAssistantMessage([fauxToolCall('restart', {})], { stopReason: 'toolUse' })
      }
      if (last?.role === 'user' && last.content === 'leave a note') {
        return fauxAssistantMessage(
          [
            fauxToolCall('note', {
              to: 'root',
              text: 'Notes now reach an idle conversation without waking it; see `extensions/lineage/`.',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'user' && last.content === 'submit workspace') {
        return fauxAssistantMessage([fauxToolCall('workspace', { action: 'submit' })], {
          stopReason: 'toolUse',
        })
      }
      if (last?.role === 'toolResult' && last.toolName === 'restart') {
        return fauxAssistantMessage([
          fauxText(last.content.map((block) => (block.type === 'text' ? block.text : '')).join('')),
        ])
      }
      if (last?.role === 'toolResult' && last.toolName === 'bash') {
        return fauxAssistantMessage(
          [fauxToolCall('edit', { path: scratch, oldText: 'before', newText: 'after' })],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'toolResult') {
        return fauxAssistantMessage([
          fauxText(
            '## Complete\n\nThe scratch file was updated.\n\n```ts\nconsole.log("Ultimate")\n```',
          ),
        ])
      }
      return fauxAssistantMessage(
        [
          fauxThinking('I will demonstrate a streamed shell command and a file edit.'),
          fauxToolCall('bash', {
            command: `printf 'before\\n' > ${shellPath}; echo starting; sleep 0.3; echo finished`,
          }),
        ],
        { stopReason: 'toolUse' },
      )
    }
    faux.setResponses([demo])
  }
  return defineExtension({ name: 'faux' })
}
