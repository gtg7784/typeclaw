import type { Reloadable, ReloadResult } from '@/reload'

import type { ChannelManager } from './manager'

export type CreateChannelsReloadableOptions = {
  manager: ChannelManager
}

export function createChannelsReloadable({ manager }: CreateChannelsReloadableOptions): Reloadable {
  return {
    scope: 'channels',
    description: 'channels adapters and live config',
    reload: async (): Promise<ReloadResult> => {
      try {
        const diff = await manager.reload()
        const parts: string[] = []
        if (diff.started.length > 0) parts.push(`${diff.started.length} started`)
        if (diff.stopped.length > 0) parts.push(`${diff.stopped.length} stopped`)
        if (diff.restartRequired.length > 0) parts.push(`${diff.restartRequired.length} restart-required`)
        const summary = parts.length === 0 ? 'no adapter changes' : parts.join(', ')
        return { scope: 'channels', ok: true, summary, details: diff }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { scope: 'channels', ok: false, reason: message }
      }
    },
  }
}
