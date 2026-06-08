import { afterEach, describe, expect, test } from 'bun:test'

import { getOAuthProvider, unregisterOAuthProvider } from '@mariozechner/pi-ai/oauth'

import {
  refreshXaiToken,
  registerXaiOAuthProvider,
  xaiOAuthProvider,
  XAI_OAUTH_PROVIDER_ID,
  type FetchFn,
} from './oauth-xai'

function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): FetchFn {
  return async (url, init) => responder(url, init)
}

describe('registerXaiOAuthProvider', () => {
  afterEach(() => {
    unregisterOAuthProvider(XAI_OAUTH_PROVIDER_ID)
  })

  test('registers a provider resolvable by getOAuthProvider("xai")', () => {
    registerXaiOAuthProvider()
    const provider = getOAuthProvider(XAI_OAUTH_PROVIDER_ID)
    expect(provider?.id).toBe('xai')
    expect(provider?.name).toBe('xAI (Grok)')
    expect(provider?.usesCallbackServer).toBe(true)
  })
})

describe('xaiOAuthProvider.getApiKey', () => {
  test('returns the access token as the bearer api key', () => {
    expect(xaiOAuthProvider.getApiKey({ access: 'tok', refresh: 'r', expires: 1 })).toBe('tok')
  })
})

describe('refreshXaiToken', () => {
  test('POSTs form-encoded refresh_token grant to the xAI token endpoint', async () => {
    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    let capturedContentType: string | undefined

    await refreshXaiToken(
      'old-refresh',
      fakeFetch((url, init) => {
        capturedUrl = url
        capturedBody = init.body as string
        capturedContentType = (init.headers as Record<string, string>)['Content-Type']
        return new Response(
          JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
          { status: 200 },
        )
      }),
    )

    expect(capturedUrl).toBe('https://auth.x.ai/oauth2/token')
    expect(capturedContentType).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(capturedBody)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('old-refresh')
    expect(params.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828')
  })

  test('returns rotated credentials with an early-skewed expiry', async () => {
    const before = Date.now()
    const creds = await refreshXaiToken(
      'old-refresh',
      fakeFetch(
        () =>
          new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), {
            status: 200,
          }),
      ),
    )
    expect(creds.access).toBe('new-access')
    expect(creds.refresh).toBe('new-refresh')
    // 3600s minus the 5-minute skew = 3300s out, give or take test wall time.
    expect(creds.expires).toBeGreaterThan(before + 3200 * 1000)
    expect(creds.expires).toBeLessThanOrEqual(Date.now() + 3300 * 1000)
  })

  test('keeps the prior refresh token when the server omits a rotated one', async () => {
    const creds = await refreshXaiToken(
      'old-refresh',
      fakeFetch(() => new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 })),
    )
    expect(creds.refresh).toBe('old-refresh')
  })

  test('throws with status and body context on a non-2xx response', async () => {
    await expect(
      refreshXaiToken(
        'old-refresh',
        fakeFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 })),
      ),
    ).rejects.toThrow(/status=400/)
  })
})
