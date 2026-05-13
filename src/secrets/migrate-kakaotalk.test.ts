import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateKakaotalkCredentials } from './migrate-kakaotalk'

async function withAgent<T>(fn: (root: string, legacyDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-migrate-'))
  try {
    const legacyDir = join(root, 'workspace', '.agent-messenger')
    await mkdir(legacyDir, { recursive: true })
    return await fn(root, legacyDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeLegacyFiles(legacyDir: string): Promise<void> {
  await writeFile(
    join(legacyDir, 'kakaotalk-credentials.json'),
    JSON.stringify({
      current_account: 'user-1',
      accounts: {
        'user-1': {
          account_id: 'user-1',
          oauth_token: 'oauth-user-1',
          user_id: 'user-1',
          refresh_token: 'refresh-user-1',
          device_uuid: 'device-user-1',
          device_type: 'tablet',
          auth_method: 'login',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  )
  await writeFile(
    join(legacyDir, 'kakaotalk-pending-login.json'),
    JSON.stringify({
      device_uuid: 'pending-device',
      device_type: 'tablet',
      email: 'user@example.com',
      created_at: '2026-01-01T00:00:00.000Z',
    }),
  )
}

describe('migrateKakaotalkCredentials', () => {
  test('promotes legacy files into secrets.json and renames the sources', async () => {
    await withAgent(async (root, legacyDir) => {
      await writeLegacyFiles(legacyDir)

      const result = await migrateKakaotalkCredentials(root)

      expect(result.promoted).toBe(true)
      const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
        channels: {
          kakaotalk?: { currentAccount: string | null; accounts: Record<string, unknown>; pendingLogin?: unknown }
        }
      }
      expect(secrets.channels.kakaotalk?.currentAccount).toBe('user-1')
      expect(secrets.channels.kakaotalk?.accounts['user-1']).toBeDefined()
      expect(secrets.channels.kakaotalk?.pendingLogin).toEqual({
        device_uuid: 'pending-device',
        device_type: 'tablet',
        email: 'user@example.com',
        created_at: '2026-01-01T00:00:00.000Z',
      })
      expect(existsSync(join(legacyDir, 'kakaotalk-credentials.json'))).toBe(false)
      expect(existsSync(join(legacyDir, 'kakaotalk-credentials.json.migrated'))).toBe(true)
      expect(existsSync(join(legacyDir, 'kakaotalk-pending-login.json.migrated'))).toBe(true)

      const second = await migrateKakaotalkCredentials(root)
      expect(second.promoted).toBe(false)
      expect(JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8'))).toEqual(secrets)
    })
  })

  test('does not overwrite an existing kakaotalk secrets block', async () => {
    await withAgent(async (root, legacyDir) => {
      await writeLegacyFiles(legacyDir)
      const existing = {
        currentAccount: 'existing-user',
        accounts: {
          'existing-user': {
            account_id: 'existing-user',
            oauth_token: 'keep',
            user_id: 'existing-user',
            device_uuid: 'existing-device',
            device_type: 'tablet',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }
      await writeFile(
        join(root, 'secrets.json'),
        JSON.stringify({ version: 2, providers: {}, channels: { kakaotalk: existing } }),
      )

      const result = await migrateKakaotalkCredentials(root)

      expect(result.promoted).toBe(true)
      const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
        channels: { kakaotalk: { pendingLogin?: unknown } }
      }
      expect(secrets.channels.kakaotalk).toEqual({
        ...existing,
        pendingLogin: {
          device_uuid: 'pending-device',
          device_type: 'tablet',
          email: 'user@example.com',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      })
      expect(existsSync(join(legacyDir, 'kakaotalk-credentials.json'))).toBe(true)
      expect(existsSync(join(legacyDir, 'kakaotalk-pending-login.json'))).toBe(false)
      expect(existsSync(join(legacyDir, 'kakaotalk-pending-login.json.migrated'))).toBe(true)
    })
  })

  test('resumes a partial migration by importing only leftover pending login state', async () => {
    await withAgent(async (root, legacyDir) => {
      await writeLegacyFiles(legacyDir)
      const existing = {
        currentAccount: 'user-1',
        accounts: {
          'user-1': {
            account_id: 'user-1',
            oauth_token: 'oauth-user-1',
            user_id: 'user-1',
            refresh_token: 'refresh-user-1',
            device_uuid: 'device-user-1',
            device_type: 'tablet',
            auth_method: 'login',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }
      await writeFile(
        join(root, 'secrets.json'),
        JSON.stringify({ version: 2, providers: {}, channels: { kakaotalk: existing } }),
      )

      const result = await migrateKakaotalkCredentials(root)

      expect(result.promoted).toBe(true)
      const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
        channels: { kakaotalk: { pendingLogin?: unknown } }
      }
      expect(secrets.channels.kakaotalk.pendingLogin).toEqual({
        device_uuid: 'pending-device',
        device_type: 'tablet',
        email: 'user@example.com',
        created_at: '2026-01-01T00:00:00.000Z',
      })
      expect(existsSync(join(legacyDir, 'kakaotalk-credentials.json'))).toBe(true)
      expect(existsSync(join(legacyDir, 'kakaotalk-pending-login.json'))).toBe(false)
    })
  })
})
