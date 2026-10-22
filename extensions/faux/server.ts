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
import type { SystemMessage } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, JsonObject } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { NoticeEvent } from '../../shared/events.ts'
import { Branched, LineageApi, Rooted } from '../lineage/api.ts'
import { SubmissionLanded, WorkspacesApi } from '../workspaces/api.ts'
import { seedLanes, stopCalling } from './lanes.ts'
import { codemodeSteps } from './codemode.ts'
import { SummaryDoc as CodemodeSummaries } from '../codemode/api.ts'
import type { CallSummary } from '../codemode/refs.ts'
import { BackupEvent } from '../cloud/api.ts'

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
  // `seedLanes` leaves a worker calling; it stops with this facet (a reload, a disable, the server closing).
  host.onClose(async () => stopCalling())
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
        // Messages triage: a landing, failure or question acts, anything else is an update. `(slow)` holds the verdict
        // for a few seconds, so a preview can show the row assessing.
        if (system.content.startsWith('Triage a message')) {
          const text = messageText(last?.content)
          const act = /landed|failed|\?/i.test(text)
          const answer = fauxAssistantMessage([
            fauxText(
              JSON.stringify(
                act
                  ? { verdict: 'act', reason: 'reports a result the user should hear' }
                  : { verdict: 'fyi', reason: 'progress only; nothing to do yet' },
              ),
            ),
          ])
          return text.includes('(slow)')
            ? new Promise((done) => setTimeout(() => done(answer), 6000))
            : answer
        }
        // Codemode summaries: one line from the calls, an effect when one writes.
        if (system.content.startsWith('Summarize what a codemode script')) {
          const { calls } = JSON.parse(messageText(last?.content)) as {
            calls: { name: string; args: string }[]
          }
          const writes = calls.filter((call) => /^(write|edit|ultimate\.action)$/.test(call.name))
          const reads = calls.length - writes.length
          const line = writes.length
            ? `Wrote ${writes.length} change${writes.length === 1 ? '' : 's'} (${writes.map((call) => call.name).join(', ')}) after ${reads} lookup${reads === 1 ? '' : 's'}`
            : `Looked up ${calls.map((call) => call.name.replace('ultimate.', '')).join(', ')}`
          return fauxAssistantMessage([
            fauxText(JSON.stringify({ line, effect: writes.length > 0 })),
          ])
        }
        // Going back with a summary: a fixed summary of the set-aside path.
        if (system.content.startsWith('Summarize the part of a coding conversation'))
          return fauxAssistantMessage([
            fauxText(
              '- Tried the scripted phases demo: edited the scratch file and committed it.\n- Added a retry button on the landing card; spacing is still unpolished.',
            ),
          ])
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
          system.content.startsWith('Describe the latest') ||
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
            ? 'Hello! I’m @ultimate, your project’s standing agent.\nWe’ll choose your setup, then I’ll read the project and write its first memories.'
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
          return tool('remember', {
            root,
            ops: [
              {
                op: 'add',
                slug: 'project-overview',
                kind: 'fact',
                line: 'What this project is and where to start reading it',
                body: `This project lives at ${host.projectRoot}. Its README is the starting point; check its scripts and tests before changing it. Keep setup in .ultimate/ and feature work in coordinator branches.`,
              },
              ...(start.includes('User instructions:\n')
                ? [
                    {
                      op: 'add',
                      slug: 'user-instructions',
                      kind: 'decision',
                      line: 'The user’s onboarding instructions, verbatim',
                      body: start.split('User instructions:\n')[1],
                    },
                  ]
                : []),
            ],
          })
        if (last?.role === 'toolResult' && last.toolName === 'remember')
          return fauxAssistantMessage([
            fauxText(
              last.isError
                ? `The first memories could not be written: ${messageText(last.content)}`
                : 'The first memories are written. What should we do first?',
            ),
          ])
        if (
          last?.role === 'user' &&
          !text.startsWith('Message from') &&
          // A branch's report is no new task: branching on it would loop.
          !text.startsWith('Reply from') &&
          since.some((message) => message.role === 'toolResult' && message.toolName === 'remember')
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
      if (last?.role === 'user' && last.content === 'decisions demo')
        return tool('message', {
          to: 'user',
          text: "The preview is ready.\n\nDecisions:\n1. **Branch starts in the context:** (a) one-line intent plus breadcrumb; (b) drop them, rely on abstracts; (c) leave as is.\n2. **Boxer's copied `agents/ultimate.md`:** (a) assess a way to add tools without forking it; (b) leave it.\n3. **Land it:** (a) yes; (b) no, change something first.\n\nMy picks: 1a 2a 3a.",
        })
      // A reply-expected message to the user with the given text, to preview its answer card.
      const ask =
        last?.role === 'user' ? /^ask ([\s\S]+)$/.exec(messageText(last.content).trim()) : null
      if (ask) return tool('message', { to: 'user', text: ask[1] })
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        // An answer card's reply: `1a. Topic: option`, `2: text` or `Question?: answer` paragraphs.
        /^(\d+[a-z]?[.:] |[^\n]+\?: )/.test(last.content)
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
            fauxToolCall('bash', {
              // A real commit in a scratch repository in the instance home, so it records `coding-tools.committed`.
              command: `cd ${shellPath}.git 2>/dev/null || { mkdir -p ${shellPath}.git && cd ${shellPath}.git && git init -q -b main; }; git -c user.name=Faux -c user.email=faux@example.test commit -q --allow-empty -m "demo: change before to after" && git log -1 --format=%H; sleep 3`,
            }),
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
      // One worker that answers and one whose run fails, to preview a subagent's done and failed states.
      if (last?.role === 'user' && last.content === 'delegate demo') {
        return fauxAssistantMessage(
          ['Return the word DONE.', 'fail demo'].map((task) =>
            fauxToolCall('subagent', { action: 'start', agent: 'worker', isolate: 'none', task }),
          ),
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
      if (transcript.messages[asked]?.content === 'codemode steps demo') {
        // A long run of codemode steps between ordinary tools: read-only, mutating, a one-call label and a failure.
        const steps: FauxContentBlock[][] = [
          [
            fauxToolCall('codemode', {
              code: "const a = await ultimate.api('conversations'); return a.slice(0, 200)",
            }),
          ],
          [
            fauxToolCall('codemode', {
              code: "const ov = await ultimate.doc('ultimate.conversation-overview', 1); const g = await ultimate.taskGraph(); return Object.keys(ov).concat(Object.keys(g))",
            }),
          ],
          [fauxToolCall('bash', { command: `grep -n before ${shellPath} | head -3` })],
          [
            fauxToolCall('codemode', {
              code: `const source = await tools.read({ path: ${JSON.stringify(scratch)} }); await tools.write({ path: ${JSON.stringify(scratch)}, content: source.replace('before', 'after') }); return 'written'`,
            }),
          ],
          [fauxToolCall('read', { path: scratch })],
          [
            fauxToolCall('codemode', {
              code: "const entries = await ultimate.entries(1, { limit: 5 }); const hits = await ultimate.search('demo', { limit: 3 }); return { entries: entries.length, hits: hits.length }",
            }),
          ],
          [fauxToolCall('edit', { path: scratch, oldText: 'after', newText: 'before' })],
          [fauxToolCall('codemode', { code: 'throw new Error("no such conversation")' })],
        ]
        const step = transcript.messages
          .slice(asked)
          .filter((message) => message.role === 'toolResult').length
        return step < steps.length
          ? fauxAssistantMessage(steps[step], { stopReason: 'toolUse' })
          : fauxAssistantMessage([
              fauxText('Checked the contracts and docs, swapped the scratch text and put it back.'),
            ])
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
      if (last?.role === 'user' && last.content === 'long bash demo') {
        return fauxAssistantMessage(
          [
            fauxToolCall('bash', {
              command:
                'cd ~; sleep 1; for i in $(seq 1 60); do echo "poll $i: checks pending"; sleep 5; done',
            }),
          ],
          { stopReason: 'toolUse' },
        )
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
      // Answers with the given Markdown verbatim, to preview how answers render it (such as `#id` mentions).
      const say = /^say ([\s\S]+)$/.exec(messageText(last?.role === 'user' ? last.content : ''))
      if (say) return fauxAssistantMessage([fauxText(say[1])])
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
      if (last?.role === 'user' && last.content === 'seed codemode')
        return tool('codemode', {
          code: "return await ultimate.action('faux', 'seedCodemode', { conversation: (await ultimate.uiState()).conversationId ?? 1 })",
        })
      if (transcript.messages[asked]?.content === 'cards demo') {
        const results = transcript.messages
          .slice(asked)
          .filter((message) => message.role === 'toolResult')
        const branch = Number(
          /Branch #(\d+) started/.exec(messageText(results[0]?.content))?.[1] ?? 1,
        )
        const steps = [
          fauxToolCall('branch', { prompt: 'landing demo', isolated: false }),
          fauxToolCall('message', {
            to: `#${branch}`,
            text: 'Can you check whether the status card renders on narrow screens?',
          }),
          fauxToolCall('codemode', {
            code: `return await ultimate.action('faux', 'seedCards', { from: ${branch} })`,
          }),
          fauxToolCall('message', {
            to: 'user',
            text: 'The card fold landed as `5e1f0a2` and is pushed to `main`.\n\nDivergence: none.',
            reply: false,
          }),
          fauxToolCall('message', { to: 'user', text: decisions }),
        ]
        return results.length < steps.length
          ? fauxAssistantMessage([steps[results.length]], { stopReason: 'toolUse' })
          : fauxAssistantMessage([fauxText('Every card kind is in this conversation now.')])
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
      // A review sent from the Review surface: acknowledge each place it names.
      const review =
        last?.role === 'user'
          ? /^Review of `(.+)` \((\d+) comments?\)/.exec(messageText(last.content))
          : null
      if (review) {
        const places = [
          ...messageText(last!.content).matchAll(/^`([^`\n]+:\d+(?:-\d+)?)` \((?:old|new)\)$/gm),
        ]
        return fauxAssistantMessage([
          fauxText(
            `Thanks for the review of \`${review[1]}\`. I will address ${review[2]} comment${review[2] === '1' ? '' : 's'}:\n\n${places.map((place) => `- \`${place[1]}\``).join('\n')}`,
          ),
        ])
      }
      // A one-way message with the given text, to preview how its recipient's row shows triage.
      const tell =
        last?.role === 'user'
          ? /^tell (#\d+|@[\w-]+) ([\s\S]+)$/.exec(messageText(last.content).trim())
          : null
      if (tell)
        return fauxAssistantMessage(
          [fauxToolCall('message', { to: tell[1], text: tell[2], reply: false })],
          { stopReason: 'toolUse' },
        )
      const target =
        last?.role === 'user'
          ? /^message (#\d+|@[\w-]+)( one-way)?$/.exec(messageText(last.content).trim())
          : null
      if (target) {
        // Pasted with images, the message forwards them.
        const pasted =
          typeof last!.content !== 'string' && last!.content.some((p) => p.type === 'image')
        return fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: target[1],
              text: 'Can you check whether the status card renders on narrow screens?',
              reply: !target[2],
              ...(pasted ? { images: 'latest' } : {}),
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

/** `read()`'s value once it is defined, checking every 200 ms for at most a minute. */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 300; tries++) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for a worktree')
}

/** Landings for `seedLandings`, newest last: sha, base, feature, title, commits. */
const demoLandings = [
  ['3e55874', 'c4ceeb7', 'Provider Health', 'Track only logged-in providers', 1],
  ['9bfcd3b', '3e55874', 'Agent Harness', 'Harness improvement epic', 17],
  ['7c17166', '9bfcd3b', 'Sidebar', 'Hide sub-agents under listed roots', 1],
  ['9057c43', '7c17166', 'Sidebar', 'Standing agent marks', 2],
  ['45a315f', '9057c43', 'Lander Row', "The lander's feature tag", 1],
] as const

/** Memories for `seedMemory`: slug, kind, line, body, source, age in hours. */
const demoMemories = [
  [
    'extensions-over-server',
    'decision',
    'New behaviour goes in extensions/, not server/: extensions hot-reload without a restart',
    'Put agent behaviour in `extensions/<name>/server.ts` and UI in `web.tsx`. `server/` and `shared/` need the `restart` tool, which boots a second process and type-checks it first.\n\nOnly move something into core when two extensions need it and no extension point fits.',
    '#12/48',
    2,
  ],
  [
    'pi-durable-pinned',
    'decision',
    'Pin @earendil-works packages to exact versions; Pi Durable is experimental',
    'Pi Durable changes its storage and replay semantics between minor versions. Pin exact versions in `package.json` and upgrade on a branch that runs `pnpm test:e2e`.',
    '#3/112',
    30,
  ],
  [
    'faux-for-ui-previews',
    'lesson',
    'Preview UI on a faux instance, never on the shared host',
    'A faux instance (`instance start` with `faux: true`) costs no tokens and has seed actions (`seedLandings`, `seedFlights`, `seedMemory`). Screenshots of the shared host leak real conversations into reports.',
    '#41/7',
    5,
  ],
  [
    'fast-tests-no-waits',
    'fact',
    'pnpm test runs in-process: no real-time waits, no spawned processes',
    'Lint enforces it with `ultimate/no-real-wait-in-fast-tests` and `ultimate/no-test-timeout`. Anything that spawns goes to `test/e2e`. Use `until` from `test/helpers.ts` for real deadlines.',
    '#18/220',
    76,
  ],
  [
    'roots-never-concluded',
    'fact',
    'Roots and standing agents are never concluded or cleared, only compacted',
    'A root runs no turns; branches start from its memory, and its history can be compacted without deleting anything.',
    undefined,
    200,
  ],
  [
    'lander-runs-all-suites',
    'fact',
    'The lander merges, runs every suite on the merged tip, then fast-forwards and pushes',
    'A worker runs the tests covering its change; the lander runs `pnpm check`, `pnpm test` and `pnpm test:e2e` again on the merge with whatever landed meanwhile. A failure leaves the target untouched.',
    '#27/96',
    12,
  ],
  [
    'cards-not-markdown',
    'decision',
    'Every user-visible outcome gets a designed card, never raw Markdown in a message',
    'Reports, landings and failures render through entry renderers that match `extensions/subagents/messages.tsx` and `extensions/workspaces/log.tsx`.',
    '#9/301',
    400,
  ],
  [
    'vite-hmr-facets',
    'fact',
    'A broken web facet shows an error card; the rest of the UI keeps running',
    'Each contribution renders in an `ExtensionBoundary`. A thrown render falls back to the previous composer renderer or an error card naming the extension.',
    '#33/14',
    50,
  ],
  [
    'worktree-cleanup-race',
    'lesson',
    'Wait for a worktree to be ready before writing to it',
    'A branch with `isolated: true` gets its worktree asynchronously. Writing before `state === "ready"` races `git worktree add` and loses the file.',
    '#52/33',
    1,
  ],
  [
    'summary-model-faux',
    'fact',
    'Under faux, the summary model is faux/faux-1:off unless settings say otherwise',
    'Titles, abstracts and memory distillation all go through `summaryModel`. Faux answers them with short canned text, so distilled memory stays empty in a preview.',
    undefined,
    150,
  ],
  [
    'no-silent-catch',
    'lesson',
    'A swallowed error needs a comment saying why ignoring it is correct',
    '`ultimate/no-silent-catch` flags empty catch blocks and `.catch` handlers that return nothing. Add a reason comment or handle the error.',
    '#20/58',
    700,
  ],
  [
    'phone-layout',
    'decision',
    'Every surface must work at 390px: rows wrap or truncate, actions stay reachable without hover',
    'Use `pointer-coarse:visible` for hover-only controls and `min-w-0` with `truncate` on flexible text.',
    '#61/12',
    20,
  ],
] as const

/** What `seedCards` writes: one of each card that reaches @ultimate as an entry rather than a tool call. */
function demoCards(from: number): { kind: string; data: JsonObject }[] {
  const subject = { title: 'Fold cards in the chat', feature: 'Chat Cards' }
  const commits = ['5e1f0a2', '4d0e9b1']
  const steps: JsonObject[] = [
    { step: 'started', at: Date.now() - 60000 },
    { step: 'merged', at: Date.now() - 50000 },
    {
      step: 'checked',
      at: Date.now() - 20000,
      check: { command: 'pnpm check', result: 'passed', summary: 'clean' },
    },
    { step: 'landed', at: Date.now() - 10000 },
  ]
  return [
    {
      kind: 'board.message',
      data: {
        id: 9001,
        from,
        text: 'Should the folded line show the age of a message?',
        reply: true,
        delivery: 'followUp',
      },
    },
    {
      kind: 'board.reply',
      data: { id: 9002, from, text: 'The status card fits on narrow screens.', reply: false },
    },
    {
      kind: 'subagents.report',
      data: {
        sender: from,
        kind: 'report',
        agent: 'worker',
        body: 'Status: DONE\n\nAll checks pass.',
      },
    },
    {
      kind: 'lineage.note',
      data: { from, text: 'The transcript paging work touches `web/src/app/transcript.tsx`.' },
    },
    {
      kind: 'lineage.note',
      data: {
        source: 'main',
        text: 'Since you last ran, `main` gained 3 commits; none overlap yours.',
      },
    },
    {
      kind: 'lineage.finished',
      data: { from, title: 'Landing demo', text: 'Landed `1a2b3c4` on `main`.' },
    },
    { kind: 'lineage.woken', data: {} },
    {
      kind: 'lineage.abstract',
      data: {
        conversation: from,
        at: 1,
        title: 'Landing demo',
        text: 'Ask: land the demo.\nState: landed.',
      },
    },
    {
      kind: 'workspaces.lander-report',
      data: {
        id: `faux-cards:${from}`,
        outcome: {
          outcome: 'landed',
          sha: commits[0],
          base: 'c4ceeb7',
          commits,
          paths: ['web/src/app/fold.tsx'],
          pushed: 'origin/main',
          target: 'main',
          tip: commits[0],
          lander: from,
          steps,
          conversationId: from,
          subject,
          at: 1,
          divergence: 'None.',
        },
      },
    },
    {
      kind: 'lineage.note',
      data: {
        from,
        source: 'lander',
        text: `Landed ${commits[0]} on main`,
        sha: commits[0],
        base: 'c4ceeb7',
        target: 'main',
        commits: commits.map((sha) => ({ sha, subject: 'feat: fold cards in the chat' })),
        more: 0,
        paths: ['web/src/app/fold.tsx'],
        pushed: 'origin/main',
        ...subject,
      },
    },
  ]
}

/** Seeding memory writes project memory without @ultimate's check: only the user (a preview's operator) may. */
export const userActions = ['seedMemory']

export const actions = {
  /**
   * Faux only: writes one of each entry card (messages and a reply from `from`, a report, notes, a catch-up, finished,
   * an abstract, landings) into the calling conversation, for `cards demo`. Display only: the
   * entries carry no model messages.
   */
  async seedCards(args: JsonValue, { host, conversationId }: ActionContext) {
    if (!host.faux) throw new Error('seedCards runs only under faux')
    const from = (args as { from?: unknown } | null)?.from
    if (typeof from !== 'number') throw new Error('from must be a conversation id')
    if (conversationId === undefined)
      throw new Error('seedCards writes into the calling conversation')
    const cards = demoCards(from)
    await host.harness().commit(async (tx) => {
      for (const card of cards) await tx.appendEntry(conversationId as ConversationId, card)
    }, BACKGROUND_CONTEXT)
    return { seeded: cards.length }
  },
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
   * Faux only: `{root?, op?}` previews project memory in root `root` (default 1). Without `op` it writes twelve
   * memories of every kind with ages from an hour to a month; `op: 'update'` rewrites one, `op: 'delete'` drops one.
   */
  async seedMemory(args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedMemory runs only under faux')
    const { root = 1, op } = (args ?? {}) as { root?: unknown; op?: unknown }
    if (typeof root !== 'number') throw new Error('root must be a conversation id')
    const lineage = host.need(LineageApi)
    if (op === 'update')
      return {
        summary: await lineage.remember(
          root,
          [
            {
              op: 'update',
              slug: 'pi-durable-pinned',
              line: 'Pin @earendil-works packages exactly; upgrade Pi Durable only on a branch that runs e2e',
              body: 'Pi Durable changes its storage and replay semantics between minor versions. Pin exact versions in `package.json`.\n\n- Upgrade on its own branch.\n- Run `pnpm test:e2e` before landing: replay bugs only show across restarts.',
              // A conversation every faux project has, so the source shows as its chip.
              source: '#1/2',
            },
          ],
          BACKGROUND_CONTEXT,
        ),
      }
    if (op === 'delete')
      return {
        summary: await lineage.remember(
          root,
          [{ op: 'delete', slug: 'worktree-cleanup-race' }],
          BACKGROUND_CONTEXT,
        ),
      }
    if (op !== undefined) throw new Error('op must be update or delete')
    const now = Date.now()
    for (const [slug, kind, line, body, source, hours] of demoMemories)
      await lineage.remember(
        root,
        [{ op: 'add', slug, kind, line, body, ...(source ? { source } : {}) }],
        BACKGROUND_CONTEXT,
        now - hours * 3_600_000,
      )
    return { seeded: demoMemories.length }
  },
  /**
   * Faux only: two isolated branches of root 1 with work in their worktrees, to preview the root's In flight rows: one
   * with three commits and an uncommitted edit, one with only uncommitted edits. Needs a project that can isolate.
   */
  async seedFlights(_args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedFlights runs only under faux')
    const lineage = host.need(LineageApi)
    const workspaces = host.need(WorkspacesApi)
    const ids: number[] = []
    for (const [prompt, commits, edits] of [
      ['Show work in flight on the root', 3, 1],
      ['Tighten the review links', 0, 2],
    ] as const) {
      const { id } = await lineage.branch(
        { from: 1, prompt, isolated: true, deliver: false },
        BACKGROUND_CONTEXT,
      )
      const record = await until(() => workspaces.get(id, BACKGROUND_CONTEXT))
      await until(async () =>
        (await workspaces.get(id, BACKGROUND_CONTEXT))?.state === 'ready' ? true : undefined,
      )
      for (let n = 1; n <= commits; n++) {
        await writeFile(join(record.path, `flight-${n}.txt`), `step ${n}\n`)
        await workspaces.git(record.path, 'add', '-A')
        await workspaces.git(
          record.path,
          '-c',
          'user.name=Faux',
          '-c',
          'user.email=faux@example.com',
          'commit',
          '-q',
          '-m',
          `feat: step ${n}`,
        )
      }
      for (let n = 1; n <= edits; n++)
        await writeFile(join(record.path, `edit-${n}.txt`), `draft ${n}\n`)
      ids.push(id)
    }
    return { branches: ids }
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
      ['cloud', 'Backup failed: POST /sync/backups returned 503: Service Unavailable'],
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
      const project = 'github.com/HazAT/ultimate'
      await host.emit(tx, BackupEvent, { phase: 'started', project })
      await host.emit(tx, BackupEvent, {
        phase: 'done',
        project,
        bytes: 48_213_504,
        uploaded: 15_728_640,
        ms: 75_120,
      })
      await host.emit(tx, BackupEvent, { phase: 'started', project })
      await host.emit(tx, BackupEvent, { phase: 'failed', project, ms: 4210, reason: 'HTTP 503' })
      await host.emit(tx, BackupEvent, { phase: 'started', project })
      await host.emit(tx, BackupEvent, {
        phase: 'failed',
        project,
        ms: 3900,
        reason: 'conflict',
        error:
          'rog backed up ultimate at 2026-10-21T09:12:00.000Z after the backup this one builds on. Restore it first (pnpm restore ultimate), or back up with force to replace it.',
      })
    }, BACKGROUND_CONTEXT)
    return { seeded: 8 + demoLandings.length + notices.length }
  },
  /**
   * Faux only: a coordinator branch and two workers next to @ultimate and the lander, with half an hour of their tool
   * and model calls in the trace (one failing) and one worker still calling, to preview the System surface's lanes.
   */
  async seedLanes(_args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedLanes runs only under faux')
    return seedLanes(host)
  },
  /**
   * Faux only: `{conversation, count}` appends about `count` entries to `conversation` in turns of four: a user input,
   * an assistant with a tool call, its result, and a Markdown answer. Previews a long transcript and its scrollback.
   */
  /**
   * Faux only: `{ conversation }` → a past run of @ultimate's real codemode calls between bash and read steps, with the
   * lines the summary model wrote for them, followed by its answer. Previews codemode cards and folded runs.
   */
  async seedCodemode(args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedCodemode runs only under faux')
    const { conversation } = (args ?? {}) as { conversation?: unknown }
    if (typeof conversation !== 'number') throw new Error('conversation must be a conversation id')
    const id = conversation as ConversationId
    const at = Date.now() - 10 * 60_000
    await host.harness().commit(async (tx) => {
      await tx.appendEntry(id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'wrap up the finished branches', timestamp: at }],
      })
      const lines: Record<string, CallSummary> = {}
      for (const [index, step] of codemodeSteps.entries()) {
        const call = `seed-codemode-${id}-${index}`
        const time = at + (index + 1) * 20_000
        await tx.appendEntry(id, {
          kind: 'pi.assistant',
          model: [
            fauxAssistantMessage([fauxToolCall(step.tool, step.args, { id: call })], {
              stopReason: 'toolUse',
              timestamp: time,
            }),
          ],
        })
        await tx.appendEntry(id, {
          kind: 'pi.tool-result',
          model: [
            {
              role: 'toolResult',
              toolCallId: call,
              toolName: step.tool,
              content: [{ type: 'text', text: step.result }],
              ...(step.details ? { details: step.details } : {}),
              isError: step.error ?? false,
              timestamp: time + 900,
            },
          ],
        })
        if (step.summary) lines[call] = step.summary
      }
      Object.assign((await tx.doc(CodemodeSummaries, id)).calls, lines)
      await tx.appendEntry(id, {
        kind: 'pi.assistant',
        model: [
          fauxAssistantMessage(
            [
              fauxText(
                'Concluded the six finished branches and paused the overnight timer. #34790 stays: it is owned by the root.',
              ),
            ],
            { timestamp: at + 9 * 60_000 },
          ),
        ],
      })
    }, BACKGROUND_CONTEXT)
    return { seeded: codemodeSteps.length }
  },
  /**
   * Faux only: `{ from }` → a reviewer subagent of `from` whose first request carries 15 of `from`'s real prompt
   * sections and two of its tools, and in `from` a mid-conversation prompt patch (a changed, an added and a removed
   * section; a changed and a removed tool) followed by a turn. Previews the context header and the patch diff.
   */
  async seedContext(args: JsonValue, { host }: ActionContext) {
    if (!host.faux) throw new Error('seedContext runs only under faux')
    const { from } = (args ?? {}) as { from?: unknown }
    if (typeof from !== 'number') throw new Error('from must be a conversation id')
    const id = from as ConversationId
    return host.harness().commit(async (tx) => {
      const page = await tx.scanEntries({ conversationId: id, order: 'descending' }, 1000)
      const baseline = page.items
        .map((entry) => entry.model?.[0])
        .find(
          (message): message is SystemMessage =>
            message?.role === 'system' && Object.keys(message.sections ?? {}).length >= 15,
        )
      if (!baseline?.sections || !baseline.toolsAdded)
        throw new Error(`#${from} has no full system prompt yet; send it a message first`)
      const at = Date.now()
      const skip = new Set(['workspace_workflow', 'messages', 'codemode', 'lineage', 'subagents'])
      const sections = Object.fromEntries(
        Object.entries(baseline.sections).filter(([key]) => !skip.has(key)),
      )
      sections.instructions =
        '<instructions>\n# Reviewer\n\nYou review one immutable commit range for correctness, simplicity and conventions. Read the diff and the code around it, run the checks that cover it, and return one verdict with findings at file:line, ranked by severity. Never edit files.\n</instructions>'
      const tools = baseline.toolsAdded.filter(
        (declared) => declared.name === 'read' || declared.name === 'bash',
      )
      const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      Object.assign(await tx.doc(host.metadata, child.id), {
        title: 'Review the context header range',
        label: 'reviewer',
      })
      const task =
        'Review the range a2fa594..HEAD: the context header, its breakdown model and the reload diff.'
      await tx.appendEntry(child.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: task, timestamp: at }],
      })
      await tx.appendEntry(child.id, {
        kind: 'pi.system',
        model: [{ role: 'system', content: '', sections, toolsAdded: tools, timestamp: at }],
      })
      await tx.appendEntry(child.id, {
        kind: 'pi.assistant',
        model: [
          fauxAssistantMessage([fauxText('**Verdict:** ship it. No findings above P3.')], {
            timestamp: at + 40_000,
          }),
        ],
      })
      const instructions = baseline.sections.instructions ?? ''
      const restart = baseline.toolsAdded.find((declared) => declared.name === 'restart')
      const read = baseline.toolsAdded.find((declared) => declared.name === 'read')
      await tx.appendEntry(id, {
        kind: 'pi.system',
        model: [
          {
            role: 'system',
            content: '',
            sections: {
              instructions: instructions.replace(
                /\n<\/instructions>$/,
                '\n\n## Review\nBefore reporting, ask the review team for one verdict on the whole range.\n</instructions>',
              ),
              environment: null,
              review:
                '<review>\nThe review team: reviewer-correctness, reviewer-simplicity, reviewer-architecture.\n</review>',
            },
            toolsRemoved: [{ name: 'read' }, ...(restart ? [{ name: 'restart' }] : [])],
            ...(read && {
              toolsAdded: [
                { ...read, description: `${read.description} Binary files show as their size.` },
              ],
            }),
            timestamp: at,
          },
        ],
      })
      await tx.appendEntry(id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'review it before you report', timestamp: at + 1000 }],
      })
      await tx.appendEntry(id, {
        kind: 'pi.assistant',
        model: [
          fauxAssistantMessage([fauxText(`Asked a reviewer: #${child.id}.`)], {
            timestamp: at + 2000,
          }),
        ],
      })
      return { subagent: child.id }
    }, BACKGROUND_CONTEXT)
  },
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
