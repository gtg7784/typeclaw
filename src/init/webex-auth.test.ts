import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createKeyStore } from '@/secrets/keys'
import { SecretsWebexCredentialStore } from '@/secrets/webex-store'

// Spread the real module so other consumers loading `agent-messenger/webex`
// (e.g. webex-id-ref's `decodeWebexId` re-export) still resolve — bun's
// `mock.module` is process-global, so a partial mock would strip every other
// export for the rest of the suite.
const realWebex = await import('agent-messenger/webex')
mock.module('agent-messenger/webex', () => ({
  ...realWebex,
  loginWithPassword: async () => {
    throw new Error('test must inject loginWithPassword')
  },
}))

type WebexAuthModule = typeof import('./webex-auth')
type LoginWithPasswordFn = WebexAuthModule['runWebexBootstrap'] extends (input: infer I) => Promise<unknown>
  ? NonNullable<I extends { loginWithPassword?: infer F } ? F : never>
  : never

let webexAuth: WebexAuthModule

beforeAll(async () => {
  webexAuth = await import('./webex-auth')
})

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-webex-test-'))

function isolatedKeyStore(agentDir: string): { keyStore: ReturnType<typeof createKeyStore>; containerName: string } {
  return {
    keyStore: createKeyStore({ keysDir: join(agentDir, '.test-keys') }),
    containerName: 'test-agent',
  }
}

describe('runWebexBootstrap', () => {
  test('persists Webex credentials when login succeeds', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginWithPasswordFn = async (email: string, password: string, opts?: { idbrokerHost?: string }) => {
        expect(email).toBe('user@example.com')
        expect(password).toBe('secret')
        expect(opts?.idbrokerHost).toBe('idbroker.example.com')
        return {
          accessToken: 'access-abc',
          refreshToken: 'refresh-xyz',
          expiresAt: 1_800_000_000,
          deviceUrl: 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-1',
          userId: 'webex-user-1',
        }
      }

      const result = await webexAuth.runWebexBootstrap({
        email: 'user@example.com',
        password: 'secret',
        agentDir,
        idbrokerHost: 'idbroker.example.com',
        loginWithPassword: fake,
        ...isolatedKeyStore(agentDir),
      })

      expect(result).toEqual({ ok: true })
      const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: webexAuth.webexSecretsPath(agentDir) })
      const account = await store.getAccount()
      expect(account?.account_id).toBe('webex-user-1')
      expect(account?.access_token).toBe('access-abc')
      expect(account?.refresh_token).toBe('refresh-xyz')
      expect(account?.device_url).toBe('https://wdm-a.wbx2.com/wdm/api/v1/devices/device-1')
      expect(account?.user_id).toBe('webex-user-1')
      expect(account?.email).toBe('user@example.com')
      expect(account?.encryptedPassword?.v).toBe(1)
      expect(account?.encryptedPassword?.alg).toBe('AES-256-GCM')

      const stored = JSON.parse(await readFile(webexAuth.webexSecretsPath(agentDir), 'utf8')) as {
        channels: { webex: { currentAccount: string } }
      }
      expect(stored.channels.webex.currentAccount).toBe('webex-user-1')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('uses email as account id when userId is absent', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginWithPasswordFn = async () => ({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1_800_000_000,
        deviceUrl: '',
        userId: '',
      })

      const result = await webexAuth.runWebexBootstrap({
        email: 'user@example.com',
        password: 'secret',
        agentDir,
        loginWithPassword: fake,
        ...isolatedKeyStore(agentDir),
      })

      expect(result).toEqual({ ok: true })
      const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: webexAuth.webexSecretsPath(agentDir) })
      expect((await store.getAccount())?.account_id).toBe('user@example.com')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure when login throws', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginWithPasswordFn = async () => {
        throw new Error('bad credentials')
      }
      const result = await webexAuth.runWebexBootstrap({
        email: 'user@example.com',
        password: 'wrong',
        agentDir,
        loginWithPassword: fake,
        ...isolatedKeyStore(agentDir),
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('bad credentials')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
