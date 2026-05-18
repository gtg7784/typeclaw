import type { Stream } from '@/stream'

import { createExternalProvider } from './providers/external'
import type { TunnelConfig, TunnelProviderHandle, TunnelState, TunnelUrlChangedPayload } from './types'

export type TunnelManagerLogger = {
  info: (m: string) => void
  warn: (m: string) => void
  error: (m: string) => void
}

export type TunnelManagerOptions = {
  tunnels: TunnelConfig[]
  stream: Stream
  logger?: TunnelManagerLogger
}

export type TunnelManager = {
  start: () => Promise<void>
  stop: () => Promise<void>
  snapshot: () => TunnelState[]
  urlFor: (tunnelName: string) => string | null
}

const consoleLogger: TunnelManagerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createTunnelManager(options: TunnelManagerOptions): TunnelManager {
  const logger = options.logger ?? consoleLogger
  const handles = new Map<string, TunnelProviderHandle>()

  for (const config of options.tunnels) {
    if (handles.has(config.name)) {
      throw new Error(`tunnel '${config.name}' declared twice in typeclaw.json#tunnels`)
    }
    const handle = buildProvider(config, (url) => publishUrlChange(options.stream, config, url, logger))
    handles.set(config.name, handle)
  }

  return {
    async start(): Promise<void> {
      await Promise.all(
        Array.from(handles.values()).map(async (h) => {
          try {
            await h.start()
          } catch (err) {
            logger.error(
              `[tunnels] ${h.snapshot().name}: start failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }),
      )
    },
    async stop(): Promise<void> {
      await Promise.all(
        Array.from(handles.values()).map((h) =>
          h.stop().catch((err: unknown) => {
            logger.warn(
              `[tunnels] ${h.snapshot().name}: stop failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }),
        ),
      )
    },
    snapshot(): TunnelState[] {
      return Array.from(handles.values()).map((h) => h.snapshot())
    },
    urlFor(tunnelName: string): string | null {
      return handles.get(tunnelName)?.snapshot().url ?? null
    },
  }
}

function buildProvider(config: TunnelConfig, onUrlChange: (url: string) => void): TunnelProviderHandle {
  switch (config.provider) {
    case 'external':
      return createExternalProvider({ config, onUrlChange })
    case 'cloudflare-quick':
    case 'cloudflare-named':
      throw new Error(`tunnel provider '${config.provider}' is not implemented yet (deferred to PR 2/3)`)
  }
}

function publishUrlChange(stream: Stream, config: TunnelConfig, url: string, logger: TunnelManagerLogger): void {
  const payload: TunnelUrlChangedPayload = {
    kind: 'tunnel-url-changed',
    tunnelName: config.name,
    url,
    for: config.for,
    rotatedAt: new Date().toISOString(),
  }
  stream.publish({ target: { kind: 'broadcast' }, payload })
  logger.info(`[tunnels] ${config.name}: URL set to ${url}`)
}
