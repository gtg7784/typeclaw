import { createDiscordBotAdapter, type DiscordBotAdapter } from './adapters/discord-bot'
import { createChannelRouter, type ChannelRouter, type CreateSessionForChannel } from './router'
import type { ChannelAdapterConfig, ChannelsConfig } from './schema'

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
  logger?: ChannelManagerLogger
  env?: NodeJS.ProcessEnv
  // Production wiring passes a factory that builds sessions with the full
  // runtime plumbing (channelRouter, stream, plugins, reloadRegistry). When
  // omitted, the router falls back to a hollow factory that creates sessions
  // without a channelRouter — the agent then has no `channel_send` tool and
  // cannot reply, which is fine for tests but a bug in production. See
  // src/run/index.ts where this is wired.
  createSessionForChannel?: CreateSessionForChannel
  // Test seam: lets a fake adapter replace the real Discord adapter wiring.
  createDiscordAdapter?: typeof createDiscordBotAdapter
}

export type ChannelManager = {
  router: ChannelRouter
  start: () => Promise<void>
  stop: () => Promise<void>
  reload: () => Promise<{ started: string[]; stopped: string[]; restartRequired: string[] }>
}

export function createChannelManager(options: ChannelManagerOptions): ChannelManager {
  const logger = options.logger ?? consoleLogger
  const env = options.env ?? process.env
  const router = createChannelRouter({
    agentDir: options.agentDir,
    configForAdapter: (adapter) => options.channelsConfigRef()[adapter],
    logger,
    ...(options.createSessionForChannel ? { createSessionForChannel: options.createSessionForChannel } : {}),
  })
  const createAdapter = options.createDiscordAdapter ?? createDiscordBotAdapter

  type AdapterEntry = {
    adapter: DiscordBotAdapter
    token: string
  }
  const live = new Map<keyof ChannelsConfig, AdapterEntry>()

  const startAdapter = async (name: 'discord-bot', cfg: ChannelAdapterConfig): Promise<boolean> => {
    if (cfg.enabled === false) {
      logger.info(`[channels] adapter "${name}" is disabled; skipping`)
      return false
    }
    const tokenEnv = TOKEN_ENV[name]
    const token = env[tokenEnv]
    if (!token || token.trim() === '') {
      logger.error(`[channels] adapter "${name}" requires ${tokenEnv} in .env; skipping`)
      return false
    }
    const adapter = createAdapter({
      router,
      configRef: () => options.channelsConfigRef()[name] ?? cfg,
      token,
      logger,
    })
    try {
      await adapter.start()
      live.set(name, { adapter, token })
      logger.info(`[channels] adapter "${name}" started`)
      return true
    } catch (err) {
      logger.error(`[channels] adapter "${name}" failed to start: ${describe(err)}`)
      return false
    }
  }

  const stopAdapter = async (name: 'discord-bot'): Promise<void> => {
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
      if (cfg['discord-bot']) await startAdapter('discord-bot', cfg['discord-bot'])
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

      const desired = cfg['discord-bot']
      const current = live.get('discord-bot')
      if (desired === undefined || desired.enabled === false) {
        if (current) {
          await stopAdapter('discord-bot')
          stopped.push('discord-bot')
        }
      } else if (!current) {
        const ok = await startAdapter('discord-bot', desired)
        if (ok) started.push('discord-bot')
      } else {
        const tokenEnv = TOKEN_ENV['discord-bot']
        const newToken = env[tokenEnv] ?? ''
        if (newToken !== current.token) {
          restartRequired.push('discord-bot (token rotation)')
        }
      }

      return { started, stopped, restartRequired }
    },
  }
}

const TOKEN_ENV = {
  'discord-bot': 'DISCORD_BOT_TOKEN',
} as const

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
