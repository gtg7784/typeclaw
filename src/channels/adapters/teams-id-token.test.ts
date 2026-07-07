import { describe, expect, test } from 'bun:test'

import type { TeamsAccountRecord } from '@/secrets/schema'

import { ContainerTeamsClient, mintTeamsIdToken } from './teams-id-token'

function account(overrides: Partial<TeamsAccountRecord> = {}): TeamsAccountRecord {
  return {
    account_id: 'account-1',
    access_token: 'skype-1',
    account_type: 'work',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

type Captured = { url: string; body: URLSearchParams }

function capturingFetch(response: Response): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as URLSearchParams })
    return response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('mintTeamsIdToken', () => {
  test('returns null when the account has no aad_refresh_token', async () => {
    const result = await mintTeamsIdToken(account({ aad_refresh_token: undefined }))
    expect(result).toBeNull()
  })

  test('mints a work bearer via the tenant-scoped refresh_token grant', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse({ access_token: 'minted-work-bearer' }))

    const result = await mintTeamsIdToken(
      account({ aad_refresh_token: 'rt-work', aad_client_id: 'client-w', aad_tenant_id: 'tenant-guid' }),
      { fetch },
    )

    expect(result).toBe('minted-work-bearer')
    expect(calls).toHaveLength(1)
    // given a work account with a resolved tenant, the grant targets that tenant's authority
    expect(calls[0]?.url).toBe('https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token')
    expect(calls[0]?.body.get('grant_type')).toBe('refresh_token')
    expect(calls[0]?.body.get('refresh_token')).toBe('rt-work')
    expect(calls[0]?.body.get('client_id')).toBe('client-w')
    expect(calls[0]?.body.get('scope')).toBe('https://api.spaces.skype.com/.default openid profile offline_access')
  })

  test('falls back to the organizations authority when no tenant is stored', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse({ access_token: 'x' }))

    await mintTeamsIdToken(account({ aad_refresh_token: 'rt', account_type: 'work', aad_tenant_id: undefined }), {
      fetch,
    })

    expect(calls[0]?.url).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token')
  })

  test('mints a personal bearer against the consumer tenant with the MSA scope', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse({ access_token: 'minted-personal' }))

    const result = await mintTeamsIdToken(account({ account_type: 'personal', aad_refresh_token: 'rt-personal' }), {
      fetch,
    })

    expect(result).toBe('minted-personal')
    expect(calls[0]?.url).toBe(
      'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/oauth2/v2.0/token',
    )
    expect(calls[0]?.body.get('scope')).toBe('service::api.fl.spaces.skype.com::MBI_SSL openid profile offline_access')
  })

  test('returns null on an AAD error response so the caller degrades', async () => {
    const { fetch } = capturingFetch(jsonResponse({ error: 'invalid_grant' }, 400))
    const result = await mintTeamsIdToken(account({ aad_refresh_token: 'stale' }), { fetch })
    expect(result).toBeNull()
  })

  test('returns null on a transport failure rather than throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const result = await mintTeamsIdToken(account({ aad_refresh_token: 'rt' }), { fetch: fetchImpl })
    expect(result).toBeNull()
  })

  test('returns null when the grant omits an access_token', async () => {
    const { fetch } = capturingFetch(jsonResponse({ token_type: 'Bearer' }))
    const result = await mintTeamsIdToken(account({ aad_refresh_token: 'rt' }), { fetch })
    expect(result).toBeNull()
  })
})

describe('ContainerTeamsClient', () => {
  test('getIdToken mints from the currently-loaded account via the injected minter', async () => {
    const acct = account({ aad_refresh_token: 'rt' })
    const seen: TeamsAccountRecord[] = []
    const client = new ContainerTeamsClient(
      () => acct,
      async (a) => {
        seen.push(a)
        return 'minted-id-token'
      },
    )

    expect(await client.getIdToken()).toBe('minted-id-token')
    expect(seen).toEqual([acct])
  })

  test('getIdToken returns null before an account is loaded', async () => {
    let loaded: TeamsAccountRecord | null = null
    const client = new ContainerTeamsClient(
      () => loaded,
      async () => 'should-not-be-called',
    )

    expect(await client.getIdToken()).toBeNull()
    loaded = account({ aad_refresh_token: 'rt' })
    expect(await client.getIdToken()).toBe('should-not-be-called')
  })
})
