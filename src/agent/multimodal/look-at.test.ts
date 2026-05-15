import { describe, expect, test } from 'bun:test'

import { lookAtTool } from './look-at'

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
