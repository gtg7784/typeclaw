import { createRequire } from 'node:module'
import { join } from 'node:path'

import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'

export type KakaotalkBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type KakaotalkLoginCallbacks = {
  onPasscode: (passcode: string) => void
}

export type KakaotalkLoginInput = {
  email: string
  password: string
  agentDir: string
  callbacks: KakaotalkLoginCallbacks
  loginFlow?: LoginFlowFn
}

export type LoginFlowOptions = {
  email: string
  password: string
  deviceType?: 'pc' | 'tablet'
  force?: boolean
  savedDeviceUuid?: string
  onPasscodeDisplay?: (code: string) => void
  debugLog?: (message: string) => void
}

export type LoginFlowCredentials = {
  access_token: string
  refresh_token: string
  user_id: string
  device_uuid: string
  device_type: 'pc' | 'tablet'
}

export type LoginFlowResult = {
  authenticated: boolean
  next_action?: string
  message?: string
  warning?: string
  error?: string
  credentials?: LoginFlowCredentials
}

export type LoginFlowFn = (options: LoginFlowOptions) => Promise<LoginFlowResult>

export function kakaotalkConfigDir(agentDir: string): string {
  return join(agentDir, 'workspace', '.agent-messenger')
}

export function kakaotalkSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export async function runKakaotalkBootstrap(input: KakaotalkLoginInput): Promise<KakaotalkBootstrapStatus> {
  try {
    const loginFlow = input.loginFlow ?? (await resolveLoginFlow())
    const credManager = new SecretsKakaoCredentialStore({
      mode: 'host',
      secretsPath: kakaotalkSecretsPath(input.agentDir),
    })
    const pending = await credManager.loadPendingLogin()
    const existing = await credManager.getAccount()
    const savedDeviceUuid =
      pending?.device_uuid ?? (existing?.auth_method === 'login' ? existing.device_uuid : undefined)

    const result = await loginFlow({
      email: input.email,
      password: input.password,
      deviceType: 'tablet',
      force: false,
      ...(savedDeviceUuid !== undefined ? { savedDeviceUuid } : {}),
      onPasscodeDisplay: input.callbacks.onPasscode,
    })

    if (!result.authenticated || !result.credentials) {
      const reason = result.message ?? result.error ?? 'agent-kakaotalk did not authenticate (check email/password)'
      return { ok: false, reason }
    }

    const now = new Date().toISOString()
    const accountId = result.credentials.user_id || 'default'
    await credManager.setAccount({
      account_id: accountId,
      oauth_token: result.credentials.access_token,
      user_id: result.credentials.user_id,
      refresh_token: result.credentials.refresh_token,
      device_uuid: result.credentials.device_uuid,
      device_type: result.credentials.device_type,
      auth_method: 'login',
      created_at: now,
      updated_at: now,
    })
    await credManager.setCurrentAccount(accountId)
    await credManager.clearPendingLogin()

    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// agent-messenger does not export `loginFlow` from its public `exports` map
// (only the runtime client + credential manager), so we resolve the package's
// installed location and import the implementation file directly. This
// bypasses the exports gate but stays within the same installed copy of the
// package — no version drift risk. If a future agent-messenger release adds
// `loginFlow` to its public exports, swap this for a normal import and delete
// the resolveLoginFlow helper.
async function resolveLoginFlow(): Promise<LoginFlowFn> {
  const require = createRequire(import.meta.url)
  const pkgJson = require.resolve('agent-messenger/package.json')
  const pkgDir = pkgJson.replace(/\/package\.json$/, '')
  const mod = (await import(`${pkgDir}/dist/src/platforms/kakaotalk/auth/kakao-login.js`)) as {
    loginFlow: LoginFlowFn
  }
  return mod.loginFlow
}
