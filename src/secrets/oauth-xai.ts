import { createServer, type Server } from 'node:http'

import { getOAuthProvider, registerOAuthProvider } from '@mariozechner/pi-ai/oauth'
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from '@mariozechner/pi-ai/oauth'

// xAI (Grok) OAuth 2.0. xAI runs a standard OIDC authorization server at
// auth.x.ai that supports BOTH authorization-code + PKCE (loopback callback)
// and the device-authorization grant. We implement the auth-code path with a
// localhost callback server (same UX as pi-ai's anthropic provider) plus a
// manual-paste fallback for cross-device/SSH flows.
//
// There is no public developer console to register a third-party OAuth client,
// so — like every OSS Grok integration (Grok CLI, opencode, hermes-agent,
// pi-xai-oauth) — we reuse the Grok CLI's public client id. The `plan=generic`
// query param is load-bearing: loopback OAuth against this client id is
// rejected without it. `referrer` is attribution only.
//
// Endpoints below are the live values from
// https://auth.x.ai/.well-known/openid-configuration. The token endpoint speaks
// application/x-www-form-urlencoded (OAuth2 default) — NOT JSON like Anthropic.
export const XAI_OAUTH_PROVIDER_ID = 'xai'

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const AUTHORIZE_URL = 'https://auth.x.ai/oauth2/authorize'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 56121
const CALLBACK_PATH = '/callback'
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`
const SCOPES = 'openid profile email offline_access grok-cli:access api:access'
const REFERRER = 'typeclaw'
// Refresh slightly early so an in-flight request never races expiry.
const EXPIRY_SKEW_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000

type XaiTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// PKCE (RFC 7636, S256). pi-ai keeps its `generatePKCE` helper out of the
// public `/oauth` barrel, so we generate the verifier/challenge with Web Crypto
// directly — available in both Node and Bun.
async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) }
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // Not a full URL — fall through to query-string / bare-code handling.
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }
  return { code: value }
}

type CallbackServer = {
  server: Server
  cancelWait: () => void
  waitForCode: () => Promise<{ code: string; state: string | null } | null>
}

function successHtml(): string {
  return '<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>xAI authentication complete.</h2><p>You can close this window and return to the terminal.</p></body></html>'
}

// The OAuth `error` query param is provider-supplied and reflected into the
// callback page, so escape it to keep a crafted callback URL
// (`?error=<script>…`) from injecting markup into the local page.
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function errorHtml(message: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>xAI authentication failed.</h2><p>${escapeHtml(message)}</p></body></html>`
}

// Resolves to `null` when the fixed loopback port can't be bound (EADDRINUSE,
// sandbox bind restriction). The caller then falls back to manual-paste mode
// rather than failing the whole login — the browser callback is a convenience,
// not a hard requirement, since the user can always paste the redirect URL.
function startCallbackServer(expectedState: string): Promise<CallbackServer | null> {
  return new Promise((resolve) => {
    let settle: ((value: { code: string; state: string | null } | null) => void) | undefined
    const waitForCodePromise = new Promise<{ code: string; state: string | null } | null>((resolveWait) => {
      let settled = false
      settle = (value) => {
        if (settled) return
        settled = true
        resolveWait(value)
      }
    })

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '', `http://${CALLBACK_HOST}`)
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(errorHtml('Callback route not found.'))
          return
        }
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(errorHtml(`Error: ${error}`))
          return
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(errorHtml('Missing code parameter.'))
          return
        }
        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(errorHtml('State mismatch.'))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(successHtml())
        settle?.({ code, state })
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Internal error')
      }
    })

    server.on('error', () => {
      server.close()
      resolve(null)
    })
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        cancelWait: () => settle?.(null),
        waitForCode: () => waitForCodePromise,
      })
    })
  })
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

async function postForm(url: string, body: Record<string, string>, fetchImpl: FetchFn): Promise<XaiTokenResponse> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`xAI OAuth request failed. status=${response.status}; url=${url}; body=${text}`)
  }
  try {
    return JSON.parse(text) as XaiTokenResponse
  } catch {
    throw new Error(`xAI OAuth returned invalid JSON. url=${url}; body=${text}`)
  }
}

