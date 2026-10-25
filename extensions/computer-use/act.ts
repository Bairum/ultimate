import { windowSchema, predicates, prepare } from './schemas.ts'
import { settings, runtime, driverFor, setup, cacheKey } from './runtime.ts'
import { json, result, anchored, plainTask, changeTask } from './tool-helpers.ts'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ClassifyApi } from '../classify/api.ts'
import { stepTarget } from './policy.ts'
import { redactor } from './content.ts'
import { path } from './parse-observation.ts'
import { ObservationUnavailable } from './tool-helpers.ts'
import { runGoal } from './jev.ts'
import type { Candidate } from './jev.ts'
import type {
  Driver,
  Element,
  Goal,
  Observation,
  Predicate,
  Step,
  StepOutcome,
  Verdict,
} from './types.ts'
import type { ActStepDetails } from './refs.ts'
import { readSession, updateSession, isStopped, hasConfirmation } from './session.ts'
import type { Active } from './runtime.ts'
import { observeWindow, observedOutput } from './observe.ts'
import {
  outline,
  actionHash,
  matchesApp,
  canonicalConsent,
  consumeCanonical,
  gates,
  allGrants,
  preflightGates,
  conversationBudgetGate,
  frontmostGate,
  resolveIdentity,
  listApps,
  confirmRefusal,
} from './gates.ts'
import type { GateContext, Refusal } from './gates.ts'
import * as task from './task.ts'
import { pixelDefaults, screenStable } from './perception.ts'
import { verifyOcr, ocrEvidence } from './verify-ocr.ts'
import { waitFor } from './wait.ts'
import { pruneEvidence } from './evidence-files.ts'

