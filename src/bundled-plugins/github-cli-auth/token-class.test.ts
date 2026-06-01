import { describe, expect, it } from 'bun:test'

import { classifyGhToken, rewriteWithToken } from './inject'

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

describe('rewriteWithToken', () => {
  it('prepends a shell-quoted GH_TOKEN assignment', () => {
    expect(rewriteWithToken('gh pr view -R acme/widgets', 'ghs_tok')).toBe(
      "GH_TOKEN='ghs_tok' gh pr view -R acme/widgets",
    )
  })

  it('escapes single quotes in the token', () => {
    expect(rewriteWithToken('gh pr view -R acme/widgets', "ab'cd")).toBe(
      "GH_TOKEN='ab'\\''cd' gh pr view -R acme/widgets",
    )
  })
})
