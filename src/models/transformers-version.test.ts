import { describe, expect, test } from 'bun:test'

import { getResolvedTransformersVersion } from './transformers-version'

describe('getResolvedTransformersVersion', () => {
  test('returns the installed @huggingface/transformers semver from its own package.json (resolved, not a typeclaw constant)', () => {
    const version = getResolvedTransformersVersion()

    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
