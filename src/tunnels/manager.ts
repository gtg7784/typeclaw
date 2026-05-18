import type { Stream } from '@/stream'

import { createCloudflareQuickProvider } from './providers/cloudflare-quick'
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
  resolveChannelUpstreamPort?: (channelName: string) => number | null
  cloudflareQuickBinary?: string
  logger?: TunnelManagerLogger
}

export type TunnelManager = {
  start: () => Promise<void>
  stop: () => Promise<void>
  snapshot: () => TunnelState[]
  urlFor: (tunnelName: string) => string | null
  tail: (tunnelName: string) => string[]
  subscribeToLogs: (tunnelName: string, cb: (line: string) => void) => () => void
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
    const handle = buildProvider(
      config,
      options.resolveChannelUpstreamPort,
      (url) => publishUrlChange(options.stream, config, url, logger),
      options.cloudflareQuickBinary,
    )
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
    tail(tunnelName: string): string[] {
      return handles.get(tunnelName)?.tail() ?? []
    },
    subscribeToLogs(tunnelName: string, cb: (line: string) => void): () => void {
      return handles.get(tunnelName)?.subscribeToLogs(cb) ?? (() => {})
    },
  }
}

function buildProvider(
  config: TunnelConfig,
  resolveChannelUpstreamPort: TunnelManagerOptions['resolveChannelUpstreamPort'],
  onUrlChange: (url: string) => void,
  cloudflareQuickBinary: string | undefined,
): TunnelProviderHandle {
  switch (config.provider) {
    case 'external':
      return createExternalProvider({ config, onUrlChange })
    case 'cloudflare-quick':
      return createCloudflareQuickProvider({
        config,
        upstreamPort: resolveUpstreamPort(config, resolveChannelUpstreamPort),
        onUrlChange,
        binary: cloudflareQuickBinary,
      })
  }
}

function resolveUpstreamPort(
  config: TunnelConfig,
  resolveChannelUpstreamPort: TunnelManagerOptions['resolveChannelUpstreamPort'],
): number {
  if (config.for.kind === 'manual') {
    if (config.upstreamPort === undefined) {
      throw new Error(`tunnel '${config.name}' (cloudflare-quick): upstreamPort is required for manual tunnels`)
    }
    return config.upstreamPort
  }

  const upstreamPort = resolveChannelUpstreamPort?.(config.for.name) ?? null
  if (upstreamPort === null) {
    throw new Error(
      `tunnel '${config.name}' (cloudflare-quick): no upstream port resolved for channel '${config.for.name}'`,
    )
  }
  return upstreamPort
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
