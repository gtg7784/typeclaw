import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'
import { SecretsBackend } from '@/secrets/storage'

import { createDiscordBotAdapter, type DiscordBotAdapter } from './adapters/discord-bot'
import { createKakaotalkAdapter, type KakaotalkAdapter } from './adapters/kakaotalk'
import { createSlackBotAdapter, type SlackBotAdapter } from './adapters/slack-bot'
import { createTelegramBotAdapter, type TelegramBotAdapter } from './adapters/telegram-bot'
import { createChannelRouter, type ChannelRouter, type CreateSessionForChannel } from './router'
import { ADAPTER_IDS, type AdapterId, type ChannelAdapterConfig, type ChannelsConfig } from './schema'

export type ChannelManagerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ChannelManagerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type ChannelManagerOptions = {
  agentDir: string
  channelsConfigRef: () => ChannelsConfig
  // Plain-text names the agent answers to in channel engagement (the
  // `alias` field in `typeclaw.json`), forwarded to the router as
  // `configuredAliases`. Read live on every inbound so an `applied`-class
  // reload of `alias` takes effect without a container restart. Omitted
  // means alias-based engagement is off — `basename(agentDir)` is still
  // implicit. This MUST be wired up in production (`src/run/index.ts`)
  // or the configured aliases are silently orphaned: parsed by the
  // schema, never read by anyone. See `manager.test.ts` for the
  // end-to-end engagement assertion that guards this wiring.
  aliasesRef?: () => readonly string[]
  logger?: ChannelManagerLogger
  env?: NodeJS.ProcessEnv
  // Production wiring passes a factory that builds sessions with the full
  // runtime plumbing (channelRouter, stream, plugins, reloadRegistry). When
  // omitted, the router falls back to a hollow factory that creates sessions
  // without a channelRouter — the agent then has no `channel_send` tool and
  // cannot reply, which is fine for tests but a bug in production. See
  // src/run/index.ts where this is wired.
  createSessionForChannel?: CreateSessionForChannel
  // Test seams: let fake adapters replace the real adapter wiring per id.
  createDiscordAdapter?: typeof createDiscordBotAdapter
  createKakaotalkAdapter?: typeof createKakaotalkAdapter
  createSlackAdapter?: typeof createSlackBotAdapter
  createTelegramAdapter?: typeof createTelegramBotAdapter
}

export type ChannelManager = {
  router: ChannelRouter
  start: () => Promise<void>
  stop: () => Promise<void>
  reload: () => Promise<{ started: string[]; stopped: string[]; restartRequired: string[] }>
}

type AnyAdapter = DiscordBotAdapter | KakaotalkAdapter | SlackBotAdapter | TelegramBotAdapter

// Credential signature is the comparison key for credential-rotation
// detection on reload. Discord and Telegram each use a single bot token;
// Slack needs both a bot token and an app-level token (Socket Mode);
// KakaoTalk authenticates via a structured multi-account block in
// secrets.json#channels.kakaotalk, so its signature is that block's content
// hash. The "credential" naming (vs "token") generalizes across the
// env-var-based adapters and KakaoTalk's account credential pathway.
type AdapterEntry = {
  adapter: AnyAdapter
  credentialSignature: string
}

