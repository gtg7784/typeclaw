import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InstagramAccount } from 'agent-messenger/instagram'

import {
  instagramConfigDir,
  runInstagramBootstrap,
  type InstagramAuthenticateResult,
  type InstagramLoginClient,
  type InstagramLoginCredentialManager,
} from './instagram-auth'

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-instagram-auth-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fakeManager(accountId = 'alice'): { manager: InstagramLoginCredentialManager; saved: InstagramAccount[] } {
  const saved: InstagramAccount[] = []
  let current: string | null = null
  return {
    saved,
    manager: {
      ensureAccountPaths: async (id) => ({ session_path: `/tmp/${id}/session.json` }),
      getAccount: async (id) => saved.find((account) => account.account_id === (id ?? current)) ?? null,
      setAccount: async (account) => {
        saved.push(account)
      },
      setCurrent: async (id) => {
        current = id
        return id === accountId
      },
    },
  }
}

function fakeClient(result: InstagramAuthenticateResult): InstagramLoginClient {
  return {
    authenticate: async () => result,
    setSessionPath: () => {},
    getUserId: () => result.userId || null,
  }
}

function observingClient(result: InstagramAuthenticateResult, onAuthenticate: () => void): InstagramLoginClient {
  return {
    authenticate: async () => {
      onAuthenticate()
      return result
    },
    setSessionPath: () => {},
    getUserId: () => result.userId || null,
  }
}

describe('runInstagramBootstrap', () => {
  test('points the SDK storage at the agent workspace during login, then restores the env', async () => {
    await withDir(async (dir) => {
      const savedEnv = process.env.AGENT_MESSENGER_CONFIG_DIR
      delete process.env.AGENT_MESSENGER_CONFIG_DIR
      try {
        const { manager } = fakeManager()
        let duringLogin: string | undefined
        await runInstagramBootstrap({
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: observingClient({ userId: '12345' }, () => {
            duringLogin = process.env.AGENT_MESSENGER_CONFIG_DIR
          }),
        })
        expect(duringLogin ?? '').toBe(instagramConfigDir(dir))
        expect(process.env.AGENT_MESSENGER_CONFIG_DIR).toBeUndefined()
      } finally {
        if (savedEnv === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR
        else process.env.AGENT_MESSENGER_CONFIG_DIR = savedEnv
      }
    })
  })

  test('mirrors SDK account metadata into secrets after clean authentication', async () => {
    await withDir(async (dir) => {
      const { manager, saved } = fakeManager()
      const status = await runInstagramBootstrap({
        username: 'alice',
        password: 'secret',
        agentDir: dir,
        credentialManager: manager,
        client: fakeClient({ userId: '12345' }),
      })
      expect(status).toEqual({ ok: true })
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({ account_id: 'alice', username: 'alice', pk: '12345' })

      const raw = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')) as {
        channels: {
          instagram: {
            currentAccount: string
            accounts: Record<string, { account_id: string; username: string; pk?: string }>
          }
        }
      }
      expect(raw.channels.instagram.currentAccount).toBe('alice')
      expect(raw.channels.instagram.accounts.alice).toMatchObject({
        account_id: 'alice',
        username: 'alice',
        pk: '12345',
      })
    })
  })

  test('reports login failures', async () => {
    await withDir(async (dir) => {
      const { manager } = fakeManager()
      const client: InstagramLoginClient = {
        authenticate: async () => {
          throw new Error('login exploded')
        },
        setSessionPath: () => {},
        getUserId: () => null,
      }
      const status = await runInstagramBootstrap({
        username: 'alice',
        password: 'secret',
        agentDir: dir,
        credentialManager: manager,
        client,
      })
      expect(status).toEqual({ ok: false, reason: 'login exploded' })
    })
  })

  test('fails clearly when 2FA is required', async () => {
    await withDir(async (dir) => {
      const { manager } = fakeManager()
      const status = await runInstagramBootstrap({
        username: 'alice',
        password: 'secret',
        agentDir: dir,
        credentialManager: manager,
        client: fakeClient({ userId: '', requiresTwoFactor: true, twoFactorInfo: {} }),
      })
      expect(status.ok).toBe(false)
      if (status.ok) throw new Error('expected failure')
      expect(status.reason).toContain('2FA/checkpoint')
      expect(status.reason).toContain('not yet supported')
    })
  })

  test('fails clearly when a checkpoint challenge is required', async () => {
    await withDir(async (dir) => {
      const { manager } = fakeManager()
      const status = await runInstagramBootstrap({
        username: 'alice',
        password: 'secret',
        agentDir: dir,
        credentialManager: manager,
        client: fakeClient({ userId: '', challengeRequired: true, challengePath: '/challenge/' }),
      })
      expect(status.ok).toBe(false)
      if (status.ok) throw new Error('expected failure')
      expect(status.reason).toContain('2FA/checkpoint')
      expect(status.reason).toContain('not yet supported')
    })
  })
})
