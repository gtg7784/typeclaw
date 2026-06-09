// Decoupled from ChannelRouter on purpose: minting a token for an arbitrary
// bash `gh` command is adjacent to channels but is not routing, and a global
// singleton would leak resolver state across tests. One instance is created in
// run/index.ts and threaded to both the plugin loader and the channel manager.

export type GithubTokenResolveResult = { kind: 'token'; token: string } | { kind: 'unavailable'; reason: string }

export type ResolveGithubTokenForRepo = (repoSlug: string) => Promise<GithubTokenResolveResult>

export type GithubTokenBridge = {
  resolveTokenForRepo: ResolveGithubTokenForRepo
  // True when a per-repo App-token minter is registered (only the GitHub App
  // adapter registers one). This is the non-secret "App auth with per-repo
  // minting is available" signal: it stays true for multi-owner / no-repos App
  // configs where the process-wide GH_TOKEN is intentionally NOT seeded, so the
  // git/gh mint paths can no longer rely on GH_TOKEN's prefix to detect App auth.
  hasAppTokenResolver: () => boolean
  registerResolver: (resolver: (repoSlug: string) => Promise<string>) => () => void
}

const NO_RESOLVER_REASON =
  'GitHub App token unavailable; the GitHub channel adapter is not running or failed to start. ' +
  'Check `typeclaw logs` and `secrets.json#channels.github`.'

export function createGithubTokenBridge(): GithubTokenBridge {
  let current: ((repoSlug: string) => Promise<string>) | null = null

  return {
    resolveTokenForRepo: async (repoSlug) => {
      const resolver = current
      if (resolver === null) return { kind: 'unavailable', reason: NO_RESOLVER_REASON }
      try {
        const token = await resolver(repoSlug)
        return { kind: 'token', token }
      } catch (err) {
        return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
      }
    },
    hasAppTokenResolver: () => current !== null,
    registerResolver: (resolver) => {
      current = resolver
      return () => {
        // Only clear if still the active resolver: a stop() racing a newer
        // start() must not wipe the newer registration.
        if (current === resolver) current = null
      }
    },
  }
}
