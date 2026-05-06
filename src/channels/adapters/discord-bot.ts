import {
  MEMBERSHIP_ENUMERATION_CAP,
  type MembershipResolver,
  type MembershipResolverFailure,
  type MembershipResolverResult,
} from '@/channels/membership'
import { deriveMembershipFromHistory } from '@/channels/membership-from-history'
import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type {
  ChannelHistoryMessage,
  FetchAttachmentCallback,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
  TypingTarget,
} from '@/channels/types'

import {
  DiscordBotClient,
  DiscordBotListener,
  DiscordIntent,
  type DiscordGatewayMessageCreateEvent,
} from './agent-messenger-shim'
import { createDiscordChannelResolver } from './discord-bot-channel-resolver'
import { classifyInbound, type InboundDropReason } from './discord-bot-classify'

const DISCORD_API_BASE = 'https://discord.com/api/v10'

function formatLabel(name: string | undefined, id: string, prefix = ''): string {
  if (name === undefined || name === '' || name === id) return id
  return `${prefix}${name}(${id})`
}

// agent-messenger's DEFAULT_INTENTS omits MessageContent (privileged), so the
// bot's gateway IDENTIFY never asks for it and Discord delivers every message
// with content: ''. We mirror the SDK's defaults here and add MessageContent
// so inbound messages actually carry text. The portal toggle is necessary but
// not sufficient — the bitmask must include this bit too.
export const DISCORD_BOT_INTENTS =
  DiscordIntent.Guilds |
  DiscordIntent.GuildMessages |
  DiscordIntent.GuildMessageReactions |
  DiscordIntent.GuildMessageTyping |
  DiscordIntent.DirectMessages |
  DiscordIntent.DirectMessageReactions |
  DiscordIntent.DirectMessageTyping |
  DiscordIntent.MessageContent

export type DiscordBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: DiscordBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type DiscordBotAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  token: string
  logger?: DiscordBotAdapterLogger
}

export type DiscordBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

