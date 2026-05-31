import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

export type RegisterGithubWebhooksOptions = {
  // Resolves an installation token scoped to the given "owner/name" repo. A
  // single GitHub App may span multiple owners (separate installations), so
  // each repo's hook must be created/listed with that repo's own token.
  token: (repoSlug: string) => Promise<string>
  webhookUrl: string
  webhookSecret: string
  repos: readonly string[]
  events: readonly string[]
  // Stable, hostname-agnostic marker embedded in the webhook URL's path so
  // hooks created by this agent in past runs can be recognized as ours even
  // after the host part of the URL has rotated (e.g. cloudflare-quick tunnels
  // mint a fresh `*.trycloudflare.com` on every container restart).
  //
  // When set, any hook whose `config.url` URL.pathname ends with this exact
  // string is considered owned by this agent: at register time we PATCH the
  // first such hook to the current URL and delete the rest as stale orphans.
  //
  // Convention: `/typeclaw/v1/github/<containerName>` — see
  // `buildManagedPath` in `./managed-path.ts`. The path is appended onto
  // tunnel-derived URLs by the adapter; user-set `webhookUrl` is kept
  // verbatim (the operator is in control of their own URL — we trust them
  // not to point two agents at the same URL).
  //
  // Omitted means the legacy URL-equality path is used (no orphan cleanup).
  // The adapter always passes it in production; the option stays optional so
  // direct unit-test calls can opt out of the cleanup logic.
  managedPath?: string
  // Opt-in legacy-orphan cleanup for hooks created before the marker existed.
  // When set (e.g. `.trycloudflare.com`), the lister ALSO claims any hook
  // whose URL host endsWith this suffix AND whose pathname is empty or `/`
  // (unmarked = necessarily pre-fix). The adapter passes this only when the
  // CURRENT effective URL itself lives on the same provider domain, so an
  // agent on an external/self-hosted tunnel can never claim a colleague's
  // cloudflare-quick hook. Hooks with a non-trivial path are still skipped
  // unconditionally so a foreign service that happens to also use
  // *.trycloudflare.com with its own path stays safe.
  legacyProviderHostSuffix?: string
  fetchImpl?: typeof fetch
}

export type WebhookRepoResult =
  | { repo: string; action: 'created'; hookId: number }
  | { repo: string; action: 'updated'; hookId: number; stalePruned: number }
  | { repo: string; action: 'failed'; error: string }

export type WebhookRegistrationResult = {
  repos: WebhookRepoResult[]
}

export async function registerGithubWebhooks(
  options: RegisterGithubWebhooksOptions,
): Promise<WebhookRegistrationResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const repos: WebhookRepoResult[] = []
  for (const repo of options.repos) {
    let token: string
    try {
      token = await options.token(repo)
    } catch (err) {
      repos.push({ repo, action: 'failed', error: describe(err) })
      continue
    }
    repos.push(await registerOne(fetchImpl, token, repo, options))
  }
  return { repos }
}

export type DeregisterGithubWebhooksOptions = {
  token: (repoSlug: string) => Promise<string>
  hooks: ReadonlyArray<{ repo: string; hookId: number }>
  fetchImpl?: typeof fetch
}

export type WebhookDeregistrationResult = {
  hooks: Array<{ repo: string; hookId: number; action: 'deleted' | 'missing' | 'failed'; error?: string }>
}

export async function deregisterGithubWebhooks(
  options: DeregisterGithubWebhooksOptions,
): Promise<WebhookDeregistrationResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const hooks: WebhookDeregistrationResult['hooks'] = []
  for (const hook of options.hooks) {
    let token: string
    try {
      token = await options.token(hook.repo)
    } catch (err) {
      hooks.push({ ...hook, action: 'failed', error: describe(err) })
      continue
    }
    hooks.push(await deleteOne(fetchImpl, token, hook))
  }
  return { hooks }
}

