import {
  ObservationUnavailable,
  json,
  result,
  plainTask,
  runtime,
  setup,
  cacheKey,
  object,
  windowSchema,
  prepare,
} from './runtime.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { resizeImage } from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { parseObservation, ancestry } from './observation.ts'
import type { Driver, Observation } from './types.ts'
import { updateSession } from './session.ts'
import * as task from './task.ts'
import { untrusted } from './content.ts'
import { readSession } from './session.ts'
import { allGrants, resolveIdentity, readConsent } from './gates.ts'

export async function windowFor(
  driver: Driver,
  app: string,
  window?: string | number,
  signal?: AbortSignal,
) {
  const listed = await driver.call('list_windows', { app }, signal)
  const windows = listed.structured?.windows
  const matches = (Array.isArray(windows) ? windows : [])
    .map(object)
    .filter(
      (w) =>
        window === undefined ||
        w.window_id === window ||
        (typeof w.title === 'string'
          ? w.title
          : typeof w.window_title === 'string'
            ? w.window_title
            : ''
        ).includes(String(window)),
    )
  if (matches.length !== 1)
    throw new Error(
      'Select exactly one window with computer_observe; window is ambiguous or missing',
    )
  return { pid: Number(matches[0].pid), window_id: Number(matches[0].window_id) }
}
export function parseWindow(reply: Awaited<ReturnType<Driver['call']>>, app: string) {
  const reason =
    typeof reply.structured?.degraded_reason === 'string'
      ? reply.structured.degraded_reason
      : reply.text
  if (!reply.ok || reply.structured?.degraded === true)
    throw new ObservationUnavailable(
      reply.refusal?.code ??
        (reason.startsWith('screen_locked') ? 'screen_locked' : 'observation_unavailable'),
      reply.refusal?.message ?? reason,
    )
  return parseObservation(
    reply,
    typeof reply.structured?.app_name === 'string' ? reply.structured.app_name : app,
  )
}
export async function observeWindow(
  driver: Driver,
  app: string,
  window: string | number | undefined,
  screenshot: 'auto' | 'always' | 'never' = 'auto',
  query?: string,
  maxDimension = 1568,
  signal?: AbortSignal,
): Promise<Observation> {
  const target = await windowFor(driver, app, window, signal)
  const args = {
    ...target,
    full_output: true,
    tree_format: 'both',
    max_elements: 250,
    max_depth: 12,
    max_dimension: maxDimension,
    include_screenshot: screenshot === 'always',
    ...(query ? { query } : {}),
  }
  let observed = parseWindow(await driver.call('get_window_state', args, signal), app)
  const chromeOnly = !observed.elements.some(
    (e) =>
      !['AXWindow', 'AXGroup', 'AXScrollArea', 'AXSplitGroup', 'AXToolbar'].includes(e.role) &&
      !ancestry(e, observed).some((parent) => parent.role === 'AXMenuBar') &&
      !/^(close|minimi[sz]e|zoom|(?:enter |exit )?full[ -]?screen)( window| button)?$/i.test(
        e.label ?? '',
      ) &&
      Boolean(e.label || e.value || e.actions.length) &&
      e.depth > 0,
  )
  if (screenshot === 'auto' && chromeOnly)
    observed = parseWindow(
      await driver.call('get_window_state', { ...args, include_screenshot: true }, signal),
      app,
    )
  observed.truncated ||= observed.tree.length > 16_000
  observed.tree = observed.tree.slice(0, 16_000)
  return observed
}
export async function observedOutput(observation: Observation, maxDimension = 1568) {
  const { image, elements: _elements, tree, ...metadata } = observation
  const content: (
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  )[] = [
    {
      type: 'text',
      text: untrusted(
        `${JSON.stringify(metadata)}\n${tree}\n${observation.truncated ? '[tree truncated]' : ''}`,
      ),
    },
  ]
  if (image) {
    const resized = await resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, {
      maxWidth: maxDimension,
      maxHeight: maxDimension,
    })
    if (resized) content.push({ type: 'image', data: resized.data, mimeType: resized.mimeType })
  }
  return { output: content, structuredOutput: json({ ...metadata, tree }) }
}
export function observeTool(host: ExtensionHost) {
  return defineTool({
    name: 'computer_observe',
    structuredOutputSchema: Type.Any(),
    description:
      'Read native apps/windows or a bounded accessibility tree, optionally with capture-bound pixels.',
    // Repeating an observation only reads desktop state; it never delivers input.
    replay: 'safe',
    prepareArguments: (raw) =>
      prepare(raw) as {
        app?: string
        window?: string | number
        screenshot?: 'auto' | 'always' | 'never'
        query?: string
        zoom?: [number, number, number, number]
        evidence?: boolean
        criterion?: string
      },
    parameters: Type.Object({
      app: Type.Optional(Type.String()),
      window: windowSchema,
      screenshot: Type.Optional(
        Type.Unsafe<'auto' | 'always' | 'never'>(
          Type.Union(['auto', 'always', 'never'].map((value) => Type.Literal(value))),
        ),
      ),
      query: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Boolean()),
      criterion: Type.Optional(Type.String()),
      zoom: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])),
    }),
    async execute(args, api, ctx) {
      return setup(host, api.conversationId, async (driver) => {
        const state = runtime(host)
        if (state.busy) return result({ status: 'busy' })
        state.busy = true
        try {
          if (args.app) {
            const identity = await resolveIdentity(driver, args.app, ctx.abortSignal)
            if (!identity) return result({ status: 'app_identity' })
            const consent = readConsent(
              identity,
              await allGrants(
                host,
                api.conversationId,
                await readSession(host, api.conversationId),
              ),
            )
            if (consent !== 'granted')
              return result({ status: consent === 'denied' ? 'denied' : 'consent_required' })
          }
          if (args.window === undefined)
            return result(
              await driver.call(
                args.app ? 'list_windows' : 'list_apps',
                args.app ? { app: args.app } : {},
                ctx.abortSignal,
              ),
            )
          if (!args.app)
            return result({
              status: 'invalid_arguments',
              message: 'app is required with window',
            })
          const agent = await (
            await host.harness().conversation(api.conversationId, context)
          )?.agent(context)
          const model = agent?.model?.modelId ?? ''
          const max = /opus.*(?:4[.-][7-9]|5[.-])/i.test(model) ? 2576 : 1568
          const observation = await observeWindow(
            driver,
            args.app,
            args.window,
            args.zoom ? 'always' : args.screenshot,
            args.query,
            max,
            ctx.abortSignal,
          )
          if (args.zoom) {
            const [x1, y1, x2, y2] = args.zoom
            const zoom = await driver.call(
              'zoom',
              {
                pid: observation.pid,
                window_id: observation.windowId,
                x1,
                y1,
                x2,
                y2,
              },
              ctx.abortSignal,
            )
            observation.image = zoom.images[0]
          }
          ctx.abortSignal?.throwIfAborted()
          runtime(host).observations.set(cacheKey(api.conversationId, args.app), observation)
          if (args.zoom) runtime(host).zoomed.add(cacheKey(api.conversationId, args.app))
          else runtime(host).zoomed.delete(cacheKey(api.conversationId, args.app))
          await updateSession(host, api.conversationId, (doc) => {
            doc.lastObservedAt = Math.max(Date.now(), ...doc.journal.map((j) => j.at))
            for (const entry of doc.journal)
              if (entry.status === 'sending') entry.status = 'unknown'
            if (doc.task) {
              doc.task = task.recordObserve(plainTask(doc.task))
              const active = doc.task.subgoals.find((s) => s.status === 'active')
              if (args.evidence && active && doc.task.spec.scope.apps.includes(observation.app))
                doc.task = task.addEvidence(plainTask(doc.task), active.id, {
                  kind: 'ax',
                  snapshot: observation.snapshot,
                  excerpt: observation.tree.slice(0, 2000),
                  ref: api.callId,
                  app: observation.app,
                  ...(args.criterion ? { criterion: args.criterion } : {}),
                })
            }
          })
          return await observedOutput(observation, max)
        } finally {
          state.busy = false
        }
      })
    },
  })
}
