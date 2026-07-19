import { describe, expect, test } from 'bun:test'

import type { Context, Model, ThinkingLevel } from '@mariozechner/pi-ai'
import { streamSimple } from '@mariozechner/pi-ai'

import { KNOWN_PROVIDERS } from './providers'

// End-to-end payload guard: drive pi-ai's real openai-completions adapter with
// each curated Upstage model and capture the request body it would send via the
// public `onPayload` hook (which fires before the HTTP call). This proves the
// wire payload only carries fields Upstage documents — the compat flags and
// thinkingLevelMap on the model objects are the mechanism, this asserts the
// resulting behavior. `onPayload` throwing short-circuits before any network I/O.

type CapturedPayload = Record<string, unknown>

async function buildUpstagePayload(
  model: Model<'openai-completions'>,
  reasoning?: ThinkingLevel,
): Promise<CapturedPayload> {
  const context: Context = {
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
  }

  let captured: CapturedPayload | undefined
  const stopMarker = new Error('payload-captured')

  const s = streamSimple(model, context, {
    apiKey: 'up_test-key',
    reasoning,
    onPayload: (payload) => {
      captured = payload as CapturedPayload
      throw stopMarker
    },
  })

  for await (const _event of s) {
    // Drain until the adapter reaches onPayload and throws; the stream surfaces
    // that as an error event, after which we stop.
    if (captured !== undefined) break
  }

  if (captured === undefined) throw new Error('onPayload never fired — adapter path changed')
  return captured
}

const REASONING_MODEL_IDS = ['solar-open2', 'solar-pro3', 'solar-pro2'] as const

describe('upstage openai-completions payload', () => {
  test('uses max_tokens (never max_completion_tokens) for every model', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      expect(payload.max_completion_tokens, `upstage/${modelId} must not send max_completion_tokens`).toBeUndefined()
      expect('max_tokens' in payload, `upstage/${modelId} should send max_tokens`).toBe(true)
    }
  })

  test('never sends the store field for any model', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      expect('store' in payload, `upstage/${modelId} must not send store`).toBe(false)
    }
  })

  test('emits only system/user/assistant roles — never the developer role', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      const messages = (payload.messages ?? []) as Array<{ role: string }>
      for (const m of messages) {
        expect(m.role, `upstage/${modelId} emitted an unsupported role`).not.toBe('developer')
      }
    }
  })

  test('does not attach strict to tool definitions for any model', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      const tools = (payload.tools ?? []) as Array<{ function?: { strict?: unknown } }>
      for (const t of tools) {
        expect(t.function?.strict, `upstage/${modelId} must not send strict on tool defs`).toBeUndefined()
      }
    }
  })

  test('clamps the reasoning models\u2019 xhigh level to Upstage\u2019s max reasoning_effort=high', async () => {
    for (const modelId of REASONING_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      const payload = await buildUpstagePayload(model, 'xhigh')
      expect(payload.reasoning_effort, `upstage/${modelId} must clamp xhigh -> high`).toBe('high')
    }
  })

  test('passes documented reasoning_effort levels through unchanged on reasoning models', async () => {
    for (const modelId of REASONING_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
        const payload = await buildUpstagePayload(model, level)
        expect(payload.reasoning_effort, `upstage/${modelId} level ${level}`).toBe(level)
      }
    }
  })

  test('solar-mini never emits reasoning_effort (it does not reason)', async () => {
    const model = KNOWN_PROVIDERS.upstage.models['solar-mini'] as Model<'openai-completions'>
    const payload = await buildUpstagePayload(model, 'high')
    expect(payload.reasoning_effort).toBeUndefined()
  })
})
