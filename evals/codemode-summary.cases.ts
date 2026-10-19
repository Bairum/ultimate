/** Real codemode calls from @ultimate (#97078), trimmed, with what their summary line must say. */
import type { Call } from '../extensions/codemode/summary.ts'

const ok = (name: string, ...args: unknown[]): Call => ({ name, args, status: 'ok' })
const conclude = (...ids: number[]) => ok('ultimate.action', 'conversations', 'conclude', { ids })
const done = (value: unknown) => `Script completed\nOutput:\n${JSON.stringify(value)}`

// Real codemode calls from @ultimate (#97078), trimmed; the number names each. One-call reads are labelled without
// the model (test/codemode-summary.test.ts), so every case here has an effect or several calls.
export const cases: {
  name: string
  code: string
  calls: Call[]
  result: string
  effect: boolean
  /** What the line must say, as a case-insensitive pattern. */
  says: RegExp
}[] = [
  {
    name: '1 conclude one',
    code: "return await ultimate.action('conversations', 'conclude', {ids: [201645]});",
    calls: [conclude(201645)],
    result: done({ concluded: [201645], kept: [{ id: 203003, unlanded: 1 }] }),
    effect: true,
    says: /^conclud.*201645/,
  },
  {
    name: '6 conclude four',
    code: "const r = await ultimate.action('conversations', 'conclude', {ids: [180933, 187816, 191053, 110108]}); return r;",
    calls: [conclude(180933, 187816, 191053, 110108)],
    result: done({ concluded: [180933, 187816, 191053, 110108], kept: [] }),
    effect: true,
    says: /^concluded (4|four) conversations \(#180933, #187816/,
  },
  {
    name: '7 conclude six',
    code: "const r = await ultimate.action('conversations', 'conclude', {ids: [190416, 190537, 195420, 197140, 197459, 197623]}); return r;",
    calls: [conclude(190416, 190537, 195420, 197140, 197459, 197623)],
    result: done({ concluded: [190416, 190537, 195420, 197140, 197459, 197623], kept: [] }),
    effect: true,
    says: /^concluded (6|six) conversations/,
  },
  {
    name: '27 clears stored notes and concludes',
    code: "store('focus', null); store('night', null); return await ultimate.action('conversations','conclude',{ids:[159728]});",
    calls: [conclude(159728)],
    result: done({ concluded: [159728], kept: [] }),
    effect: true,
    says: /^conclud.*159728/,
  },
  {
    name: '28 checks the catalogue, then pauses a timer',
    code: "const c = await ultimate.catalogue(); const ex = await ultimate.extensions(); text(JSON.stringify({apis:c.apis.length, missing:c.missing, cycles:c.cycles, n: ex.length}));\nconst r = await ultimate.action('automations','pause',{id:'A7'}); text('timer: '+r.enabled);",
    calls: [
      ok('ultimate.catalogue'),
      ok('ultimate.extensions'),
      ok('ultimate.action', 'automations', 'pause', { id: 'A7' }),
    ],
    result: 'Script completed\nOutput:\n{"apis":12,"missing":[],"cycles":[],"n":40}\ntimer: false',
    effect: true,
    says: /^paused/,
  },
  {
    name: '36 creates an automation',
    code: "const r = await ultimate.action('automations','create',{name:'ultimate-overnight-check', schedule:'every 30m', prompt:'Send @ultimate a one-way check-in.'}); return r;",
    calls: [
      ok('ultimate.action', 'automations', 'create', {
        name: 'ultimate-overnight-check',
        schedule: 'every 30m',
      }),
    ],
    result: done({ id: 'A7', name: 'ultimate-overnight-check', enabled: true }),
    effect: true,
    says: /^(created|scheduled|set up|added).*(overnight|30)/,
  },
  {
    name: '59 a refused conclude fails',
    code: "return await ultimate.action('conversations','conclude',{ids:[34790,34804,34820,35701]});",
    calls: [{ ...conclude(34790, 34804, 34820, 35701), status: 'error' }],
    result:
      'Script failed\nOutput:\nError: Conversation 34790 is owned, not a top-level conversation',
    effect: false,
    says: /fail|could not|couldn.t|refused|unable/,
  },
  {
    name: '63 notes pending work and concludes',
    code: "store('haza-pc-pending', {tasks: ['switch machine-home conversations to openai-codex']}); return await ultimate.action('conversations','conclude',{ids:[155356]});",
    calls: [conclude(155356)],
    result: done({ concluded: [155356], kept: [] }),
    effect: true,
    says: /^conclud.*155356/,
  },
  {
    name: '89 checks extensions, then concludes',
    code: "const ex = await ultimate.extensions(); const errs = ex.filter(x=>x.errors?.length).map(x=>x.name); const r = await ultimate.action('conversations','conclude',{ids:[135873]}); return {errs, r};",
    calls: [ok('ultimate.extensions'), conclude(135873)],
    result: done({ errs: [], r: { concluded: [135873], kept: [{ id: 136211, uncommitted: 1 }] } }),
    effect: true,
    says: /^conclud.*135873/,
  },
  {
    name: 'a write that succeeded before a failure still leads',
    code: "await tools.write({path:'notes.md', content:'x'}); await tools.bash({command:'pnpm test'})",
    calls: [
      { name: 'write', args: { path: 'notes.md', content: 'x' }, status: 'ok' },
      { name: 'bash', args: { command: 'pnpm test' }, status: 'error' },
    ],
    result: 'Script failed\nOutput:\nError: 3 tests failed',
    effect: true,
    says: /^wrote.*notes\.md/,
  },
  {
    name: '12 lists conversations and the task graph',
    code: 'const cs = await ultimate.conversations(); const g = await ultimate.taskGraph();\nreturn cs.filter(c => !c.owner).slice(0,5).map(c => ({id:c.id}));',
    calls: [ok('ultimate.conversations'), ok('ultimate.taskGraph')],
    result: done([{ id: 1 }, { id: 14 }, { id: 87 }]),
    effect: false,
    says: /conversation/,
  },
  {
    name: '32 checks running tasks and one conversation',
    code: "const g = await ultimate.taskGraph(); const t = Object.values(g.tasks).filter(x=>x?.state?.status==='running'); text(JSON.stringify(t.length)); const e = await ultimate.entries(171550, {limit: 1}); text(e[0]?.id);",
    calls: [ok('ultimate.taskGraph'), ok('ultimate.entries', 171550, { limit: 1 })],
    result: 'Script completed\nOutput:\n4\n171550 last: 2026-10-18T22:45:49Z',
    effect: false,
    says: /task|171550/,
  },
  {
    name: '56 searches history twice',
    code: "const hits = await ultimate.search('\"provider\":\"openai\"', {limit: 200}); text('total '+hits.length); const s2 = await ultimate.search('openai/gpt-6', {limit: 50}); text(s2.length);",
    calls: [
      ok('ultimate.search', '"provider":"openai"', { limit: 200 }),
      ok('ultimate.search', 'openai/gpt-6', { limit: 50 }),
    ],
    result: 'Script completed\nOutput:\ntotal 200\n15',
    effect: false,
    says: /^search/,
  },
  {
    name: '92 checks the build and extensions',
    code: 'const s = await ultimate.system(); const ex = await ultimate.extensions(); return {gen: s.build.generation, errs: []};',
    calls: [ok('ultimate.system'), ok('ultimate.extensions')],
    result: done({ gen: 3, core: 'adf8789be4ab', errs: [] }),
    effect: false,
    says: /build|system|extension|generation/,
  },
  {
    name: '96 reads recent entries and searches questions',
    code: "const e = await ultimate.entries(97078, {limit: 30}); const d = await ultimate.search('\"questions.', {conversationId: 1, limit: 5}); return d;",
    calls: [
      ok('ultimate.entries', 97078, { limit: 30 }),
      ok('ultimate.search', '"questions.', { conversationId: 1, limit: 5 }),
    ],
    result: done([]),
    effect: false,
    says: /97078|question/,
  },
  {
    name: '78 finds screenshots and checks a preview',
    code: "const r = await ultimate.search('shots-148709', {conversationId: 148709, limit: 5}); text(r.length); text(await tools.bash({command:'ls /tmp/shots-148709/; curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:35259/'}));",
    calls: [
      ok('ultimate.search', 'shots-148709', { conversationId: 148709, limit: 5 }),
      {
        name: 'bash',
        args: { command: 'ls /tmp/shots-148709/; curl -s http://127.0.0.1:35259/' },
        status: 'ok',
      },
    ],
    result: 'Script completed\nOutput:\n5\nfront-health.png\nstatus-failing.png\n200',
    effect: false,
    says: /screenshot|preview|148709/,
  },
  {
    name: '54 reads the summary model setting and greps settings',
    code: "text(JSON.stringify(await ultimate.action('conversations','summaryModel',{}))); text(await tools.bash({command:'grep -rn \"openai/\" ~/.ultimate/settings.json | head'}));",
    calls: [
      ok('ultimate.action', 'conversations', 'summaryModel', {}),
      {
        name: 'bash',
        args: { command: 'grep -rn "openai/" ~/.ultimate/settings.json | head' },
        status: 'ok',
      },
    ],
    result:
      'Script completed\nOutput:\n{"value":"openai-codex/gpt-6-luna:medium","source":"default"}\n',
    effect: false,
    // Quoted command text never reaches the model, so the grep pattern is not named.
    says: /summary ?model|settings/,
  },
]
