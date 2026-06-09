import { describe, expect, it } from 'bun:test'

import { createGithubTokenBridge } from './github-token-bridge'

describe('createGithubTokenBridge', () => {
  it('returns unavailable when no resolver is registered', async () => {
    const bridge = createGithubTokenBridge()

    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).toContain('not running')
  })

  it('returns the minted token when a resolver is registered', async () => {
    const bridge = createGithubTokenBridge()
    bridge.registerResolver(async (repoSlug) => `ghs_token_for_${repoSlug}`)

    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result).toEqual({ kind: 'token', token: 'ghs_token_for_acme/widgets' })
  })

  it('surfaces a throwing resolver as unavailable instead of crashing', async () => {
    const bridge = createGithubTokenBridge()
    bridge.registerResolver(async () => {
      throw new Error('installation lookup failed: 404')
    })

    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result).toEqual({ kind: 'unavailable', reason: 'installation lookup failed: 404' })
  })

  it('unregister restores the unavailable state', async () => {
    const bridge = createGithubTokenBridge()
    const unregister = bridge.registerResolver(async () => 'ghs_x')

    unregister()
    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result.kind).toBe('unavailable')
  })

  it('a later register replaces the current resolver', async () => {
    const bridge = createGithubTokenBridge()
    bridge.registerResolver(async () => 'ghs_first')
    bridge.registerResolver(async () => 'ghs_second')

    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result).toEqual({ kind: 'token', token: 'ghs_second' })
  })

  it('stale unregister does not wipe a newer resolver', async () => {
    const bridge = createGithubTokenBridge()
    const unregisterFirst = bridge.registerResolver(async () => 'ghs_first')
    bridge.registerResolver(async () => 'ghs_second')

    unregisterFirst()
    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result).toEqual({ kind: 'token', token: 'ghs_second' })
  })

  it('hasAppTokenResolver tracks resolver registration', () => {
    const bridge = createGithubTokenBridge()
    expect(bridge.hasAppTokenResolver()).toBe(false)

    const unregister = bridge.registerResolver(async () => 'ghs_x')
    expect(bridge.hasAppTokenResolver()).toBe(true)

    unregister()
    expect(bridge.hasAppTokenResolver()).toBe(false)
  })
})
