import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { refreshDeviceCodeAccount, TeamsCredentialManager } from 'agent-messenger/teams'

import { type TeamsAccountRecord, type TeamsChannelBlock, teamsChannelBlockSchema } from './schema'
import { SecretsBackend } from './storage'
import { SecretsTeamsCredentialStore } from './teams-store'

// Teams user-account skype tokens live only 60-90 minutes, so a long-running
// adapter must silently re-mint them from the stored AAD refresh trio. The
// host tick fires every 5 minutes and renews once the token is within 15
// minutes of `token_expires_at`: that clears a full tick-interval with headroom
// for host sleep / daemon respawn, and gives ~3 attempts before a token would
// otherwise lapse mid-session.
export const RENEWAL_WINDOW_MS = 15 * 60 * 1000

// `TeamsCredentialManager.accountOverride` is static process state and the SDK
// refresh reads/writes a file store, so only one Teams refresh may run in a
// hostd process at a time. Serialize every SDK call through this chain.
let refreshChain: Promise<unknown> = Promise.resolve()

export type TeamsRenewalDecision =
  | { kind: 'skip'; reason: 'no_account' | 'fresh_enough'; expiresInMs?: number }
  | { kind: 'reauth_required'; reason: 'no_refresh_token'; message: string }
  | { kind: 'should_renew'; account: TeamsAccountRecord }

export type TeamsRenewalAttempt =
  | { kind: 'ok'; account_id: string; previousExpiresAt: number; nextExpiresAt: number }
  | { kind: 'reauth_required'; account_id: string; reason: string; message: string }
  | { kind: 'transient_failure'; account_id: string; reason: string }

export type RefreshDeviceCodeAccountFn = typeof refreshDeviceCodeAccount

export type TeamsRenewalContext = {
  agentDir: string
  now?: () => number
  refreshDeviceCodeAccount?: RefreshDeviceCodeAccountFn
}

export function decideRenewal(block: TeamsChannelBlock, now: number): TeamsRenewalDecision {
  const accountId = block.currentAccount
  if (!accountId) return { kind: 'skip', reason: 'no_account' }
  const account = block.accounts[accountId]
  if (!account) return { kind: 'skip', reason: 'no_account' }

  // A present-and-parseable expiry more than a window away is the only reason
  // to skip. A missing or unparseable expiry falls through to renew (better to
  // spend a refresh than leave an extracted/legacy record stuck until manual
  // reauth) — but only if there's refresh material to spend.
  const expiresAt = account.token_expires_at !== undefined ? Date.parse(account.token_expires_at) : Number.NaN
  if (Number.isFinite(expiresAt)) {
    const expiresInMs = expiresAt - now
    if (expiresInMs > RENEWAL_WINDOW_MS) return { kind: 'skip', reason: 'fresh_enough', expiresInMs }
  }

  if (!account.aad_refresh_token) {
    return {
      kind: 'reauth_required',
      reason: 'no_refresh_token',
      message: `Teams account ${accountId} has no AAD refresh token — run \`typeclaw channel reauth teams\`.`,
    }
  }

  return { kind: 'should_renew', account }
}

