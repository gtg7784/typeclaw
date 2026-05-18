import { buildAuthStrategy } from '@/channels/adapters/github/auth'
import { GITHUB_API_BASE, githubJsonHeaders } from '@/channels/adapters/github/auth-pat'

export type GithubAuthInput =
  | { type: 'pat'; pat: string }
  | { type: 'app'; appId: number; privateKey: string; installationId?: number }

export type RegisterGithubWebhooksOptions = {
  auth: GithubAuthInput
  webhookUrl: string
  webhookSecret: string
  repos: readonly string[]
  // Accepts either coarse names ('issue_comment') or the dotted event.action
  // form used by the runtime allowlist ('issue_comment.created'). The dotted
  // form is reduced to its coarse part because GitHub's hook config API only
  // subscribes by event name.
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
  const auth = buildAuthStrategy({ auth: toSecretAuth(options.auth), fetchImpl })
  try {
    const token = await auth.token()
    const repos: WebhookRepoResult[] = []
    for (const repo of options.repos) {
      repos.push(await registerOne(fetchImpl, token, repo, options))
    }
    return { repos }
  } finally {
    await auth.dispose()
  }
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

type RepoSlug = { owner: string; name: string }

function parseRepoSlug(slug: string): RepoSlug | null {
  const parts = slug.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!owner || !name) return null
  return { owner, name }
}

async function findMatchingHook(
  fetchImpl: typeof fetch,
  token: string,
  repo: RepoSlug,
  webhookUrl: string,
): Promise<number | null> {
  const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/hooks`, {
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
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: toCoarseEvents(options.events),
      config: {
        url: options.webhookUrl,
        content_type: 'json',
        secret: options.webhookSecret,
        insecure_ssl: '0',
      },
    }),
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
    body: JSON.stringify({
      active: true,
      events: toCoarseEvents(options.events),
      config: {
        url: options.webhookUrl,
        content_type: 'json',
        secret: options.webhookSecret,
        insecure_ssl: '0',
      },
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`update hook failed: ${response.status}${body !== '' ? ` ${body}` : ''}`)
  }
}

function toCoarseEvents(events: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const e of events) {
    const coarse = e.split('.')[0]
    if (coarse && coarse.length > 0) seen.add(coarse)
  }
  return [...seen]
}

function toSecretAuth(auth: GithubAuthInput): Parameters<typeof buildAuthStrategy>[0]['auth'] {
  if (auth.type === 'pat') {
    return { type: 'pat', token: { value: auth.pat } }
  }
  return {
    type: 'app',
    appId: auth.appId,
    privateKey: { value: auth.privateKey },
    ...(auth.installationId !== undefined ? { installationId: auth.installationId } : {}),
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
