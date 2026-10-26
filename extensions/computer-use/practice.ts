import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { FrameMeta, FrameRef, Teach, TeachPractice, TaughtStep } from './refs.ts'
import type { Driver, Observation, Predicate, TaskSpec } from './types.ts'
import {
  captureWindow,
  readTeach,
  savedSkillMarkdown,
  teaching,
  teachingPaths,
  teachDetails,
  updateTeach,
  validateSteps,
} from './teach.ts'
import { taskTool, intentInConversation } from './task-tool.ts'
import { readSession, updateSession, isStopped } from './session.ts'
import { runtime, settings, setup } from './runtime.ts'
import { allGrants, readConsent, matchesApp, identityForPid } from './gates.ts'
import { windowFor } from './observe.ts'
import {
  clock,
  containsLabel,
  matchLabel,
  parseRegions,
  presentLabel,
  requireVisible,
  normalizeLabel,
} from './perception.ts'
import type { Region } from './perception.ts'
import { teachingOcr, credentialCue } from './teach-recorder.ts'
import { saveEvidence, protectTeachReview } from './evidence-files.ts'
import { json, result } from './tool-helpers.ts'
import { redactor } from './content.ts'
import * as task from './task.ts'

class ProjectUntrusted extends Error {}
const validSkillName = (skill: unknown): skill is string =>
  typeof skill === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill) && skill.length <= 64
