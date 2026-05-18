import { basename, resolve } from 'node:path'

const MARKER_PREFIX = '/typeclaw/github/'

export function buildManagedPath(agentId: string): string {
  const safe = sanitizeAgentId(agentId)
  return `${MARKER_PREFIX}${safe}`
}

// `containerName` (TYPECLAW_CONTAINER_NAME) is the load-bearing identifier
// inside the container; falls back to the agent folder basename for host-side
// callers (e.g. eager webhook install at `typeclaw channel add github` time)
// that don't have the env var set yet. Both resolve to the same string in
// practice — see `containerNameFromCwd` in src/container/shared.ts.
export function resolveAgentId(options: { containerName?: string; agentDir: string }): string {
  const fromEnv = options.containerName?.trim()
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return basename(resolve(options.agentDir))
}

// Append the marker path to a URL that's missing one. The cloudflare-quick
// tunnel hands us `https://<random>.trycloudflare.com` with no path; we want
// the marker visible in the resulting webhook URL so a future run of THIS
// agent can recognize the hook as ours after the hostname rotates.
//
// If the URL already has a non-trivial path (user-set webhookUrl), it's
// returned verbatim. We treat that as "operator owns this URL" — appending
// our marker would silently change a user-configured webhook URL.
export function applyManagedPath(rawUrl: string, managedPath: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') return rawUrl
  parsed.pathname = managedPath
  return parsed.toString()
}

// `containerNameFromCwd` (src/container/shared.ts) clamps to [a-z0-9_.-];
// applying the same conservative shape here keeps URL paths well-formed even
// if a caller passes us an unsanitized identifier from somewhere else.
function sanitizeAgentId(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const cleaned = trimmed.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'agent' : cleaned
}
