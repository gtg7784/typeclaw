import type { Reloadable, ReloadResult } from '@/reload'

import { invalidateProviderAuthCache } from './auth'

export type CreateProviderAuthReloadableOptions = {
  // Fired after the auth cache is cleared. The run stage wires this to channel
  // session teardown so live sessions — which captured an AuthStorage at
  // creation — are recreated with freshly-resolved credentials.
  onProviderAuthChanged?: () => void | Promise<void>
}

export function createProviderAuthReloadable({
  onProviderAuthChanged,
}: CreateProviderAuthReloadableOptions = {}): Reloadable {
  return {
    scope: 'providers',
    description: 'secrets.json provider credentials',
    reload: async (): Promise<ReloadResult> => {
      invalidateProviderAuthCache()
      await onProviderAuthChanged?.()
      return { scope: 'providers', ok: true, summary: 'provider auth cache cleared' }
    },
  }
}
