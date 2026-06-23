import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsDiscordCredentialStore } from './discord-store'
import type { DiscordAccountRecord } from './schema'

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-discord-store-'))

function account(overrides: Partial<DiscordAccountRecord> = {}): DiscordAccountRecord {
  return {
    account_id: '100000000000000001',
    token: 'discord-token-test',
    username: 'alice',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SecretsDiscordCredentialStore', () => {
  test('round-trips setAccount/getAccount on a host secrets file', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsDiscordCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account())

      expect(await store.getAccount()).toEqual(account())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('removeAccount clears the account and advances current account', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsDiscordCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ account_id: '100000000000000001' }))
      await store.setAccount(account({ account_id: '100000000000000002' }))
      await store.setCurrentAccount('100000000000000001')

      await store.removeAccount('100000000000000001')

      expect(await store.getAccount('100000000000000001')).toBeNull()
      expect((await store.getAccount())?.account_id).toBe('100000000000000002')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('listAccounts marks the current account', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsDiscordCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ account_id: '100000000000000001' }))
      await store.setAccount(account({ account_id: '100000000000000002' }))
      await store.setCurrentAccount('100000000000000002')

      expect((await store.listAccounts()).map(({ account_id, is_current }) => ({ account_id, is_current }))).toEqual([
        { account_id: '100000000000000001', is_current: false },
        { account_id: '100000000000000002', is_current: true },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