async function registerOne(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  options: RegisterGithubWebhooksOptions,
): Promise<WebhookRepoResult> {
  const parsed = parseRepoSlug(repo)
  if (parsed === null) {
    return { repo, action: 'failed', error: `invalid repo slug: "${repo}" (expected owner/name)` }
  }
  try {
    const owned = await findManagedHooks(
      fetchImpl,
      token,
      parsed,
      options.webhookUrl,
      options.managedPath,
      options.legacyProviderHostSuffix,
    )
    if (owned.length === 0) {
      const hookId = await createHook(fetchImpl, token, parsed, options)
      return { repo, action: 'created', hookId }
    }
    // Sort by id ascending so the canonical kept hook is deterministic
    // (oldest = lowest id wins). This makes successive runs converge on the
    // same hookId for the same repo, which is friendlier to anyone
    // inspecting the repo's webhook list.
    const [keep, ...stale] = owned.slice().sort((a, b) => a - b)
    await updateHook(fetchImpl, token, parsed, keep!, options)
    let stalePruned = 0
    for (const id of stale) {
      const ok = await tryDeleteHook(fetchImpl, token, parsed, id)
      if (ok) stalePruned++
    }
    return { repo, action: 'updated', hookId: keep!, stalePruned }
  } catch (err) {
    return { repo, action: 'failed', error: describe(err) }
  }
}

async function deleteOne(
  fetchImpl: typeof fetch,
  token: string,
  hook: { repo: string; hookId: number },
): Promise<WebhookDeregistrationResult['hooks'][number]> {
  const parsed = parseRepoSlug(hook.repo)
  if (parsed === null) {
    return { ...hook, action: 'failed', error: `invalid repo slug: "${hook.repo}"` }
  }
  try {
    const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.name}/hooks/${hook.hookId}`, {
      method: 'DELETE',
      headers: githubJsonHeaders(token),
    })
    if (response.status === 404) return { ...hook, action: 'missing' }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ...hook,
        action: 'failed',
        error: `delete hook failed: ${response.status}${body !== '' ? ` ${body}` : ''}`,
      }
    }
    return { ...hook, action: 'deleted' }
  } catch (err) {
    return { ...hook, action: 'failed', error: describe(err) }
  }
}

// Best-effort stale-hook prune. We don't surface 404/403/etc. as a register
// failure because the primary keep-hook is already updated; an inability to
// delete a stale orphan is a soft warning at most. Caller counts successful
// prunes for the log line.
async function tryDeleteHook(fetchImpl: typeof fetch, token: string, repo: RepoSlug, hookId: number): Promise<boolean> {
  try {
    const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/hooks/${hookId}`, {
      method: 'DELETE',
      headers: githubJsonHeaders(token),
    })
    // 404 = already gone; treat as a successful prune for log-summary purposes
    // (the orphan is no longer on the repo, which is what we wanted).
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

type RepoSlug = { owner: string; name: string }

function parseRepoSlug(slug: string): RepoSlug | null {
  const parts = slug.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!owner || !name) return null
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) return null
  return { owner, name }
}

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/

