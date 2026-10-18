import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSecret } from '../../lib/secrets.ts'

export const secrets = [
  {
    name: 'TYPESAFE_API_KEY',
    description: 'TypeSafe API key for Jev typed judgments',
    url: 'https://console.typesafe.ai/keys',
  },
]

export type ClassifyQuestion =
  | { type: 'choice'; instructions: JsonValue; criteria: Record<string, JsonValue> }
  | { type: 'noul'; instructions: JsonValue; criteria?: { true?: JsonValue; false?: JsonValue } }
  | { type: 'score'; instructions: JsonValue; criteria: JsonValue[] }

export type ClassifyAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | {
      type: 'score'
      score: number
      confidence: number
      probabilities: Record<string, number>
      legend: Record<string, JsonValue>
    }

export type ClassifyResult = {
  model: string
  answers: Record<string, ClassifyAnswer>
  usage: { inputTokens: number }
}

export type ClassifyService = {
  ask(
    request: { state: JsonValue; questions: Record<string, ClassifyQuestion> },
    signal: AbortSignal,
  ): Promise<ClassifyResult>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default function classify(host: ExtensionHost) {
  const service: ClassifyService = {
    async ask(request, signal) {
      const key = await readSecret(host.userHome, 'TYPESAFE_API_KEY')
      if (!key) {
        throw new Error(
          'Missing TYPESAFE_API_KEY. Enable secrets and add TYPESAFE_API_KEY in the Secrets panel (⌘K → Secrets).',
        )
      }
      const response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-1.14.0', ...request }),
        signal,
      })
      if (!response.ok) {
        throw new Error(`TypeSafe ${response.status}: ${(await response.text()).slice(0, 1000)}`)
      }
      const body: unknown = await response.json()
      if (
        !record(body) ||
        typeof body.model !== 'string' ||
        !record(body.answers) ||
        !record(body.usage) ||
        typeof body.usage.input_tokens !== 'number'
      ) {
        throw new Error(
          'Malformed TypeSafe response: expected model, answers and usage.input_tokens',
        )
      }
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = body.answers[id]
        if (!record(answer) || answer.type !== question.type) {
          throw new Error(`Malformed TypeSafe response: expected ${question.type} answer for ${id}`)
        }
      }
      return {
        model: body.model,
        answers: body.answers as Record<string, ClassifyAnswer>,
        usage: { inputTokens: body.usage.input_tokens },
      }
    },
  }
  host.provide('classify', service)
  return defineExtension({ name: 'classify' })
}