// Discord's typing indicator (`POST /channels/{id}/typing`) is fire-and-
// forget: the indicator expires after ~10s on Discord's side, the router
// re-fires it every 8s while debouncing or generating, and a missed beat just
// gaps the indicator by a few seconds. We bypass the SDK because it doesn't
// expose this endpoint; rate-limit handling is unnecessary here because the
// router caps cadence per-channel at 8s.
export function createTypingCallback(deps: {
  token: string
  configRef: () => ChannelAdapterConfig
  logger: DiscordBotAdapterLogger
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
}): TypingCallback {
  const { token, configRef, logger, formatChannelTag } = deps
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'discord-bot') return
    const config = configRef()
    if (!isAllowed(config.allow, target.workspace, target.chat)) return
    // Threads are channels in Discord, so the typing endpoint takes the
    // thread id directly when present.
    const channelId = target.thread ?? target.chat
    const tag = formatChannelTag ? await formatChannelTag(target.workspace, channelId) : `channel=${channelId}`
    try {
      const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/typing`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Length': '0' },
      })
      if (!response.ok) {
        logger.warn(`[discord-bot] typing ${tag} status=${response.status}`)
      }
    } catch (err) {
      logger.warn(`[discord-bot] typing ${tag} failed: ${describe(err)}`)
    }
  }
}

export const DISCORD_HISTORY_LIMIT_MAX = 100

type DiscordGuildPreview = {
  approximate_member_count?: number
}

type DiscordGuildMember = {
  user?: { id?: string; bot?: boolean }
}

export function createDiscordMembershipResolver(deps: {
  token: string
  logger: DiscordBotAdapterLogger
  historyCallback: HistoryCallback
  fetchImpl?: typeof fetch
  now?: () => number
}): MembershipResolver {
  const fetchFn = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.workspace === '@dm') return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }

    const fallback = (): Promise<MembershipResolverResult> =>
      deriveMembershipFromHistory({
        fetchHistory: (limit) => deps.historyCallback({ chat: key.chat, thread: key.thread, limit }),
        now,
      })

    const preview = await fetchDiscordJson<DiscordGuildPreview>(
      fetchFn,
      `${DISCORD_API_BASE}/guilds/${key.workspace}/preview`,
      deps.token,
    )
    if (!preview.ok) {
      deps.logger.warn(`[discord-bot] membership preview guild=${key.workspace} failed: ${preview.reason}`)
      return preview.failure
    }

    const approximate = Math.max(0, Math.floor(preview.value.approximate_member_count ?? 0))
    if (approximate > MEMBERSHIP_ENUMERATION_CAP) {
      // Beyond the enumeration cap, /members truncates anyway, and the
      // recent-speakers count is more useful for engagement than a raw
      // guild-wide approximation that double-counts lurkers.
      return await fallback()
    }

    const members = await fetchDiscordJson<DiscordGuildMember[]>(
      fetchFn,
      `${DISCORD_API_BASE}/guilds/${key.workspace}/members?limit=100`,
      deps.token,
    )
    if (!members.ok) {
      if (members.status === 403) {
        // 403 here is almost always the GUILD_MEMBERS privileged intent
        // missing on the application (Developer Portal → Bot →
        // Privileged Gateway Intents → SERVER MEMBERS INTENT). Server-side
        // ADMINISTRATOR perms do not unlock this — the gate is at the
        // gateway/API privacy layer.
        deps.logger.warn(
          `[discord-bot] membership members guild=${key.workspace} status=403 (likely missing GUILD_MEMBERS intent); deriving from recent message authors`,
        )
        return await fallback()
      }
      deps.logger.warn(`[discord-bot] membership members guild=${key.workspace} failed: ${members.reason}`)
      return members.failure
    }

    let bots = 0
    let humans = 0
    for (const member of members.value) {
      if (member.user?.bot === true) bots++
      else humans++
    }
    return { humans, bots, fetchedAt: now(), truncated: false }
  }
}

type DiscordFetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number | null; reason: string; failure: MembershipResolverFailure }

async function fetchDiscordJson<T>(fetchFn: typeof fetch, url: string, token: string): Promise<DiscordFetchResult<T>> {
  let response: Response
  try {
    response = await fetchFn(url, { method: 'GET', headers: { Authorization: `Bot ${token}` } })
  } catch (err) {
    return { ok: false, status: null, reason: describe(err), failure: { kind: 'transient' } }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: `http ${response.status}`,
      failure: discordFailureForStatus(response.status),
    }
  }
  try {
    return { ok: true, value: (await response.json()) as T }
  } catch (err) {
    return { ok: false, status: null, reason: `parse failed: ${describe(err)}`, failure: { kind: 'transient' } }
  }
}

function discordFailureForStatus(status: number): MembershipResolverFailure {
  if (status === 401 || status === 403 || status === 404) return { kind: 'permanent' }
  return { kind: 'transient' }
}

type DiscordRawHistoryMessage = {
  id: string
  channel_id: string
  author: { id: string; username?: string; global_name?: string | null; bot?: boolean }
  content: string
  timestamp: string
  message_reference?: { message_id?: string }
}

// Discord treats threads as separate channels with their own snowflake ids,
// and the gateway puts the thread's id in `event.channel_id`. The inbound
// classifier therefore stores the thread channel id in `chat` and leaves
// `thread` null. This callback uses `args.chat` as the channel id directly,
// which works for both top-level channels and threads. When a future caller
// passes a non-null `args.thread`, that wins (forward-compatible with a
// design where `chat` is the parent and `thread` is the thread channel id).
export function createDiscordHistoryCallback(deps: {
  token: string
  configRef: () => ChannelAdapterConfig
  logger: DiscordBotAdapterLogger
  botUserIdRef: () => string | null
  fetchImpl?: typeof fetch
}): HistoryCallback {
  const { token, configRef, logger, botUserIdRef } = deps
  const fetchFn = deps.fetchImpl ?? fetch
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const config = configRef()
    if (!isAllowedAnyGuild(config.allow, args.chat)) {
      return { ok: false, error: 'denied by allow rules' }
    }

    const channelId = args.thread ?? args.chat
    const limit = clampLimit(args.limit, DISCORD_HISTORY_LIMIT_MAX)
    const params = new URLSearchParams({ limit: String(limit) })
    if (args.cursor !== undefined && args.cursor !== '') params.set('before', args.cursor)

    let raw: DiscordRawHistoryMessage[]
    let response: Response
    try {
      response = await fetchFn(`${DISCORD_API_BASE}/channels/${channelId}/messages?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bot ${token}` },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`[discord-bot] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
    if (!response.ok) {
      return { ok: false, error: `http ${response.status}` }
    }
    try {
      raw = (await response.json()) as DiscordRawHistoryMessage[]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `parse failed: ${message}` }
    }

    const botUserId = botUserIdRef()
    // Discord returns newest-first; reverse for oldest-first chronological.
    const mapped = raw.map((m) => mapDiscordMessage(m, botUserId)).reverse()

    // Cursor for the next (older) page is the oldest message id we just
    // received — Discord's `before=` is exclusive and content-addressed.
    // Only present when this page was fully populated; otherwise the agent
    // has reached the start of the channel.
    const nextCursor = raw.length === limit && raw.length > 0 ? raw[raw.length - 1]!.id : undefined
    if (nextCursor !== undefined) {
      return { ok: true, messages: mapped, nextCursor }
    }
    return { ok: true, messages: mapped }
  }
}