export function candidateStep(candidate: Candidate): Step {
  return candidate.action === 'set_value'
    ? { kind: 'set_value', element: candidate.element.token, value: candidate.value! }
    : { kind: 'click', element: candidate.element.token }
}
export type ActArgs = {
  app: string
  window?: string | number
  actions?: Step[]
  goal?: Goal
  expect?: Predicate[] | { ocr: { appears?: string[]; disappears?: string[] } }
  foreground?: boolean
  criterion?: string
  subgoal?: string
}
export async function pending(
  host: ExtensionHost,
  conversation: number,
  app: string,
  refusal: Refusal,
  step?: number,
) {
  if (!['consent_required', 'confirm_required'].includes(refusal.refuse)) return
  await updateSession(host, conversation, (session) => {
    if (!session.pending.some((p) => p.app === app && p.key === refusal.key))
      session.pending.push({
        kind: refusal.refuse === 'consent_required' ? 'consent' : 'confirm',
        app,
        ...(refusal.key && session.task ? { task: session.task.spec.id } : {}),
        ...(step === undefined ? {} : { step }),
        ...(refusal.key ? { key: refusal.key } : {}),
        ...(refusal.payload === undefined ? {} : { payload: refusal.payload }),
        ...(refusal.x === undefined || refusal.y === undefined
          ? {}
          : { x: refusal.x, y: refusal.y }),
        ...(refusal.window !== undefined
          ? { window: refusal.window, label: refusal.label ?? '' }
          : {}),
        at: Date.now(),
      })
  })
}
export function dispatch(
  step: Step,
  observation: Observation,
  foreground: boolean,
): { tool: string; args: Record<string, JsonValue> } | undefined {
  const base = { pid: observation.pid, window_id: observation.windowId }
  const mode = { delivery_mode: foreground ? 'foreground' : 'background' }
  if (step.kind === 'wait') return undefined // Driver 0.37.0 has no wait tool; never fabricate a dispatch.
  if (step.kind === 'menu') return { tool: 'invoke_menu', args: { ...base, path: step.path } }
  if (step.kind === 'key')
    return {
      tool: 'press_key',
      args: { ...base, ...mode, key: step.key, modifiers: step.modifiers ?? [] },
    }
  const element: Record<string, JsonValue> =
    'element' in step && step.element ? { element_token: step.element } : {}
  const pixels: Record<string, JsonValue> =
    'x' in step && step.x !== undefined ? { x: step.x, y: step.y!, capture_id: step.capture! } : {}
  if (step.kind === 'type')
    return { tool: 'type_text', args: { ...base, ...mode, ...element, text: step.text } }
  if (step.kind === 'set_value')
    return { tool: 'set_value', args: { ...base, ...element, value: step.value } }
  if (step.kind === 'scroll')
    return {
      tool: 'scroll',
      args: { ...base, ...mode, ...element, direction: step.direction, amount: step.amount ?? 3 },
    }
  // click supports capture-bound pixels; double/right use the same click tool's count/button.
  return {
    tool: 'click',
    args: {
      ...base,
      ...mode,
      ...element,
      button: step.kind === 'right_click' ? 'right' : 'left',
      count: step.kind === 'double_click' ? 2 : 1,
      ...pixels,
    },
  }
}
export async function act(
  host: ExtensionHost,
  driver: Driver,
  conversation: number,
  call: string,
  args: ActArgs,
  signal: AbortSignal,
  progress: (text: string) => void = () => {},
) {
  if ((args.actions === undefined) === (args.goal === undefined))
    return result({
      status: 'invalid_arguments',
      message: 'Provide exactly one of actions or goal.',
    })
  const runtimeState = runtime(host)
  if (runtimeState.busy)
    return result({
      status: 'busy',
      message: 'Another computer call is active; observe again when it finishes.',
    })
  const abort = new AbortController()
  signal = AbortSignal.any([signal, abort.signal])
  const active: Active = { stopped: false, inFlight: false, abort }
  runtimeState.busy = true
  runtimeState.active.set(conversation, active)
  try {
    await pruneEvidence(host.home)
    let session = await readSession(host, conversation)
    const taskRefusal = task.requireActiveTask(session.task)
    if (taskRefusal) return result({ status: taskRefusal.refuse, message: taskRefusal.message })
    const subgoal = args.subgoal ?? session.task!.subgoals.find((s) => s.status === 'active')?.id
    if (!session.task!.subgoals.some((s) => s.id === subgoal && s.status === 'active'))
      return result({ status: 'subgoal_required', message: 'Activate one subgoal before acting.' })
    if (
      session.journal.some(
        (j) => j.status === 'sending' || (j.status === 'unknown' && j.at > session.lastObservedAt),
      )
    ) {
      await changeTask(host, conversation, (state) =>
        task.markInterrupted(state, 'crash', [], Date.now()),
      )
      return result({ status: 'observe_first', journal: session.journal.slice(-20) })
    }
    const values = [
      ...Object.values(args.goal?.params ?? {}),
      ...Object.values(session.task!.spec.scope.params),
      ...(args.actions ?? []).flatMap((s) =>
        s.kind === 'type' ? [s.text] : s.kind === 'set_value' ? [s.value] : [],
      ),
    ].filter(Boolean)
    const redact = redactor(values)
    const needsPixels =
      runtimeState.observations.get(cacheKey(conversation, args.app))?.degraded ||
      args.actions?.some((s) => ('x' in s && s.x !== undefined) || s.kind === 'wait') ||
      (Array.isArray(args.expect) ? args.expect.some((p) => p.ocr) : args.expect?.ocr)
    const config = { ...pixelDefaults, ...(needsPixels ? (await settings(host)).pixel : {}) }
    const expectations: Predicate[] = Array.isArray(args.expect)
      ? args.expect
      : args.expect
        ? [args.expect]
        : []
    const uiSteps: ActStepDetails[] = []
    const describe = (action: Step, outcome: StepOutcome, target?: Element) => {
      uiSteps.push({
        kind: action.kind,
        status: outcome.status,
        ...('expect_label' in action && action.expect_label
          ? { expectLabel: { text: redact(action.expect_label), untrusted: true as const } }
          : {}),
        ...((outcome.status === 'delivered' || outcome.status === 'refused') && outcome.ocrMatch
          ? { ocrMatch: { text: redact(outcome.ocrMatch), untrusted: true as const } }
          : {}),
        ...(outcome.status === 'refused' && outcome.nearest
          ? {
              nearest: outcome.nearest.map((text) => ({
                text: redact(text),
                untrusted: true as const,
              })),
            }
          : {}),
        ...(outcome.status === 'delivered' && outcome.wait
          ? {
              wait: {
                status: outcome.wait.status,
                ms: outcome.wait.ms,
                seen: outcome.wait.seen.map((text) => ({
                  text: redact(text),
                  untrusted: true as const,
                })),
              },
            }
          : {}),
        ...(outcome.status === 'refused'
          ? { code: redact(outcome.code), message: redact(outcome.message) }
          : {}),
        ...(outcome.status === 'failed' ? { message: redact(outcome.message) } : {}),
        ...(target
          ? {
              role: { text: redact(target.role), untrusted: true },
              label: { text: redact(target.label ?? ''), untrusted: true },
            }
          : {}),
      })
    }
    let count = 0
    let observation = runtimeState.observations.get(cacheKey(conversation, args.app))
    const initialObservation = observation
    // Do not contact the Driver (including reads) until stopped and consent gates passed.
    const initial: GateContext = {
      session,
      conversation,
      grants: await allGrants(host, conversation, session),
      params: values,
      app: args.app,
      step: args.actions?.[0] ?? { kind: 'click' },
      target: observation
        ? stepTarget(args.actions?.[0] ?? { kind: 'click' }, observation)
        : undefined,
      stepKinds: args.goal ? ['click', 'set_value'] : undefined,
      observation,
      foreground: args.foreground ?? false,
      active,
      count,
      signal,
      host,
      driver,
    }
    for (const gate of preflightGates) {
      const refusal = await gate(initial)
      if (refusal) {
        await pending(host, conversation, args.app, refusal)
        return result({ status: refusal.refuse, message: refusal.message })
      }
    }
    if (
      !args.goal &&
      (!observation ||
        (args.window !== undefined &&
          args.window !== observation.windowId &&
          !observation.title.includes(String(args.window))))
    ) {
      await changeTask(host, conversation, (current) =>
        task.markInterrupted(current, 'crash', [], Date.now()),
      )
      return result({
        status: 'observe_first',
        message: 'Observe and select a window before acting.',
      })
    }
    const capture = (maxDimension: number) =>
      observeWindow(
        driver,
        args.app,
        args.window ?? observation?.windowId,
        'always',
        undefined,
        maxDimension,
        signal,
      )
    const observe = async () => {
      const latest = await readSession(host, conversation)
      const identity = await resolveIdentity(driver, args.app, signal)
      if (!identity)
        throw new ObservationUnavailable('app_identity', 'Could not resolve the app identity.')
      const consent = canonicalConsent(identity, await allGrants(host, conversation, latest))
      if (await isStopped(host, conversation, { session: latest, active, signal }))
        throw new ObservationUnavailable('stopped', 'Computer use is stopped.')
      if (args.goal && consent !== 'granted')
        throw new ObservationUnavailable(
          consent === 'denied' ? 'denied' : 'consent_required',
          'Canonical app consent is required before reading for Jev.',
        )
      observation = await observeWindow(
        driver,
        args.app,
        args.window ?? observation?.windowId,
        observation?.degraded ? 'always' : 'never',
        undefined,
        1568,
        signal,
      )
      runtimeState.observations.set(cacheKey(conversation, args.app), observation)
      runtimeState.zoomed.delete(cacheKey(conversation, args.app))
      await changeTask(host, conversation, (current) => {
        const observed = task.recordObserve(current)
        if (current.status !== 'active') observed.needsObserve = current.needsObserve
        return observed
      })
      return observation
    }
    let linkedProgress = false
    let lastVerdict: Verdict = 'unknown'
    const verify = async (preds: Predicate[]): Promise<Verdict> => {
      linkedProgress = false
      if (!preds.length || !observation) return 'unknown'
      if (await isStopped(host, conversation, { active, signal })) return 'unknown'
      if (preds.some((p) => p.ocr)) {
        const checked = await verifyOcr(driver, observation, preds, config, signal, redact)
        if (checked.verdict !== 'satisfied') return checked.verdict
        const evidence = await ocrEvidence(
          host.home,
          conversation,
          observation,
          preds,
          call,
          checked.excerpt,
          args.criterion,
        )
        await changeTask(host, conversation, (state) => {
          linkedProgress = task.predicateEvidence(state, evidence)
          return task.addEvidence(state, subgoal!, evidence)
        })
        return 'satisfied'
      }
      const checked = await driver.call(
        'verify_state',
        {
          pid: observation.pid,
          window_id: observation.windowId,
          expect: preds,
          timeout_ms: 0,
        },
        signal,
      )
      const verdict = checked.structured?.verdict ?? checked.structured?.status
      const verified =
        checked.ok && (verdict === 'satisfied' || verdict === 'unsatisfied') ? verdict : 'unknown'
      if (verified === 'satisfied')
        await changeTask(host, conversation, (state) => {
          const evidence: task.Evidence = {
            kind: 'verify',
            predicates: preds,
            verdict: verified,
            ref: call,
            app: observation!.app,
            ...(args.criterion ? { criterion: args.criterion } : {}),
          }
          linkedProgress = task.predicateEvidence(state, evidence)
          return task.addEvidence(state, subgoal!, evidence)
        })
      return verified
    }
    let pendingStep: { actionHash: string; delivered: boolean; subgoal: string } | undefined
    const recordPending = async (verifiedProgress: boolean) => {
      if (!pendingStep) return
      const recorded = pendingStep
      pendingStep = undefined
      await changeTask(host, conversation, (state) =>
        task.recordStep(state, {
          ...recorded,
          verifiedProgress,
          outlineFingerprint: outline(observation),
        }),
      )
    }
    const step = async (original: Step): Promise<StepOutcome> => {
      let remapped = false
      // A batch's later tokens were valid at entry. Remap them by a unique role/label path
      // after our own post-step reads; never extend this to tokens from earlier calls.
      if (
        'element' in original &&
        original.element &&
        initialObservation &&
        observation &&
        !observation.elements.some(
          (e) => e.token === ('element' in original ? original.element : undefined),
        )
      ) {
        const prior = initialObservation.elements.find(
          (e) => e.token === ('element' in original ? original.element : undefined),
        )
        const matches = prior
          ? observation.elements.filter(
              (e) => path(e, observation!) === path(prior, initialObservation),
            )
          : []
        if (matches.length === 1) {
          original = { ...original, element: matches[0].token }
          remapped = true
        }
      }
      let next = original
      const before = observation!
      if (
        'x' in original &&
        original.x !== undefined &&
        runtimeState.zoomed.has(cacheKey(conversation, args.app))
      )
        return {
          status: 'refused',
          code: 'zoom_read_only',
          message: 'Zoom images are read-only. Observe a full capture before pixel actions.',
        }
      if (
        ['click', 'double_click', 'right_click'].includes(original.kind) &&
        !('element' in original && original.element) &&
        !(
          'x' in original &&
          original.x !== undefined &&
          original.y !== undefined &&
          original.capture
        )
      )
        return {
          status: 'refused',
          code: 'invalid_arguments',
          message: 'Clicks require an element token or capture-bound x/y.',
        }
      const target = stepTarget(original, before)
      if ('element' in original && original.element && !target)
        return {
          status: 'refused',
          code: 'stale',
          message: 'Element is not in the latest observation.',
        }
      if (
        'x' in original &&
        original.x !== undefined &&
        (!original.capture || original.capture !== before.capture?.id)
      )
        return { status: 'refused', code: 'stale', message: 'Pixels need the latest capture id.' }
      if (original.kind === 'wait') {
        if (
          !original.until ||
          !Object.values(original.until).some(Boolean) ||
          !Number.isFinite(original.seconds) ||
          original.seconds < 0 ||
          original.seconds > Math.min(120, config.maxWaitSeconds)
        )
          return {
            status: 'refused',
            code: 'invalid_arguments',
            message:
              'Wait requires until and a timeout within the configured limit (at most 120 seconds).',
          }
        session = await readSession(host, conversation)
        const ctx: GateContext = {
          ...initial,
          session,
          grants: await allGrants(host, conversation, session),
          step: original,
          dispatch: true,
          observation,
          count,
        }
        for (const gate of [...preflightGates, conversationBudgetGate]) {
          const refusal = await gate(ctx)
          if (refusal) return { status: 'refused', code: refusal.refuse, message: refusal.message }
        }
        const waited = await waitFor({
          driver,
          capture: async (size) => {
            observation = await capture(size)
            runtimeState.observations.set(cacheKey(conversation, args.app), observation)
            return observation
          },
          until: original.until,
          seconds: original.seconds,
          signal,
          stopped: () => isStopped(host, conversation, { active, signal }),
          time: runtimeState.clock,
          minConfidence: config.minConfidence,
          redact,
        })
        if (waited.status === 'delivered') {
          const index = count++
          await updateSession(host, conversation, (doc) => {
            doc.budget.startedAt ||= Date.now()
            doc.budget.steps++
            doc.journal.push({
              call,
              step: index,
              kind: 'wait',
              app: args.app,
              status: 'delivered',
              at: Date.now(),
            })
          })
          await changeTask(host, conversation, (state) =>
            task.recordStep(state, {
              actionHash: actionHash(original),
              delivered: true,
              verifiedProgress: false,
              subgoal: subgoal!,
              outlineFingerprint: outline(observation),
            }),
          )
        }
        return waited
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        session = await readSession(host, conversation)
        const ctx: GateContext = {
          ...initial,
          session,
          grants: await allGrants(host, conversation, session),
          step: next,
          target: stepTarget(next, observation!),
          dispatch: true,
          observation,
          count,
        }
        for (const gate of gates) {
          const refusal = await gate(ctx)
          if (refusal) {
            await pending(host, conversation, ctx.app, refusal, count)
            return {
              status: 'refused',
              code: refusal.refuse,
              message: refusal.message,
              ...(ctx.ocrMatch ? { ocrMatch: redact(ctx.ocrMatch) } : {}),
              ...(refusal.nearest ? { nearest: refusal.nearest.map(redact) } : {}),
            }
          }
        }
        if (active.stopped || signal.aborted) return { status: 'not_run' }
        const command = dispatch(next, observation!, args.foreground ?? false)
        if (!command)
          return {
            status: 'refused',
            code: 'invalid_arguments',
            message: 'This step has no Driver dispatch.',
          }
        const index = count++
        await updateSession(host, conversation, (doc) => {
          doc.budget.startedAt ||= Date.now()
          doc.budget.steps++
          doc.journal.push({
            call,
            step: index,
            kind: next.kind,
            app: ctx.app,
            ...(ctx.target ? { role: ctx.target.role, label: redact(ctx.target.label ?? '') } : {}),
            ...('text' in next
              ? { length: next.text.length }
              : 'value' in next
                ? { length: next.value.length }
                : {}),
            status: 'sending',
            at: Math.max(Date.now(), doc.lastObservedAt + 1),
          })
        })
        progress(`Step ${index + 1}: ${next.kind} sending\n`)
        let outcome: StepOutcome
        ctx.session = await readSession(host, conversation)
        const focusRefusal = await frontmostGate(ctx)
        const latest = await readSession(host, conversation)
        const stillConsented =
          canonicalConsent(ctx.identity!, await allGrants(host, conversation, latest)) === 'granted'
        const takeover =
          args.foreground && latest.takeovers.some((t) => matchesApp(ctx.identity!, t.app))
        const stillTakenOver = !focusRefusal && ((!ctx.frontmost && !args.foreground) || takeover)
        const stopped = await isStopped(host, conversation, { session: latest, active, signal })
        if (stopped || !stillConsented || !stillTakenOver) {
          await updateSession(host, conversation, (doc) => {
            doc.journal.findLast((j) => j.call === call && j.step === index)!.status = 'refused'
          })
          return stopped
            ? { status: 'not_run' }
            : {
                status: 'refused',
                code: stillConsented ? 'user_active' : 'consent_required',
                message: stillConsented
                  ? 'Foreground takeover was revoked before dispatch.'
                  : 'Consent was revoked before dispatch.',
              }
        }
        if (ctx.confirmationUsed && !hasConfirmation(latest, ctx.confirmation!)) {
          const refusal = confirmRefusal(ctx.app, next, ctx.target, observation)
          await pending(host, conversation, ctx.app, refusal, count)
          await updateSession(host, conversation, (doc) => {
            doc.journal.findLast((j) => j.call === call && j.step === index)!.status = 'refused'
          })
          return {
            status: 'refused',
            code: refusal.refuse,
            message: refusal.message,
            ...(ctx.ocrMatch ? { ocrMatch: redact(ctx.ocrMatch) } : {}),
          }
        }
        await updateSession(host, conversation, (doc) => {
          doc.confirmed = doc.confirmed.filter((c) => c.key !== ctx.confirmation)
          doc.grants = consumeCanonical(ctx.identity!, doc.grants)
        })
        active.inFlight = true
        try {
          const reply = await driver.call(command.tool, command.args, signal)
          outcome = reply.ok
            ? {
                status: 'delivered',
                text: reply.text,
                ...(ctx.ocrMatch ? { ocrMatch: redact(ctx.ocrMatch) } : {}),
              }
            : reply.refusal
              ? { status: 'refused', code: reply.refusal.code, message: reply.refusal.message }
              : { status: 'failed', message: reply.text }
        } catch {
          // Once sent, a transport error cannot prove non-delivery; never automatically retry it.
          outcome = { status: 'unknown' }
          active.uncertain = signal.aborted
        } finally {
          active.inFlight = false
          if (!active.uncertain) clearTimeout(active.timer)
        }
        await updateSession(host, conversation, (doc) => {
          const entry = doc.journal.findLast(
            (j) => j.call === call && j.step === index && j.status === 'sending',
          )!
          entry.status = outcome.status
        })
        progress(`Step ${index + 1}: ${outcome.status}\n`)
        pendingStep = {
          actionHash: actionHash(next, ctx.target, observation),
          delivered: outcome.status === 'delivered',
          subgoal: subgoal!,
        }
        if (outcome.status === 'unknown')
          await changeTask(host, conversation, (state) =>
            task.markInterrupted(state, 'crash', [], Date.now()),
          )
        if (!args.goal || outcome.status !== 'delivered') {
          let verified = false
          let post: Observation | undefined
          try {
            if (
              outcome.status === 'delivered' &&
              (observation?.degraded ||
                ('x' in next && next.x !== undefined) ||
                expectations.some((p) => p.ocr))
            ) {
              if (observation?.degraded || ('x' in next && next.x !== undefined))
                await screenStable(capture, signal, config.settleMs, runtimeState.clock)
              observation = await capture(1568)
              runtimeState.observations.set(cacheKey(conversation, args.app), observation)
              post = observation
            }
            verified =
              outcome.status === 'delivered' &&
              (lastVerdict = await verify(expectations)) === 'satisfied' &&
              linkedProgress
            if (outcome.status === 'delivered' && !post) post = await observe()
          } catch (error) {
            await changeTask(host, conversation, (current) =>
              task.markInterrupted(current, 'crash', [], Date.now()),
            )
            throw error
          } finally {
            const recorded = pendingStep
            pendingStep = undefined
            await changeTask(host, conversation, (current) =>
              task.recordStep(current, {
                ...recorded,
                verifiedProgress: verified,
                outlineFingerprint: outline(post),
              }),
            )
          }
        }
        if (outcome.status === 'refused' && outcome.code === 'stale_element_token') {
          const fresh = await observe()
          const matches = target
            ? fresh.elements.filter((e) => path(e, fresh) === path(target, before))
            : []
          if (!remapped && attempt === 0 && matches.length === 1 && 'element' in next) {
            remapped = true
            next = { ...next, element: matches[0].token }
            continue
          }
          return {
            status: 'refused',
            code: 'stale',
            message: 'Stale token could not be remapped uniquely after one retry.',
          }
        }
        return outcome
      }
      return { status: 'refused', code: 'stale', message: 'Stale token retry exhausted.' }
    }
    if (args.goal) {
      const goalConfig = await settings(host)
      const decisions: Promise<void>[] = []
      let confirmationFailure: Refusal | undefined
      const outcome = await runGoal(args.goal, {
        app: args.app,
        observe,
        act: async (c) => {
          await Promise.all(decisions)
          const action = candidateStep(c)
          const delivered = await step(action)
          describe(action, delivered, { ...c.element, label: c.label })
          if (delivered.status === 'refused' && delivered.code === 'payload_too_large')
            confirmationFailure = { refuse: delivered.code, message: delivered.message }
          return delivered
        },
        verify,
        ask: host.want(ClassifyApi)
          ? (request, requestSignal) => host.want(ClassifyApi)!.ask(request, requestSignal)
          : undefined,
        allowed: (c) =>
          session.task!.spec.scope.actions.includes(candidateStep(c).kind) ? 'ok' : 'consequential',
        confirm: async (c) => {
          const next = candidateStep(c)
          const target = stepTarget(next, observation!)
          const app = observation!.app
          const refusal = confirmRefusal(app, next, target, observation)
          if (refusal.refuse === 'payload_too_large') {
            confirmationFailure = refusal
            return false
          }
          if (hasConfirmation(await readSession(host, conversation), refusal.key)) return true
          await pending(host, conversation, app, refusal, count)
          return false
        },
        stopped: () => active.stopped,
        signal,
        now: Date.now,
        // Apps update their accessibility tree a moment after an action; wait once before judging "no effect".
        settle: () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 400)
            signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
          }),
        thresholds: goalConfig.jev,
        record: (decision) => {
          const { chose, ...fields } = decision
          decisions.push(
            updateSession(host, conversation, (doc) => {
              doc.journal.push({
                call,
                step: decision.step,
                kind: 'jev',
                app: args.app,
                status: 'decision',
                at: Date.now(),
                decision: {
                  ...fields,
                  top: decision.top.map((t) => ({
                    ...t,
                    id: redact(t.id),
                    label: redact(t.label),
                  })),
                  ...(chose === undefined ? {} : { chose: redact(chose) }),
                },
              })
              if (decision.outcome === 'verified' && pendingStep) {
                doc.task = task.recordStep(plainTask(doc.task!), {
                  ...pendingStep,
                  verifiedProgress: linkedProgress,
                  outlineFingerprint: outline(observation),
                })
                pendingStep = undefined
              }
            }),
          )
        },
      }).catch(async (error: unknown) => {
        await Promise.all(decisions)
        await recordPending(false)
        await changeTask(host, conversation, (current) =>
          task.markInterrupted(current, 'crash', [], Date.now()),
        )
        throw error
      })
      await Promise.all(decisions)
      await recordPending(false)
      if (outcome.status === 'escalated')
        await changeTask(host, conversation, (state) =>
          task.recordEscalation(state, outcome.reason, Date.now()),
        )
      else
        await changeTask(host, conversation, (state) => {
          const completed = task.completeSubgoal(state, subgoal!, Date.now())
          return 'refuse' in completed ? state : completed
        })
      const visible = confirmationFailure
        ? {
            ...outcome,
            status: confirmationFailure.refuse,
            reason: confirmationFailure.refuse,
            detail: confirmationFailure.message,
          }
        : outcome
      const summary = result({
        ...visible,
        ...('observation' in outcome ? { observation: undefined } : {}),
      })
      const view = observation ? await observedOutput(observation) : undefined
      const uiDecisions = (await readSession(host, conversation)).journal.flatMap((j) =>
        j.call === call && j.decision
          ? [
              {
                ...j.decision,
                top: j.decision.top.map((top) => ({
                  ...top,
                  label: { text: top.label, untrusted: true as const },
                })),
              },
            ]
          : [],
      )
      return {
        ...summary,
        output: [...summary.output, ...(view?.output ?? [])],
        details: {
          task: null,
          act: {
            mode: 'goal',
            steps: uiSteps,
            decisions: uiDecisions,
            ...(outcome.status === 'done' ? { verdict: outcome.verdict } : {}),
            ...(confirmationFailure
              ? { escalationReason: confirmationFailure.refuse }
              : outcome.status === 'escalated'
                ? { escalationReason: outcome.reason }
                : {}),
          },
          ...(view?.details.observe
            ? {
                observe: {
                  ...view.details.observe,
                  ...(view.details.observe.imageIndex === undefined
                    ? {}
                    : { imageIndex: view.details.observe.imageIndex + summary.output.length }),
                },
              }
            : {}),
        },
        structuredOutput: json({
          ...visible,
          ...('observation' in outcome
            ? { observation: { ...outcome.observation, image: undefined } }
            : {}),
        }),
      }
    }
    const outcomes: StepOutcome[] = []
    let halted = false
    for (const action of args.actions!) {
      const target =
        stepTarget(action, observation!) ??
        (initialObservation ? stepTarget(action, initialObservation) : undefined)
      const outcome: StepOutcome =
        halted || active.stopped ? { status: 'not_run' } : await step(action)
      outcomes.push(outcome)
      describe(action, outcome, target)
      halted ||= outcome.status !== 'delivered' || outcome.wait?.status === 'timeout'
    }
    const hasOcr = expectations.some((p) => p.ocr)
    const verdict =
      hasOcr && !outcomes.some((o) => o.status === 'delivered')
        ? 'unknown'
        : hasOcr && outcomes.some((o) => o.status === 'delivered' && !o.wait)
          ? lastVerdict
          : await verify(expectations)
    const unknown = outcomes.some((o) => o.status === 'unknown')
    // An internal post-act read does not acknowledge an interrupted/unknown action for the planner.
    if (
      !unknown &&
      !outcomes.every((o) => o.status === 'delivered') &&
      !(await isStopped(host, conversation, { active, signal }))
    )
      await observe()
    const summary = {
      status: active.stopped
        ? 'stopped'
        : (outcomes.find((o) => o.status === 'refused')?.code ??
          (outcomes.every((o) => o.status === 'delivered')
            ? (outcomes.findLast((o) => o.status === 'delivered' && o.wait)?.wait?.status ??
              'delivered')
            : 'incomplete')),
      outcomes,
      verdict,
    }
    const view = await observedOutput(observation!)
    const rendered = result(summary)
    return {
      output: [...rendered.output, ...view.output],
      details: {
        task: null,
        act: { mode: 'explicit', steps: uiSteps, decisions: [], verdict },
        observe: {
          ...view.details.observe,
          ...(view.details.observe.imageIndex === undefined
            ? {}
            : { imageIndex: view.details.observe.imageIndex + rendered.output.length }),
        },
      },
      structuredOutput: json({ ...summary, observation: { ...observation, image: undefined } }),
    }
  } finally {
    if (!active.uncertain) clearTimeout(active.timer)
    runtimeState.active.delete(conversation)
    runtimeState.busy = false
    // Re-arm the idle timer after long-running calls as well as short ones.
    await driverFor(host).catch((error) => console.error('computer-use: idle timer failed:', error))
  }
}

