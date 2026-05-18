export type TunnelProvider = 'external' | 'cloudflare-quick'

export type TunnelFor = { kind: 'channel'; name: string } | { kind: 'manual' }

export type TunnelConfig = {
  name: string
  provider: TunnelProvider
  for: TunnelFor
  externalUrl?: string
  upstreamPort?: number
}

export type TunnelStatus = 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'permanently-failed'

export type TunnelState = {
  name: string
  provider: TunnelProvider
  for: TunnelFor
  url: string | null
  status: TunnelStatus
  lastUrlAt: number | null
  detail: string
}

export type TunnelProviderHandle = {
  start: () => Promise<void>
  stop: () => Promise<void>
  snapshot: () => TunnelState
}

export type TunnelUrlChangedPayload = {
  kind: 'tunnel-url-changed'
  tunnelName: string
  url: string
  for: TunnelFor
  rotatedAt: string
}
