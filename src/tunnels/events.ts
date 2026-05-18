import type { TunnelUrlChangedPayload } from './types'

export function isTunnelUrlChangedPayload(value: unknown): value is TunnelUrlChangedPayload {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.kind !== 'tunnel-url-changed') return false
  if (typeof v.tunnelName !== 'string') return false
  if (typeof v.url !== 'string') return false
  if (typeof v.rotatedAt !== 'string') return false
  if (v.for === null || typeof v.for !== 'object') return false
  const forKind = (v.for as Record<string, unknown>).kind
  if (forKind !== 'channel' && forKind !== 'manual') return false
  return true
}
