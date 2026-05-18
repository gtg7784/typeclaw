export function githubEventKey(event: string, action: unknown): string {
  return typeof action === 'string' && action.length > 0 ? `${event}.${action}` : event
}

export function isGithubEventAllowed(allowlist: readonly string[], event: string, action: unknown): boolean {
  const key = githubEventKey(event, action)
  return allowlist.includes(key) || allowlist.includes(event)
}
