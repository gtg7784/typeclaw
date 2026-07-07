import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TeamsChannelBlock } from './schema'
import { decideRenewal, type RefreshDeviceCodeAccountFn, renewCurrentAccount, RENEWAL_WINDOW_MS } from './teams-renewal'

const MIN_MS = 60 * 1000
const NOW = Date.parse('2026-07-08T00:00:00.000Z')

function block(overrides: Partial<TeamsChannelBlock['accounts'][string]> = {}): TeamsChannelBlock {
  return {
    currentAccount: 'acc-1',
    accounts: {
      'acc-1': {
        account_id: 'acc-1',
        access_token: 'old-token',
        token_expires_at: new Date(NOW + 5 * MIN_MS).toISOString(),
        account_type: 'work',
        aad_refresh_token: 'old-refresh',
        aad_client_id: 'client-1',
        aad_tenant_id: 'tenant-1',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        ...overrides,
      },
    },
  }
}

async function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return fn(await mkdtemp(join(tmpdir(), 'typeclaw-teams-renewal-')))
}

async function writeSecrets(dir: string, teams: TeamsChannelBlock): Promise<void> {
  await writeFile(join(dir, 'secrets.json'), JSON.stringify({ version: 2, providers: {}, channels: { teams } }))
}

async function readTeamsBlock(dir: string): Promise<TeamsChannelBlock> {
  const raw = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'))
  return raw.channels.teams
}

// A fake SDK refresh that mirrors the real one's contract: it mutates the given
// credManager by writing back a freshly minted account, then returns true.
function fakeRefresh(next: {
  token: string
  tokenExpiresAt: string
  refreshToken?: string
}): RefreshDeviceCodeAccountFn {
  return (async (accountType, credManager) => {
    if (!credManager) return false
    const prior = await credManager.getCurrentAccount()
    if (!prior?.aad_refresh_token) return false
    await credManager.setDeviceCodeAccount({
      accountType,
      token: next.token,
      tokenExpiresAt: next.tokenExpiresAt,
      aadRefreshToken: next.refreshToken ?? prior.aad_refresh_token,
      aadClientId: prior.aad_client_id,
      aadTenantId: prior.aad_tenant_id,
      teams: {},
      currentTeam: null,
      authMethod: 'device-code',
      makeCurrent: true,
    })
    return true
  }) as RefreshDeviceCodeAccountFn
}

describe('decideRenewal', () => {
  test('skips when no current account', () => {
    expect(decideRenewal({ currentAccount: null, accounts: {} }, NOW)).toEqual({ kind: 'skip', reason: 'no_account' })
  })

  test('skips when the token is comfortably fresh', () => {
    const b = block({ token_expires_at: new Date(NOW + RENEWAL_WINDOW_MS + 60 * MIN_MS).toISOString() })
    const decision = decideRenewal(b, NOW)
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') expect(decision.reason).toBe('fresh_enough')
  })

  test('renews when the token is inside the renewal window', () => {
    const decision = decideRenewal(block(), NOW)
    expect(decision.kind).toBe('should_renew')
  })

  test('reauth_required when inside the window but no refresh token', () => {
    const decision = decideRenewal(block({ aad_refresh_token: undefined }), NOW)
    expect(decision).toMatchObject({ kind: 'reauth_required', reason: 'no_refresh_token' })
  })

  test('attempts renewal when expiry is missing but refresh material exists', () => {
    const decision = decideRenewal(block({ token_expires_at: undefined }), NOW)
    expect(decision.kind).toBe('should_renew')
  })

  test('attempts renewal when expiry is unparseable but refresh material exists', () => {
    const decision = decideRenewal(block({ token_expires_at: 'not-a-date' }), NOW)
    expect(decision.kind).toBe('should_renew')
  })
})

