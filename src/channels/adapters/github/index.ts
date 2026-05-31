import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig, GithubAdapterConfig } from '@/channels/schema'
import { resolveSecret } from '@/secrets/resolve'
import type { GithubSecretsBlock } from '@/secrets/schema'

import { buildAuthStrategy, type GithubAuthContext } from './auth'
import { createGithubChannelNameResolver } from './channel-resolver'
import { createDeliveryDedup } from './dedup'
import { findPermissionGaps } from './event-permissions'
import { createGithubFetchAttachmentCallback } from './fetch-attachment'
import { createGithubHistoryCallback } from './history'
import { createGithubWebhookHandler } from './inbound'
import { applyManagedPath, buildManagedPath, resolveAgentId } from './managed-path'
import { createGithubMembershipResolver } from './membership'
import { createGithubOutboundCallback } from './outbound'
import {
  buildAppPermissionPreflightGuidance,
  buildPermissionGuidance,
  parseListHooksPermissionStatus,
} from './permission-guidance'
import { createTeamMembershipChecker } from './team-membership'
import { deregisterGithubWebhooks, registerGithubWebhooks, type WebhookRegistrationResult } from './webhook-register'

export type GithubAdapterLogger = {
  info: (m: string) => void
  warn: (m: string) => void
  error: (m: string) => void
}

export type GithubAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig & GithubAdapterConfig
  secrets: GithubSecretsBlock
  agentDir: string
  logger?: GithubAdapterLogger
  fetchImpl?: typeof fetch
  httpListenImpl?: (port: number, handler: (req: Request) => Promise<Response>) => { stop: () => Promise<void> }
  tunnelUrl?: () => string | null
  // Whether a channel-bound tunnel exists in typeclaw.json#tunnels[] for the
  // github channel. Used to distinguish "no tunnel configured (operator opted
  // out)" from "tunnel configured but not producing a URL (something is
  // wrong)" so the skip-registration log can be precise and actionable.
  // Optional so tests that don't exercise the tunnel-status path can omit it.
  tunnelConfiguredForChannel?: () => boolean
  // Sleep between learning the public webhook URL and telling GitHub about
  // it. cloudflared prints the trycloudflare.com URL as soon as the control
  // connection comes up, but the Cloudflare edge needs a beat to start
  // routing traffic for that hostname. If we register with GitHub the
  // instant we know the URL, GitHub's automatic `ping` delivery races the
  // edge and lands "failed to connect to host". 2s is enough on every
  // network we've tested; tests pass 0 to skip.
  webhookRegistrationDelayMs?: number
  // Test-only: replaces the wall-clock sleep used for the registration
  // delay above. Production leaves it undefined and we use `setTimeout`.
  sleep?: (ms: number) => Promise<void>
  // How often to proactively refresh the token and update GH_TOKEN
  // when the adapter is running but has not made an outbound API call
  // recently. Zero disables the background refresh entirely.
  // Default: 30 minutes.
  tokenRefreshIntervalMs?: number
  // Test-only: replaces `setInterval` so tests can control when the
  // background refresh fires without waiting on real wall-clock time.
  setInterval?: (handler: () => void, ms: number) => { clear: () => void }
}

export type GithubAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

const consoleLogger: GithubAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

const DEFAULT_WEBHOOK_REGISTRATION_DELAY_MS = 2_000
const DEFAULT_TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000

