import { createPrivateKey } from 'node:crypto'

import { resolveSecret, type Secret } from '@/secrets/resolve'

import type { GithubAuthContext, GithubAuthStrategy, GithubInstallationGrants, GithubSelfUser } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders, githubPublicHeaders } from './auth-pat'

type TokenCacheEntry = { value: string; expiresAt: number }

export class AppAuthStrategy implements GithubAuthStrategy {
  private readonly appId: number
  private readonly privateKeyPem: string
  private readonly fetchImpl: typeof fetch
  // Installation-level and repository-restricted tokens are distinct
  // authorities even when GitHub serves them from the same installation.
  private readonly tokenCache = new Map<string, TokenCacheEntry>()
  private readonly repoInstallationCache = new Map<string, number>()
  private soleInstallationId: number | null = null
  private _selfUser: GithubSelfUser | null = null

  constructor(options: { appId: number; privateKey: Secret; fetchImpl?: typeof fetch }) {
    const privateKeyPem = resolveSecret(options.privateKey, undefined, process.env)
    if (privateKeyPem === undefined || privateKeyPem.trim() === '') throw new Error('GitHub App private key is missing')
    this.appId = options.appId
    this.privateKeyPem = privateKeyPem
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async token(context?: GithubAuthContext): Promise<string> {
    const jwt = await this.mintJwt()
    const installId = await this.resolveInstallationId(jwt, context)
    return this.installationToken(jwt, installId, context?.repoSlug)
  }

  async authHeaders(context?: GithubAuthContext): Promise<HeadersInit> {
    return githubJsonHeaders(await this.token(context))
  }

  private async installationToken(jwt: string, installId: number, repoSlug?: string): Promise<string> {
    const repository = repoSlug === undefined || repoSlug === '' ? undefined : canonicalRepoSlug(repoSlug)
    const cacheKey =
      repository === undefined ? `${installId}:installation` : `${installId}:repository:${repository.slug}`
    const cached = this.tokenCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) return cached.value
    const response = await this.fetchImpl(`${GITHUB_API_BASE}/app/installations/${installId}/access_tokens`, {
      method: 'POST',
      headers: githubJsonHeaders(jwt),
      body: JSON.stringify(repository === undefined ? {} : { repositories: [repository.name] }),
    })
    if (!response.ok) throw new Error(`GitHub App token mint failed: ${response.status}`)
    const raw = (await response.json()) as { token?: unknown; expires_at?: unknown }
    if (typeof raw.token !== 'string') throw new Error('GitHub App token response missing token')
    const expiresAt = typeof raw.expires_at === 'string' ? Date.parse(raw.expires_at) : Date.now() + 60 * 60 * 1000
    this.tokenCache.set(cacheKey, { value: raw.token, expiresAt })
    return raw.token
  }

  async getSelf(): Promise<GithubSelfUser> {
    if (this._selfUser) return this._selfUser
    const jwt = await this.mintJwt()
    const appResponse = await this.fetchImpl(`${GITHUB_API_BASE}/app`, { headers: githubJsonHeaders(jwt) })
    if (!appResponse.ok) throw new Error(`GitHub App preflight failed: ${appResponse.status}`)
    const app = (await appResponse.json()) as { slug?: unknown }
    if (typeof app.slug !== 'string') throw new Error('GitHub /app response missing slug')

    const botLogin = `${app.slug}[bot]`
    // GET /users/{login} is a public endpoint and rejects App JWTs with 401.
    // Installation tokens also fail here (404 — they're scoped to repos, not user lookups).
    // The bot user is publicly visible, so no auth is the only path that works.
    const userResponse = await this.fetchImpl(`${GITHUB_API_BASE}/users/${encodeURIComponent(botLogin)}`, {
      headers: githubPublicHeaders(),
    })
    if (!userResponse.ok) throw new Error(`GitHub bot user lookup failed: ${userResponse.status}`)
    const user = (await userResponse.json()) as { id?: unknown; login?: unknown }
    if (typeof user.id !== 'number' || typeof user.login !== 'string') {
      throw new Error('GitHub bot user response missing id/login')
    }
    this._selfUser = { id: user.id, login: user.login }
    return this._selfUser
  }

  async getInstallationGrants(context?: GithubAuthContext): Promise<GithubInstallationGrants> {
    const jwt = await this.mintJwt()
    const installId = await this.resolveInstallationId(jwt, context)
    const response = await this.fetchImpl(`${GITHUB_API_BASE}/app/installations/${installId}`, {
      headers: githubJsonHeaders(jwt),
    })
    if (!response.ok) throw new Error(`GitHub App installation fetch failed: ${response.status}`)
    const raw = (await response.json()) as { permissions?: unknown; events?: unknown }
    const permissions: Record<string, 'read' | 'write' | 'admin'> = {}
    if (raw.permissions !== null && typeof raw.permissions === 'object') {
      for (const [key, value] of Object.entries(raw.permissions as Record<string, unknown>)) {
        if (value === 'read' || value === 'write' || value === 'admin') permissions[key] = value
      }
    }
    const events = Array.isArray(raw.events) ? raw.events.filter((e): e is string => typeof e === 'string') : []
    return { permissions, events }
  }

