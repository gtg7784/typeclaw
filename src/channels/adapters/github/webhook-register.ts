import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

export type RegisterGithubWebhooksOptions = {
  token: () => Promise<string>
  webhookUrl: string
  webhookSecret: string
  repos: readonly string[]
  events: readonly string[]
  fetchImpl?: typeof fetch
}

export type WebhookRepoResult =
  | { repo: string; action: 'created'; hookId: number }
  | { repo: string; action: 'updated'; hookId: number }
  | { repo: string; action: 'failed'; error: string }

export type WebhookRegistrationResult = {
  repos: WebhookRepoResult[]
}

export async function registerGithubWebhooks(
  options: RegisterGithubWebhooksOptions,
): Promise<WebhookRegistrationResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  let token: string
  try {
    token = await options.token()
  } catch (err) {
    const error = describe(err)
    return { repos: options.repos.map((repo) => ({ repo, action: 'failed' as const, error })) }
  }
  const repos: WebhookRepoResult[] = []
  for (const repo of options.repos) {
    repos.push(await registerOne(fetchImpl, token, repo, options))
  }
  return { repos }
}

export type DeregisterGithubWebhooksOptions = {
  token: () => Promise<string>
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
  let token: string
  try {
    token = await options.token()
  } catch (err) {
    const error = describe(err)
    return { hooks: options.hooks.map((h) => ({ ...h, action: 'failed', error })) }
  }
  const hooks: WebhookDeregistrationResult['hooks'] = []
  for (const hook of options.hooks) {
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
    const existing = await findMatchingHook(fetchImpl, token, parsed, options.webhookUrl)
    if (existing === null) {
      const hookId = await createHook(fetchImpl, token, parsed, options)
      return { repo, action: 'created', hookId }
    }
    await updateHook(fetchImpl, token, parsed, existing, options)
    return { repo, action: 'updated', hookId: existing }
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

async function findMatchingHook(
  fetchImpl: typeof fetch,
  token: string,
  repo: RepoSlug,
  webhookUrl: string,
): Promise<number | null> {
  const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/hooks?per_page=100`, {
    method: 'GET',
    headers: githubJsonHeaders(token),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`list hooks failed: ${response.status}${body !== '' ? ` ${body}` : ''}`)
  }
  const hooks = (await response.json()) as Array<{ id?: unknown; config?: { url?: unknown } }>
  for (const hook of hooks) {
    if (hook.config?.url === webhookUrl && typeof hook.id === 'number') return hook.id
  }
  return null
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
