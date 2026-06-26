import type { CurrentHostDaemon } from '@/container'

// Shared between the daemon (which alone knows its HTTP port + in-process
// registrar, both available only after boot) and the renewal callbacks in
// cli/hostd.ts (constructed before the daemon). `ready()` lets a caller that
// fires before boot await population instead of racing to a null read.
export type CurrentHostDaemonHolder = {
  set: (value: CurrentHostDaemon) => void
  ready: () => Promise<CurrentHostDaemon>
}

export function createCurrentHostDaemonHolder(): CurrentHostDaemonHolder {
  let resolveReady: (value: CurrentHostDaemon) => void
  const readyPromise = new Promise<CurrentHostDaemon>((resolve) => {
    resolveReady = resolve
  })
  return {
    set: (value) => resolveReady(value),
    ready: () => readyPromise,
  }
}
