import { describe, expect, test } from 'bun:test'

import {
  buildGlmVisionMessages,
  extractGlmVisionText,
  GLM_VISION_TTFB_MS,
  lookAtTool,
  resolveGlmVisionTtfbMs,
} from './look-at'
import { buildMultimodalLookerSystemPrompt } from './looker'

type ImageParam = { url?: string; path?: string; data?: string; mimeType?: string } | Record<string, never>

async function execute(args: { images: ImageParam[]; prompt?: string }) {
  // pi-coding-agent's `execute` signature is `(toolCallId, params, signal,
  // onUpdate, ctx)`; for these validation-path tests the last three are
  // unused (the tool fails fast in toImageInput before any LLM/IO).
  // The cast is needed because the JSONSchema-derived Static<TParams> type
  // differs from our type-level ImageParam shape.
  return lookAtTool.execute(
    'test-call-id',
    args as unknown as Parameters<typeof lookAtTool.execute>[1],
    undefined,
    undefined,
    {} as unknown as Parameters<typeof lookAtTool.execute>[4],
  )
}

describe('lookAtTool — image source validation (no LLM call)', () => {
  // All these tests should fail validation BEFORE attempting to spawn a
  // multimodal-looker session. They prove the exactly-one-source rule from
  // the self-review (Bug 3) is enforced regardless of what the model passes.

  test('rejects mixing url and path', async () => {
    const result = await execute({ images: [{ url: 'https://example.com/x.png', path: '/agent/x.png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
    expect(result.details).toMatchObject({ error: expect.stringContaining('exactly one') })
  })

  test('rejects mixing url and data', async () => {
    const result = await execute({
      images: [{ url: 'https://example.com/x.png', data: 'aGk=', mimeType: 'image/png' }],
    })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
  })

  test('rejects mixing path and data+mimeType', async () => {
    const result = await execute({ images: [{ path: '/agent/x.png', data: 'aGk=', mimeType: 'image/png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
  })

  test('rejects empty image object', async () => {
    const result = await execute({ images: [{}] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
  })

  test('rejects data without mimeType (incomplete base64 spec)', async () => {
    const result = await execute({ images: [{ data: 'aGk=' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('base64') })
  })

  test('rejects mimeType without data (incomplete base64 spec)', async () => {
    const result = await execute({ images: [{ mimeType: 'image/png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('base64') })
  })

  test('rejects relative file path', async () => {
    const result = await execute({ images: [{ path: 'relative/x.png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('absolute') })
  })

  test('rejects file with unsupported extension', async () => {
    const result = await execute({ images: [{ path: '/tmp/x.bmp' }] })
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/unsupported|not found/),
    })
  })

  test('rejects base64 with non-image mimeType', async () => {
    const result = await execute({ images: [{ data: 'aGVsbG8=', mimeType: 'text/plain' }] })
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('mimeType must be image/*'),
    })
  })
})

describe('extractGlmVisionText — GLM vision response parsing', () => {
  test('extracts trimmed assistant content from a well-formed response', () => {
    const body = { choices: [{ message: { role: 'assistant', content: '\nblue\n' } }] }
    expect(extractGlmVisionText(body)).toBe('blue')
  })

  test('returns null when choices is empty', () => {
    expect(extractGlmVisionText({ choices: [] })).toBeNull()
  })

  test('returns null when content is blank', () => {
    expect(extractGlmVisionText({ choices: [{ message: { content: '   ' } }] })).toBeNull()
  })

  test('returns null for a non-object body', () => {
    expect(extractGlmVisionText(null)).toBeNull()
    expect(extractGlmVisionText('oops')).toBeNull()
  })

  test('returns null when the API returns an error envelope instead of choices', () => {
    expect(extractGlmVisionText({ error: { code: '1113', message: 'Insufficient balance' } })).toBeNull()
  })
})

describe('buildGlmVisionMessages — GLM payload preserves looker behavior', () => {
  const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }

  test('prepends the looker system prompt (with a question)', () => {
    const messages = buildGlmVisionMessages([image], 'What color is the car?')
    expect(messages[0]).toEqual({
      role: 'system',
      content: buildMultimodalLookerSystemPrompt('What color is the car?'),
    })
    expect(messages[0]!.content).toContain('What color is the car?')
  })

  test('uses the describe-everything system prompt when no prompt is given', () => {
    const messages = buildGlmVisionMessages([image], undefined)
    expect(messages[0]).toEqual({ role: 'system', content: buildMultimodalLookerSystemPrompt(undefined) })
  })

  test('carries the image as a data-URI and the user text in the user turn', () => {
    const messages = buildGlmVisionMessages([image], undefined)
    const user = messages[1] as { role: string; content: Array<Record<string, unknown>> }
    expect(user.role).toBe('user')
    expect(user.content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } })
    expect(user.content[1]).toEqual({ type: 'text', text: 'Please describe the attached image(s).' })
  })
})

describe('resolveGlmVisionTtfbMs — vision TTFB budget', () => {
  test('defaults to 45s when the env var is unset', () => {
    expect(resolveGlmVisionTtfbMs({})).toBe(GLM_VISION_TTFB_MS)
    expect(GLM_VISION_TTFB_MS).toBe(45_000)
  })

  test('a valid TYPECLAW_GLM_VISION_TTFB_MS overrides the default', () => {
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: '60000' })).toBe(60_000)
  })

  test('an invalid or empty env value falls back to the default', () => {
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: '' })).toBe(GLM_VISION_TTFB_MS)
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: 'abc' })).toBe(GLM_VISION_TTFB_MS)
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: '-5' })).toBe(GLM_VISION_TTFB_MS)
  })
})
