import { join } from 'node:path'

import {
  loginWithDeviceCode as upstreamLoginWithDeviceCode,
  TeamsCredentialManager,
  type DeviceCodePrompt,
  type DeviceLoginResult,
} from 'agent-messenger/teams'

import type { TeamsAccountRecord, TeamsAccountType } from '@/secrets/schema'
import { SecretsTeamsCredentialStore } from '@/secrets/teams-store'

export type TeamsBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type LoginWithDeviceCodeFn = typeof upstreamLoginWithDeviceCode

export type TeamsDeviceCodeCallbacks = {
  onCode: (prompt: DeviceCodePrompt) => void | Promise<void>
  onPending?: () => void
}

export type TeamsLoginInput = {
  agentDir: string
  accountType: TeamsAccountType
  callbacks: TeamsDeviceCodeCallbacks
  loginWithDeviceCode?: LoginWithDeviceCodeFn
  // The SDK persists the minted token in its own config dir; scope it to the
  // agent folder so the login is self-contained and read-back is deterministic
  // instead of leaking into the operator's global agent-messenger config.
  credManager?: TeamsCredentialManager
}

export function teamsSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export async function runTeamsBootstrap(input: TeamsLoginInput): Promise<TeamsBootstrapStatus> {
  try {
    const loginWithDeviceCode = input.loginWithDeviceCode ?? upstreamLoginWithDeviceCode
    const credManager = input.credManager ?? new TeamsCredentialManager(teamsConfigDir(input.agentDir))

    const result = await loginWithDeviceCode(
      {
        accountType: input.accountType,
        onCode: input.callbacks.onCode,
        ...(input.callbacks.onPending !== undefined ? { onPending: input.callbacks.onPending } : {}),
      },
      credManager,
    )

    const record = await buildAccountRecord(result, credManager)
    if (record === null) {
      return { ok: false, reason: 'device-code login did not persist a usable Teams token' }
    }

    const store = new SecretsTeamsCredentialStore({ mode: 'host', secretsPath: teamsSecretsPath(input.agentDir) })
    await store.setAccount(record)
    await store.setCurrentAccount(record.account_id)

    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// The SDK writes the minted token into its own credential manager keyed by
// account type; read it back and translate into typeclaw's TeamsAccountRecord
// shape for secrets.json. The AAD refresh trio is what lets the runtime adapter
// silently re-mint the ~60-90min skype token, so it must survive the hop.
async function buildAccountRecord(
  result: DeviceLoginResult,
  credManager: TeamsCredentialManager,
): Promise<TeamsAccountRecord | null> {
  const config = await credManager.loadConfig()
  const account = config?.accounts[result.accountType]
  if (account === undefined || account.token === '') return null

  const now = new Date().toISOString()
  const accountId = accountIdFor(result)
  return {
    account_id: accountId,
    access_token: account.token,
    ...(account.token_expires_at !== undefined ? { token_expires_at: account.token_expires_at } : {}),
    account_type: result.accountType,
    ...(account.region !== undefined ? { region: account.region } : {}),
    ...(result.userName !== undefined ? { user_name: result.userName } : {}),
    ...(account.aad_refresh_token !== undefined ? { aad_refresh_token: account.aad_refresh_token } : {}),
    ...(account.aad_client_id !== undefined ? { aad_client_id: account.aad_client_id } : {}),
    ...(account.aad_tenant_id !== undefined ? { aad_tenant_id: account.aad_tenant_id } : {}),
    created_at: now,
    updated_at: now,
  }
}

// A stable per-account id for secrets.json. Teams has no cheap unique user id
// surfaced by the device-code result, so key on the display name when present
// and fall back to the account type, so a re-auth of the same account replaces
// its record rather than accumulating duplicates.
function accountIdFor(result: DeviceLoginResult): string {
  const name = result.userName?.trim()
  return name !== undefined && name !== '' ? name : result.accountType
}

// The SDK caches the minted token in this dir; keep it under the already
// gitignored `.typeclaw/` local-scratch root so Teams tokens / AAD refresh
// tokens can never be staged into git by accident.
function teamsConfigDir(agentDir: string): string {
  return join(agentDir, '.typeclaw', 'teams-auth')
}

export type { DeviceCodePrompt, DeviceLoginResult }
