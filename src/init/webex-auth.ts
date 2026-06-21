import { join, resolve } from 'node:path'

import { loginWithPassword as upstreamLoginWithPassword, type PasswordLoginResult } from 'agent-messenger/webex'

import { containerNameFromCwd } from '@/container'
import { keysDir } from '@/hostd/paths'
import { encrypt } from '@/secrets/encryption'
import { createKeyStore, type KeyStore } from '@/secrets/keys'
import type { WebexAccountRecord } from '@/secrets/schema'
import { SecretsWebexCredentialStore } from '@/secrets/webex-store'

export type WebexBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type LoginWithPasswordFn = typeof upstreamLoginWithPassword

export type WebexLoginInput = {
  email: string
  password: string
  agentDir: string
  idbrokerHost?: string
  loginWithPassword?: LoginWithPasswordFn
  keyStore?: KeyStore
  containerName?: string
}

export function webexSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export async function runWebexBootstrap(input: WebexLoginInput): Promise<WebexBootstrapStatus> {
  try {
    const loginWithPassword = input.loginWithPassword ?? upstreamLoginWithPassword
    const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: webexSecretsPath(input.agentDir) })
    const loginOptions = input.idbrokerHost !== undefined ? { idbrokerHost: input.idbrokerHost } : undefined
    const result = await loginWithPassword(input.email, input.password, loginOptions)

    const now = new Date().toISOString()
    const accountId = result.userId || input.email
    const containerName = input.containerName ?? containerNameFromCwd(resolve(input.agentDir))
    const keyStore = input.keyStore ?? createKeyStore({ keysDir: keysDir() })
    const key = await keyStore.ensure(containerName)
    const encryptedPassword = encrypt(input.password, key, {
      containerName,
      accountId,
      purpose: 'webex-password',
    })
    const account: WebexAccountRecord = {
      account_id: accountId,
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_at: result.expiresAt,
      device_url: result.deviceUrl,
      user_id: result.userId,
      created_at: now,
      updated_at: now,
      email: input.email,
      encryptedPassword,
    }
    await store.setAccount(account)
    await store.setCurrentAccount(accountId)

    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export type { PasswordLoginResult }
