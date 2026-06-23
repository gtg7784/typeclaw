import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { loginWithRemoteAuth as upstreamLoginWithRemoteAuth, type RemoteAuthSession } from 'agent-messenger/discord'

import { SecretsDiscordCredentialStore } from '@/secrets/discord-store'
import type { DiscordAccountRecord } from '@/secrets/schema'

export type DiscordBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type LoginWithRemoteAuthFn = typeof upstreamLoginWithRemoteAuth

export type DiscordLoginInput = {
  agentDir: string
  onQrUrl?: (url: string) => void | Promise<void>
  loginWithRemoteAuth?: LoginWithRemoteAuthFn
}

export function discordSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export async function runDiscordBootstrap(input: DiscordLoginInput): Promise<DiscordBootstrapStatus> {
  try {
    const loginWithRemoteAuth = input.loginWithRemoteAuth ?? upstreamLoginWithRemoteAuth
    const store = new SecretsDiscordCredentialStore({ mode: 'host', secretsPath: discordSecretsPath(input.agentDir) })
    const result = await loginWithRemoteAuth({ onQrUrl: input.onQrUrl })
    const now = new Date().toISOString()
    const accountId = discordAccountId(result)
    const account: DiscordAccountRecord = {
      account_id: accountId,
      token: result.token,
      ...(result.user?.username !== undefined ? { username: result.user.username } : {}),
      created_at: now,
      updated_at: now,
    }
    await store.setAccount(account)
    await store.setCurrentAccount(accountId)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function discordAccountId(result: RemoteAuthSession): string {
  if (result.user?.id !== undefined && result.user.id !== '') return result.user.id
  return createHash('sha256').update(result.token).digest('hex').slice(0, 16)
}

export type { RemoteAuthSession }
