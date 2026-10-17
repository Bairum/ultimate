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
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

const messageText = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      : ''
const tool = (name: string, args: JsonObject, greeting?: string) =>
  fauxAssistantMessage([...(greeting ? [fauxText(greeting)] : []), fauxToolCall(name, args)], {
    stopReason: 'toolUse',
  })

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
      if (system?.role === 'system' && typeof system.content === 'string') {
        if (system.content.startsWith("List the decisions a coding agent's final reply"))
          return fauxAssistantMessage([
            fauxText(
              JSON.stringify({
                questions:
                  typeof last?.content === 'string' &&
                  last.content.includes('Should we keep the preview running?')
                    ? [
                        { text: 'Should we keep the preview running?', kind: 'confirm' },
                        {
                          text: 'Which layout should we use?',
                          kind: 'choice',
                          options: [
                            {
                              label: 'Compact',
                              detail: 'Fits the existing cards',
                              recommended: true,
                            },
                            { label: 'Spacious', detail: 'More room between options' },
                          ],
                        },
                      ]
                    : [],
              }),
            ),
          ])
        if (
          system.content.startsWith('Assess the latest') ||
          system.content.startsWith('Summarize the initial') ||
          system.content.startsWith('Refresh a coding')
        ) {
          const source = typeof last?.content === 'string' ? last.content : ''
          const prompt = source
            .split(/(?:^|\n\n)user: /)
            .at(-1)!
            .split('\n\nassistant: ')[0]
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60)
          const needsInput = source
            .split('\n\nassistant: ')
            .at(-1)
            ?.includes('Should we keep the preview running?')
          return fauxAssistantMessage([
            fauxText(
              JSON.stringify({
                assessment: needsInput ? 'needs_input' : 'done',
                activity: 'Replied in the demo.',
                title: prompt,
                summary: 'Scripted demo conversation.',
                // 'no feature' keeps a conversation untagged, so previews can show it by its title.
                ...(source.includes('no feature') ? {} : { feature: 'Demo' }),
                abstract: `Ask: ${prompt}\nState: ${needsInput ? 'awaiting a decision' : 'scripted demo reply'}`,
              }),
            ),
          ])
        }
      }
      const onboardingAt = transcript.messages.findLastIndex(
        (message) =>
          message.role === 'user' && messageText(message.content).startsWith('Onboarding started.'),
      )
      if (onboardingAt >= 0) {
        const start = messageText(transcript.messages[onboardingAt].content)
        const root = Number(start.match(/Root: (\d+)/u)?.[1])
        const since = transcript.messages.slice(onboardingAt)
        const text = messageText(last?.content)
        const choices = since
          .filter((message) => message.role === 'user')
          .map((message) => messageText(message.content))
        const cards = [
          ...(start.includes('First run: true') ? ['extensions'] : []),
          ...(start.includes('Project setup undecided: true') ? ['project'] : []),
          ...(!start.includes('Git isolation: ready') ? ['git'] : []),
        ]
        if (
          last?.role === 'user' &&
          (text.startsWith('Onboarding started.') || text.startsWith('Setup choice ('))
        ) {
          const next = cards.find(
            (card) => !choices.some((choice) => choice.startsWith(`Setup choice (${card}):`)),
          )
          const greeting = text.startsWith('Onboarding started.')
            ? 'Hello! I’m @ultimate, your project’s standing agent.\nWe’ll choose your setup, then I’ll read the project and write its first tally.'
            : undefined
          return next
            ? tool('setup', { card: next }, greeting)
            : tool('read', { path: join(host.projectRoot, 'README.md') }, greeting)
        }
        if (last?.role === 'toolResult' && last.toolName === 'setup')
          return fauxAssistantMessage([
            fauxText('Choose on the card above; I’ll continue when you’re ready.'),
          ])
        if (last?.role === 'toolResult' && last.toolName === 'read')
          return tool('seed_tally', {
            root,
            text: `This project lives at ${host.projectRoot}. Its README is the starting point; check its scripts and tests before changing it. Keep setup in .ultimate/ and feature work in coordinator branches. Current state: initial onboarding reading complete.\n\n${start.includes('User instructions:\n') ? start.split('User instructions:\n')[1] : ''}`,
          })
        if (last?.role === 'toolResult' && last.toolName === 'seed_tally')
          return fauxAssistantMessage([
            fauxText('The first tally is ready. What should we do first?'),
          ])
        if (
          last?.role === 'user' &&
          text.startsWith('Message from user:') &&
          since.some(
            (message) => message.role === 'toolResult' && message.toolName === 'seed_tally',
          )
        )
          return tool('branch', {
            root,
            prompt: text.split('\n').slice(1).join('\n').split('\nAnswer here;')[0],
            isolated: false,
          })
        if (last?.role === 'toolResult' && last.toolName === 'branch')
          return fauxAssistantMessage([
            fauxText(
              'Started a coordinator branch for your first task. I’m waiting for its report.',
            ),
          ])
      }
      const decisions =
        'The preview is ready. Two decisions before continuing:\n\nShould we keep the preview running?\n1. Yes\n2. No\n\nWhich layout should we use?\n1. Compact — fits the existing cards (recommended)\n2. Spacious — more room between options'
      if (last?.role === 'user' && last.content === 'questions demo')
        return tool('message', { to: 'user', text: decisions })
      if (last?.role === 'user' && last.content === 'ask demo')
        return fauxAssistantMessage([fauxText(decisions)])
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        (last.content.startsWith('Q: ') || last.content.includes('\nQ: '))
      )
        return fauxAssistantMessage([fauxText('Understood. I’ll continue with your reply.')])
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
      if (transcript.messages[asked]?.content === 'messages demo') {
        const steps = [
          fauxToolCall('message', {
            to: 'user',
            text: 'The question-card fix landed as `d9b7b46` and is pushed to `main`.\n\nDivergence: none.',
            reply: false,
          }),
          fauxToolCall('message', {
            to: 'user',
            text: 'Should the preview keep running?\n1. Yes\n2. No',
          }),
        ]
        const step = transcript.messages
          .slice(asked)
          .filter((message) => message.role === 'toolResult').length
        return step < steps.length
          ? fauxAssistantMessage([steps[step]], { stopReason: 'toolUse' })
          : fauxAssistantMessage([fauxText('Messages demo complete.')])
      }
      const target =
        last?.role === 'user' && typeof last.content === 'string'
          ? /^message (#\d+)( one-way)?$/.exec(last.content)
          : null
      if (target) {
        return fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: target[1],
              text: 'Can you check whether the board card renders on narrow screens?',
              reply: !target[2],
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'toolResult' && last.toolName === 'message')
        return fauxAssistantMessage([fauxText('Sent.')])
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