export function actTool(host: ExtensionHost) {
  return defineTool({
    name: 'computer_act',
    structuredOutputSchema: Type.Any(),
    description:
      'Act one step at a time, explicitly or through a bounded Jev goal. Requires user consent; never replay unknown steps.',
    prepareArguments: (raw) => prepare(raw) as ActArgs,
    parameters: Type.Object({
      app: Type.String(),
      window: windowSchema,
      subgoal: Type.Optional(Type.String()),
      criterion: Type.Optional(Type.String()),
      actions: Type.Optional(Type.Array(stepSchema, { minItems: 1 })),
      goal: Type.Optional(
        Type.Object({
          text: Type.String(),
          params: Type.Optional(Type.Record(Type.String(), Type.String())),
          steps: Type.Optional(Type.Array(Type.String())),
          done_when: Type.Optional(predicates),
          budget: Type.Optional(
            Type.Object({
              steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
              seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 900 })),
            }),
          ),
        }),
      ),
      expect: Type.Optional(
        Type.Union([
          predicates,
          Type.Object({
            ocr: Type.Object({
              appears: Type.Optional(Type.Array(Type.String())),
              disappears: Type.Optional(Type.Array(Type.String())),
            }),
          }),
        ]),
      ),
      foreground: Type.Optional(Type.Boolean()),
    }),
    async execute(args, api, ctx) {
      const refusal = task.requireActiveTask((await readSession(host, api.conversationId)).task)
      if (refusal)
        return anchored(
          host,
          api.conversationId,
          result({ status: refusal.refuse, message: refusal.message }),
        )
      return setup(host, api.conversationId, (driver) =>
        act(
          host,
          driver,
          api.conversationId,
          api.callId,
          args,
          ctx.abortSignal ?? new AbortController().signal,
          (text) => api.output(text),
        ),
      )
    },
  })
}

