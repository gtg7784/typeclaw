import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createAccountId,
  InstagramClient as RealInstagramClient,
  InstagramCredentialManager,
  type InstagramAccount,
} from 'agent-messenger/instagram'

import { SecretsInstagramCredentialStore } from '@/secrets/instagram-store'

export type InstagramBootstrapStatus = { ok: true } | { ok: false; reason: string }

// Instagram gates a fresh login behind one of two interactive second factors:
// a 2FA code (authenticator app / SMS the account already has enabled) or a
// checkpoint challenge (a suspicious-login verification code sent to email or
// SMS). Both require a human to read a code off a device, so they only work
// with a TTY. The callbacks return the entered code, or `null` when the user
// aborts / no interactive prompt is available (cron/container re-auth) — in
// which case the bootstrap fails loudly instead of hanging.
export type InstagramLoginCallbacks = {
  onTwoFactorCode?: (info: InstagramTwoFactorPrompt) => Promise<string | null>
  onChallengeCode?: (info: InstagramChallengePrompt) => Promise<InstagramChallengeResponse | null>
}

export type InstagramTwoFactorPrompt = { username: string }

export type InstagramChallengePrompt = { contactPoint: string; method: InstagramChallengeMethod }

export type InstagramChallengeMethod = 'email' | 'sms'

export type InstagramChallengeResponse = { code: string }

export type InstagramLoginInput = {
  username: string
  password: string
  agentDir: string
  callbacks?: InstagramLoginCallbacks
  client?: InstagramLoginClient
  credentialManager?: InstagramLoginCredentialManager
}

export type InstagramAuthenticateResult = {
  userId: string
  requiresTwoFactor?: boolean
  twoFactorInfo?: Record<string, unknown>
  challengeRequired?: boolean
  challengePath?: string
}

export type InstagramTwoFactorResult = { userId: string }

export type InstagramChallengeSendResult = { contactPoint: string; stepName: string }

export type InstagramChallengeSubmitResult = { userId: string }

// Structural subset of the upstream InstagramClient the bootstrap drives.
// Declared here (rather than relying on the SDK class) so tests can inject a
// fake without standing up the real HTTP client, mirroring the LINE adapter.
export type InstagramLoginClient = {
  authenticate(username: string, password: string): Promise<InstagramAuthenticateResult>
  twoFactorLogin(username: string, code: string, twoFactorIdentifier: string): Promise<InstagramTwoFactorResult>
  challengeSendCode(apiPath: string, method?: InstagramChallengeMethod): Promise<InstagramChallengeSendResult>
  challengeSubmitCode(apiPath: string, code: string): Promise<InstagramChallengeSubmitResult>
  setSessionPath(path: string): void
  getUserId(): string | null
}

export type InstagramLoginCredentialManager = {
  ensureAccountPaths(accountId: string): Promise<{ session_path: string }>
  getAccount(accountId?: string): Promise<InstagramAccount | null>
  setAccount(account: InstagramAccount): Promise<void>
  setCurrent(accountId: string): Promise<boolean>
}

export function instagramSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export function instagramConfigDir(agentDir: string): string {
  return join(agentDir, 'workspace', '.agent-messenger')
}