  async dispose(): Promise<void> {
    this.tokenCache.clear()
    this.repoInstallationCache.clear()
  }

  private async mintJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const iat = now - 60
    const exp = iat + 600
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ iat, exp, iss: this.appId }))
    const signingInput = `${header}.${payload}`
    const key = await importRsaPrivateKey(this.privateKeyPem)
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      new TextEncoder().encode(signingInput),
    )
    return `${signingInput}.${base64url(Buffer.from(signature))}`
  }

  private async resolveInstallationId(jwt: string, context?: GithubAuthContext): Promise<number> {
    if (context?.repoSlug !== undefined && context.repoSlug !== '') {
      const repository = canonicalRepoSlug(context.repoSlug)
      return this.resolveInstallationByEndpoint(
        jwt,
        `repos/${context.repoSlug}/installation`,
        `repository:${repository.slug}`,
        context.repoSlug,
      )
    }
    if (context?.owner !== undefined && context.owner !== '') {
      return this.resolveInstallationByEndpoint(
        jwt,
        `orgs/${context.owner}/installation`,
        `owner:${context.owner.toLocaleLowerCase()}`,
        context.owner,
      )
    }
    if (this.soleInstallationId !== null) return this.soleInstallationId
    const response = await this.fetchImpl(`${GITHUB_API_BASE}/app/installations`, { headers: githubJsonHeaders(jwt) })
    if (!response.ok) throw new Error(`GitHub App installations fetch failed: ${response.status}`)
    const list = (await response.json()) as Array<{ id?: unknown }>
    if (list.length === 0) throw new Error('GitHub App has no installations')
    if (list.length > 1) {
      const ids = list.map((installation) => installation.id).join(', ')
      throw new Error(`GitHub App has multiple installations (${ids}); a repo must be specified to select one`)
    }
    const id = list[0]?.id
    if (typeof id !== 'number') throw new Error('GitHub App installation missing id')
    this.soleInstallationId = id
    return id
  }

  private async resolveInstallationByEndpoint(
    jwt: string,
    path: string,
    cacheKey: string,
    target: string,
  ): Promise<number> {
    const cached = this.repoInstallationCache.get(cacheKey)
    if (cached !== undefined) return cached
    const response = await this.fetchImpl(`${GITHUB_API_BASE}/${path}`, { headers: githubJsonHeaders(jwt) })
    if (response.status === 404) {
      throw new Error(`GitHub App is not installed for ${target} or lacks access to that repository`)
    }
    if (!response.ok) throw new Error(`GitHub App installation lookup for ${target} failed: ${response.status}`)
    const raw = (await response.json()) as { id?: unknown }
    if (typeof raw.id !== 'number') throw new Error(`GitHub App installation for ${target} missing id`)
    this.repoInstallationCache.set(cacheKey, raw.id)
    return raw.id
  }
}

function canonicalRepoSlug(repoSlug: string): { slug: string; name: string } {
  const slug = repoSlug.toLocaleLowerCase()
  const [owner, name, ...rest] = slug.split('/')
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) {
    throw new Error(`Invalid GitHub repository slug: ${repoSlug}`)
  }
  return { slug, name }
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  // GitHub's "Generate a private key" button hands out PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`),
  // but WebCrypto's importKey only accepts PKCS#8. Round-trip through node:crypto, which accepts
  // both PKCS#1 and PKCS#8 PEM, then re-export as PKCS#8 DER for WebCrypto.
  const pkcs8Der = pemToPkcs8Der(pem)
  return await crypto.subtle.importKey('pkcs8', pkcs8Der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'sign',
  ])
}

function pemToPkcs8Der(pem: string): ArrayBuffer {
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pem)) {
    throw new Error('GitHub App private key is encrypted; provide an unencrypted PEM')
  }
  let keyObject
  try {
    keyObject = createPrivateKey({ key: pem, format: 'pem' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`GitHub App private key is invalid: ${message}`)
  }
  if (keyObject.asymmetricKeyType !== 'rsa') {
    throw new Error(`GitHub App private key must be RSA, got ${keyObject.asymmetricKeyType ?? 'unknown'}`)
  }
  const der = keyObject.export({ type: 'pkcs8', format: 'der' })
  const out = new ArrayBuffer(der.byteLength)
  new Uint8Array(out).set(der)
  return out
}
