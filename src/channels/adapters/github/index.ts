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
  let selfLogin: string | null = null
  let started = false
  const workspaceByChat = new Map<string, string>()

  const rememberWorkspace = (workspace: string, chat: string): void => {
    workspaceByChat.set(chat, workspace)
  }

  const outbound = createGithubOutboundCallback({ token: auth.token, logger, fetchImpl })
  const history = createGithubHistoryCallback({
    token: auth.token,
    fetchImpl,
    workspaceForChat: (chat) => workspaceByChat.get(chat) ?? null,
  })
  const membership = createGithubMembershipResolver({ token: auth.token, fetchImpl })
  const channelNameResolver = createGithubChannelNameResolver({ token: auth.token, fetchImpl })
  const fetchAttachment = createGithubFetchAttachmentCallback()
  const dedup = createDeliveryDedup()
  const handler = createGithubWebhookHandler({
    webhookSecret,
    dedup,
    allowlist: () => options.configRef().eventAllowlist,
    selfLogin: () => selfLogin,
    logger,
    route: async (message) => {
      rememberWorkspace(message.workspace, message.chat)
      await options.router.route(message)
    },
  })

  return {
    async start(): Promise<void> {
      if (started) return
      const self = await auth.getSelf()
      selfLogin = self.login
      options.router.registerOutbound('github', outbound)
      options.router.registerHistory('github', history)
      options.router.registerMembership('github', membership)
      options.router.registerChannelNameResolver('github', channelNameResolver)
      options.router.registerFetchAttachment('github', fetchAttachment)
      server = (options.httpListenImpl ?? listenWithBun)(options.configRef().webhookPort, handler)
      started = true
      logger.info(`[github] webhook listening on port ${options.configRef().webhookPort} as @${self.login}`)
    },
    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('github', outbound)
      options.router.unregisterHistory('github', history)
      options.router.unregisterMembership('github', membership)
      options.router.unregisterChannelNameResolver('github', channelNameResolver)
      options.router.unregisterFetchAttachment('github', fetchAttachment)
      await server?.stop()
      server = null
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