export async function runInstagramBootstrap(input: InstagramLoginInput): Promise<InstagramBootstrapStatus> {
  try {
    const store = new SecretsInstagramCredentialStore({
      mode: 'host',
      secretsPath: instagramSecretsPath(input.agentDir),
    })
    const result = await withInstagramConfigDir(
      instagramConfigDir(input.agentDir),
      async (): Promise<InstagramBootstrapStatus> => {
        const sdkManager = new InstagramCredentialManager()
        const manager = input.credentialManager ?? sdkManager
        const accountId = createAccountId(input.username)
        const paths = await manager.ensureAccountPaths(accountId)
        const client = input.client ?? buildInstagramClient(sdkManager)
        client.setSessionPath(paths.session_path)

        // A checkpoint login persists a partial SDK session (challenge_path +
        // cookies) inside authenticate(), before we know whether the operator
        // can finish it. Snapshot the file up front and restore it on any
        // failure — whether completeLogin returns a non-ok status (fail-closed
        // / cancelled) or throws (e.g. challengeSubmitCode rejecting a wrong
        // code) — so a half-written session is never left behind. Rethrow so
        // the outer catch reports the error.
        const sessionSnapshot = await snapshotSessionFile(paths.session_path)
        try {
          const result = await completeLogin({ store, manager, client, accountId, input })
          if (!result.ok) await restoreSessionFile(paths.session_path, sessionSnapshot)
          return result
        } catch (err) {
          await restoreSessionFile(paths.session_path, sessionSnapshot)
          throw err
        }
      },
    )
    return result
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

type ResolvedUserId = { ok: true; userId: string } | { ok: false; reason: string }

async function completeLogin(args: {
  store: SecretsInstagramCredentialStore
  manager: InstagramLoginCredentialManager
  client: InstagramLoginClient
  accountId: string
  input: InstagramLoginInput
}): Promise<InstagramBootstrapStatus> {
  const { store, manager, client, accountId, input } = args
  const resolved = await resolveUserId(client, input)
  if (!resolved.ok) return resolved
  const userId = resolved.userId || client.getUserId()
  if (userId === null || userId === '') return { ok: false, reason: 'Instagram login did not authenticate' }
  return persistAccount({ store, manager, accountId, username: input.username, userId })
}

// Drives the authenticate → (optional 2FA / challenge) → userId path. Each
// second factor is completed in place so a successful code entry continues to
// the same persist step a clean login would, and an aborted / unsupported
// prompt fails loudly rather than leaving a half-written session.
async function resolveUserId(client: InstagramLoginClient, input: InstagramLoginInput): Promise<ResolvedUserId> {
  const auth = await client.authenticate(input.username, input.password)
  if (auth.requiresTwoFactor) return completeTwoFactor(client, input, auth)
  if (auth.challengeRequired) return completeChallenge(client, input, auth)
  return { ok: true, userId: auth.userId }
}

async function completeTwoFactor(
  client: InstagramLoginClient,
  input: InstagramLoginInput,
  auth: InstagramAuthenticateResult,
): Promise<ResolvedUserId> {
  const identifier = readTwoFactorIdentifier(auth.twoFactorInfo)
  if (identifier === null) {
    return { ok: false, reason: 'Instagram requested 2FA but did not return a two-factor identifier.' }
  }
  const prompt = input.callbacks?.onTwoFactorCode
  if (prompt === undefined) return twoFactorUnavailable()
  const code = await prompt({ username: input.username })
  if (code === null || code.trim() === '') {
    return { ok: false, reason: 'Instagram 2FA was cancelled — no verification code was entered.' }
  }
  const result = await client.twoFactorLogin(input.username, code.trim(), identifier)
  return { ok: true, userId: result.userId }
}

async function completeChallenge(
  client: InstagramLoginClient,
  input: InstagramLoginInput,
  auth: InstagramAuthenticateResult,
): Promise<ResolvedUserId> {
  const path = auth.challengePath
  if (path === undefined || path === '') {
    return { ok: false, reason: 'Instagram requested a checkpoint but did not return a challenge path.' }
  }
  const prompt = input.callbacks?.onChallengeCode
  if (prompt === undefined) return challengeUnavailable()

  // Instagram sends the verification code to email by default; SMS is only an
  // option when the account has a verified phone. Send-then-prompt keeps the
  // code delivery inside the interactive window so a stale contact point can't
  // leave the user waiting on a code that was never dispatched.
  const method: InstagramChallengeMethod = 'email'
  const sent = await client.challengeSendCode(path, method)
  const response = await prompt({ contactPoint: sent.contactPoint, method })
  if (response === null || response.code.trim() === '') {
    return { ok: false, reason: 'Instagram checkpoint was cancelled — no verification code was entered.' }
  }
  const result = await client.challengeSubmitCode(path, response.code.trim())
  return { ok: true, userId: result.userId }
}

async function persistAccount(args: {
  store: SecretsInstagramCredentialStore
  manager: InstagramLoginCredentialManager
  accountId: string
  username: string
  userId: string
}): Promise<InstagramBootstrapStatus> {
  const { store, manager, accountId, username, userId } = args
  const now = new Date().toISOString()
  await manager.setAccount({
    account_id: accountId,
    username,
    pk: userId,
    created_at: now,
    updated_at: now,
  })
  await manager.setCurrent(accountId)

  const sdkAccount = await manager.getAccount(accountId)
  if (sdkAccount === null) {
    return { ok: false, reason: 'Instagram login authenticated but did not persist SDK credentials' }
  }
  await store.setAccount({
    account_id: sdkAccount.account_id,
    username: sdkAccount.username,
    ...(sdkAccount.full_name !== undefined ? { full_name: sdkAccount.full_name } : {}),
    ...(sdkAccount.profile_pic_url !== undefined ? { profile_pic_url: sdkAccount.profile_pic_url } : {}),
    ...(sdkAccount.pk !== undefined ? { pk: sdkAccount.pk } : {}),
    created_at: sdkAccount.created_at,
    updated_at: sdkAccount.updated_at,
  })
  await store.setCurrentAccount(sdkAccount.account_id)
  return { ok: true }
}

// The SDK returns `two_factor_info.two_factor_identifier`; it's the opaque
// token `twoFactorLogin` must echo back. Read defensively — a shape drift
// surfaces as a clear error instead of an SDK-internal crash.
function readTwoFactorIdentifier(info: Record<string, unknown> | undefined): string | null {
  const identifier = info?.['two_factor_identifier']
  return typeof identifier === 'string' && identifier !== '' ? identifier : null
}

async function snapshotSessionFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// Restore the pre-login state: rewrite the prior contents, or delete the file
// when no session existed before, so a failed second factor leaves the session
// path exactly as it was found.
async function restoreSessionFile(path: string, snapshot: string | null): Promise<void> {
  if (snapshot === null) {
    await rm(path, { force: true })
    return
  }
  await writeFile(path, snapshot, { mode: 0o600 })
}

function buildInstagramClient(manager: InstagramCredentialManager): InstagramLoginClient {
  return new RealInstagramClient(manager) as unknown as InstagramLoginClient
}

function twoFactorUnavailable(): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      'Instagram account requires a 2FA code, but no interactive prompt is available. Run `typeclaw channel add instagram` (or `typeclaw channel reauth instagram`) from a terminal to enter the code.',
  }
}

function challengeUnavailable(): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      'Instagram account requires a checkpoint verification code, but no interactive prompt is available. Run `typeclaw channel add instagram` (or `typeclaw channel reauth instagram`) from a terminal to enter the code.',
  }
}

async function withInstagramConfigDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENT_MESSENGER_CONFIG_DIR
  process.env.AGENT_MESSENGER_CONFIG_DIR = dir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR
    else process.env.AGENT_MESSENGER_CONFIG_DIR = previous
  }
}
