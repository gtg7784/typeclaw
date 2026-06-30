import { join } from 'node:path'

import {
  createAccountId,
  InstagramClient as RealInstagramClient,
  InstagramCredentialManager,
  type InstagramAccount,
} from 'agent-messenger/instagram'

import { SecretsInstagramCredentialStore } from '@/secrets/instagram-store'

export type InstagramBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type InstagramLoginInput = {
  username: string
  password: string
  agentDir: string
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

export type InstagramLoginClient = {
  authenticate(username: string, password: string): Promise<InstagramAuthenticateResult>
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
        const auth = await client.authenticate(input.username, input.password)
        if (auth.requiresTwoFactor) return unsupportedTwoFactor()
        if (auth.challengeRequired) return unsupportedChallenge()
        const userId = auth.userId || client.getUserId()
        if (userId === null || userId === '') return { ok: false, reason: 'Instagram login did not authenticate' }

        const now = new Date().toISOString()
        await manager.setAccount({
          account_id: accountId,
          username: input.username,
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
      },
    )
    return result
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function buildInstagramClient(manager: InstagramCredentialManager): InstagramLoginClient {
  return new RealInstagramClient(manager) as unknown as InstagramLoginClient
}

function unsupportedTwoFactor(): InstagramBootstrapStatus {
  return {
    ok: false,
    reason:
      'Instagram account requires 2FA/checkpoint, which is not yet supported by the typeclaw Instagram channel. Disable 2FA on a dedicated agent account, or complete the checkpoint in a browser first.',
  }
}

function unsupportedChallenge(): InstagramBootstrapStatus {
  return {
    ok: false,
    reason:
      'Instagram account requires 2FA/checkpoint, which is not yet supported by the typeclaw Instagram channel. Disable 2FA on a dedicated agent account, or complete the checkpoint in a browser first.',
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