async function skillScopes(host: ExtensionHost, skill: string) {
  if (!validSkillName(skill)) return []
  return (
    await Promise.all(
      (['project', 'personal'] as const).map(async (scope) => {
        try {
          if (scope === 'project' && (await host.projectSetup()).decision !== true) return undefined
          const paths = await teachingPaths(
            scope === 'project' ? host.projectRoot : host.userHome,
            skill,
          )
          if (!paths.hasDestination) return undefined
          const info = await lstat(join(paths.skills, skill, 'SKILL.md'))
          return info.isFile() && !info.isSymbolicLink() ? scope : undefined
        } catch {
          // Unsafe or unreadable locations are not offered; never fall back to another scope.
          return undefined
        }
      }),
    )
  ).filter((scope) => scope !== undefined)
}
async function regularFile(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe procedure file')
  return readFile(path, 'utf8')
}
export async function readProcedure(
  host: ExtensionHost,
  skill: string,
  scope: 'project' | 'personal',
) {
  if (!validSkillName(skill) || !['project', 'personal'].includes(scope))
    throw new Error('Unsafe skill name')
  if (scope === 'project' && (await host.projectSetup()).decision !== true)
    throw new ProjectUntrusted('project_untrusted')
  const paths = await teachingPaths(scope === 'project' ? host.projectRoot : host.userHome, skill)
  if (!paths.hasDestination) throw new Error('Unknown taught skill')
  const directory = join(paths.skills, skill)
  const [procedure, markdown, raw] = await Promise.all(
    ['procedure.json', 'SKILL.md', 'teach.json'].map((file) => regularFile(join(directory, file))),
  )
  const manifest = JSON.parse(raw) as {
    format: string
    title: string
    app: { name: string; bundle: string }
    window: { id: number; titleSubstring: string }
    windows?: { app: string; bundle: string; titleSubstring: string }[]
    frames: Record<string, FrameRef>
    sha256: string
    savedAt: number
  }
  if (
    !manifest ||
    manifest.format !== 'ultimate.teach.v1' ||
    typeof manifest.title !== 'string' ||
    !manifest.title.trim() ||
    manifest.title.length > 2000 ||
    !manifest.app ||
    typeof manifest.app.name !== 'string' ||
    !manifest.app.name.trim() ||
    typeof manifest.app.bundle !== 'string' ||
    !manifest.window ||
    !Number.isSafeInteger(manifest.window.id) ||
    manifest.window.id < 1 ||
    typeof manifest.window.titleSubstring !== 'string' ||
    credentialCue(manifest.window.titleSubstring) ||
    !Number.isFinite(manifest.savedAt) ||
    !manifest.frames ||
    typeof manifest.frames !== 'object' ||
    Array.isArray(manifest.frames) ||
    manifest.sha256 !== createHash('sha256').update(procedure).digest('hex')
  )
    throw new Error('Invalid teach manifest')
  const windows = manifest.windows
  if (
    windows !== undefined &&
    (!Array.isArray(windows) ||
      !windows.length ||
      windows.length > 6 ||
      !windows.every(
        (w) =>
          !!w &&
          typeof w.app === 'string' &&
          !!w.app.trim() &&
          typeof w.bundle === 'string' &&
          typeof w.titleSubstring === 'string' &&
          w.titleSubstring.length <= 2000 &&
          !credentialCue(w.titleSubstring),
      ) ||
      // The first window mirrors the single-window fields older readers use.
      windows[0].app !== manifest.app.name ||
      windows[0].bundle !== manifest.app.bundle ||
      windows[0].titleSubstring !== manifest.window.titleSubstring)
  )
    throw new Error('Invalid teach windows')
  const frames: Record<string, FrameRef> = {}
  for (const [id, frame] of Object.entries(manifest.frames)) {
    if (
      !frame ||
      frame.id !== id ||
      !/^[a-zA-Z0-9-]+$/.test(id) ||
      !Number.isSafeInteger(frame.width) ||
      frame.width < 1 ||
      !Number.isSafeInteger(frame.height) ||
      frame.height < 1 ||
      (frame.window !== undefined &&
        (!Number.isSafeInteger(frame.window) ||
          frame.window < 1 ||
          frame.window >= (windows?.length ?? 1)))
    )
      throw new Error('Invalid taught frame')
    frames[id] = {
      id,
      width: frame.width,
      height: frame.height,
      ...(frame.window !== undefined ? { window: frame.window } : {}),
    }
    if (frame.file !== undefined) {
      if (typeof frame.file !== 'string' || !/^frames\/\d+-[a-zA-Z0-9.-]+\.png$/.test(frame.file))
        throw new Error('Unsafe taught image')
      const imageDirectory = join(directory, 'frames')
      const info = await lstat(imageDirectory)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(imageDirectory)) !== join(await realpath(directory), 'frames')
      )
        throw new Error('Unsafe taught image directory')
      const file = join(directory, frame.file)
      const image = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (image && (!image.isFile() || image.isSymbolicLink()))
        throw new Error('Unsafe taught image')
      if (image) frames[id].file = file
    }
  }
  const steps = validateSteps(JSON.parse(procedure), Object.values(frames))
  if (
    steps.some((s) => s.approved !== true) ||
    markdown !== savedSkillMarkdown(skill, manifest.title, steps, procedure.trimEnd())
  )
    throw new Error('Re-save the reviewed procedure')
  const lesson = windows ?? [
    {
      app: manifest.app.name,
      bundle: manifest.app.bundle,
      titleSubstring: manifest.window.titleSubstring,
    },
  ]
  return { manifest, frames, steps, windows: lesson }
}
export function practiceCriteria(steps: TaughtStep[]): TaskSpec['criteria'] {
  return steps.map((step) => ({
    id: `P${step.n}`,
    text: `Step ${step.n}: expected screen`,
    check: predicates(step),
  }))
}
function predicates(step: TaughtStep): Predicate[] {
  return [
    {
      ocr: {
        ...(step.expect.appears ? { appears: step.expect.appears } : {}),
        ...(step.expect.disappears ? { disappears: step.expect.disappears } : {}),
      },
    },
  ]
}
export function taughtConsequential(
  steps: readonly TaughtStep[],
  labels: unknown,
): labels is string[] {
  return (
    Array.isArray(labels) &&
    labels.every(
      (label) =>
        typeof label === 'string' &&
        !!normalizeLabel(label) &&
        steps.some(
          (step) =>
            step.consequential && normalizeLabel(step.target.label) === normalizeLabel(label),
        ),
    )
  )
}

