import { describe, expect, test } from 'bun:test'

import { parseAuthFile } from './schema'

describe('parseAuthFile', () => {
  test('accepts the new envelope shape', () => {
    const result = parseAuthFile({
      version: 1,
      llm: { openai: { type: 'api_key', key: 'sk-test' } },
      channels: {},
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(1)
    expect(result.file.llm).toEqual({ openai: { type: 'api_key', key: 'sk-test' } })
    expect(result.file.channels).toEqual({})
  })

  test('accepts the new envelope with $schema and missing optional sections', () => {
    const result = parseAuthFile({
      $schema: './node_modules/typeclaw/auth.schema.json',
      version: 1,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.llm).toEqual({})
    expect(result.file.channels).toEqual({})
  })

  test('upgrades legacy flat shape with at least one credential', () => {
    const result = parseAuthFile({
      openai: { type: 'api_key', key: 'sk-test' },
      'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(1)
    expect(result.file.llm.openai).toEqual({ type: 'api_key', key: 'sk-test' })
    expect(result.file.llm['openai-codex']?.type).toBe('oauth')
    expect(result.file.channels).toEqual({})
  })

  test('upgrades empty object as legacy-empty (freshly created auth.json)', () => {
    const result = parseAuthFile({})

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toEqual({ version: 1, llm: {}, channels: {} })
  })

  test('preserves passthrough fields on OAuth credentials so upstream additions survive', () => {
    const result = parseAuthFile({
      version: 1,
      llm: {
        'openai-codex': {
          type: 'oauth',
          access: 'a',
          refresh: 'r',
          expires: 99,
          someFutureUpstreamField: 'preserved',
        },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cred = result.file.llm['openai-codex']
    expect(cred).toBeDefined()
    if (cred?.type !== 'oauth') throw new Error('expected oauth credential')
    expect(cred['someFutureUpstreamField']).toBe('preserved')
  })

  test('rejects malformed credential in legacy shape (api_key missing key)', () => {
    const result = parseAuthFile({ openai: { type: 'api_key' } })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('version')
  })

  test('rejects wrong version with informative path: message error', () => {
    const result = parseAuthFile({ version: 2, llm: {} })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('version')
  })

  test('rejects non-object input', () => {
    const result = parseAuthFile('not a record')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.length).toBeGreaterThan(0)
  })

  test('rejects array input', () => {
    const result = parseAuthFile([])

    expect(result.ok).toBe(false)
  })

  test('rejects unknown discriminator on legacy credential', () => {
    const result = parseAuthFile({ openai: { type: 'totally_made_up', key: 'x' } })

    expect(result.ok).toBe(false)
  })
})
