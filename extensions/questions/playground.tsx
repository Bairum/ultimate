import { RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { cn, Header } from '@/sdk'
import { AgentMark } from '../conversations/ui.tsx'
import { accentOf } from '../messages/ui.tsx'
import { Card } from './card.tsx'
import type { Answer } from './refs.ts'
import type { Question } from './types.ts'

type Sample = { id: string; title: string; text: string; questions: Question[] }

const diff = (lines: string) => `\`\`\`diff\n${lines}\n\`\`\``

/** One @ultimate message per question kind, as the transcript would show it. */
const samples: Sample[] = [
  {
    id: 'decisions',
    title: 'Choices with picks',
    text: "The preview is ready and the tally reads well.\n\nDecisions:\n1. **Branch starts in the context:** (a) one-line intent plus breadcrumb; (b) drop them, rely on abstracts; (c) leave as is.\n2. **Boxer's copied `agents/ultimate.md`:** (a) assess a way to add tools without forking it; (b) leave it.\n3. **Land it:** (a) yes; (b) no, change something first.\n\nMy picks: 1a 2a 3a.",
    questions: [
      {
        text: 'Branch starts in the context',
        kind: 'choice',
        ref: '1',
        options: [
          {
            label: 'one-line intent plus breadcrumb',
            key: 'a',
            recommended: true,
            preview: diff(
              '- ## Branches\n- #335800 started from root with 14 memories\n+ #335800 · answer card redesign  ↳ #335800/12',
            ),
          },
          {
            label: 'drop them, rely on abstracts',
            key: 'b',
            detail: 'Shorter tally; branches only show once they land',
          },
          { label: 'leave as is', key: 'c' },
        ],
      },
      {
        text: "Boxer's copied agents/ultimate.md",
        kind: 'choice',
        ref: '2',
        options: [
          {
            label: 'assess a way to add tools without forking it',
            key: 'a',
            recommended: true,
          },
          { label: 'leave it', key: 'b' },
        ],
      },
      {
        text: 'Land it',
        kind: 'choice',
        ref: '3',
        options: [
          { label: 'yes', key: 'a', recommended: true },
          { label: 'no, change something first', key: 'b' },
        ],
      },
    ],
  },
  {
    id: 'multi',
    title: 'Multiple choice',
    text: 'The night watch found four flaky suites. I can quarantine and fix them in one branch.\n\n**Which should I take on now?** Pick any.',
    questions: [
      {
        text: 'Which suites should I fix now?',
        kind: 'multi',
        options: [
          {
            label: 'questions-keyboard',
            detail: 'e2e · fails 1 in 12 on Enter timing',
            recommended: true,
          },
          { label: 'workspaces-integration', detail: 'e2e · git lock race', recommended: true },
          { label: 'dream-seed', detail: 'unit · clock-dependent' },
          { label: 'lint-api', detail: 'unit · snapshot drift' },
        ],
      },
    ],
  },
  {
    id: 'confirm',
    title: 'Confirm',
    text: 'The patch is committed in `ultimate/47c790-335800` and `pnpm check` passes.\n\nShould I submit it to the lander now?',
    questions: [{ text: 'Submit the patch to the lander now?', kind: 'confirm' }],
  },
  {
    id: 'text',
    title: 'Free text',
    text: "I'm naming the new surface. It shows in the switcher and in ⌘K.\n\nWhat should it be called?",
    questions: [
      {
        text: 'What should the surface be called?',
        kind: 'text',
        placeholder: 'e.g. Questions playground',
      },
    ],
  },
  {
    id: 'scale',
    title: 'Scale',
    text: 'Before I spend another round on motion: how finished does the answer card feel to you right now?',
    questions: [
      {
        text: 'How finished does the card feel?',
        kind: 'scale',
        scale: { min: 1, max: 5, low: 'rough', high: 'polished' },
      },
    ],
  },
  {
    id: 'mixed',
    title: 'Every kind at once',
    text: 'Three things before I start the migration branch.',
    questions: [
      {
        text: 'Storage for the board',
        kind: 'choice',
        ref: '1',
        options: [
          {
            label: 'one document per root',
            key: 'a',
            recommended: true,
            preview: diff(
              '- asked: Record<string, Question[]>\n+ asked: Record<string, { questions: Question[]; at: number }>',
            ),
          },
          { label: 'one document per message', key: 'b' },
        ],
      },
      {
        text: 'Also migrate',
        kind: 'multi',
        ref: '2',
        options: [
          { label: 'old answers', key: 'a', recommended: true },
          { label: 'dismissed notes', key: 'b' },
          { label: 'retired entries', key: 'c' },
        ],
      },
      { text: 'Run it on the fleet tonight?', kind: 'confirm', ref: '3' },
      {
        text: 'Risk you are willing to take',
        kind: 'scale',
        ref: '4',
        scale: { min: 1, max: 5, low: 'none', high: 'yolo' },
      },
      {
        text: 'Anything I should know?',
        kind: 'text',
        ref: '5',
        placeholder: 'Optional',
      },
    ],
  },
  {
    id: 'reply',
    title: 'Nothing extracted',
    text: "I looked at the logs and can't tell which of the two deploys broke search. Do you remember which one you pushed last Friday?",
    questions: [],
  },
]

const wait = () => new Promise((resolve) => setTimeout(resolve, 600))

/** A message from @ultimate as the transcript shows it, with its answer card under the text. */
function Sample({
  sample,
  round,
  keys,
  activate,
}: {
  sample: Sample
  round: number
  keys: boolean
  activate: () => void
}) {
  const accent = accentOf('ultimate')
  const [log, setLog] = useState<string>()
  const record = (value: string) => wait().then(() => setLog(value))
  return (
    <div className="space-y-1.5" onPointerDown={activate} onFocus={activate}>
      <h2 className="font-mono text-[11px] text-muted-foreground">{sample.title}</h2>
      <section
        className={cn(
          'w-full min-w-0 rounded-md border border-l-2 border-border',
          accent.left,
          accent.fill,
        )}
      >
        <header className="flex min-h-8 items-center gap-2 px-3 pt-2.5 font-mono text-[11px] text-muted-foreground">
          <span className={cn('flex items-center gap-1.5 font-semibold', accent.name)}>
            <AgentMark name="ultimate" size="sm" />
            <span className="font-sans text-[10.5px] font-semibold tracking-[0.28em]">
              ULTIMATE
            </span>
          </span>
          <span className="ml-auto">2m</span>
        </header>
        <div className="min-w-0 px-3 py-3 text-[13px] leading-relaxed">
          <MessageResponse>{sample.text}</MessageResponse>
        </div>
        <Card
          key={round}
          card={`playground:${sample.id}`}
          questions={sample.questions}
          keys={keys}
          submit={(answers: Answer[]) =>
            record(answers.map((a) => `${a.question}: ${a.answer}`).join('\n'))
          }
          reply={(text) => record(text)}
          dismiss={() => record('(dismissed)')}
        />
      </section>
      {log && (
        <pre className="font-mono text-[10px] whitespace-pre-wrap text-muted-foreground/70">
          → {log}
        </pre>
      )}
    </div>
  )
}

/** Every answer-card kind with sample data, so the card can be seen and tried without a live question. */
export function Playground() {
  const [round, setRound] = useState(0)
  // Like the transcript, one card takes the desktop keys: the one touched last.
  const [active, setActive] = useState('decisions')
  return (
    <>
      <Header>
        <span className="text-[13px]">Questions playground</span>
        <Button
          className="ml-2"
          variant="ghost"
          size="xs"
          onClick={() => setRound((value) => value + 1)}
        >
          <RotateCcwIcon />
          Reset
        </Button>
      </Header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          {samples.map((sample) => (
            <Sample
              key={`${sample.id}:${round}`}
              sample={sample}
              round={round}
              keys={active === sample.id}
              activate={() => setActive(sample.id)}
            />
          ))}
        </div>
      </div>
    </>
  )
}
