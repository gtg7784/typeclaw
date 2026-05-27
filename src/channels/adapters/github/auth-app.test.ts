import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'

import { AppAuthStrategy } from './auth-app'

const fixedNow = Date.parse('2026-05-18T12:00:00Z')

let privateKeyPem = ''
let privateKeyPkcs1Pem = ''
let publicKeyPem = ''
let originalNow: () => number

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  privateKeyPkcs1Pem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
})

beforeEach(() => {
  originalNow = Date.now
  Date.now = () => fixedNow
})

afterEach(() => {
  Date.now = originalNow
})

describe('AppAuthStrategy', () => {
  it('mints a verifiable RS256 JWT with GitHub App claims', async () => {
    let jwt = ''
    const strategy = new AppAuthStrategy({
      appId: 12345,
      privateKey: { value: privateKeyPem },
      installationId: 67890,
      fetchImpl: fakeFetch(async (_url, init) => {
        jwt = bearerToken(init)
        return Response.json({ token: 'installation-token', expires_at: '2026-05-18T13:00:00Z' })
      }),
    })

    await strategy.token()

    const decoded = decodeJwt(jwt)
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decoded.payload).toEqual({ iat: fixedNow / 1000 - 60, exp: fixedNow / 1000 + 540, iss: 12345 })
    expect(verifyJwtSignature(jwt)).toBe(true)
  })

  it('mints and caches installation tokens for configured installations', async () => {
    const calls: string[] = []
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      installationId: 99,
      fetchImpl: fakeFetch(async (url) => {
        calls.push(String(url))
        return Response.json({ token: 'cached-token', expires_at: '2026-05-18T13:00:00Z' })
      }),
    })

    await expect(strategy.token()).resolves.toBe('cached-token')
    await expect(strategy.token()).resolves.toBe('cached-token')

    expect(calls).toEqual(['https://api.github.com/app/installations/99/access_tokens'])
  })

  it('refreshes cached installation tokens inside the five-minute boundary', async () => {
    const tokens = ['first-token', 'second-token']
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      installationId: 99,
      fetchImpl: fakeFetch(async () =>
        Response.json({ token: tokens.shift() ?? 'extra-token', expires_at: '2026-05-18T13:00:00Z' }),
      ),
    })

    await expect(strategy.token()).resolves.toBe('first-token')
    Date.now = () => Date.parse('2026-05-18T12:56:00Z')

    await expect(strategy.token()).resolves.toBe('second-token')
  })

  it('auto-discovers a single installation id', async () => {
    const calls: string[] = []
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      fetchImpl: fakeFetch(async (url) => {
        calls.push(String(url))
        if (String(url).endsWith('/app/installations')) return Response.json([{ id: 777 }])
        return Response.json({ token: 'auto-token', expires_at: '2026-05-18T13:00:00Z' })
      }),
    })

    await expect(strategy.token()).resolves.toBe('auto-token')

    expect(calls).toEqual([
      'https://api.github.com/app/installations',
      'https://api.github.com/app/installations/777/access_tokens',
    ])
  })

  it('rejects apps without installations', async () => {
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      fetchImpl: fakeFetch(async () => Response.json([])),
    })

    await expect(strategy.token()).rejects.toThrow(/no installations/i)
  })

  it('rejects ambiguous installation auto-discovery with listed ids', async () => {
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      fetchImpl: fakeFetch(async () => Response.json([{ id: 11 }, { id: 22 }])),
    })

    await expect(strategy.token()).rejects.toThrow(/multiple installations \(11, 22\)/i)
  })

  it('accepts PKCS#1 RSA private keys (the format GitHub hands out by default)', async () => {
    let jwt = ''
    const strategy = new AppAuthStrategy({
      appId: 12345,
      privateKey: { value: privateKeyPkcs1Pem },
      installationId: 67890,
      fetchImpl: fakeFetch(async (_url, init) => {
        jwt = bearerToken(init)
        return Response.json({ token: 'installation-token', expires_at: '2026-05-18T13:00:00Z' })
      }),
    })

    await strategy.token()

    expect(privateKeyPkcs1Pem).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(verifyJwtSignature(jwt)).toBe(true)
  })

  it('rejects encrypted private keys with a clear message', async () => {
    const encryptedPem = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'topsecret' },
    }).privateKey

    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: encryptedPem },
      installationId: 99,
      fetchImpl: fakeFetch(async () => new Response('unreachable', { status: 500 })),
    })

    await expect(strategy.token()).rejects.toThrow(/encrypted/i)
  })

  it('rejects malformed PEM input with a descriptive error', async () => {
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: '-----BEGIN RSA PRIVATE KEY-----\nnot-base64\n-----END RSA PRIVATE KEY-----\n' },
      installationId: 99,
      fetchImpl: fakeFetch(async () => new Response('unreachable', { status: 500 })),
    })

    await expect(strategy.token()).rejects.toThrow(/invalid/i)
  })

  it('resolves and caches the GitHub App bot user', async () => {
    const calls: string[] = []
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      fetchImpl: fakeFetch(async (url) => {
        calls.push(String(url))
        if (String(url).endsWith('/app')) return Response.json({ slug: 'typeclaw' })
        return Response.json({ id: 42, login: 'typeclaw[bot]' })
      }),
    })

    await expect(strategy.getSelf()).resolves.toEqual({ id: 42, login: 'typeclaw[bot]' })
    await expect(strategy.getSelf()).resolves.toEqual({ id: 42, login: 'typeclaw[bot]' })

    expect(calls).toEqual(['https://api.github.com/app', 'https://api.github.com/users/typeclaw%5Bbot%5D'])
  })

  it('looks up the bot user without an Authorization header', async () => {
    const usersAuth: (string | null)[] = []
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      fetchImpl: fakeFetch(async (url, init) => {
        if (String(url).endsWith('/app')) return Response.json({ slug: 'typeclaw' })
        usersAuth.push(new Headers(init?.headers).get('authorization'))
        return Response.json({ id: 42, login: 'typeclaw[bot]' })
      }),
    })

    await strategy.getSelf()

    expect(usersAuth).toEqual([null])
  })

  it('surfaces the upstream status when the bot user lookup fails', async () => {
    const strategy = new AppAuthStrategy({
      appId: 1,
      privateKey: { value: privateKeyPem },
      fetchImpl: fakeFetch(async (url) => {
        if (String(url).endsWith('/app')) return Response.json({ slug: 'typeclaw' })
        return new Response('Bad credentials', { status: 401 })
      }),
    })

    await expect(strategy.getSelf()).rejects.toThrow(/bot user lookup failed: 401/i)
  })
})

function fakeFetch(handler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} })
}

function bearerToken(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
}

function decodeJwt(jwt: string): { header: unknown; payload: unknown } {
  const [header, payload] = jwt.split('.')
  return { header: parseBase64urlJson(header ?? ''), payload: parseBase64urlJson(payload ?? '') }
}

function parseBase64urlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

function verifyJwtSignature(jwt: string): boolean {
  const [header, payload, signature] = jwt.split('.')
  const verify = createVerify('RSA-SHA256')
  verify.update(`${header}.${payload}`)
  verify.end()
  return verify.verify(publicKeyPem, Buffer.from((signature ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}
