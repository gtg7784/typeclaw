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

export function rewriteWithToken(command: string, token: string): string {
  return `GH_TOKEN=${shellQuote(token)} ${command}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