export async function renewCurrentAccount(
  ctx: TeamsRenewalContext,
): Promise<TeamsRenewalAttempt | { kind: 'skipped'; reason: string; expiresInMs?: number }> {
  const secretsPath = join(ctx.agentDir, 'secrets.json')
  const backend = new SecretsBackend(secretsPath)
  const block = parseBlockOrEmpty(backend.readChannelsSync()?.teams)
  const decision = decideRenewal(block, (ctx.now ?? Date.now)())

  if (decision.kind === 'skip') {
    return {
      kind: 'skipped',
      reason: decision.reason,
      ...(decision.expiresInMs !== undefined ? { expiresInMs: decision.expiresInMs } : {}),
    }
  }
  if (decision.kind === 'reauth_required') {
    return {
      kind: 'reauth_required',
      account_id: block.currentAccount ?? '',
      reason: decision.reason,
      message: decision.message,
    }
  }

  const refreshFn = ctx.refreshDeviceCodeAccount ?? refreshDeviceCodeAccount
  const refreshed = await enqueueRefresh(() => runBridgedRefresh(decision.account, refreshFn))
  if (refreshed === null) {
    // The SDK swallows the underlying error and only returns a boolean, so a
    // false here could be a dead refresh token OR a transient AAD/network blip.
    // The permanent case (no refresh token) is already caught in decideRenewal,
    // so classify a failure past that gate as transient and retry next tick
    // rather than permanently disabling the account.
    return { kind: 'transient_failure', account_id: decision.account.account_id, reason: 'silent_refresh_failed' }
  }

  const store = new SecretsTeamsCredentialStore({ mode: 'host', secretsPath })
  const previousExpiresAt = Date.parse(decision.account.token_expires_at ?? '')
  const nextExpiresAt = Date.parse(refreshed.token_expires_at ?? '')
  // setAccount's mergeAccountPreservingRefreshFields backfills any AAD field the
  // readback omitted, so we always keep a spendable refresh trio.
  await store.setAccount({
    ...decision.account,
    access_token: refreshed.access_token,
    ...(refreshed.token_expires_at !== undefined ? { token_expires_at: refreshed.token_expires_at } : {}),
    ...(refreshed.aad_refresh_token !== undefined ? { aad_refresh_token: refreshed.aad_refresh_token } : {}),
    ...(refreshed.region !== undefined ? { region: refreshed.region } : {}),
    updated_at: new Date().toISOString(),
  })

  return {
    kind: 'ok',
    account_id: decision.account.account_id,
    previousExpiresAt: Number.isFinite(previousExpiresAt) ? previousExpiresAt : 0,
    nextExpiresAt: Number.isFinite(nextExpiresAt) ? nextExpiresAt : 0,
  }
}

type RefreshedFields = Pick<TeamsAccountRecord, 'access_token' | 'token_expires_at' | 'aad_refresh_token' | 'region'>

// The only public Teams refresh entry point writes through the SDK's own
// file-backed TeamsCredentialManager, so bridge it: seed a throwaway manager in
// a temp dir from our stored record, let the SDK exchange the AAD refresh token
// for a fresh skype token, then read the refreshed account back out and hand
// only the TypeClaw-owned fields to the caller. Returns null when the SDK could
// not produce a usable token.
async function runBridgedRefresh(
  account: TeamsAccountRecord,
  refreshFn: RefreshDeviceCodeAccountFn,
): Promise<RefreshedFields | null> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-teams-refresh-'))
  try {
    const manager = new TeamsCredentialManager(dir)
    await manager.setDeviceCodeAccount({
      accountType: account.account_type,
      token: account.access_token,
      tokenExpiresAt: account.token_expires_at ?? '',
      ...(account.aad_refresh_token !== undefined ? { aadRefreshToken: account.aad_refresh_token } : {}),
      ...(account.aad_client_id !== undefined ? { aadClientId: account.aad_client_id } : {}),
      ...(account.aad_tenant_id !== undefined ? { aadTenantId: account.aad_tenant_id } : {}),
      ...(account.region !== undefined ? { region: account.region } : {}),
      ...(account.user_name !== undefined ? { userName: account.user_name } : {}),
      teams: {},
      currentTeam: null,
      authMethod: 'device-code',
      makeCurrent: true,
    })

    const ok = await refreshFn(account.account_type, manager)
    if (!ok) return null

    const refreshed = await manager.getCurrentAccount()
    // A true return with a null/tokenless readback is a malformed success — the
    // caller treats null as a transient failure rather than persisting garbage.
    if (!refreshed || !refreshed.token) return null

    return {
      access_token: refreshed.token,
      ...(refreshed.token_expires_at !== undefined ? { token_expires_at: refreshed.token_expires_at } : {}),
      ...(refreshed.aad_refresh_token !== undefined ? { aad_refresh_token: refreshed.aad_refresh_token } : {}),
      ...(refreshed.region !== undefined ? { region: refreshed.region } : {}),
    }
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function enqueueRefresh<T>(op: () => Promise<T>): Promise<T> {
  const next = refreshChain.then(op, op)
  refreshChain = next.catch(() => {})
  return next
}

function parseBlockOrEmpty(value: unknown): TeamsChannelBlock {
  if (value === undefined) return { currentAccount: null, accounts: {} }
  return teamsChannelBlockSchema.parse(value)
}