function toCredentials(token: XaiTokenResponse): OAuthCredentials {
  if (!token.access_token || !token.refresh_token || token.expires_in === undefined) {
    throw new Error('xAI OAuth response missing access_token, refresh_token, or expires_in')
  }
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
  }
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fetchImpl: FetchFn,
): Promise<OAuthCredentials> {
  const token = await postForm(
    TOKEN_URL,
    {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
    fetchImpl,
  )
  return toCredentials(token)
}

export async function loginXai(callbacks: OAuthLoginCallbacks, fetchImpl: FetchFn = fetch): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePkce()
  const server = await startCallbackServer(verifier)
  let code: string | undefined
  try {
    const authParams = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: verifier,
      plan: 'generic',
      referrer: REFERRER,
    })
    callbacks.onAuth({
      url: `${AUTHORIZE_URL}?${authParams.toString()}`,
      instructions:
        'Complete login in your browser. Grok shows a code to copy on the "could not establish connection" page — paste that code here. If the browser is on another machine, paste the code (or the final redirect URL) here.',
    })

    if (server && callbacks.onManualCodeInput) {
      // Race the local callback server against a manual paste: whichever lands
      // a code first wins (cross-device/SSH logins can't reach the loopback).
      let manualInput: string | undefined
      let manualError: Error | undefined
      const manualPromise = callbacks
        .onManualCodeInput()
        .then((input) => {
          manualInput = input
          server.cancelWait()
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err))
          server.cancelWait()
        })

      const result = await server.waitForCode()
      if (manualError) throw manualError
      if (result?.code) {
        code = result.code
      } else if (manualInput) {
        code = parseManualCode(manualInput, verifier)
      }
      if (!code) {
        await manualPromise
        if (manualError) throw manualError
        if (manualInput) {
          code = parseManualCode(manualInput, verifier)
        }
      }
    } else if (server) {
      const result = await server.waitForCode()
      if (result?.code) code = result.code
    } else if (callbacks.onManualCodeInput) {
      // No callback server bound — manual paste is the only path to a code.
      code = parseManualCode(await callbacks.onManualCodeInput(), verifier)
    }

    if (!code) {
      const input = await callbacks.onPrompt({
        message: 'Paste the authorization code or full redirect URL:',
        placeholder: REDIRECT_URI,
      })
      code = parseManualCode(input, verifier)
    }

    if (!code) throw new Error('Missing authorization code')

    callbacks.onProgress?.('Exchanging authorization code for tokens...')
    return await exchangeAuthorizationCode(code, verifier, fetchImpl)
  } finally {
    server?.server.close()
  }
}

function parseManualCode(input: string, verifier: string): string | undefined {
  const parsed = parseAuthorizationInput(input)
  if (parsed.state && parsed.state !== verifier) throw new Error('OAuth state mismatch')
  return parsed.code
}

export async function refreshXaiToken(refreshToken: string, fetchImpl: FetchFn = fetch): Promise<OAuthCredentials> {
  const token = await postForm(
    TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    },
    fetchImpl,
  )
  // Some OAuth servers omit a rotated refresh token on refresh; keep the prior
  // one so the credential stays usable across the next cycle.
  return toCredentials({ ...token, refresh_token: token.refresh_token ?? refreshToken })
}

export const xaiOAuthProvider: OAuthProviderInterface = {
  id: XAI_OAUTH_PROVIDER_ID,
  name: 'xAI (Grok)',
  usesCallbackServer: true,
  login: loginXai,
  refreshToken: (credentials) => refreshXaiToken(credentials.refresh),
  getApiKey: (credentials) => credentials.access,
}

let registered = false

// pi-ai ships no built-in xAI OAuth provider, so we register ours. Idempotent
// and called from `createSecretsStoreForAgent` — the single chokepoint both the
// init-time login path and the container-runtime auth/refresh path go through —
// so the provider is always present before `AuthStorage.login()` /
// `getApiKey()` look it up via `getOAuthProvider('xai')`.
export function registerXaiOAuthProvider(): void {
  if (registered && getOAuthProvider(XAI_OAUTH_PROVIDER_ID)) return
  registerOAuthProvider(xaiOAuthProvider)
  registered = true
}