function actionKind(action: TaughtStep['action']) {
  return action === 'upload' || action === 'select' ? ('click' as const) : action
}
export async function startPractice(
  host: ExtensionHost,
  conversation: number,
  call: string,
  args: {
    skill: string
    scope?: 'project' | 'personal'
    params?: Record<string, string>
    consequential?: string[]
  },
  signal = new AbortController().signal,
) {
  if (runtime(host).busy) return result({ status: 'busy' })
  runtime(host).busy = true
  try {
    const current = await readTeach(host, conversation)
    if (teaching(current)) return result({ status: 'teaching' })
    if (current.segment?.source && current.segment.status === 'review')
      return result({
        status: 'review_required',
        message: 'Review and save the reopened lesson first.',
      })
    if (args.scope === undefined)
      return result({
        status: 'scope_required',
        scopes: await skillScopes(host, args.skill),
        message: 'Choose project or personal explicitly; never guess or fall back.',
      })
    const scope = args.scope
    let saved: Awaited<ReturnType<typeof readProcedure>>
    try {
      saved = await readProcedure(host, args.skill, scope)
    } catch (error) {
      // File/schema errors fail closed without echoing potentially hostile procedure text.
      if (error instanceof ProjectUntrusted)
        return result({
          status: 'project_untrusted',
          message: 'Trust the project setup before loading project lessons.',
        })
      return result({
        status: 'resave_required',
        message: 'Re-save this reviewed lesson with teachSave before practice.',
      })
    }
    const { manifest, frames, steps, windows } = saved
    if (steps.some((s) => s.action === 'type_secret'))
      return result({
        status: 'unsupported_until_secrets',
        message: 'Secret typing is not available yet; never substitute literal typing.',
      })
    if (steps.some((s) => !(s.expect.appears?.length || s.expect.disappears?.length)))
      return result({
        status: 'expect_required',
        message: 'Reopen the lesson, add expected OCR labels and save again.',
      })
    if (steps.length > 100)
      return result({
        status: 'practice_budget',
        message: 'Practice supports at most 100 steps (a 200-step approval).',
      })
    const consequential = args.consequential ?? []
    if (!taughtConsequential(steps, consequential))
      return result({ status: 'consequential_not_taught' })
    if (!(await intentInConversation(host, conversation, manifest.title)))
      return result({
        status: 'intent_required',
        message: 'Ask the user to request this skill title verbatim before practicing.',
      })
    const params = args.params ?? {}
    if (
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      Object.values(params).some((value) => typeof value !== 'string')
    )
      return result({ status: 'invalid_arguments' })
    for (const name of new Set(steps.flatMap((s) => (s.value ? [s.value.param] : [])))) {
      if (typeof params[name] !== 'string' || !params[name].trim())
        return result({ status: 'param_required', param: name })
    }
    for (const [name, value] of Object.entries(params)) {
      if (!(await intentInConversation(host, conversation, value, true)))
        return result({
          status: 'param_provenance',
          param: name,
          message: 'Parameter values must come from the user or operator brief.',
        })
    }
    const config = await settings(host)
    const actions = [...new Set(steps.map((s) => actionKind(s.action)))].filter(
      (kind) => kind !== 'type_secret',
    )
    // The run approval covers one app: with several windows of it there is no single window to bind.
    const sameApp = windows.filter(
      (w) => w.app === manifest.app.name && w.bundle === manifest.app.bundle,
    )
    const spec = {
      id: `practice-${randomUUID()}`,
      intent: manifest.title,
      goal: manifest.title,
      criteria: practiceCriteria(steps),
      scope: { apps: [...new Set(windows.map((w) => w.app))], actions, params, consequential },
      approval: {
        app: manifest.app.bundle || manifest.app.name,
        appName: manifest.app.name,
        ...(sameApp.length > 1
          ? {}
          : { window: manifest.window.titleSubstring || manifest.window.id }),
        pixel: true as const,
        actions,
        steps: steps.length * 2,
        minutes: 15,
        foreground: config.pixel?.foregroundForDegraded !== 'background',
      },
    }
    const started = await taskTool(host, conversation, call, { action: 'start', spec }, signal, {
      appName: manifest.app.name,
    })
    if ((await readSession(host, conversation)).task?.spec.id !== spec.id) return started
    await updateTeach(host, conversation, (doc) => {
      doc.practice = {
        task: spec.id,
        skill: args.skill,
        scope,
        status: 'ready',
        title: manifest.title,
        app: manifest.app.name,
        bundle: manifest.app.bundle,
        window: manifest.window,
        windows,
        frames,
        steps,
        checks: [],
      }
      doc.mismatches = []
    })
    await updateSession(host, conversation, (doc) => {
      if (doc.task?.spec.id !== spec.id) throw new Error('Practice task changed')
      doc.task.practiceRun = spec.id
    })
    const redact = redactor(Object.values(params))
    return {
      ...result(
        JSON.parse(
          JSON.stringify(
            {
              status: 'awaiting_confirmation',
              spec: {
                ...spec,
                scope: {
                  ...spec.scope,
                  params: Object.fromEntries(Object.keys(params).map((key) => [key, '[param]'])),
                },
              },
              plan: steps.map((s) => ({
                ...s,
                action: actionKind(s.action),
                evidence: frames[s.frame],
              })),
            },
            function (this: unknown, key, value: unknown) {
              // Redact payload strings, not protocol numbers, action kinds, parameter names or server refs.
              return typeof value === 'string' &&
                value !== '[param]' &&
                this !== actions &&
                this !== spec.scope.apps &&
                !['status', 'id', 'app', 'action', 'param', 'frame', 'file'].includes(key)
                ? redact(value)
                : value
            },
          ),
        ),
      ),
      details: json({ teach: teachDetails(await readTeach(host, conversation)) }),
    }
  } finally {
    runtime(host).busy = false
  }
}

