import { isIP } from 'node:net'

import type { SecuritySeverity } from '../permissions'
import { ACKNOWLEDGE_GUARDS, type SecurityBlock, isGuardAcknowledged } from '../policy'

export const GUARD_SSRF = 'ssrf'
// Classified `medium` (silent-attack axis): bypass lets `curl
// http://169.254.169.254/...` return cloud-metadata IAM credentials into
// model context. Silent — no channel side effect at the moment of fetch.
// Catastrophic on follow-up because the model now has live cloud creds.
export const GUARD_SSRF_SEVERITY: SecuritySeverity = 'medium'

const ALWAYS_BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'metadata.aws.internal',
  'instance-data',
  'instance-data.ec2.internal',
])

const ALWAYS_BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.lan', '.intranet', '.corp', '.home']

export type SsrfClassification = {
  blocked: boolean
  category?:
    | 'loopback'
    | 'private_ipv4'
    | 'link_local'
    | 'cloud_metadata'
    | 'ipv6_internal'
    | 'unspecified'
    | 'shared_cgnat'
    | 'reserved_internal_host'
    | 'unsupported_scheme'
  reason?: string
}

export function classifyUrl(rawUrl: string): SsrfClassification {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { blocked: false }
  }

  if (
    parsed.protocol === 'file:' ||
    parsed.protocol === 'gopher:' ||
    parsed.protocol === 'ftp:' ||
    parsed.protocol === 'data:' ||
    parsed.protocol === 'jar:' ||
    parsed.protocol === 'php:' ||
    parsed.protocol === 'dict:'
  ) {
    return {
      blocked: true,
      category: 'unsupported_scheme',
      reason: `${parsed.protocol} URL is not allowed for outbound fetch`,
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { blocked: false }
  }

  const host = parsed.hostname.toLowerCase()
  const decoded = decodeBracketedIpv6(host)

  if (ALWAYS_BLOCKED_HOSTS.has(decoded)) {
    return {
      blocked: true,
      category: 'reserved_internal_host',
      reason: `host "${decoded}" resolves to internal/loopback infrastructure`,
    }
  }
  for (const suffix of ALWAYS_BLOCKED_HOST_SUFFIXES) {
    if (decoded.endsWith(suffix)) {
      return {
        blocked: true,
        category: 'reserved_internal_host',
        reason: `host suffix "${suffix}" is reserved for internal networks`,
      }
    }
  }

  const addressClassification = classifyIpAddress(decoded)
  if (addressClassification.blocked) return addressClassification

  return { blocked: false }
}

export function classifyIpAddress(address: string): SsrfClassification {
  const decoded = decodeBracketedIpv6(address.toLowerCase().split('%')[0] ?? '')
  const ipv4 = parseIpv4Loose(decoded)
  if (ipv4) {
    const cls = classifyIpv4(ipv4)
    if (cls) return { blocked: true, category: cls.category, reason: cls.reason }
    return { blocked: false }
  }
  const normalizedIpv6 = normalizeIpv6(decoded)
  if (normalizedIpv6 !== undefined) {
    const cls = classifyIpv6(normalizedIpv6)
    if (cls) return { blocked: true, category: cls.category, reason: cls.reason }
  }
  return { blocked: false }
}

function normalizeIpv6(address: string): string | undefined {
  if (isIP(address) !== 6) return undefined
  try {
    return decodeBracketedIpv6(new URL(`http://[${address}]/`).hostname).toLowerCase()
  } catch {
    return undefined
  }
}

export function checkSsrfGuard(options: { tool: string; args: Record<string, unknown> }): SecurityBlock | undefined {
  const { tool, args } = options
  if (tool !== 'web_fetch') return undefined
  const url = args.url
  if (typeof url !== 'string') return undefined
  if (isGuardAcknowledged(args, GUARD_SSRF)) return undefined

  const result = classifyUrl(url)
  if (!result.blocked) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_SSRF}\` blocked web_fetch to a non-public destination (${result.category ?? 'unknown'}): ${result.reason ?? 'classified as internal'}.`,
      'This protects against SSRF, cloud metadata exfiltration, and accidental fetches against internal services.',
      `If this is genuinely intentional and you trust the URL, retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_SSRF}: true\` in the web_fetch arguments.`,
    ].join(' '),
  }
}

