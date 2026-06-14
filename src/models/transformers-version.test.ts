import { describe, expect, test } from 'bun:test'

import { getResolvedTransformersVersion } from './transformers-version'

describe('getResolvedTransformersVersion', () => {
  test('resolves the installed @huggingface/transformers semver from its own package.json without throwing', () => {
    // Guards the ERR_PACKAGE_PATH_NOT_EXPORTED hazard: the package does not
    // export a ./package.json subpath, so the version must be derived from the
    // resolved (exported) entry, not a direct subpath require.
    const version = getResolvedTransformersVersion()

    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
