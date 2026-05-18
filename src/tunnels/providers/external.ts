import type { TunnelConfig, TunnelProviderHandle, TunnelState } from '../types'

export type ExternalProviderOptions = {
  config: TunnelConfig
  onUrlChange: (url: string) => void
}

export function createExternalProvider(options: ExternalProviderOptions): TunnelProviderHandle {
  const { config, onUrlChange } = options
  if (config.provider !== 'external') {
    throw new Error(`createExternalProvider: provider must be 'external', got '${config.provider}'`)
  }
  const url = config.externalUrl
  if (url === undefined || url.trim() === '') {
    throw new Error(`tunnel '${config.name}' (external): externalUrl is required`)
  }

  let started = false
  const state: TunnelState = {
    name: config.name,
    provider: 'external',
    for: config.for,
    url: null,
    status: 'stopped',
    lastUrlAt: null,
    detail: '',
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      state.url = url
      state.status = 'healthy'
      state.lastUrlAt = Date.now()
      onUrlChange(url)
    },
    async stop(): Promise<void> {
      if (!started) return
      started = false
      state.status = 'stopped'
    },
    snapshot(): TunnelState {
      return { ...state }
    },
    tail(): string[] {
      return []
    },
    subscribeToLogs(): () => void {
      return () => {}
    },
  }
}