function mapDiscordMessage(msg: DiscordRawHistoryMessage, botUserId: string | null): ChannelHistoryMessage {
  const isBot = msg.author.bot === true || (botUserId !== null && msg.author.id === botUserId)
  const ts = Date.parse(msg.timestamp)
  return {
    externalMessageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.author.global_name ?? msg.author.username ?? msg.author.id,
    text: msg.content,
    ts: Number.isFinite(ts) ? ts : 0,
    isBot,
    replyToBotMessageId: msg.message_reference?.message_id ?? null,
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

// Discord channel ids are globally unique snowflakes, so a `channel:<id>`
// or `guild:<g>/<id>` rule for any guild admits this chat. We match this
// way because at fetch time the tool has resolved the chat from session
// origin but does not always re-supply the guild id (esp. across cursor
// pagination), so the workspace-aware `isAllowed` is too narrow here.
function isAllowedAnyGuild(rules: readonly string[], chat: string): boolean {
  for (const rule of rules) {
    if (rule === '*') return true
    if (rule === 'guild:*' || rule === 'team:*') return true
    if (rule === 'dm:*') return true
    if (rule.startsWith('channel:') && rule.slice(8) === chat) return true
    if (rule.startsWith('dm:') && rule.slice(3) === chat) return true
    if (rule.startsWith('guild:')) {
      const body = rule.slice(6)
      const slash = body.indexOf('/')
      if (slash !== -1 && body.slice(slash + 1) === chat) return true
    }
  }
  return false
}

// Discord-side asymmetry: agent-messenger's upstream `uploadFile` posts the
// file to `POST /channels/{id}/messages` as a multipart-only request. It does
// not accept a `content` body or a `thread_id`. So when the agent wants to
// send "text + file together in a thread", we cannot do it in one round-trip
// the way Slack can. Compromise that preserves observable intent without
// patching upstream:
//   1. Upload each attachment individually via uploadFile(chat, path).
//      Files land in channel root even when the session is in a thread —
//      logged as a warning so it shows up in operator triage.
//   2. After uploads, if `text` was provided, send it via sendMessage with
//      thread_id when applicable. Text DOES get the thread, file does not.
// Failure semantics: if any upload fails, we abort and return ok:false with
// the upload error (the file the agent wanted to share is the load-bearing
// part of the message). The text post is best-effort and only attempted
// after every upload succeeds.
export function createOutboundCallback(deps: {
  client: Pick<DiscordBotClient, 'sendMessage' | 'uploadFile'>
  configRef: () => ChannelAdapterConfig
  logger: DiscordBotAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
  resolvePath?: (path: string) => string
}): OutboundCallback {
  const { client, configRef, logger, formatChannelTag, resolvePath } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'discord-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[discord-bot] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) {
      return { ok: false, error: 'message has neither text nor attachments' }
    }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(
      `[discord-bot] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${msg.thread ? ` thread=${msg.thread}` : ''}`,
    )

    for (const attachment of attachments) {
      const path = resolvePath ? resolvePath(attachment.path) : attachment.path
      try {
        const file = await client.uploadFile(msg.chat, path)
        logger.info(`[discord-bot] uploaded id=${file.id} filename=${file.filename} size=${file.size} ${tag}`)
        if (msg.thread) {
          logger.warn(
            `[discord-bot] uploaded file landed in channel root, not thread ${msg.thread}: ` +
              'agent-messenger uploadFile does not accept thread_id',
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[discord-bot] uploadFile failed for ${path}: ${message}`)
        return { ok: false, error: `uploadFile failed: ${message}` }
      }
    }

    if (text === '') {
      return { ok: true }
    }

    try {
      const sent = await client.sendMessage(msg.chat, text, msg.thread ? { thread_id: msg.thread } : undefined)
      logger.info(`[discord-bot] sent id=${sent.id} ${tag}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[discord-bot] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

// Discord CDN URLs (`cdn.discordapp.com/attachments/...`) are signed and
// expire (~24h). Sending the bot token alongside makes no difference for
// public CDN URLs (Discord ignores it), but is required for the rare
// guild-restricted attachment, so we set it unconditionally — fail-open
// to ensure-public is the wrong default for a fetch primitive that the
// agent will lean on. URL validation refuses anything outside Discord's
// own domains so the agent can't be tricked into using this callback as
// a generic credentialed fetch.
const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

export function createFetchAttachmentCallback(deps: {
  token: string
  logger: DiscordBotAdapterLogger
  fetchImpl?: typeof fetch
}): FetchAttachmentCallback {
  const { token, logger } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  return async ({ ref, filename }) => {
    let url: URL
    try {
      url = new URL(ref)
    } catch {
      return { ok: false, error: `invalid Discord attachment URL: ${ref}` }
    }
    if (!DISCORD_ATTACHMENT_HOSTS.has(url.hostname)) {
      return { ok: false, error: `not a Discord CDN URL: ${url.hostname}` }
    }
    try {
      const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bot ${token}` } })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const message = `discord cdn fetch ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`
        logger.error(`[discord-bot] fetchAttachment failed for ${url.toString()}: ${message}`)
        return { ok: false, error: message }
      }
      const arrayBuffer = await res.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const inferredFilename = filename ?? url.pathname.split('/').pop() ?? 'attachment'
      const contentType = res.headers.get('content-type') ?? undefined
      logger.info(
        `[discord-bot] downloaded url=${url.toString()} name=${inferredFilename} size=${buffer.length}${contentType ? ` type=${contentType}` : ''}`,
      )
      return {
        ok: true,
        buffer,
        filename: inferredFilename,
        ...(contentType !== undefined ? { mimetype: contentType } : {}),
        size: buffer.length,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[discord-bot] fetchAttachment failed for ${url.toString()}: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createDiscordBotAdapter(options: DiscordBotAdapterOptions): DiscordBotAdapter {
  const logger = options.logger ?? consoleLogger
  const client = new DiscordBotClient()
  let listener: DiscordBotListener | null = null
  let botUserId: string | null = null
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createDiscordChannelResolver({ token: options.token })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'discord-bot', workspace, chat, thread: null }).catch(
      () => ({}) as ResolvedChannelNames,
    )
    const workspacePart = workspace === '@dm' ? 'dm' : `guild=${formatLabel(names.workspaceName, workspace)}`
    const chatPart = `channel=${formatLabel(names.chatName, chat)}`
    return `${workspacePart} ${chatPart}`
  }

  const typingCallback = createTypingCallback({
    token: options.token,
    configRef: options.configRef,
    logger,
    formatChannelTag,
  })

  const historyCallback = createDiscordHistoryCallback({
    token: options.token,
    configRef: options.configRef,
    logger,
    botUserIdRef: () => botUserId,
  })

  const membershipResolver = createDiscordMembershipResolver({
    token: options.token,
    logger,
    historyCallback,
  })

  const outboundCallback = createOutboundCallback({
    client,
    configRef: options.configRef,
    logger,
    formatChannelTag,
  })

  const fetchAttachmentCallback = createFetchAttachmentCallback({ token: options.token, logger })

  const handleMessageCreate = async (event: DiscordGatewayMessageCreateEvent): Promise<void> => {
    inflightInbounds++
    try {
      // One log line per gateway event is non-negotiable: it's the only way to
      // tell from logs whether the gateway is delivering at all. content_len=0
      // is the smoking gun for a missing MessageContent privileged intent.
      const inboundWorkspace = event.guild_id ?? '@dm'
      const inboundTag = await formatChannelTag(inboundWorkspace, event.channel_id)
      logger.info(
        `[discord-bot] inbound id=${event.id} author=${formatLabel(event.author.username, event.author.id)} ${inboundTag} content_len=${event.content.length}`,
      )

      const verdict = classifyInbound(event, options.configRef(), botUserId)
      if (verdict.kind === 'drop') {
        logger.info(`[discord-bot] dropped id=${event.id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      const routedTag = await formatChannelTag(verdict.payload.workspace, verdict.payload.chat)
      logger.info(
        `[discord-bot] routed id=${event.id} ${routedTag} mention=${verdict.payload.isBotMention} reply=${verdict.payload.replyToBotMessageId !== null}`,
      )
      await options.router.route(verdict.payload)
    } catch (err) {
      logger.error(`[discord-bot] handleInbound failed: ${describe(err)}`)
    } finally {
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      try {
        await client.login({ token: options.token })
      } catch (err) {
        started = false
        logger.error(`[discord-bot] login failed: ${describe(err)}`)
        throw err
      }

      listener = new DiscordBotListener(client, { intents: DISCORD_BOT_INTENTS })
      listener.on('connected', (info) => {
        botUserId = info.user.id
        logger.info(`[discord-bot] connected as ${info.user.username} (${info.user.id})`)
      })
      listener.on('disconnected', () => {
        logger.warn('[discord-bot] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[discord-bot] gateway error: ${describe(err)}`)
      })
      listener.on('message_create', (event) => {
        void handleMessageCreate(event)
      })

      options.router.registerOutbound('discord-bot', outboundCallback)
      options.router.registerTyping('discord-bot', typingCallback)
      options.router.registerChannelNameResolver('discord-bot', channelResolver)
      options.router.registerHistory('discord-bot', historyCallback)
      options.router.registerFetchAttachment('discord-bot', fetchAttachmentCallback)
      options.router.registerMembership('discord-bot', membershipResolver)

      try {
        await listener.start()
      } catch (err) {
        started = false
        logger.error(`[discord-bot] listener start failed: ${describe(err)}`)
        throw err
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('discord-bot', outboundCallback)
      options.router.unregisterTyping('discord-bot', typingCallback)
      options.router.unregisterChannelNameResolver('discord-bot', channelResolver)
      options.router.unregisterHistory('discord-bot', historyCallback)
      options.router.unregisterFetchAttachment('discord-bot', fetchAttachmentCallback)
      options.router.unregisterMembership('discord-bot', membershipResolver)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
    },

    isConnected(): boolean {
      return botUserId !== null
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Operator hints appended to drop logs. Kept short — full guidance lives in
// docs. The empty_content hint is the highest-leverage one because that
// failure mode is invisible from Discord's side (bot stays green).
function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_content':
      return ' (enable MESSAGE CONTENT INTENT in Discord Developer Portal and restart)'
    case 'not_in_allow_list':
      return ' (extend channels.discord-bot.allow in typeclaw.json to admit this workspace/channel)'
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}
