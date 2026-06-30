import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsInstagramCredentialStore } from './instagram-store'
import type { InstagramAccountRecord } from './schema'

async function withStore<T>(
  fn: (store: SecretsInstagramCredentialStore, secretsPath: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-instagram-store-'))
  try {
    const secretsPath = join(root, 'secrets.json')
    return await fn(new SecretsInstagramCredentialStore({ mode: 'host', secretsPath }), secretsPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function account(id: string, overrides: Partial<InstagramAccountRecord> = {}): InstagramAccountRecord {
  return {
    account_id: id,
    username: `user-${id}`,
    pk: `pk-${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SecretsInstagramCredentialStore host mode', () => {
  test('round-trips setAccount through secrets.json#channels.instagram', async () => {
    await withStore(async (store, secretsPath) => {
      await store.setAccount(account('ig-1'))
      expect(await store.getAccount()).toEqual(account('ig-1'))
      const raw = JSON.parse(await readFile(secretsPath, 'utf8')) as { channels: Record<string, unknown> }
      expect(raw.channels.instagram).toEqual({ currentAccount: 'ig-1', accounts: { 'ig-1': account('ig-1') } })
    })
  })

  test('supports list, current-account switching, and remove', async () => {
    await withStore(async (store) => {
      await store.setAccount(account('ig-1'))
      await store.setAccount(account('ig-2'))
      await store.setCurrentAccount('ig-2')
      expect(await store.getAccount()).toEqual(account('ig-2'))
      expect(await store.listAccounts()).toEqual([
        { ...account('ig-1'), is_current: false },
        { ...account('ig-2'), is_current: true },
      ])
      await store.removeAccount('ig-1')
      expect(await store.getAccount('ig-1')).toBeNull()
    })
  })
})
