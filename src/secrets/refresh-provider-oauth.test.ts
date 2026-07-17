import { afterEach, describe, expect, test } from 'bun:test'

import { registerOAuthProvider, unregisterOAuthProvider } from '@mariozechner/pi-ai/oauth'
import type { OAuthCredentials, OAuthProviderInterface } from '@mariozechner/pi-ai/oauth'
import { AuthStorage } from '@mariozechner/pi-coding-agent'
import type { AuthCredential } from '@mariozechner/pi-coding-agent'

import { refreshProviderOAuthCredentials } from './refresh-provider-oauth'

const STUB_PROVIDER_ID = 'stub-oauth'
const registered = new Set<string>()

function installStubProvider(overrides: Partial<OAuthProviderInterface> & { id?: string } = {}): string {
  const id = overrides.id ?? STUB_PROVIDER_ID
  const provider: OAuthProviderInterface = {
    id,
    name: 'Stub OAuth',
    login: async () => {
      throw new Error('login not used in tests')
    },
    refreshToken: overrides.refreshToken ?? (async (creds) => creds),
    getApiKey: overrides.getApiKey ?? ((creds) => creds.access),
  }
  registerOAuthProvider(provider)
  registered.add(id)
  return id
}

afterEach(() => {
  for (const id of registered) unregisterOAuthProvider(id)
  registered.clear()
})

function oauthCred(access: string, expires: number, refresh = 'refresh-token'): OAuthCredentials & { type: 'oauth' } {
  return { type: 'oauth', access, refresh, expires }
}

function storageWith(data: Record<string, AuthCredential>): AuthStorage {
  return AuthStorage.inMemory(data)
}

const FUTURE = Date.now() + 60 * 60 * 1000
const PAST = Date.now() - 60 * 60 * 1000

describe('refreshProviderOAuthCredentials', () => {
  test('no oauth providers → empty result, no work', async () => {
    const storage = storageWith({ openai: { type: 'api_key', key: 'sk-test' } })

    const result = await refreshProviderOAuthCredentials({ authStorage: storage })

    expect(result.entries).toEqual([])
  })

  test('valid (unexpired) token → valid-or-refreshed without invoking refresh', async () => {
    const id = installStubProvider({
      refreshToken: async () => {
        throw new Error('refresh must not run for an unexpired token')
      },
    })
    const storage = storageWith({ [id]: oauthCred('valid-access', FUTURE) })

    const result = await refreshProviderOAuthCredentials({ authStorage: storage })

    expect(result.entries).toEqual([{ providerId: id, outcome: 'valid-or-refreshed' }])
  })

  test('expired token → refresh runs, new credential persists, outcome valid-or-refreshed', async () => {
    let refreshCalls = 0
    const id = installStubProvider({
      refreshToken: async (creds): Promise<OAuthCredentials> => {
        refreshCalls += 1
        return { access: 'fresh-access', refresh: creds.refresh, expires: FUTURE }
      },
    })
    const storage = storageWith({ [id]: oauthCred('stale-access', PAST) })

    const result = await refreshProviderOAuthCredentials({ authStorage: storage })

    expect(refreshCalls).toBe(1)
    expect(result.entries).toEqual([{ providerId: id, outcome: 'valid-or-refreshed' }])
    const persisted = storage.getAll()[id]
    expect(persisted).toMatchObject({ type: 'oauth', access: 'fresh-access', expires: FUTURE })
  })

  test('expired token + failing refresh → refresh-failed with surfaced error', async () => {
    const logs: string[] = []
    const id = installStubProvider({
      refreshToken: async () => {
        throw new Error('token endpoint 400: invalid_grant')
      },
    })
    const storage = storageWith({ [id]: oauthCred('stale-access', PAST) })

    const result = await refreshProviderOAuthCredentials({
      authStorage: storage,
      log: (m) => logs.push(m),
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.providerId).toBe(id)
    expect(result.entries[0]!.outcome).toBe('refresh-failed')
    // The SDK wraps the underlying cause into "Failed to refresh OAuth token
    // for <id>"; the raw cause (invalid_grant) is not propagated to drainErrors,
    // so we assert on the operator-actionable wrapper we actually surface.
    expect(result.entries[0]!.error).toContain('Failed to refresh OAuth token')
    expect(result.entries[0]!.error).toContain(id)
    expect(logs.some((m) => m.includes(id) && m.includes('refresh failed'))).toBe(true)
  })

  test('one failing provider does not stop others from being probed', async () => {
    const good = installStubProvider({
      id: 'stub-good',
      refreshToken: async (creds): Promise<OAuthCredentials> => ({
        access: 'good-fresh',
        refresh: creds.refresh,
        expires: FUTURE,
      }),
    })
    const bad = installStubProvider({
      id: 'stub-bad',
      refreshToken: async () => {
        throw new Error('boom')
      },
    })
    const storage = storageWith({
      [bad]: oauthCred('bad-stale', PAST),
      [good]: oauthCred('good-stale', PAST),
    })

    const result = await refreshProviderOAuthCredentials({ authStorage: storage })

    const byId = Object.fromEntries(result.entries.map((e) => [e.providerId, e.outcome]))
    expect(byId[good]).toBe('valid-or-refreshed')
    expect(byId[bad]).toBe('refresh-failed')
  })

  test('unknown oauth provider (not registered) → refresh-failed, no throw', async () => {
    const storage = storageWith({ 'never-registered': oauthCred('x', PAST) })

    const result = await refreshProviderOAuthCredentials({ authStorage: storage })

    expect(result.entries).toEqual([
      { providerId: 'never-registered', outcome: 'refresh-failed', error: expect.any(String) },
    ])
  })

  test('one failing provider does not leak its error onto the next provider', async () => {
    const bad = installStubProvider({
      id: 'stub-bad-first',
      refreshToken: async () => {
        throw new Error('first-failure')
      },
    })
    const good = installStubProvider({
      id: 'stub-good-second',
      refreshToken: async (creds): Promise<OAuthCredentials> => ({
        access: 'ok',
        refresh: creds.refresh,
        expires: FUTURE,
      }),
    })
    const storage = storageWith({
      [bad]: oauthCred('a', PAST),
      [good]: oauthCred('b', PAST),
    })

    const result = await refreshProviderOAuthCredentials({ authStorage: storage })

    const goodEntry = result.entries.find((e) => e.providerId === good)
    expect(goodEntry?.outcome).toBe('valid-or-refreshed')
    expect(goodEntry?.error).toBeUndefined()
  })
})