// Returns the hookIds of every hook owned by this agent on `repo`, in the
// order GitHub returned them. Ownership is the union of three rules:
//
//   1. `config.url === webhookUrl` — the live URL match. Covers the
//      common case (user-set webhookUrl, or a tunnel URL that hasn't
//      rotated since the last register).
//
//   2. `URL(config.url).pathname` ends with `managedPath` — the
//      hostname-agnostic path-marker match. Covers hooks that THIS agent
//      created in a previous run whose tunnel host has since rotated.
//      Skipped when `managedPath` is omitted (legacy callers).
//
//   3. (Opt-in via `legacyProviderHostSuffix`) `URL(config.url).host` ends
//      with the supplied suffix AND pathname is empty or `/`. Covers the
//      pre-marker orphans the user reported in the bug. Tightly bounded:
//      same provider domain only, unmarked hooks only.
//
// Hooks whose `config.url` isn't a parseable URL are ignored. Hooks
// without an `id` are ignored.
async function findManagedHooks(
  fetchImpl: typeof fetch,
  token: string,
  repo: RepoSlug,
  webhookUrl: string,
  managedPath: string | undefined,
  legacyProviderHostSuffix: string | undefined,
): Promise<number[]> {
  const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/hooks?per_page=100`, {
    method: 'GET',
    headers: githubJsonHeaders(token),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`list hooks failed: ${response.status}${body !== '' ? ` ${body}` : ''}`)
  }
  const hooks = (await response.json()) as Array<{ id?: unknown; config?: { url?: unknown } }>
  const owned: number[] = []
  for (const hook of hooks) {
    if (typeof hook.id !== 'number') continue
    const url = hook.config?.url
    if (typeof url !== 'string') continue
    if (url === webhookUrl) {
      owned.push(hook.id)
      continue
    }
    if (managedPath !== undefined && hookPathMatchesMarker(url, managedPath)) {
      owned.push(hook.id)
      continue
    }
    if (legacyProviderHostSuffix !== undefined && hookIsUnmarkedOnProvider(url, legacyProviderHostSuffix)) {
      owned.push(hook.id)
    }
  }
  return owned
}

function hookPathMatchesMarker(rawUrl: string, marker: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  // Suffix match on pathname only (not the full URL). Rotating Cloudflare
  // hostnames change `parsed.host`; the marker survives in `parsed.pathname`.
  // Suffix (not equality) so a future reverse-proxy that prepends a path
  // prefix doesn't break recognition.
  return parsed.pathname === marker || parsed.pathname.endsWith(marker)
}

function hookIsUnmarkedOnProvider(rawUrl: string, hostSuffix: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  // Empty pathname (rare, depends on URL parser) or root only. Anything
  // with a real path is treated as user-controlled and left alone.
  const unmarked = parsed.pathname === '' || parsed.pathname === '/'
  // hostSuffix must start with a dot OR be the full host — guards against
  // `foo.com` accidentally matching `evilfoo.com`.
  const onProvider = parsed.host === hostSuffix || (hostSuffix.startsWith('.') && parsed.host.endsWith(hostSuffix))
  return unmarked && onProvider
}

async function createHook(
  fetchImpl: typeof fetch,
  token: string,
  repo: RepoSlug,
  options: RegisterGithubWebhooksOptions,
): Promise<number> {
  const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/hooks`, {
    method: 'POST',
    headers: githubJsonHeaders(token),
    body: JSON.stringify(buildHookPayload(options, { includeName: true })),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`create hook failed: ${response.status}${body !== '' ? ` ${body}` : ''}`)
  }
  const raw = (await response.json()) as { id?: unknown }
  if (typeof raw.id !== 'number') throw new Error('create hook response missing id')
  return raw.id
}

async function updateHook(
  fetchImpl: typeof fetch,
  token: string,
  repo: RepoSlug,
  hookId: number,
  options: RegisterGithubWebhooksOptions,
): Promise<void> {
  const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/hooks/${hookId}`, {
    method: 'PATCH',
    headers: githubJsonHeaders(token),
    body: JSON.stringify(buildHookPayload(options, { includeName: false })),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`update hook failed: ${response.status}${body !== '' ? ` ${body}` : ''}`)
  }
}

function buildHookPayload(
  options: RegisterGithubWebhooksOptions,
  { includeName }: { includeName: boolean },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    active: true,
    events: toCoarseEvents(options.events),
    config: {
      url: options.webhookUrl,
      content_type: 'json',
      secret: options.webhookSecret,
      insecure_ssl: '0',
    },
  }
  if (includeName) payload.name = 'web'
  return payload
}

function toCoarseEvents(events: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const e of events) {
    const coarse = e.split('.')[0]
    if (coarse && coarse.length > 0) seen.add(coarse)
  }
  return [...seen]
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
