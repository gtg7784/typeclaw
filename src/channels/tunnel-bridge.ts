import type { Stream } from '@/stream'
import { isTunnelUrlChangedPayload } from '@/tunnels'

import type { AdapterId } from './schema'

export type TunnelBridgeLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type TunnelBridgeChannelManager = {
  restartAdapter: (name: AdapterId) => Promise<void>
}

export type TunnelBridgeOptions = {
  stream: Stream
  channelManager: TunnelBridgeChannelManager
  logger?: TunnelBridgeLogger
}

export type TunnelBridge = {
  stop: () => void
}

const consoleLogger: TunnelBridgeLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
}

export function createTunnelBridge(options: TunnelBridgeOptions): TunnelBridge {
  const logger = options.logger ?? consoleLogger
  // Subscribe synchronously; run/index.ts must create this bridge before
  // tunnelManager.start() so an initial provider URL broadcast cannot be missed.
  const unsubscribe = options.stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const payload = msg.payload
    if (!isTunnelUrlChangedPayload(payload)) return
    if (payload.for.kind !== 'channel') return
    const name = (payload.for as { name?: unknown }).name
    if (typeof name !== 'string') return
    logger.info(`[tunnels] ${name} URL → restarting adapter`)
    void options.channelManager.restartAdapter(name as AdapterId).catch((err: unknown) => {
      logger.error(`[tunnels] failed to restart ${name} adapter: ${err instanceof Error ? err.message : String(err)}`)
    })
  })

  return {
    stop: unsubscribe,
  }
}
