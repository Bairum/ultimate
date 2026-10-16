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
      const asked = transcript.messages.findLastIndex((message) => message.role === 'user')
      if (transcript.messages[asked]?.content === 'phases demo') {
        const steps = [
          [
            fauxText('Looking at the scratch file first.'),
            fauxToolCall('bash', {
              command: `printf 'before\\n' > ${shellPath}; grep -n before ${shellPath}; sleep 4`,
            }),
          ],
          [
            fauxText('Changing before to after.'),
            fauxToolCall('edit', { path: scratch, oldText: 'before', newText: 'after' }),
          ],
          [
            fauxText('Running the tests.'),
            fauxToolCall('bash', { command: 'echo "pnpm test"; sleep 4; echo "12 passed"' }),
          ],
          [
            fauxText('Tests pass; committing.'),
            fauxToolCall('bash', { command: 'echo "git commit -m demo"; sleep 3' }),
          ],
        ]
        const step = transcript.messages
          .slice(asked)
          .filter((message) => message.role === 'toolResult').length
        return step < steps.length
          ? fauxAssistantMessage(steps[step], { stopReason: 'toolUse' })
          : fauxAssistantMessage([fauxText('Phases demo complete.')])
      }
      if (
        system?.role === 'system' &&
        typeof system.content === 'string' &&
        system.content.startsWith('You condense')
      ) {
        return fauxAssistantMessage([
          fauxText(
            '## Idea\n\nUltimate is one tree of conversations: a tally root and its branches (#1/11).\n\n## Standing decisions\n\n- Keep it minimal; reuse the existing card language.\n- Open: how notes reach an idle conversation.',
          ),
        ])
      }
      if (
        system?.role === 'system' &&
        typeof system.content === 'string' &&
        system.content.startsWith('You write the note')
      ) {
        return fauxAssistantMessage([
          fauxText(
            'Settled: notes stay plain lines in the tally, no separate panel.\nRuled out: a notes database; the tally already keeps history.\nOpen: whether notes need their own colour.',
          ),
        ])
      }
      if (
        system?.role === 'system' &&
        typeof system.content === 'string' &&
        system.content.startsWith('You draft')
      ) {
        return fauxAssistantMessage([
          fauxText(
            'Show notes in the tally as plain lines, as the side chat settled. Verify on a faux preview.',
          ),
        ])
      }
      if (last?.role === 'user' && last.content === 'propose a branch') {
        return fauxAssistantMessage(
          [
            fauxText('Settled, then: this is the branch I would start.'),
            fauxToolCall('propose_branch', {
              prompt:
                'Render side notes in the tally as quiet cards with their text, linking the side chat and the branch it started.',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      const sections = (system as { sections?: Record<string, string> } | undefined)?.sections
      if (last?.role === 'user' && sections?.lineage?.includes('a side chat with')) {
        return fauxAssistantMessage([
          fauxText(
            'From the tally: notes reach the root as plain lines, and nothing else stores them. Keeping them there avoids a second place to look.',
          ),
        ])
      }
      if (last?.role === 'toolResult' && last.toolName === 'propose_branch') {
        return fauxAssistantMessage([fauxText('Start it from the card when you are ready.')])
      }
      if (last?.role === 'user' && last.content === 'delegate to worker') {
        return fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              action: 'start',
              agent: 'worker',
              isolate: 'none',
              task: 'Return the word DONE.',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'user' && last.content === 'Return the word DONE.') {
        return fauxAssistantMessage([fauxText('DONE')])
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
      if (last?.role === 'user' && last.content === 'fail demo') {
        return fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'Demo failure: the provider refused the request.',
        })
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
      const notify =
        last?.role === 'user' && typeof last.content === 'string'
          ? /^notify (\d+)( quietly)?$/.exec(last.content)
          : null
      if (notify) {
        return fauxAssistantMessage(
          [fauxToolCall('notify', { id: Number(notify[1]), wake: !notify[2] })],
          { stopReason: 'toolUse' },
        )
      }
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        /^#\d+ finished/.test(last.content)
      ) {
        return fauxAssistantMessage([fauxText('Noted: it finished.')])
      }
      if (last?.role === 'user' && last.content === 'submit workspace') {
        return fauxAssistantMessage(
          [fauxToolCall('workspace', { action: 'submit', divergence: 'None' })],
          { stopReason: 'toolUse' },
        )
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
