import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
// KakaoTalk authenticates via a credentials file under
// AGENT_MESSENGER_CONFIG_DIR (workspace/), so its signature is the file's
// content hash. The "credential" naming (vs "token") generalizes across the
// env-var-based adapters and KakaoTalk's file-based credential pathway.
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
    if (name === 'kakaotalk') return buildKakaotalkSignature(options.agentDir, env)
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
      const kakaoFallback = { ...cfg, autoMarkRead: false }
      return createKakaotalk({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? kakaoFallback,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsDir: resolveKakaoConfigDir(options.agentDir, env),
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
            // KakaoTalk credentials file deleted). Continuing to use the
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

// Token-based adapters only. KakaoTalk's credentials live in a file under
// AGENT_MESSENGER_CONFIG_DIR (workspace/.agent-messenger/), not in env, so
// it goes through buildKakaotalkSignature instead.
const TOKEN_ENV: Record<Exclude<AdapterId, 'kakaotalk'>, readonly string[]> = {
  'discord-bot': ['DISCORD_BOT_TOKEN'],
  'slack-bot': ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  'telegram-bot': ['TELEGRAM_BOT_TOKEN'],
}

const KAKAO_DEFAULT_SUBDIR = '.agent-messenger'
const KAKAO_CREDENTIALS_FILE = 'kakaotalk-credentials.json'

function resolveKakaoConfigDir(agentDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.AGENT_MESSENGER_CONFIG_DIR
  if (override !== undefined && override.trim() !== '') return override
  return join(agentDir, 'workspace', KAKAO_DEFAULT_SUBDIR)
}

function resolveKakaoCredentialsPath(agentDir: string, env: NodeJS.ProcessEnv): string {
  return join(resolveKakaoConfigDir(agentDir, env), KAKAO_CREDENTIALS_FILE)
}

function buildKakaotalkSignature(agentDir: string, env: NodeJS.ProcessEnv): { signature: string; missing: string[] } {
  const path = resolveKakaoCredentialsPath(agentDir, env)
  if (!existsSync(path)) {
    return { signature: '', missing: [`kakaotalk credentials file at ${path}`] }
  }
  try {
    // Content hash, not mtime+size: KakaoTalk's credential file is small
    // (a few hundred bytes of JSON) and is rewritten on every OAuth token
    // refresh. Hashing avoids two failure modes mtime+size could miss:
    //   (a) a refresh that produces byte-identical content (rare but
    //       possible when nothing actually rotated) — we correctly skip;
    //   (b) a refresh that lands on the same mtime due to FS resolution
    //       (some host filesystems quantize to seconds).
    const buf = readFileSync(path)
    const digest = createHash('sha256').update(buf).digest('hex')
    return { signature: `${path}@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`kakaotalk credentials file at ${path} (${describe(err)})`] }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