export function createGithubAdapter(options: GithubAdapterOptions): GithubAdapter {
  const logger = options.logger ?? consoleLogger
  const fetchImpl = options.fetchImpl ?? fetch
  const webhookRegistrationDelayMs = options.webhookRegistrationDelayMs ?? DEFAULT_WEBHOOK_REGISTRATION_DELAY_MS
  const sleep = options.sleep ?? defaultSleep
  const auth = buildAuthStrategy({ auth: options.secrets.auth, fetchImpl })
  const webhookSecret = resolveSecret(options.secrets.webhookSecret, undefined, process.env)
  if (webhookSecret === undefined || webhookSecret.trim() === '') throw new Error('GitHub webhookSecret is missing')

  let server: { stop: () => Promise<void> } | null = null
  let selfId: string | null = null
  let selfLogin: string | null = null
  let started = false
  let managedHooks: ReadonlyArray<{ repo: string; hookId: number }> = []
  let tokenRefreshTimer: { clear: () => void } | null = null
  const workspaceByChat = new Map<string, string>()

  const rememberWorkspace = (workspace: string, chat: string): void => {
    workspaceByChat.set(chat, workspace)
  }

  // Repo/owner-aware token resolver. A single GitHub App can span multiple
  // installations (one per owner); each consumer passes its repo/owner so the
  // right installation token is minted. Unlike the old single-token path, this
  // does NOT mutate process.env.GH_TOKEN — that global is seeded separately and
  // only when exactly one installation applies (see seedGhTokenIfSingle).
  const authToken = (context?: GithubAuthContext) => auth.token(context)
  const outbound = createGithubOutboundCallback({
    token: authToken,
    authType: options.secrets.auth.type,
    logger,
    fetchImpl,
  })
  const history = createGithubHistoryCallback({
    token: authToken,
    fetchImpl,
    workspaceForChat: (chat) => workspaceByChat.get(chat) ?? null,
  })
  const membership = createGithubMembershipResolver({ token: authToken, fetchImpl })
  const channelNameResolver = createGithubChannelNameResolver({ token: authToken, fetchImpl })
  const fetchAttachment = createGithubFetchAttachmentCallback()
  // No-op typing callback: GitHub has no typing indicator API.
  const typing = async (): Promise<void> => {}
  const dedup = createDeliveryDedup()
  const isBotInTeam = createTeamMembershipChecker({ token: authToken, fetchImpl })
  const handler = createGithubWebhookHandler({
    webhookSecret,
    dedup,
    allowlist: () => options.configRef().eventAllowlist,
    selfId: () => selfId,
    selfLogin: () => selfLogin,
    authType: () => options.secrets.auth.type,
    isBotInTeam,
    logger,
    route: (message) => {
      rememberWorkspace(message.workspace, message.chat)
      // Ack-first: wrap in Promise.resolve so a synchronous throw inside
      // router.route() cannot prevent the 200 response from being returned.
      void Promise.resolve()
        .then(() => options.router.route(message))
        .catch((err: unknown) => {
          logger.error(`[github] route failed: ${err instanceof Error ? err.message : String(err)}`)
        })
    },
  })

  return {
    async start(): Promise<void> {
      if (started) return
      const self = await auth.getSelf()
      selfId = String(self.id)
      selfLogin = self.login
      // Register all callbacks before binding the HTTP listener so the router
      // is fully wired before any webhook can arrive.
      options.router.registerOutbound('github', outbound)
      options.router.registerTyping('github', typing)
      options.router.registerHistory('github', history)
      options.router.registerMembership('github', membership)
      options.router.registerChannelNameResolver('github', channelNameResolver)
      options.router.registerFetchAttachment('github', fetchAttachment)
      try {
        server = (options.httpListenImpl ?? listenWithBun)(options.configRef().webhookPort, handler)
      } catch (err) {
        // Listener failed — roll back all registrations so stop() is a no-op
        // and the manager can report the failure cleanly.
        options.router.unregisterOutbound('github', outbound)
        options.router.unregisterTyping('github', typing)
        options.router.unregisterHistory('github', history)
        options.router.unregisterMembership('github', membership)
        options.router.unregisterChannelNameResolver('github', channelNameResolver)
        options.router.unregisterFetchAttachment('github', fetchAttachment)
        await auth.dispose()
        delete process.env.GH_TOKEN
        selfId = null
        selfLogin = null
        throw err
      }
      started = true
      // GH_TOKEN is a single process-wide env var the container's `gh` CLI
      // reads, but a GitHub App spanning multiple owners has no single correct
      // token. Seed/refresh it only when exactly one repo is configured (PAT,
      // or App with one unambiguous installation). With multiple repos we skip
      // the global seed: ad-hoc `gh` calls must target a specific repo, and the
      // adapter's own API calls always resolve a repo-scoped token via authToken.
      const ghTokenRepo = ghTokenSeedRepo(options.configRef().repos ?? [])
      const seedGhToken = async (): Promise<void> => {
        process.env.GH_TOKEN = await auth.token(ghTokenRepo === null ? undefined : { repoSlug: ghTokenRepo })
      }
      if (ghTokenRepo !== null || options.secrets.auth.type === 'pat') {
        await seedGhToken()
        const tokenRefreshIntervalMs = options.tokenRefreshIntervalMs ?? DEFAULT_TOKEN_REFRESH_INTERVAL_MS
        if (tokenRefreshIntervalMs > 0) {
          const refresh = () => {
            seedGhToken().catch((err) => {
              logger.error(
                `[github] periodic token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
              )
            })
          }
          const setIntervalFn =
            options.setInterval ??
            ((handler: () => void, ms: number) => {
              const timer = setInterval(handler, ms)
              return { clear: () => clearInterval(timer) }
            })
          tokenRefreshTimer = setIntervalFn(refresh, tokenRefreshIntervalMs)
        }
      } else {
        logger.info(
          '[github] multiple repos configured across possibly-different owners; GH_TOKEN not seeded globally. ' +
            'Ad-hoc `gh` commands should set a repo-scoped token explicitly.',
        )
      }
      logger.info(`[github] webhook listening on port ${options.configRef().webhookPort} as @${self.login}`)
      // Best-effort: App-only preflight that compares the installation's granted
      // permissions against the configured eventAllowlist and warns about gaps.
      // Catches the most common misconfiguration (App installed with the default
      // metadata-only permission set) before any event fires a 403.
      await runAppPermissionPreflight(logger, auth, options.configRef().eventAllowlist, options.configRef().repos ?? [])
      // Repository webhook registration is best-effort: failures are logged
      // per-repo, the adapter stays up. A misconfigured PAT or App that
      // can't manage hooks must not prevent the adapter from accepting
      // events for repos whose hooks are already registered.
      const cfg = options.configRef()
      const repos = cfg.repos ?? []
      const tunnelUrl = options.tunnelUrl?.() ?? null
      if (cfg.webhookUrl !== undefined && tunnelUrl !== null) {
        logger.warn('[github] webhookUrl configured; ignoring tunnel URL for webhook registration')
      }
      const rawUrl = cfg.webhookUrl ?? tunnelUrl
      const managedPath = buildManagedPath(
        resolveAgentId({ containerName: process.env.TYPECLAW_CONTAINER_NAME, agentDir: options.agentDir }),
      )
      const effectiveUrl = rawUrl === null ? null : applyManagedPath(rawUrl, managedPath)
      if (effectiveUrl === null) {
        logSkippedRegistration(logger, {
          tunnelConfigured: options.tunnelConfiguredForChannel?.() ?? false,
          reposCount: repos.length,
        })
      } else if (repos.length > 0) {
        const legacyProviderHostSuffix = detectLegacyProviderHostSuffix(effectiveUrl)
        logger.info(
          `[github] registering webhook for ${repos.length} repo(s) [${repos.join(', ')}] -> ${effectiveUrl} (events: ${cfg.eventAllowlist.join(', ')})`,
        )
        if (webhookRegistrationDelayMs > 0) {
          logger.info(
            `[github] waiting ${webhookRegistrationDelayMs}ms before registering webhook so the Cloudflare edge can warm up`,
          )
          await sleep(webhookRegistrationDelayMs)
        }
        const registration = await registerGithubWebhooks({
          token: (repoSlug: string) => auth.token({ repoSlug }),
          webhookUrl: effectiveUrl,
          webhookSecret,
          repos,
          events: cfg.eventAllowlist,
          managedPath,
          ...(legacyProviderHostSuffix !== undefined ? { legacyProviderHostSuffix } : {}),
          fetchImpl,
        })
        managedHooks = registration.repos.flatMap((r) =>
          r.action === 'created' || r.action === 'updated' ? [{ repo: r.repo, hookId: r.hookId }] : [],
        )
        logRegistrationOutcome(logger, registration, options.secrets.auth.type)
      }
    },
    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('github', outbound)
      options.router.unregisterTyping('github', typing)
      options.router.unregisterHistory('github', history)
      options.router.unregisterMembership('github', membership)
      options.router.unregisterChannelNameResolver('github', channelNameResolver)
      options.router.unregisterFetchAttachment('github', fetchAttachment)
      await server?.stop()
      // Detach hooks AFTER closing the listener so any in-flight deliveries
      // from GitHub no longer hit a live receiver while we're tearing down.
      // The token call uses the still-live `auth` strategy; dispose() runs
      // last to clear the cached App-installation token.
      if (managedHooks.length > 0) {
        const deregistration = await deregisterGithubWebhooks({
          token: (repoSlug: string) => auth.token({ repoSlug }),
          hooks: managedHooks,
          fetchImpl,
        })
        logDeregistrationOutcome(logger, deregistration)
        managedHooks = []
      }
      if (tokenRefreshTimer !== null) {
        tokenRefreshTimer.clear()
        tokenRefreshTimer = null
      }
      await auth.dispose()
      delete process.env.GH_TOKEN
      server = null
      selfId = null
      selfLogin = null
    },
    isConnected(): boolean {
      return started && selfLogin !== null
    },
  }
}

function listenWithBun(port: number, handler: (req: Request) => Promise<Response>): { stop: () => Promise<void> } {
  const server = Bun.serve({ port, fetch: handler })
  return { stop: async () => server.stop() }
}

function logSkippedRegistration(
  logger: GithubAdapterLogger,
  context: { tunnelConfigured: boolean; reposCount: number },
): void {
  if (context.reposCount === 0) {
    logger.info('[github] no repos[] configured; webhook registration skipped')
    return
  }
  if (context.tunnelConfigured) {
    logger.warn(
      '[github] webhook registration SKIPPED: a tunnel is configured for this channel but produced no URL yet. ' +
        "Check `typeclaw tunnel status` for the tunnel's health (cloudflared binary missing, " +
        'auth failure, network issue). Webhook delivery will not work until the tunnel produces a public URL.',
    )
    return
  }
  logger.warn(
    '[github] webhook registration SKIPPED: no `channels.github.webhookUrl` set and no `tunnels[]` entry ' +
      'binds a public URL to this channel. Add an entry to `tunnels[]` (e.g. `provider: "cloudflare-quick"`) ' +
      'or set `channels.github.webhookUrl` to a public URL to enable webhook delivery.',
  )
}

// Known tunnel-provider host suffixes whose hostnames rotate per container.
// A pre-marker hook on one of these is unambiguously a typeclaw orphan from
// this agent's prior runs (cloudflare-quick is per-container, the host
// changes every restart, so a stale unmarked *.trycloudflare.com hook
// pointing at a now-dead host cannot belong to any live service).
// Extending: add the host suffix here AND verify that hooks on the new
// provider always look unmarked (no operator-supplied path) before the
// marker was introduced.
const LEGACY_TUNNEL_PROVIDER_HOSTS: readonly string[] = ['.trycloudflare.com']

function detectLegacyProviderHostSuffix(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  for (const suffix of LEGACY_TUNNEL_PROVIDER_HOSTS) {
    if (parsed.host.endsWith(suffix)) return suffix
  }
  return undefined
}

function logRegistrationOutcome(
  logger: GithubAdapterLogger,
  result: WebhookRegistrationResult,
  authType: 'pat' | 'app',
): void {
  const permissionFailures: Array<{ repo: string; status: number }> = []
  for (const r of result.repos) {
    if (r.action === 'created') logger.info(`[github] registered webhook ${r.hookId} on ${r.repo}`)
    else if (r.action === 'updated') {
      const tail = r.stalePruned > 0 ? ` (pruned ${r.stalePruned} stale)` : ''
      logger.info(`[github] updated webhook ${r.hookId} on ${r.repo}${tail}`)
    } else {
      logger.warn(`[github] webhook register failed for ${r.repo}: ${r.error}`)
      const status = parseListHooksPermissionStatus(r.error)
      if (status !== null) permissionFailures.push({ repo: r.repo, status })
    }
  }
  // One guidance block per start() (not per repo) so a 10-repo permission
  // failure doesn't paste the same paragraph 10 times. The names below MUST
  // match the current github.com UI labels — see comment in
  // buildPermissionGuidance.
  if (permissionFailures.length > 0) {
    logger.warn(buildPermissionGuidance(authType, permissionFailures))
  }
}

async function runAppPermissionPreflight(
  logger: GithubAdapterLogger,
  auth: ReturnType<typeof buildAuthStrategy>,
  eventAllowlist: readonly string[],
  repos: readonly string[],
): Promise<void> {
  if (auth.getInstallationGrants === undefined) return
  const getGrants = (context: GithubAuthContext | undefined) => auth.getInstallationGrants?.(context)
  // One grants check per distinct owner: installations are owner-scoped, so
  // repos sharing an owner share an installation. The first repo per owner is
  // the resolution key. With no repos, fall back to a single context-free check.
  const reposByOwner = new Map<string, string>()
  for (const repo of repos) {
    const owner = repo.split('/')[0]
    if (owner !== undefined && owner !== '' && !reposByOwner.has(owner)) reposByOwner.set(owner, repo)
  }
  const contexts: Array<{ label: string; context: { repoSlug: string } | undefined }> =
    reposByOwner.size === 0
      ? [{ label: 'app', context: undefined }]
      : [...reposByOwner.values()].map((repo) => ({ label: repo, context: { repoSlug: repo } }))
  for (const { label, context } of contexts) {
    let grants
    try {
      grants = await getGrants(context)
    } catch (err) {
      logger.warn(
        `[github] permission preflight skipped for ${label}: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    if (grants === undefined) continue
    const gaps = findPermissionGaps(eventAllowlist, grants.permissions)
    if (gaps.length > 0) logger.warn(buildAppPermissionPreflightGuidance(gaps))
  }
}

function logDeregistrationOutcome(
  logger: GithubAdapterLogger,
  result: Awaited<ReturnType<typeof deregisterGithubWebhooks>>,
): void {
  for (const h of result.hooks) {
    if (h.action === 'deleted') logger.info(`[github] detached webhook ${h.hookId} from ${h.repo}`)
    else if (h.action === 'missing') logger.info(`[github] webhook ${h.hookId} on ${h.repo} already gone`)
    else logger.warn(`[github] webhook detach failed for ${h.repo}#${h.hookId}: ${h.error ?? 'unknown error'}`)
  }
}

// Two repos under the same owner share an installation and could in principle
// share a global GH_TOKEN, but the marginal value doesn't justify the special
// case — only a single configured repo yields an unambiguous seed.
function ghTokenSeedRepo(repos: readonly string[]): string | null {
  return repos.length === 1 ? (repos[0] ?? null) : null
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
