import type { DriverResult, Element, Observation } from './types.ts'

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Driver observation: ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new Error(`Invalid Driver observation: missing or invalid ${field}`)
  return value
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid Driver observation: missing or invalid ${field}`)
  }
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean')
    throw new Error(`Invalid Driver observation: missing or invalid ${field}`)
  return value
}

export function parseObservation(result: DriverResult, app: string): Observation {
  const data = object(result.structured, 'structuredContent')
  if (!Array.isArray(data.elements))
    throw new Error('Invalid Driver observation: missing or invalid elements')
  const elements = data.elements.map((raw, i): Element => {
    const element = object(raw, `elements[${i}]`)
    const role = string(element.role, 'role')
    if (
      !Array.isArray(element.actions) ||
      !element.actions.every((action) => typeof action === 'string')
    ) {
      throw new Error(`Invalid Driver observation: elements[${i}].actions must be a string array`)
    }
    return {
      token: string(element.element_token, 'element_token'),
      index: number(element.element_index, 'element_index'),
      ...(element.parent_index != null
        ? { parent: number(element.parent_index, 'parent_index') }
        : {}),
      depth: number(element.depth, 'depth'),
      role,
      ...(element.label != null ? { label: string(element.label, 'label') } : {}),
      ...(element.value != null ? { value: string(element.value, 'value') } : {}),
      enabled: element.enabled == null ? role !== 'AXWindow' : boolean(element.enabled, 'enabled'),
      actions: element.actions,
      ...(element.frame != null ? { frame: frame(element.frame) } : {}),
    }
  })
  return {
    app,
    pid: number(data.pid, 'pid'),
    windowId: number(data.window_id, 'window_id'),
    title: string(data.window_title, 'window_title'),
    snapshot: string(data.snapshot_id, 'snapshot_id'),
    tree: string(data.tree_markdown, 'tree_markdown'),
    truncated: boolean(data.truncated, 'truncated'),
    elements,
    ...(data.capture_id != null
      ? {
          capture: {
            id: string(data.capture_id, 'capture_id'),
            width: number(data.screenshot_width, 'screenshot_width'),
            height: number(data.screenshot_height, 'screenshot_height'),
            scale: number(data.screenshot_scale, 'screenshot_scale'),
          },
        }
      : {}),
    ...(result.images[0] ? { image: result.images[0] } : {}),
  }
}

function frame(value: unknown): NonNullable<Element['frame']> {
  const data = object(value, 'frame')
  return {
    x: number(data.x, 'frame.x'),
    y: number(data.y, 'frame.y'),
    w: number(data.w, 'frame.w'),
    h: number(data.h, 'frame.h'),
  }
}
