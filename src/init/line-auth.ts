import { join } from 'node:path'

import { LineClient as RealLineClient, LineCredentialManager, type LineLoginResult } from 'agent-messenger/line'

import { SecretsLineCredentialStore } from '@/secrets/line-store'

export type LineBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type LineLoginCallbacks = {
  onQRUrl?: (url: string) => void
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
  loginWithQR(options: { onQRUrl: (url: string) => void; onPincode: (pin: string) => void }): Promise<LineLoginResult>
  loginWithEmail(options: {
    email: string
    password: string
    onPincode: (pin: string) => void
  }): Promise<LineLoginResult>
}

export function lineSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export async function runLineBootstrap(input: LineLoginInput): Promise<LineBootstrapStatus> {
  try {
    const store = new SecretsLineCredentialStore({ mode: 'host', secretsPath: lineSecretsPath(input.agentDir) })
    // The LINE SDK persists the minted auth_token + certificate by calling
    // setAccount() on whatever credential manager the client was built with.
    // Wiring our secrets.json-backed store in here means a successful login
    // writes straight to secrets.json#channels.line — no second copy in
    // ~/.config/agent-messenger to keep in sync.
    const client = input.client ?? buildLineClient(store)

    const result =
      input.method === 'qr'
        ? await client.loginWithQR({
            onQRUrl: (url) => input.callbacks.onQRUrl?.(url),
            onPincode: input.callbacks.onPincode,
          })
        : await client.loginWithEmail({
            email: input.email,
            password: input.password,
            onPincode: input.callbacks.onPincode,
          })

    if (!result.authenticated || result.account_id === undefined) {
      const reason = result.message ?? result.error ?? 'LINE login did not authenticate'
      return { ok: false, reason }
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
