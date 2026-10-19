import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxContentBlock, FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, EntryId, JsonObject } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { NoticeEvent } from '../../shared/events.ts'
import { Branched, LineageApi, Rooted } from '../lineage/api.ts'
import { SubmissionLanded } from '../workspaces/api.ts'

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
  // Core, always on; resolved where it is called, declared here so the catalogue lists it.
  host.need(LineageApi)
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
          !text.startsWith('Message from') &&
          // A branch's report is no new task: branching on it would loop.
          !text.startsWith('Reply from') &&
          since.some(
            (message) => message.role === 'toolResult' && message.toolName === 'seed_tally',
          )
        )
          return tool('branch', {
            root,
            prompt: text,
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
      if (
        last?.role === 'toolResult' &&
        last.toolName === 'codemode' &&
        transcript.messages[asked]?.content === 'codemode demo'
      ) {
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
      if (last?.role === 'user' && last.content === 'fleet demo') return tool('fleet', {})
      // Answers with the given Markdown verbatim, to preview how answers render it (such as `#id` mentions).
      const say = /^say ([\s\S]+)$/.exec(messageText(last?.role === 'user' ? last.content : ''))
      if (say) return fauxAssistantMessage([fauxText(say[1])])
      if (
        last?.role === 'toolResult' &&
        last.toolName === 'fleet' &&
        transcript.messages[asked]?.content === 'fleet demo'
      )
        return fauxAssistantMessage([
          fauxText('ultimate is moving from haza-pc to rog; blog runs here with one kept ref.'),
        ])
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
      // A request as its first line, also when it arrived as a message: the chat demos run in @ultimate and its branch.
      const request = messageText(transcript.messages[asked]?.content)
        .replace(/^Message from [^\n]*:\n/, '')
        .split('\n')[0]
      const chatSteps: Record<string, FauxContentBlock[][]> = {
        'chat demo': [
          [
            fauxThinking('The user wants the parser fix checked and landed.'),
            fauxToolCall('bash', { command: 'echo checking the parser; sleep 0.3; echo clean' }),
          ],
          [fauxToolCall('read', { path: join(host.projectRoot, 'README.md') })],
          [fauxToolCall('branch', { prompt: 'landing demo', isolated: false })],
          [
            fauxToolCall('message', {
              to: 'user',
              text: 'The parser fix landed as `081dc9b` and is pushed to `main`.\n\nDivergence: none.',
              reply: false,
            }),
          ],
          [
            fauxToolCall('message', {
              to: 'user',
              text: 'Should the preview keep running?\n1. Yes\n2. No',
            }),
          ],
        ],
        'ask demo': [
          [
            fauxToolCall('message', {
              to: 'user',
              text: 'Which layout should the bubbles use?\n1. **Compact**: fits the existing cards (recommended)\n2. **Spacious**: more room around the text',
            }),
          ],
        ],
        'landing demo': [
          [fauxToolCall('bash', { command: 'echo pnpm check; sleep 0.3; echo passed' })],
        ],
        // @ultimate often messages you from inside a script.
        'script ask demo': [
          [
            fauxToolCall('codemode', {
              code: `await tools.bash({ command: 'echo checking the preview' }); return await tools.message({ to: 'user', text: ${JSON.stringify(decisions)} });`,
            }),
          ],
        ],
      }
      const chatAnswers: Record<string, string> = {
        'chat demo': 'Started a branch to land the work and asked you whether the preview stays.',
        'ask demo': 'Waiting for your answer on the layout.',
        'script ask demo': 'Asked you about the preview and the layout.',
        'landing demo':
          'Landed `1a2b3c4` on `main` and pushed it to `origin`.\n\nDivergence: none.',
      }
      if (Object.hasOwn(chatSteps, request)) {
        const step = transcript.messages
          .slice(asked)
          .filter((message) => message.role === 'toolResult').length
        return step < chatSteps[request].length
          ? fauxAssistantMessage(chatSteps[request][step], { stopReason: 'toolUse' })
          : fauxAssistantMessage([fauxText(chatAnswers[request])])
      }
      if (last?.role === 'user' && messageText(last.content).startsWith('Reply from #'))
        return fauxAssistantMessage([fauxText('Noted; nothing else is needed from it.')])
      const target =
        last?.role === 'user' && typeof last.content === 'string'
          ? /^message (#\d+|@[\w-]+)( one-way)?$/.exec(last.content)
          : null
      if (target) {
        return fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: target[1],
              text: 'Can you check whether the status card renders on narrow screens?',
              reply: !target[2],
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last?.role === 'toolResult' && last.toolName === 'message')
        return fauxAssistantMessage([fauxText('Sent.')])
      const shot =
        last?.role === 'user' && typeof last.content === 'string'
          ? /^screenshot (\S+\.png)$/.exec(last.content)
          : null
      if (shot) {
        return fauxAssistantMessage([fauxToolCall('screenshot', { path: shot[1], waitMs: 0 })], {
          stopReason: 'toolUse',
        })
      }
      if (last?.role === 'toolResult' && last.toolName === 'screenshot')
        return fauxAssistantMessage([fauxText('Saved.')])
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

/** Landings for `seedLandings`, newest last: sha, base, feature, title, commits. */
const demoLandings = [
  ['3e55874', 'c4ceeb7', 'Provider Health', 'Track only logged-in providers', 1],
  ['9bfcd3b', '3e55874', 'Agent Harness', 'Harness improvement epic', 17],
  ['7c17166', '9bfcd3b', 'Sidebar', 'Hide sub-agents under listed roots', 1],
  ['9057c43', '7c17166', 'Sidebar', 'Standing agent marks', 2],
  ['45a315f', '9057c43', 'Lander Row', "The lander's feature tag", 1],
] as const

export const actions = {
  /**
   * Faux only: `{from}` writes demo landing notes from conversation `from` into its root, with real-looking shas,
   * features and commit counts, to preview the root's Landed section and the landing cards.
   */
  async seedLandings(args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedLandings runs only under faux')
    const from = (args as { from?: unknown } | null)?.from
    if (typeof from !== 'number') throw new Error('from must be a conversation id')
    const lineage = host.need(LineageApi)
    for (const [sha, base, feature, title, count] of demoLandings) {
      const commits = Array.from({ length: Math.min(count, 10) }, (_, n) => ({
        sha: `${sha.slice(0, 5)}${n}0`,
        subject: `feat: ${title.toLowerCase()} (${n + 1})`,
      }))
      await lineage.leaveNote('root', `Landed ${sha} on main from #${from} ${title} (${feature})`, {
        from,
        source: 'lander',
        requestId: `faux-landing:${from}:${sha}`,
        data: {
          sha,
          base,
          target: 'main',
          commits,
          more: Math.max(0, count - 10),
          paths: ['extensions/conversations/root.tsx'],
          title,
          feature,
          divergence: 'None.',
          pushed: 'origin/main',
        },
      })
    }
    return { seeded: demoLandings.length }
  },
  /**
   * Faux only: `{from}` emits a realistic mix of durable events about conversation `from` and its root (the root, the
   * branch, five landings with features and commit counts, two notices), to preview the Activity panel. The landings
   * also reach the root as landing notes, as real ones do.
   */
  async seedEvents(args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedEvents runs only under faux')
    const from = (args as { from?: unknown } | null)?.from
    if (typeof from !== 'number') throw new Error('from must be a conversation id')
    const root = (await host.want(LineageApi)?.rootOf(from, BACKGROUND_CONTEXT)) ?? 1
    const notices = [
      ['tailscale', 'tailscale serve failed: tailscaled is not running on this machine'],
      ['cloud', 'Sync paused: the lease is held by rog until 21:40'],
    ] as const
    await host.harness().commit(async (tx) => {
      const latest = await tx.scanEntries(
        { conversationId: from as ConversationId, order: 'descending' },
        1,
      )
      const at = latest.items[0]?.id ?? (0 as EntryId)
      await host.emit(tx, Rooted, { id: root, intent: 'Project context' })
      await host.emit(tx, Branched, { id: from, from: root, at: 1, intent: 'landing demo' })
      for (const [index, [sha, base, feature, title, count]] of demoLandings.entries()) {
        if (index === 2 || index === 4) {
          const [extension, message] = notices[index === 2 ? 0 : 1]
          await host.emit(tx, NoticeEvent, { extension, message, level: 'warning' })
        }
        await host.emit(tx, SubmissionLanded, {
          submission: `faux-event:${from}:${sha}`,
          conversationId: from,
          at,
          sha,
          base,
          target: 'main',
          lander: from,
          divergence: 'None.',
          title,
          feature,
          commits: Array.from({ length: Math.min(count, 10) }, (_, n) => ({
            sha: `${sha.slice(0, 5)}${n}0`,
            subject: `feat: ${title.toLowerCase()} (${n + 1})`,
          })),
          commitCount: count,
          paths: ['extensions/conversations/root.tsx'],
          pushed: 'origin/main',
        })
      }
    }, BACKGROUND_CONTEXT)
    return { seeded: 2 + demoLandings.length + notices.length }
  },
  /**
   * Faux only: `{conversation, count}` appends about `count` entries to `conversation` in turns of four: a user input,
   * an assistant with a tool call, its result, and a Markdown answer. Previews a long transcript and its scrollback.
   */
  async seedHistory(args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedHistory runs only under faux')
    const { conversation, count = 1000 } = (args ?? {}) as {
      conversation?: unknown
      count?: unknown
    }
    if (typeof conversation !== 'number') throw new Error('conversation must be a conversation id')
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 20_000)
      throw new Error('count must be an integer from 1 to 20000')
    const id = conversation as ConversationId
    const turns = Math.ceil(count / 4)
    const start = Date.now() - turns * 60_000
    // Commits of 50 turns keep each transaction small.
    for (let from = 0; from < turns; from += 50)
      await host.harness().commit(async (tx) => {
        for (let turn = from; turn < Math.min(turns, from + 50); turn++) {
          const at = start + turn * 60_000
          const call = `seed-${id}-${turn}`
          await tx.appendEntry(id, {
            kind: 'pi.user',
            model: [
              {
                role: 'user',
                content: `Seeded request ${turn + 1}: check step ${turn + 1}`,
                timestamp: at,
              },
            ],
          })
          await tx.appendEntry(id, {
            kind: 'pi.assistant',
            model: [
              fauxAssistantMessage(
                [
                  fauxText(`Looking at step ${turn + 1}.`),
                  fauxToolCall('bash', { command: `rg -n step${turn + 1} src` }, { id: call }),
                ],
                { stopReason: 'toolUse', timestamp: at + 1000 },
              ),
            ],
          })
          await tx.appendEntry(id, {
            kind: 'pi.tool-result',
            model: [
              {
                role: 'toolResult',
                toolCallId: call,
                toolName: 'bash',
                content: [
                  {
                    type: 'text',
                    text: `src/step${turn + 1}.ts:${turn + 3}: const step = ${turn + 1}`,
                  },
                ],
                isError: false,
                timestamp: at + 2000,
              },
            ],
          })
          await tx.appendEntry(id, {
            kind: 'pi.assistant',
            model: [
              fauxAssistantMessage(
                [
                  fauxText(
                    `## Step ${turn + 1}\n\nFound it in \`src/step${turn + 1}.ts\`:\n\n- the value is **${turn + 1}**\n- nothing else changed\n\n\`\`\`ts\nconst step = ${turn + 1}\n\`\`\``,
                  ),
                ],
                { timestamp: at + 3000 },
              ),
            ],
          })
        }
      }, BACKGROUND_CONTEXT)
    return { seeded: turns * 4 }
  },
}
