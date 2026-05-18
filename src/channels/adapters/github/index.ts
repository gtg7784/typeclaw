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
import { createGithubMembershipResolver } from './membership'
import { createGithubOutboundCallback } from './outbound'

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
