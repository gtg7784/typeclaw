import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsTeamsCredentialStore } from '@/secrets/teams-store'

const realTeams = await import('agent-messenger/teams')
mock.module('agent-messenger/teams', () => ({
  ...realTeams,
  loginWithDeviceCode: async () => {
    throw new Error('test must inject loginWithDeviceCode')
  },
}))

type TeamsAuthModule = typeof import('./teams-auth')
type LoginWithDeviceCodeFn = NonNullable<Parameters<TeamsAuthModule['runTeamsBootstrap']>[0]['loginWithDeviceCode']>

let teamsAuth: TeamsAuthModule

beforeAll(async () => {
  teamsAuth = await import('./teams-auth')
})

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-teams-test-'))

type FakeAccount = {
  token: string
  token_expires_at?: string
  region?: 'amer' | 'emea' | 'apac'
  aad_refresh_token?: string
  aad_client_id?: string
  aad_tenant_id?: string
}

// A stand-in for the SDK's TeamsCredentialManager: the real login writes the
// minted token into it, so the fake login populates `accounts` the same way and
// runTeamsBootstrap reads it back through loadConfig().
function fakeCredManager(accounts: Record<string, FakeAccount>) {
  return {
    async loadConfig() {
      return { current_account: null, accounts }
    },
  } as unknown as InstanceType<typeof realTeams.TeamsCredentialManager>
}

describe('runTeamsBootstrap', () => {
  test('persists the minted Teams account to secrets.json', async () => {
    const agentDir = await tmp()
    try {
      const credManager = fakeCredManager({
        work: {
          token: 'skype-token-abc',
          token_expires_at: '2026-01-01T01:00:00Z',
          region: 'amer',
          aad_refresh_token: 'aad-refresh',
          aad_client_id: 'client-1',
          aad_tenant_id: 'tenant-1',
        },
      })

      const fakeLogin: LoginWithDeviceCodeFn = async (callbacks) => {
        expect(callbacks.accountType).toBe('work')
        await callbacks.onCode({
          verificationUri: 'https://microsoft.com/devicelogin',
          verificationUriComplete: 'https://microsoft.com/devicelogin?otc=ABCD',
          userCode: 'ABCD-EFGH',
          expiresAt: Date.now() + 600_000,
        })
        return { accountType: 'work', userName: 'Agent Smith', teams: [], current: null }
      }

      const result = await teamsAuth.runTeamsBootstrap({
        agentDir,
        accountType: 'work',
        callbacks: { onCode: () => {} },
        loginWithDeviceCode: fakeLogin,
        credManager,
      })

      expect(result).toEqual({ ok: true })

      const store = new SecretsTeamsCredentialStore({ mode: 'host', secretsPath: teamsAuth.teamsSecretsPath(agentDir) })
      const account = await store.getAccount()
      expect(account?.account_id).toBe('Agent Smith')
      expect(account?.access_token).toBe('skype-token-abc')
      expect(account?.token_expires_at).toBe('2026-01-01T01:00:00Z')
      expect(account?.account_type).toBe('work')
      expect(account?.region).toBe('amer')
      expect(account?.user_name).toBe('Agent Smith')
      expect(account?.aad_refresh_token).toBe('aad-refresh')
      expect(account?.aad_client_id).toBe('client-1')
      expect(account?.aad_tenant_id).toBe('tenant-1')

      const stored = JSON.parse(await readFile(teamsAuth.teamsSecretsPath(agentDir), 'utf8')) as {
        channels: { teams: { currentAccount: string } }
      }
      expect(stored.channels.teams.currentAccount).toBe('Agent Smith')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('falls back to account type as id when the login has no user name', async () => {
    const agentDir = await tmp()
    try {
      const credManager = fakeCredManager({ personal: { token: 'skype-personal' } })
      const result = await teamsAuth.runTeamsBootstrap({
        agentDir,
        accountType: 'personal',
        callbacks: { onCode: () => {} },
        loginWithDeviceCode: async () => ({ accountType: 'personal', userName: '', teams: [], current: null }),
        credManager,
      })

      expect(result).toEqual({ ok: true })
      const store = new SecretsTeamsCredentialStore({ mode: 'host', secretsPath: teamsAuth.teamsSecretsPath(agentDir) })
      expect((await store.getAccount())?.account_id).toBe('personal')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('fails when the login persists no usable token', async () => {
    const agentDir = await tmp()
    try {
      const credManager = fakeCredManager({})
      const result = await teamsAuth.runTeamsBootstrap({
        agentDir,
        accountType: 'work',
        callbacks: { onCode: () => {} },
        loginWithDeviceCode: async () => ({ accountType: 'work', userName: 'X', teams: [], current: null }),
        credManager,
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toMatch(/did not persist a usable Teams token/)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure when the device-code login throws', async () => {
    const agentDir = await tmp()
    try {
      const result = await teamsAuth.runTeamsBootstrap({
        agentDir,
        accountType: 'work',
        callbacks: { onCode: () => {} },
        loginWithDeviceCode: async () => {
          throw new Error('authorization declined')
        },
        credManager: fakeCredManager({}),
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('authorization declined')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
