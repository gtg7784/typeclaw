import { join } from 'node:path'

import { loginWithQr as upstreamLoginWithQr, type QrSession } from 'agent-messenger/slack'

import type { SlackAccountRecord } from '@/secrets/schema'
import { SecretsSlackCredentialStore } from '@/secrets/slack-store'

export type SlackBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type LoginWithQrFn = typeof upstreamLoginWithQr

export type SlackLoginInput = {
  qrDataUrl: string
  agentDir: string
  loginWithQr?: LoginWithQrFn
}

export function slackSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export async function runSlackBootstrap(input: SlackLoginInput): Promise<SlackBootstrapStatus> {
  try {
    const loginWithQr = input.loginWithQr ?? upstreamLoginWithQr
    const store = new SecretsSlackCredentialStore({ mode: 'host', secretsPath: slackSecretsPath(input.agentDir) })
    const result = await loginWithQr(input.qrDataUrl)
    const now = new Date().toISOString()
    const accountId = workspaceId(result)
    const account: SlackAccountRecord = {
      account_id: accountId,
      token: result.token,
      cookie: result.cookie,
      workspace_id: accountId,
      workspace_name: result.workspace,
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

function workspaceId(result: QrSession): string {
  const record = result as QrSession & { workspace_id?: unknown }
  return typeof record.workspace_id === 'string' && record.workspace_id !== '' ? record.workspace_id : result.workspace
}

export type { QrSession }
