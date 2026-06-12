import { createConnection } from 'node:net'

// cloudflared allocates a public quick-tunnel URL even when nothing is
// listening upstream, so a "healthy" tunnel can still 502 every request. We
// probe the upstream ourselves before claiming health; refused connections,
// timeouts, and socket errors all count as unreachable.
export async function isUpstreamReachable(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }

    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export type UpstreamProbe = (port: number) => Promise<boolean>