export function appsTool(host: ExtensionHost) {
  return defineTool({
    name: 'computer_apps',
    // Reads are harmless to repeat; a durable call-id journal prevents any launch from being resent.
    replay: 'safe',
    structuredOutputSchema: Type.Any(),
    description:
      'List running native apps, or launch a consented app in the background. Listing is read-only; launches are not replayed.',
    prepareArguments: (raw) => prepare(raw) as { launch?: string },
    parameters: Type.Object({ launch: Type.Optional(Type.String()) }),
    async execute(args, api, ctx) {
      if (await isStopped(host, api.conversationId, { signal: ctx.abortSignal }))
        return result({ status: 'stopped' })
      if (args.launch) {
        if (
          (await readSession(host, api.conversationId)).journal.some((j) => j.call === api.callId)
        )
          return anchored(
            host,
            api.conversationId,
            result({
              status: 'observe_first',
              message: 'This launch was already sent; observe its outcome instead of repeating it.',
            }),
          )
        const current = (await readSession(host, api.conversationId)).task
        const refusal = task.requireActiveTask(current)
        if (refusal)
          return anchored(
            host,
            api.conversationId,
            result({ status: refusal.refuse, message: refusal.message }),
          )
      }
      return setup(host, api.conversationId, async (driver) => {
        if (!args.launch) return result((await listApps(driver, ctx.abortSignal)).reply)
        const session = await readSession(host, api.conversationId)
        if (await isStopped(host, api.conversationId, { session, signal: ctx.abortSignal }))
          return result({ status: 'stopped' })
        const identity = await resolveIdentity(driver, args.launch, ctx.abortSignal)
        if (!identity) return result({ status: 'app_identity' })
        if (!session.task!.spec.scope.apps.some((app) => matchesApp(identity, app)))
          return result({ status: 'out_of_scope' })
        const consent = canonicalConsent(
          identity,
          await allGrants(host, api.conversationId, session),
        )
        if (consent !== 'granted') {
          const refusal = {
            refuse: consent === 'denied' ? 'denied' : 'consent_required',
            message: `Consent required for ${args.launch}`,
          }
          await pending(host, api.conversationId, args.launch, refusal)
          return result({ status: refusal.refuse })
        }
        const state = runtime(host)
        if (state.busy) return result({ status: 'busy' })
        const app = identity.name
        const abort = new AbortController()
        const active: Active = { stopped: false, inFlight: false, abort }
        state.active.set(api.conversationId, active)
        state.busy = true
        let sent = false
        try {
          await updateSession(host, api.conversationId, (doc) => {
            doc.journal.push({
              call: api.callId,
              step: 0,
              kind: 'launch',
              app,
              status: 'sending',
              at: Math.max(Date.now(), doc.lastObservedAt + 1),
            })
          })
          const latest = await readSession(host, api.conversationId)
          const stopped = await isStopped(host, api.conversationId, {
            session: latest,
            active,
            signal: ctx.abortSignal,
          })
          if (
            stopped ||
            canonicalConsent(identity, await allGrants(host, api.conversationId, latest)) !==
              'granted'
          ) {
            await updateSession(host, api.conversationId, (doc) => {
              doc.journal.findLast((j) => j.call === api.callId)!.status = 'refused'
            })
            return result({
              status: stopped ? 'stopped' : 'consent_required',
            })
          }
          await updateSession(host, api.conversationId, (doc) => {
            doc.grants = consumeCanonical(identity, doc.grants)
          })
          active.inFlight = true
          sent = true
          const reply = await driver.call(
            'launch_app',
            { name: app },
            ctx.abortSignal ? AbortSignal.any([abort.signal, ctx.abortSignal]) : abort.signal,
          )
          await updateSession(host, api.conversationId, (doc) => {
            doc.journal.findLast((j) => j.call === api.callId)!.status = reply.ok
              ? 'delivered'
              : reply.refusal
                ? 'refused'
                : 'failed'
          })
          return result(reply)
        } catch (error) {
          if (!sent) throw error
          // A transport failure after sending cannot prove that the app was not launched.
          active.uncertain = abort.signal.aborted || ctx.abortSignal?.aborted
          await updateSession(host, api.conversationId, (doc) => {
            doc.journal.findLast((j) => j.call === api.callId)!.status = 'unknown'
          })
          return result({
            status: 'unknown',
            message: 'Observe before deciding whether to launch again.',
          })
        } finally {
          active.inFlight = false
          if (!active.uncertain) clearTimeout(active.timer)
          state.active.delete(api.conversationId)
          state.busy = false
          await driverFor(host).catch((error) =>
            console.error('computer-use: idle timer failed:', error),
          )
        }
      })
    },
  })
}
export const element = Type.String()
export const stepSchema = Type.Unsafe<Step>(
  Type.Union([
    Type.Object({
      kind: Type.Union(
        ['click', 'double_click', 'right_click'].map((value) => Type.Literal(value)),
      ),
      element: Type.Optional(element),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      capture: Type.Optional(Type.String()),
      expect_label: Type.Optional(Type.String()),
    }),
    Type.Object({ kind: Type.Literal('type'), element, text: Type.String() }),
    Type.Object({ kind: Type.Literal('set_value'), element, value: Type.String() }),
    Type.Object({
      kind: Type.Literal('key'),
      key: Type.String(),
      modifiers: Type.Optional(Type.Array(Type.String())),
    }),
    Type.Object({ kind: Type.Literal('menu'), path: Type.Array(Type.String(), { minItems: 1 }) }),
    Type.Object({
      kind: Type.Literal('scroll'),
      element: Type.Optional(element),
      direction: Type.Union(['up', 'down', 'left', 'right'].map((value) => Type.Literal(value))),
      amount: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    Type.Object({
      kind: Type.Literal('wait'),
      seconds: Type.Number({ minimum: 0, maximum: 120 }),
      until: Type.Object({
        text: Type.Optional(Type.String()),
        gone: Type.Optional(Type.String()),
        stable: Type.Optional(Type.Literal(true)),
      }),
    }),
  ]),
)
