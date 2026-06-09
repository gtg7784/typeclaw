export type GhTokenClass = 'cross-owner' | 'fine-grained-pat' | 'app' | 'none'

export function classifyGhToken(token: string | undefined): GhTokenClass {
  if (token === undefined || token === '') return 'none'
  if (token.startsWith('ghp_')) return 'cross-owner'
  if (token.startsWith('github_pat_')) return 'fine-grained-pat'
  if (token.startsWith('ghs_')) return 'app'
  // Unknown/legacy formats: treat as App so a repo-targeting call still resolves
  // a per-repo token rather than silently using a possibly-wrong global one.
  return 'app'
}

// Whether the per-repo App minter should fire for a repo-targeting command.
// App auth is detected via EITHER a seeded App-class GH_TOKEN OR a live App
// token resolver — the latter is the authority because multi-owner / no-repos
// App configs intentionally leave GH_TOKEN unseeded (the prefix would read
// 'none'), yet the per-repo minter is still registered and able to mint. Classic
// and fine-grained PATs are never re-minted: they pass through with whatever
// GH_TOKEN is seeded, exactly as before.
export function shouldMintAppToken(token: string | undefined, hasAppTokenResolver: boolean): boolean {
  const tokenClass = classifyGhToken(token)
  if (tokenClass === 'cross-owner' || tokenClass === 'fine-grained-pat') return false
  return tokenClass === 'app' || hasAppTokenResolver
}
