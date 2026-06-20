import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebexAccountRecord } from './schema'
import { SecretsWebexCredentialStore } from './webex-store'

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-webex-store-'))

function account(overrides: Partial<WebexAccountRecord> = {}): WebexAccountRecord {
  return {
    account_id: 'account-1',
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: 1_800_000_000,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SecretsWebexCredentialStore', () => {
  test('round-trips setAccount/getAccount on a host secrets file', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ email: 'user@example.com' }))

      expect(await store.getAccount()).toEqual(account({ email: 'user@example.com' }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('preserves renewal fields when later setAccount omits them', async () => {
    const dir = await tmp()
    try {
      const encryptedPassword = {
        v: 1 as const,
        alg: 'AES-256-GCM' as const,
        kid: 'kid',
        iv: 'iv',
        ciphertext: 'ciphertext',
        authTag: 'authTag',
        createdAt: '2026-01-01T00:00:00.000Z',
      }
      const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ email: 'user@example.com', encryptedPassword }))
      await store.setAccount(account({ access_token: 'access-2', refresh_token: 'refresh-2' }))

      const stored = await store.getAccount()
      expect(stored?.access_token).toBe('access-2')
      expect(stored?.refresh_token).toBe('refresh-2')
      expect(stored?.email).toBe('user@example.com')
      expect(stored?.encryptedPassword).toEqual(encryptedPassword)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('removeAccount clears the account and advances current account', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ account_id: 'a' }))
      await store.setAccount(account({ account_id: 'b' }))
      await store.setCurrentAccount('a')

      await store.removeAccount('a')

      expect(await store.getAccount('a')).toBeNull()
      expect((await store.getAccount())?.account_id).toBe('b')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('listAccounts marks the current account', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ account_id: 'a' }))
      await store.setAccount(account({ account_id: 'b' }))
      await store.setCurrentAccount('b')

      expect((await store.listAccounts()).map(({ account_id, is_current }) => ({ account_id, is_current }))).toEqual([
        { account_id: 'a', is_current: false },
        { account_id: 'b', is_current: true },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
