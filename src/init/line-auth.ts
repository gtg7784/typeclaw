import { join } from 'node:path'

import { LineClient as RealLineClient, LineCredentialManager, type LineLoginResult } from 'agent-messenger/line'

import { SecretsLineCredentialStore } from '@/secrets/line-store'

export type LineBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type LineLoginCallbacks = {
  onQRUrl?: (url: string) => void | Promise<void>
  onPincode: (pin: string) => void
}

// QR is the default because a LINE account may have no usable e-mail/password
// (social-login accounts), and QR only adds bootstrap-time UX — the persisted
// credential (auth_token + certificate) is identical regardless of method.
export type LineLoginInput =
  | {
      method: 'qr'
      agentDir: string
      callbacks: LineLoginCallbacks
      client?: LineLoginClient
    }
  | {
      method: 'email'
      email: string
      password: string
      agentDir: string
      callbacks: LineLoginCallbacks
      client?: LineLoginClient
    }

// Structural subset of the upstream LineClient the bootstrap drives. Declared
// here so tests can inject a fake without standing up the real LOCO client.
export type LineLoginClient = {
  loginWithQR(options: {
    onQRUrl: (url: string) => void | Promise<void>
    onPincode: (pin: string) => void
  }): Promise<LineLoginResult>
  loginWithEmail(options: {
    email: string
    password: string
    onPincode: (pin: string) => void
  }): Promise<LineLoginResult>
}

let lineTokenInfoSuppressionQueue: Promise<void> = Promise.resolve()

export function lineSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

// The SDK persists E2EE (Letter-Sealing) key material under
// `<AGENT_MESSENGER_CONFIG_DIR>/line-storage/`. The container sets that env to
// the agent workspace (src/init/dockerfile.ts), but a host-stage login (init /
// `channel reauth line`) would otherwise fall back to `~/.config/agent-messenger`
// — so the E2EE key gets written somewhere the container never reads, and inbound
// Letter-Sealing messages stay undecryptable. Point the host login at the same
// per-agent dir the container uses so the key lands where the runtime reads it.
export function lineConfigDir(agentDir: string): string {
  return join(agentDir, 'workspace', '.agent-messenger')
}

export async function runLineBootstrap(input: LineLoginInput): Promise<LineBootstrapStatus> {
  try {
    process.env.AGENT_MESSENGER_CONFIG_DIR ??= lineConfigDir(input.agentDir)
    const store = new SecretsLineCredentialStore({ mode: 'host', secretsPath: lineSecretsPath(input.agentDir) })
    // The LINE SDK persists the minted auth_token + certificate by calling
    // setAccount() on whatever credential manager the client was built with.
    // Wiring our secrets.json-backed store in here means a successful login
    // writes straight to secrets.json#channels.line — no second copy in
    // ~/.config/agent-messenger to keep in sync.
    const client = input.client ?? buildLineClient(store)

    const result = await suppressLineTokenInfoDump(() =>
      input.method === 'qr'
        ? client.loginWithQR({
            onQRUrl: async (url) => {
              await input.callbacks.onQRUrl?.(url)
            },
            onPincode: input.callbacks.onPincode,
          })
        : client.loginWithEmail({
            email: input.email,
            password: input.password,
            onPincode: input.callbacks.onPincode,
          }),
    )

    if (!result.authenticated || result.account_id === undefined) {
      const reason = result.message ?? result.error ?? 'LINE login did not authenticate'
      return { ok: false, reason }
    }

    // The SDK persists the account by calling setAccount() on the credential
    // manager as a side effect of login. We can't assume it did: read the
    // record back and require an auth_token before declaring success, so a
    // login that authenticated but failed to persist surfaces as an error
    // instead of a green "added" with an empty secrets.json#channels.line.
    const persisted = await store.getAccount(result.account_id)
    if (persisted === null || persisted.auth_token === '') {
      return { ok: false, reason: 'LINE login authenticated but did not persist credentials' }
    }

    await store.setCurrentAccount(result.account_id)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function buildLineClient(store: SecretsLineCredentialStore): LineLoginClient {
  // The upstream LineClient constructor takes a LineCredentialManager. Our
  // store implements the same setAccount/getAccount surface the login path
  // calls, so it stands in as the credential manager via a structural cast.
  const credManager = store as unknown as LineCredentialManager
  return new RealLineClient(credManager) as unknown as LineLoginClient
}

async function suppressLineTokenInfoDump<T>(fn: () => Promise<T>): Promise<T> {
  const previous = lineTokenInfoSuppressionQueue
  let release: () => void = () => {}
  lineTokenInfoSuppressionQueue = new Promise((resolve) => {
    release = resolve
  })
  await previous

  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    if (isLineTokenInfoDump(args)) return
    originalLog(...args)
  }
  try {
    return await fn()
  } finally {
    console.log = originalLog
    release()
  }
}

function isLineTokenInfoDump(args: unknown[]): boolean {
  if (args.length !== 1) return false
  const value = args[0]
  if (value === null || typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  return (
    looksLikeJwt(record['1']) &&
    looksLikeJwt(record['2']) &&
    typeof record['3'] === 'number' &&
    typeof record['4'] === 'object' &&
    typeof record['5'] === 'string' &&
    typeof record['6'] === 'number'
  )
}

function looksLikeJwt(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}