export function createChannelManager(options: ChannelManagerOptions): ChannelManager {
  const logger = options.logger ?? consoleLogger
  const env = options.env ?? process.env
  const router = createChannelRouter({
    agentDir: options.agentDir,
    configForAdapter: (adapter) => options.channelsConfigRef()[adapter],
    logger,
    ...(options.aliasesRef ? { configuredAliases: options.aliasesRef } : {}),
    ...(options.createSessionForChannel ? { createSessionForChannel: options.createSessionForChannel } : {}),
  })
  const createDiscordAdapter = options.createDiscordAdapter ?? createDiscordBotAdapter
  const createKakaotalk = options.createKakaotalkAdapter ?? createKakaotalkAdapter
  const createSlackAdapter = options.createSlackAdapter ?? createSlackBotAdapter
  const createTelegramAdapter = options.createTelegramAdapter ?? createTelegramBotAdapter

  const live = new Map<AdapterId, AdapterEntry>()

  const buildCredentialSignature = (name: AdapterId): { signature: string; missing: string[] } => {
    if (name === 'kakaotalk') return buildKakaotalkSignature(options.agentDir)
    const requiredEnvs = TOKEN_ENV[name]
    const parts: string[] = []
    const missing: string[] = []
    for (const key of requiredEnvs) {
      const value = env[key]
      if (value === undefined || value.trim() === '') missing.push(key)
      else parts.push(`${key}=${value}`)
    }
    return { signature: parts.join('|'), missing }
  }

  const buildAdapter = (name: AdapterId, cfg: ChannelAdapterConfig): AnyAdapter | null => {
    if (name === 'discord-bot') {
      const token = env.DISCORD_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createDiscordAdapter({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
      })
    }
    if (name === 'slack-bot') {
      const token = env.SLACK_BOT_TOKEN
      const appToken = env.SLACK_APP_TOKEN
      if (token === undefined || token.trim() === '') return null
      if (appToken === undefined || appToken.trim() === '') return null
      return createSlackAdapter({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        appToken,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
      })
    }
    if (name === 'kakaotalk') {
      return createKakaotalk({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore: createContainerKakaoCredentialStore(options.agentDir, env),
      })
    }
    if (name === 'telegram-bot') {
      const token = env.TELEGRAM_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createTelegramAdapter({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
      })
    }
    return null
  }

  const startAdapter = async (name: AdapterId, cfg: ChannelAdapterConfig): Promise<boolean> => {
    if (cfg.enabled === false) {
      logger.info(`[channels] adapter "${name}" is disabled; skipping`)
      return false
    }
    const { signature, missing } = buildCredentialSignature(name)
    if (missing.length > 0) {
      logger.error(`[channels] adapter "${name}" missing credentials: ${missing.join(', ')}; skipping`)
      return false
    }
    const adapter = buildAdapter(name, cfg)
    if (adapter === null) {
      logger.error(`[channels] adapter "${name}" could not be constructed; skipping`)
      return false
    }
    try {
      await adapter.start()
      live.set(name, { adapter, credentialSignature: signature })
      logger.info(`[channels] adapter "${name}" started`)
      return true
    } catch (err) {
      logger.error(`[channels] adapter "${name}" failed to start: ${describe(err)}`)
      return false
    }
  }

  const stopAdapter = async (name: AdapterId): Promise<void> => {
    const entry = live.get(name)
    if (!entry) return
    live.delete(name)
    try {
      await entry.adapter.stop()
      logger.info(`[channels] adapter "${name}" stopped`)
    } catch (err) {
      logger.error(`[channels] adapter "${name}" failed to stop: ${describe(err)}`)
    }
  }

  return {
    router,

    async start(): Promise<void> {
      const cfg = options.channelsConfigRef()
      for (const name of ADAPTER_IDS) {
        const adapterCfg = cfg[name]
        if (adapterCfg !== undefined) await startAdapter(name, adapterCfg)
      }
    },

    async stop(): Promise<void> {
      for (const name of Array.from(live.keys())) await stopAdapter(name)
      await router.stop()
    },

    async reload(): Promise<{ started: string[]; stopped: string[]; restartRequired: string[] }> {
      const cfg = options.channelsConfigRef()
      const started: string[] = []
      const stopped: string[] = []
      const restartRequired: string[] = []

      for (const name of ADAPTER_IDS) {
        const desired = cfg[name]
        const current = live.get(name)
        if (desired === undefined || desired.enabled === false) {
          if (current) {
            await stopAdapter(name)
            stopped.push(name)
          }
        } else if (!current) {
          const ok = await startAdapter(name, desired)
          if (ok) started.push(name)
        } else {
          const { signature, missing } = buildCredentialSignature(name)
          if (missing.length > 0) {
            // Required credentials disappeared (env vars removed from .env, or
            // KakaoTalk credentials removed from secrets.json). Continuing to use the
            // in-memory credentials would silently honor a credential the
            // operator explicitly removed, so stop the adapter instead of
            // waiting for a manual restart.
            logger.warn(
              `[channels] adapter "${name}" missing credentials after reload (${missing.join(', ')}); stopping`,
            )
            await stopAdapter(name)
            stopped.push(name)
          } else if (signature !== current.credentialSignature) {
            const reason = name === 'kakaotalk' ? 'credential rotation' : 'token rotation'
            restartRequired.push(`${name} (${reason})`)
          }
        }
      }

      return { started, stopped, restartRequired }
    },
  }
}

// Token-based adapters only. KakaoTalk's credentials live in
// secrets.json#channels.kakaotalk, not in env, so it goes through
// buildKakaotalkSignature instead.
const TOKEN_ENV: Record<Exclude<AdapterId, 'kakaotalk'>, readonly string[]> = {
  'discord-bot': ['DISCORD_BOT_TOKEN'],
  'slack-bot': ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  'telegram-bot': ['TELEGRAM_BOT_TOKEN'],
}

function createContainerKakaoCredentialStore(agentDir: string, env: NodeJS.ProcessEnv): SecretsKakaoCredentialStore {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) {
    throw new Error(
      'KakaoTalk credentials require TYPECLAW_HOSTD_URL, TYPECLAW_HOSTD_TOKEN, and TYPECLAW_CONTAINER_NAME',
    )
  }
  return new SecretsKakaoCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostdUrl,
    restartToken,
    containerName,
  })
}

function buildKakaotalkSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.kakaotalk
    if (!isKakaoCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.kakaotalk'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.kakaotalk@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.kakaotalk (${describe(err)})`] }
  }
}

function isKakaoCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
