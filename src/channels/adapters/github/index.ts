import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig, GithubAdapterConfig } from '@/channels/schema'
import { resolveSecret } from '@/secrets/resolve'
import type { GithubSecretsBlock } from '@/secrets/schema'

import { buildAuthStrategy } from './auth'
import { createGithubChannelNameResolver } from './channel-resolver'
import { createDeliveryDedup } from './dedup'
import { createGithubFetchAttachmentCallback } from './fetch-attachment'
import { createGithubHistoryCallback } from './history'
import { createGithubWebhookHandler } from './inbound'
import { applyManagedPath, buildManagedPath, resolveAgentId } from './managed-path'
import { createGithubMembershipResolver } from './membership'
import { createGithubOutboundCallback } from './outbound'
import { buildPermissionGuidance, parseListHooksPermissionStatus } from './permission-guidance'
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

export function createGithubAdapter(options: GithubAdapterOptions): GithubAdapter {
  const logger = options.logger ?? consoleLogger
  const fetchImpl = options.fetchImpl ?? fetch
  const auth = buildAuthStrategy({ auth: options.secrets.auth, fetchImpl })
  const webhookSecret = resolveSecret(options.secrets.webhookSecret, undefined, process.env)
  if (webhookSecret === undefined || webhookSecret.trim() === '') throw new Error('GitHub webhookSecret is missing')

  let server: { stop: () => Promise<void> } | null = null
  let selfId: string | null = null
  let selfLogin: string | null = null
  let started = false
  let managedHooks: ReadonlyArray<{ repo: string; hookId: number }> = []
  const workspaceByChat = new Map<string, string>()

  const rememberWorkspace = (workspace: string, chat: string): void => {
    workspaceByChat.set(chat, workspace)
  }

  const tokenFn = async () => {
    const t = await auth.token()
    process.env.GH_TOKEN = t
    return t
  }
  const outbound = createGithubOutboundCallback({ token: tokenFn, logger, fetchImpl })
  const history = createGithubHistoryCallback({
    token: tokenFn,
    fetchImpl,
    workspaceForChat: (chat) => workspaceByChat.get(chat) ?? null,
  })
  const membership = createGithubMembershipResolver({ token: tokenFn, fetchImpl })
  const channelNameResolver = createGithubChannelNameResolver({ token: tokenFn, fetchImpl })
  const fetchAttachment = createGithubFetchAttachmentCallback()
  // No-op typing callback: GitHub has no typing indicator API.
  const typing = async (): Promise<void> => {}
  const dedup = createDeliveryDedup()
  const handler = createGithubWebhookHandler({
    webhookSecret,
    dedup,
    allowlist: () => options.configRef().eventAllowlist,
    selfId: () => selfId,
    selfLogin: () => selfLogin,
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
      // Seed GH_TOKEN so `gh` CLI calls in the container are pre-authenticated.
      // tokenFn keeps it current on every adapter API call; App tokens refresh
      // automatically when within 5 minutes of expiry.
      process.env.GH_TOKEN = await auth.token()
      started = true
      logger.info(`[github] webhook listening on port ${options.configRef().webhookPort} as @${self.login}`)
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
        const registration = await registerGithubWebhooks({
          token: tokenFn,
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
          token: tokenFn,
          hooks: managedHooks,
          fetchImpl,
        })
        logDeregistrationOutcome(logger, deregistration)
        managedHooks = []
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
