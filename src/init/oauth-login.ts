import { join } from 'node:path'

import {
  KNOWN_PROVIDERS,
  providerForModelRef,
  supportsOAuth,
  type KnownModelRef,
  type KnownProviderId,
} from '@/config/providers'
import { createSecretsStoreForAgent } from '@/secrets'

export type OAuthLoginResult = { ok: true } | { ok: false; reason: string }

export type OAuthLoginRunner = (options: { cwd: string; model: KnownModelRef }) => Promise<OAuthLoginResult>

// Wrap pi-ai's OAuth callbacks so the CLI doesn't have to know about the
// upstream callback shape. The CLI only sees three lifecycle events:
// (1) onAuth(url) — print the URL the user must visit
// (2) onProgress(message) — show waiting/finalizing status
// (3) onPrompt(prompt) — ask the user for a manual code if the browser flow
//     can't reach the local callback server. Most users won't see this; it
//     fires when they paste the post-redirect URL by hand.
export type OAuthCallbacks = {
  onAuth: (url: string, instructions?: string) => void
  onProgress?: (message: string) => void
  onPrompt: (message: string, placeholder?: string) => Promise<string | null>
}

// Default runner: real OAuth flow against pi-ai. Tests inject a stub to skip
// network entirely. The runner's only job is to log in, write to the secrets
// file, and report ok/error — it does NOT update typeclaw.json (the model
// ref is already chosen by the caller and written by `scaffold`).
export function makeOAuthLoginRunner(callbacks: OAuthCallbacks): OAuthLoginRunner {
  return async ({ cwd, model }) => {
    const providerId = providerForModelRef(model)
    const provider = KNOWN_PROVIDERS[providerId]
    if (!supportsOAuth(provider) || !provider.oauthProviderId) {
      return { ok: false, reason: `Provider ${provider.name} does not support OAuth` }
    }

    try {
      const secrets = createSecretsStoreForAgent(join(cwd, 'secrets.json'))
      await secrets.login(provider.oauthProviderId, {
        onAuth: (info) => callbacks.onAuth(info.url, info.instructions),
        onProgress: callbacks.onProgress,
        onPrompt: async (prompt) => {
          const value = await callbacks.onPrompt(prompt.message, prompt.placeholder)
          if (value === null) {
            throw new Error('Login cancelled by user')
          }
          return value
        },
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

// Test seam: lets unit tests assert "OAuth login was invoked with these
// params" without spinning up a real secrets store / browser callback server.
export type FakeOAuthLoginRunnerOptions = {
  result?: OAuthLoginResult
  onCalled?: (options: { cwd: string; model: KnownModelRef; providerId: KnownProviderId }) => void
}

export function makeFakeOAuthLoginRunner(options: FakeOAuthLoginRunnerOptions = {}): OAuthLoginRunner {
  return async ({ cwd, model }) => {
    const providerId = providerForModelRef(model)
    options.onCalled?.({ cwd, model, providerId })
    return options.result ?? { ok: true }
  }
}
