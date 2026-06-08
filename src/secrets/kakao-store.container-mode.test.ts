import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { KakaoAccountCredentials } from 'agent-messenger/kakaotalk'

import type { Request, Response } from '@/hostd/protocol'

import { SecretsKakaoCredentialStore } from './kakao-store'
import { kakaoChannelBlockSchema } from './schema'
import { SecretsBackend } from './storage'

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function account(id: string, overrides: Partial<KakaoAccountCredentials> = {}): KakaoAccountCredentials {
  return {
    account_id: id,
    oauth_token: `oauth-${id}`,
    user_id: id,
    refresh_token: `refresh-${id}`,
    device_uuid: `device-${id}`,
    device_type: 'tablet',
    auth_method: 'login',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function startFakeHostd(
  secretsPath: string,
  token: string,
  containerName: string,
): { url: string; patches: Request[] } {
  const patches: Request[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${token}`) {
        return json({ ok: false, reason: 'invalid restart token' }, 403)
      }
      const rpc = (await req.json()) as Request
      patches.push(rpc)
      if (rpc.kind !== 'secrets-patch') return json({ ok: false, reason: 'unsupported' }, 403)
      if (rpc.containerName !== containerName) return json({ ok: false, reason: 'not registered' }, 403)
      if (!('kakaotalk' in rpc.patch.channels)) return json({ ok: false, reason: 'expected kakaotalk patch' }, 403)
      const block = kakaoChannelBlockSchema.parse(rpc.patch.channels.kakaotalk)
      await new SecretsBackend(secretsPath).updateChannelsAsync(async (channels) => ({
        result: undefined,
        next: { ...channels, kakaotalk: block },
      }))
      return json({ ok: true, result: { containerName, patched: true } })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, patches }
}

describe('SecretsKakaoCredentialStore container mode', () => {
  test('reads an absent secrets.json as empty without creating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-store-container-'))
    try {
      const secretsPath = join(root, 'secrets.json')
      const store = new SecretsKakaoCredentialStore({
        mode: 'container',
        secretsPath,
        hostdUrl: 'http://127.0.0.1:1',
        restartToken: 'secret',
        containerName: 'coder',
      })

      expect(await store.load()).toEqual({ current_account: null, accounts: {} })
      expect(existsSync(secretsPath)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('routes writes through secrets-patch and reads the updated local envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-store-container-'))
    try {
      const secretsPath = join(root, 'secrets.json')
      new SecretsBackend(secretsPath).writeChannelsSync({})
      const hostd = startFakeHostd(secretsPath, 'secret', 'coder')
      const store = new SecretsKakaoCredentialStore({
        mode: 'container',
        secretsPath,
        hostdUrl: hostd.url,
        restartToken: 'secret',
        containerName: 'coder',
      })

      await store.setAccount(account('user-1'))

      expect(hostd.patches).toHaveLength(1)
      expect(hostd.patches[0]?.kind).toBe('secrets-patch')
      expect(await store.getAccount()).toEqual(account('user-1'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('serializes concurrent writes before sending full-block patches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-store-container-'))
    try {
      const secretsPath = join(root, 'secrets.json')
      new SecretsBackend(secretsPath).writeChannelsSync({})
      const hostd = startFakeHostd(secretsPath, 'secret', 'coder')
      const store = new SecretsKakaoCredentialStore({
        mode: 'container',
        secretsPath,
        hostdUrl: hostd.url,
        restartToken: 'secret',
        containerName: 'coder',
      })

      await Promise.all([store.setAccount(account('user-1')), store.setAccount(account('user-2'))])

      const loaded = await store.load()
      expect(Object.keys(loaded.accounts).sort()).toEqual(['user-1', 'user-2'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('surfaces hostd write failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-store-container-'))
    try {
      const secretsPath = join(root, 'secrets.json')
      new SecretsBackend(secretsPath).writeChannelsSync({})
      const hostd = startFakeHostd(secretsPath, 'secret', 'coder')
      const store = new SecretsKakaoCredentialStore({
        mode: 'container',
        secretsPath,
        hostdUrl: hostd.url,
        restartToken: 'wrong',
        containerName: 'coder',
      })

      await expect(store.setAccount(account('user-1'))).rejects.toThrow(/secrets-patch failed/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function json(response: Response, status = 200): globalThis.Response {
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