function decodeBracketedIpv6(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

function parseIpv4Loose(host: string): [number, number, number, number] | undefined {
  const dotted = host.match(/^(\d{1,10})\.(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/)
  if (dotted && dotted[1] && dotted[2] && dotted[3] && dotted[4]) {
    const parts = [dotted[1], dotted[2], dotted[3], dotted[4]].map((s) => parseInt(s, 10))
    if (parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
      return parts as [number, number, number, number]
    }
  }
  const decimal = host.match(/^(\d{6,12})$/)
  if (decimal && decimal[1]) {
    const n = Number(decimal[1])
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    }
  }
  const hex = host.match(/^0x([0-9a-f]{1,8})$/i)
  if (hex && hex[1]) {
    const n = parseInt(hex[1], 16)
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    }
  }
  return undefined
}

function classifyIpv4(
  ip: [number, number, number, number],
): { category: SsrfClassification['category']; reason: string } | undefined {
  const [a, b] = ip
  if (a === 127) return { category: 'loopback', reason: `IPv4 loopback (${ip.join('.')})` }
  if (a === 10) return { category: 'private_ipv4', reason: `private RFC1918 10.0.0.0/8 (${ip.join('.')})` }
  if (a === 172 && b >= 16 && b <= 31)
    return { category: 'private_ipv4', reason: `private RFC1918 172.16.0.0/12 (${ip.join('.')})` }
  if (a === 192 && b === 168)
    return { category: 'private_ipv4', reason: `private RFC1918 192.168.0.0/16 (${ip.join('.')})` }
  if (a === 169 && b === 254)
    return { category: 'cloud_metadata', reason: `link-local / cloud metadata 169.254.0.0/16 (${ip.join('.')})` }
  if (a === 100 && b >= 64 && b <= 127)
    return { category: 'shared_cgnat', reason: `CGNAT 100.64.0.0/10 (${ip.join('.')})` }
  if (a === 198 && (b === 18 || b === 19))
    return { category: 'private_ipv4', reason: `benchmarking-only 198.18.0.0/15 (${ip.join('.')})` }
  if (a === 0) return { category: 'unspecified', reason: `unspecified 0.0.0.0/8 (${ip.join('.')})` }
  if (a >= 224) return { category: 'private_ipv4', reason: `multicast/reserved (${ip.join('.')})` }
  return undefined
}

function classifyIpv6(host: string): { category: SsrfClassification['category']; reason: string } | undefined {
  const lower = host.toLowerCase()
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return { category: 'loopback', reason: 'IPv6 loopback ::1' }
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return { category: 'unspecified', reason: 'IPv6 unspecified ::' }
  const firstHextet = Number.parseInt(lower.split(':')[0] ?? '', 16)
  if (Number.isFinite(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
    return { category: 'link_local', reason: 'IPv6 link-local fe80::/10' }
  if (Number.isFinite(firstHextet) && firstHextet >= 0xfec0 && firstHextet <= 0xfeff)
    return { category: 'ipv6_internal', reason: 'IPv6 site-local fec0::/10' }
  if (lower.startsWith('fc') || lower.startsWith('fd'))
    return { category: 'ipv6_internal', reason: 'IPv6 unique-local fc00::/7' }
  if (lower.startsWith('ff')) return { category: 'ipv6_internal', reason: 'IPv6 multicast ff00::/8' }
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length)
    const dotted = parseIpv4Loose(tail)
    if (dotted) {
      const cls = classifyIpv4(dotted)
      if (cls) return { category: cls.category, reason: `IPv4-mapped IPv6: ${cls.reason}` }
    }
    const hexPair = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hexPair && hexPair[1] && hexPair[2]) {
      const hi = parseInt(hexPair[1], 16)
      const lo = parseInt(hexPair[2], 16)
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const ip: [number, number, number, number] = [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff]
        const cls = classifyIpv4(ip)
        if (cls) return { category: cls.category, reason: `IPv4-mapped IPv6: ${cls.reason}` }
      }
    }
  }
  return undefined
}