describe('renewCurrentAccount', () => {
  test('refreshes an expiring token and writes the new token back to secrets.json', async () => {
    await withAgentDir(async (dir) => {
      await writeSecrets(dir, block())
      const nextExpiry = new Date(NOW + 80 * MIN_MS).toISOString()

      const result = await renewCurrentAccount({
        agentDir: dir,
        now: () => NOW,
        refreshDeviceCodeAccount: fakeRefresh({
          token: 'new-token',
          tokenExpiresAt: nextExpiry,
          refreshToken: 'rotated-refresh',
        }),
      })

      expect(result.kind).toBe('ok')
      const persisted = await readTeamsBlock(dir)
      expect(persisted.accounts['acc-1']?.access_token).toBe('new-token')
      expect(persisted.accounts['acc-1']?.token_expires_at).toBe(nextExpiry)
      expect(persisted.accounts['acc-1']?.aad_refresh_token).toBe('rotated-refresh')
    })
  })

  test('preserves the AAD client/tenant ids across a refresh', async () => {
    await withAgentDir(async (dir) => {
      await writeSecrets(dir, block())

      await renewCurrentAccount({
        agentDir: dir,
        now: () => NOW,
        refreshDeviceCodeAccount: fakeRefresh({
          token: 'new-token',
          tokenExpiresAt: new Date(NOW + 80 * MIN_MS).toISOString(),
        }),
      })

      const persisted = await readTeamsBlock(dir)
      expect(persisted.accounts['acc-1']?.aad_client_id).toBe('client-1')
      expect(persisted.accounts['acc-1']?.aad_tenant_id).toBe('tenant-1')
    })
  })

  test('skips a fresh token without calling the SDK', async () => {
    await withAgentDir(async (dir) => {
      await writeSecrets(dir, block({ token_expires_at: new Date(NOW + 60 * MIN_MS).toISOString() }))
      let called = false

      const result = await renewCurrentAccount({
        agentDir: dir,
        now: () => NOW,
        refreshDeviceCodeAccount: (async () => {
          called = true
          return true
        }) as RefreshDeviceCodeAccountFn,
      })

      expect(result).toMatchObject({ kind: 'skipped', reason: 'fresh_enough' })
      expect(called).toBe(false)
    })
  })

  test('reports reauth_required when there is no refresh token', async () => {
    await withAgentDir(async (dir) => {
      await writeSecrets(dir, block({ aad_refresh_token: undefined }))

      const result = await renewCurrentAccount({ agentDir: dir, now: () => NOW })

      expect(result).toMatchObject({ kind: 'reauth_required', reason: 'no_refresh_token', account_id: 'acc-1' })
    })
  })

  test('classifies an SDK false (refresh material present) as transient_failure and leaves the token untouched', async () => {
    await withAgentDir(async (dir) => {
      await writeSecrets(dir, block())

      const result = await renewCurrentAccount({
        agentDir: dir,
        now: () => NOW,
        refreshDeviceCodeAccount: (async () => false) as RefreshDeviceCodeAccountFn,
      })

      expect(result).toMatchObject({ kind: 'transient_failure', account_id: 'acc-1' })
      const persisted = await readTeamsBlock(dir)
      expect(persisted.accounts['acc-1']?.access_token).toBe('old-token')
    })
  })

  test('treats a malformed success (true but no readable account) as transient_failure', async () => {
    await withAgentDir(async (dir) => {
      await writeSecrets(dir, block())

      const result = await renewCurrentAccount({
        agentDir: dir,
        now: () => NOW,
        // Returns true but wipes the store so the readback yields no account —
        // a malformed success the bridge must not persist as a real token.
        refreshDeviceCodeAccount: (async (_accountType, credManager) => {
          await credManager?.clearCredentials()
          return true
        }) as RefreshDeviceCodeAccountFn,
      })

      expect(result).toMatchObject({ kind: 'transient_failure', account_id: 'acc-1' })
      const persisted = await readTeamsBlock(dir)
      expect(persisted.accounts['acc-1']?.access_token).toBe('old-token')
    })
  })
})
