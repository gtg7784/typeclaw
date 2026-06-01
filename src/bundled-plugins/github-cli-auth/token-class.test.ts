import { describe, expect, it } from 'bun:test'

import { classifyGhToken } from './token-class'

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
