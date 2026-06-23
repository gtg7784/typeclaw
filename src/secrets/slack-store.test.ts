import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SlackAccountRecord } from './schema'
import { SecretsSlackCredentialStore } from './slack-store'

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-slack-store-'))

function account(overrides: Partial<SlackAccountRecord> = {}): SlackAccountRecord {
  return {
    account_id: 'T0123456789',
    token: 'xoxc-test',
    cookie: 'xoxd-test',
    workspace_id: 'T0123456789',
    workspace_name: 'Acme',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SecretsSlackCredentialStore', () => {
  test('round-trips setAccount/getAccount on a host secrets file', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsSlackCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account())

      expect(await store.getAccount()).toEqual(account())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('removeAccount clears the account and advances current account', async () => {
    const dir = await tmp()
    try {
      const store = new SecretsSlackCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ account_id: 'a', workspace_id: 'a' }))
      await store.setAccount(account({ account_id: 'b', workspace_id: 'b' }))
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
      const store = new SecretsSlackCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      await store.setAccount(account({ account_id: 'a', workspace_id: 'a' }))
      await store.setAccount(account({ account_id: 'b', workspace_id: 'b' }))
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
