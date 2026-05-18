const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export function extractQuickTunnelUrl(line: string): string | null {
  return QUICK_TUNNEL_URL_PATTERN.exec(line)?.[0] ?? null
}
