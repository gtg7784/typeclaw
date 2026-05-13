import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { KakaoAccountCredentials, PendingLoginState } from 'agent-messenger/kakaotalk'

import { SecretsKakaoCredentialStore } from './kakao-store'

async function withStore<T>(fn: (store: SecretsKakaoCredentialStore, secretsPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-store-'))
  try {
    const secretsPath = join(root, 'secrets.json')
    return await fn(new SecretsKakaoCredentialStore({ mode: 'host', secretsPath }), secretsPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

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

describe('SecretsKakaoCredentialStore host mode', () => {
  test('round-trips setAccount through secrets.json', async () => {
    await withStore(async (store, secretsPath) => {
      await store.setAccount(account('user-1'))

      expect(await store.getAccount()).toEqual(account('user-1'))
      const raw = JSON.parse(await readFile(secretsPath, 'utf8')) as { channels: Record<string, unknown> }
      expect(raw.channels.kakaotalk).toEqual({ currentAccount: 'user-1', accounts: { 'user-1': account('user-1') } })
    })
  })

  test('supports multiple accounts and current account switching', async () => {
    await withStore(async (store) => {
      await store.setAccount(account('user-1'))
      await store.setAccount(account('user-2'))
      await store.setCurrentAccount('user-2')

      expect(await store.getAccount()).toEqual(account('user-2'))
      expect(await store.getAccount('user-1')).toEqual(account('user-1'))
      expect(await store.listAccounts()).toEqual([
        { ...account('user-1'), is_current: false },
        { ...account('user-2'), is_current: true },
      ])
    })
  })

  test('removeAccount deletes the account and picks a replacement current account', async () => {
    await withStore(async (store) => {
      await store.setAccount(account('user-1'))
      await store.setAccount(account('user-2'))
      await store.removeAccount('user-1')

      expect(await store.getAccount('user-1')).toBeNull()
      expect((await store.load()).current_account).toBe('user-2')
    })
  })

  test('round-trips pending login state', async () => {
    await withStore(async (store) => {
      const pending: PendingLoginState = {
        device_uuid: 'pending-device',
        device_type: 'tablet',
        email: 'user@example.com',
        created_at: '2026-01-01T00:00:00.000Z',
      }

      await store.savePendingLogin(pending)
      expect(await store.loadPendingLogin()).toEqual(pending)
      await store.clearPendingLogin()
      expect(await store.loadPendingLogin()).toBeNull()
    })
  })

  test('serializes concurrent setAccount calls without losing accounts', async () => {
    await withStore(async (store) => {
      await Promise.all([store.setAccount(account('user-1')), store.setAccount(account('user-2'))])

      const loaded = await store.load()
      expect(Object.keys(loaded.accounts).sort()).toEqual(['user-1', 'user-2'])
    })
  })
})