type Bounds = Region['bounds']
const gap = (a: Bounds, b: Bounds) =>
  Math.hypot(
    Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0),
    Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0),
  )
function inside(bounds: Bounds, region: number[]) {
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2
  return x >= region[0] && x <= region[2] && y >= region[1] && y <= region[3]
}
export function beforePractice(
  step: TaughtStep,
  regions: Region[],
  fresh: { width: number; height: number },
  taught: FrameRef,
  minConfidence: number,
) {
  const target = matchLabel(regions, step.target.label, undefined, 0, minConfidence)
  if (!target.match) return false
  const region = step.target.region?.map(
    (value, i) => value * (i % 2 ? fresh.height / taught.height : fresh.width / taught.width),
  )
  if (region && !inside(target.match.bounds, region)) return false
  const radius = Math.max(80, Math.max(fresh.width, fresh.height) * 0.25)
  return step.target.anchors.every((label) =>
    regions.some(
      (anchor) =>
        anchor.kind === 'text' &&
        anchor.confidence >= minConfidence &&
        containsLabel(anchor.label, label) &&
        (region
          ? inside(anchor.bounds, region)
          : gap(target.match!.bounds, anchor.bounds) <= radius),
    ),
  )
}
/** Capture lesson window `index`, found by its title fragment, after checking its owner's identity and consent. */
async function checkedCapture(
  host: ExtensionHost,
  conversation: number,
  practice: TeachPractice,
  index: number,
  driver: Driver,
  signal: AbortSignal,
) {
  const session = await readSession(host, conversation)
  const window =
    practice.windows?.[index] ??
    (index
      ? undefined
      : {
          app: practice.app,
          bundle: practice.bundle,
          titleSubstring: practice.window.titleSubstring,
        })
  if (!window) throw new Error('Practice window is missing from the lesson')
  // Only the first window falls back to its saved id; an untitled other window must be its app's only one.
  const target = await windowFor(
    driver,
    window.app,
    window.titleSubstring || (index ? undefined : practice.window.id),
    signal,
  )
  const identity = await identityForPid(driver, target.pid, signal)
  if (
    !identity ||
    !matchesApp(identity, window.app) ||
    (window.bundle && identity.bundle !== window.bundle) ||
    readConsent(identity, await allGrants(host, conversation, session)) !== 'granted'
  )
    throw new Error('Practice app consent or identity changed')
  const observation = await captureWindow(driver, target, window.app, 1568, signal)
  requireVisible({ ...observation, degraded: true })
  if (!observation.capture || !observation.image) throw new Error('Practice requires a screenshot')
  const parsed = await parseRegions(
    driver,
    observation.capture.id,
    { kinds: ['text', 'icon'] },
    signal,
  )
  return { observation, regions: parsed.regions }
}
async function performCheck(
  host: ExtensionHost,
  conversation: number,
  driver: Driver,
  practice: TeachPractice,
  n: number,
  phase: 'before' | 'after',
  signal: AbortSignal,
  append: boolean,
) {
  const session = await readSession(host, conversation)
  const refusal = task.requireActiveTask(session.task)
  if (refusal) return { passed: false, status: refusal.refuse }
  if (session.task!.spec.id !== practice.task || session.task!.practiceRun !== practice.task)
    return { passed: false, status: 'practice_task_changed' }
  const step = practice.steps.find((s) => s.n === n)
  if (!step) return { passed: false, status: 'invalid_step' }
  const time = runtime(host).clock ?? clock
  const config = await settings(host)
  const minimum = config.pixel?.minConfidence ?? 0.5
  const redact = redactor(Object.values(session.task!.spec.scope.params))
  const deadline = time.now() + (phase === 'after' ? (step.expect.timeoutSeconds ?? 10) * 1000 : 0)
  let latest: { observation: Observation; regions: Region[] }
  let passed: boolean
  do {
    if (signal.aborted || (await isStopped(host, conversation)))
      return { passed: false, status: 'stopped' }
    latest = await checkedCapture(
      host,
      conversation,
      practice,
      practice.frames[step.frame]?.window ?? 0,
      driver,
      signal,
    )
    const { observation, regions } = latest
    passed =
      phase === 'before'
        ? beforePractice(step, regions, observation.capture!, practice.frames[step.frame], minimum)
        : (step.expect.appears ?? []).every((label) =>
            regions.some(
              (r) => r.kind === 'text' && r.confidence >= minimum && containsLabel(r.label, label),
            ),
          ) &&
          (step.expect.disappears ?? []).every(
            (label) => !regions.some((r) => r.kind === 'text' && presentLabel(r.label, label)),
          )
    if (passed || time.now() >= deadline) break
    await time.sleep(Math.min(500, deadline - time.now()), signal)
  } while (!signal.aborted)
  if (signal.aborted || (await isStopped(host, conversation)))
    return { passed: false, status: 'stopped' }
  const at = time.now()
  const { observation, regions } = latest!
  const safe = teachingOcr(regions, redact)
  const fresh: FrameMeta = {
    id: randomUUID(),
    at,
    width: observation.capture!.width,
    height: observation.capture!.height,
    ocr: safe.ocr,
    diff: { appeared: [], disappeared: [] },
    inferred: `Practice step ${n} ${phase}: ${passed! ? 'matched' : 'mismatch'}.`,
  }
  if (!safe.password && observation.image?.mimeType === 'image/png')
    fresh.file = await saveEvidence(
      host.home,
      conversation,
      Buffer.from(observation.image.data, 'base64'),
    )
  if (passed!) {
    await updateTeach(host, conversation, (doc) => {
      if (doc.practice?.task !== practice.task || doc.practice.status === 'mismatch') return
      const check = {
        step: n,
        phase,
        at,
        predicates:
          phase === 'after'
            ? predicates(step)
            : [{ ocr: { appears: [step.target.label, ...step.target.anchors] } }],
        capture: observation.capture!.id,
        ref: `practice:${fresh.id}`,
        frame: {
          id: fresh.id,
          width: fresh.width,
          height: fresh.height,
          ...(fresh.file ? { file: fresh.file } : {}),
        },
      }
      if (append) doc.practice.checks.push(check)
      else doc.practice.final = check
    })
    return { passed: true, status: 'satisfied' }
  }
  const expected =
    phase === 'before'
      ? [step.target.label, ...step.target.anchors]
      : [
          ...(step.expect.appears ?? []).map((label) => `Appears: ${label}`),
          ...(step.expect.disappears ?? []).map((label) => `Disappears: ${label}`),
        ]
  const target = matchLabel(regions, step.target.label, undefined, 0, minimum).match
  const centre = target?.bounds ?? { x: fresh.width / 2, y: fresh.height / 2, width: 0, height: 0 }
  const seen = safe.ocr
    .toSorted((a, b) => gap(a.bounds, centre) - gap(b.bounds, centre))
    .slice(0, 20)
    .map((r) => r.text)
  await updateTeach(host, conversation, (doc) => {
    if (doc.practice?.task !== practice.task) return
    doc.practice.status = 'mismatch'
    doc.mismatches ??= []
    doc.mismatches.push({
      step: n,
      phase,
      at,
      expected: expected.map(redact),
      seen,
      taught: practice.frames[step.frame],
      fresh,
    })
  })
  await updateSession(host, conversation, (doc) => {
    if (doc.task?.spec.id === practice.task) {
      doc.task.practiceMismatch = true
      doc.task.runTakeover = false
    }
  })
  return { passed: false, status: 'mismatch' }
}
export async function checkPractice(
  host: ExtensionHost,
  conversation: number,
  n: number,
  phase: 'before' | 'after',
  signal = new AbortController().signal,
) {
  if (runtime(host).busy) return result({ status: 'busy' })
  runtime(host).busy = true
  try {
    const doc = await readTeach(host, conversation)
    if (teaching(doc)) return result({ status: 'teaching' })
    if (!doc.practice) return result({ status: 'no_practice' })
    if (doc.practice.status === 'mismatch') return result({ status: 'practice_mismatch' })
    return await setup(host, conversation, async (driver) => {
      const checked = await performCheck(
        host,
        conversation,
        driver,
        doc.practice!,
        n,
        phase,
        signal,
        true,
      )
      return {
        ...result(checked),
        details: json({ teach: teachDetails(await readTeach(host, conversation)) }),
      }
    })
  } finally {
    runtime(host).busy = false
  }
}
export async function finalPracticeCheck(
  host: ExtensionHost,
  conversation: number,
  driver: Driver,
  practice: TeachPractice,
  signal: AbortSignal,
) {
  const checked = await performCheck(
    host,
    conversation,
    driver,
    practice,
    practice.steps.length,
    'after',
    signal,
    false,
  )
  return checked.passed ? ('satisfied' as const) : ('unsatisfied' as const)
}
export async function reopenTeaching(
  host: ExtensionHost,
  args: { conversation: number; scope: 'project' | 'personal'; name: string },
) {
  const state = runtime(host)
  if (state.busy || state.active.size) throw new Error('Computer use is busy')
  state.busy = true
  try {
    const teachingDoc = await readTeach(host, args.conversation)
    if (teaching(teachingDoc)) throw new Error('Stop teaching before reopening a lesson')
    if (['drafting', 'review'].includes(teachingDoc.segment?.status ?? ''))
      throw new Error('Save or reject the current draft before reopening.')
    const current = (await readSession(host, args.conversation)).task
    if (
      current?.practiceRun &&
      ['active', 'awaiting_confirmation', 'stopped', 'paused_by_user'].includes(current.status)
    )
      throw new Error('Finish the practice partial or blocked before reopening')
    const { manifest, frames, steps, windows } = await readProcedure(host, args.name, args.scope)
    const at = Date.now()
    await updateTeach(host, args.conversation, (doc) => {
      if (teaching(doc) || state.active.size)
        throw new Error('Computer use changed while reopening')
      if (['drafting', 'review'].includes(doc.segment?.status ?? ''))
        throw new Error('Save or reject the current draft before reopening.')
      if (doc.segment) protectTeachReview(host.home, args.conversation, doc.segment.id, false)
      doc.segment = {
        id: randomUUID(),
        app: manifest.app.name,
        bundle: manifest.app.bundle,
        window: manifest.window.id,
        windowTitle: manifest.window.titleSubstring,
        // A review never records: only the first window keeps a saved id, the others are found by title.
        windows: windows.map((w, i) => ({
          app: w.app,
          ...(w.bundle ? { bundle: w.bundle } : {}),
          window: i ? 0 : manifest.window.id,
          windowTitle: w.titleSubstring,
        })),
        title: manifest.title,
        startedAt: at,
        endsAt: at,
        status: 'review',
        source: { scope: args.scope, name: args.name, hash: manifest.sha256 },
        frames: Object.values(frames).map((frame) => ({
          ...frame,
          at: manifest.savedAt,
          ocr: [],
          diff: { appeared: [], disappeared: [] },
          inferred: 'Saved lesson evidence.',
        })),
        narration: [],
        dropped: [],
      }
      doc.steps = steps.map((step) => {
        const copy = structuredClone(step)
        delete copy.approved
        return copy
      })
    })
    return await readTeach(host, args.conversation)
  } finally {
    state.busy = false
  }
}
export async function validateSavedReview(
  host: ExtensionHost,
  segment: NonNullable<Teach['segment']>,
) {
  if (!segment.source) return
  const { manifest, frames } = await readProcedure(host, segment.source.name, segment.source.scope)
  if (
    manifest.sha256 !== segment.source.hash ||
    segment.frames.some((frame) => frame.file && frame.file !== frames[frame.id]?.file)
  )
    throw new Error('Saved lesson changed; reopen it before reading or saving')
}
