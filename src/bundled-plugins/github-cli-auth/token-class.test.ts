import { describe, expect, it } from 'bun:test'

import { classifyGhToken, shouldMintAppToken } from './token-class'

describe('classifyGhToken', () => {
  it('classifies a classic PAT as cross-owner', () => {
    expect(classifyGhToken('ghp_abc123')).toBe('cross-owner')
  })

  it('classifies a fine-grained PAT', () => {
    expect(classifyGhToken('github_pat_abc123')).toBe('fine-grained-pat')
  })

  it('classifies an App installation token', () => {
    expect(classifyGhToken('ghs_abc123')).toBe('app')
  })

  it('treats an absent token as none', () => {
    expect(classifyGhToken(undefined)).toBe('none')
    expect(classifyGhToken('')).toBe('none')
  })

  it('treats an unknown prefix as app (conservative per-repo resolution)', () => {
    expect(classifyGhToken('gho_oauthtoken')).toBe('app')
  })
})

describe('shouldMintAppToken', () => {
  it('mints for an App-class GH_TOKEN regardless of resolver presence', () => {
    expect(shouldMintAppToken('ghs_abc', false)).toBe(true)
    expect(shouldMintAppToken('ghs_abc', true)).toBe(true)
  })

  it('mints when GH_TOKEN is unseeded but a live minter is registered', () => {
    expect(shouldMintAppToken(undefined, true)).toBe(true)
    expect(shouldMintAppToken('', true)).toBe(true)
  })

  it('does not mint when GH_TOKEN is unseeded and no minter is registered', () => {
    expect(shouldMintAppToken(undefined, false)).toBe(false)
  })

  it('never re-mints for classic or fine-grained PATs, even with a live minter', () => {
    expect(shouldMintAppToken('ghp_classic', true)).toBe(false)
    expect(shouldMintAppToken('github_pat_xyz', true)).toBe(false)
  })
})
