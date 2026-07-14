import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

import { classifyIpAddress, classifyUrl } from '@/bundled-plugins/security/policies/ssrf'

export type PublicHttpAddress = { address: string; family: 4 | 6 }

export type PublicHttpRequestOptions = {
  protocol: 'http:' | 'https:'
  hostname: string
  port?: number
  path: string
  method: 'GET'
  headers: Record<string, string>
  servername?: string
  signal: AbortSignal
  lookup: LookupFunction
  autoSelectFamily: false
}

export type PublicHttpResponse = {
  statusCode: number
  headers: IncomingHttpHeaders
  body: AsyncIterable<Uint8Array>
  cancel(): void
}

export type PublicHttpDependencies = {
  resolveAddresses(hostname: string): Promise<readonly PublicHttpAddress[]>
  request(options: PublicHttpRequestOptions): Promise<PublicHttpResponse>
}

export type PublicHttpResult = { response: PublicHttpResponse; finalUrl: string }

export const DEFAULT_PUBLIC_HTTP_MAX_REDIRECTS = 5

export async function requestPublicHttpUrl(
  rawUrl: string,
  options: {
    signal: AbortSignal
    headers?: Record<string, string>
    headersForUrl?: (url: string) => Record<string, string>
    onResponse?: (response: PublicHttpResponse, url: string) => void
    maxRedirects?: number
    dependencies?: PublicHttpDependencies
  },
): Promise<PublicHttpResult> {
  const dependencies = options.dependencies ?? defaultPublicHttpDependencies
  const maxRedirects = options.maxRedirects ?? DEFAULT_PUBLIC_HTTP_MAX_REDIRECTS
  let current = requirePublicHttpUrl(rawUrl)
  const initialOrigin = new URL(current).origin
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const parsed = new URL(current)
    const hostname = unbracketHostname(parsed.hostname)
    const response = await dependencies.request({
      protocol: parsed.protocol as 'http:' | 'https:',
      hostname,
      ...(parsed.port === '' ? {} : { port: Number(parsed.port) }),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        ...headersForHop(options.headers ?? {}, initialOrigin, parsed.origin),
        ...options.headersForUrl?.(current),
        Host: parsed.host,
      },
      ...(parsed.protocol === 'https:' ? { servername: hostname } : {}),
      signal: options.signal,
      lookup: createPublicSocketLookup(dependencies.resolveAddresses),
      autoSelectFamily: false,
    })
    options.onResponse?.(response, current)
    if (!isRedirectStatus(response.statusCode)) return { response, finalUrl: current }
    try {
      const location = headerValue(response.headers, 'location')
      if (location === null) throw new Error(`redirect from ${current} omitted the Location header`)
      if (redirects === maxRedirects) throw new Error(`redirect limit exceeded (${maxRedirects})`)
      current = requirePublicHttpUrl(new URL(location, current).toString())
    } finally {
      response.cancel()
    }
  }
  throw new Error('redirect limit exceeded')
}

function headersForHop(
  headers: Record<string, string>,
  initialOrigin: string,
  currentOrigin: string,
): Record<string, string> {
  if (initialOrigin === currentOrigin) return headers
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !/^(authorization|cookie|proxy-authorization)$/i.test(name)),
  )
}

export function createPublicSocketLookup(resolveAddresses: PublicHttpDependencies['resolveAddresses']): LookupFunction {
  return (hostname, options, callback) => {
    void resolveAddresses(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new Error(`DNS lookup returned no addresses for ${hostname}`), '', 0)
          return
        }
        for (const candidate of addresses) {
          const actualFamily = isIP(candidate.address)
          if (actualFamily !== candidate.family || (actualFamily !== 4 && actualFamily !== 6)) {
            callback(new Error(`DNS lookup returned an invalid address for ${hostname}`), '', 0)
            return
          }
          const classification = classifyIpAddress(candidate.address)
          if (classification.blocked) {
            callback(
              new Error(
                `DNS lookup rejected non-public address for ${hostname}: ${classification.reason ?? candidate.address}`,
              ),
              '',
              0,
            )
            return
          }
        }
        const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined
        const chosen = addresses.find(
          (candidate) => requestedFamily === undefined || candidate.family === requestedFamily,
        )
        if (chosen === undefined) {
          callback(new Error(`DNS lookup returned no IPv${requestedFamily} address for ${hostname}`), '', 0)
          return
        }
        if (options.all === true) callback(null, [chosen])
        else callback(null, chosen.address, chosen.family)
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), '', 0),
    )
  }
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export const defaultPublicHttpDependencies: PublicHttpDependencies = {
  async resolveAddresses(hostname) {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
    return addresses.map((candidate) => {
      if (candidate.family !== 4 && candidate.family !== 6) {
        throw new Error(`DNS lookup returned unsupported family ${candidate.family} for ${hostname}`)
      }
      return { address: candidate.address, family: candidate.family }
    })
  },
  async request(options) {
    return await new Promise((resolve, reject) => {
      const request = options.protocol === 'https:' ? httpsRequest : httpRequest
      const outgoing = request(options, (response) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          cancel: () => response.destroy(),
        })
      })
      outgoing.once('error', reject)
      outgoing.end()
    })
  },
}

function requirePublicHttpUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`URL must be a valid public HTTP(S) URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL must use public HTTP(S), not ${parsed.protocol}`)
  }
  const classification = classifyUrl(parsed.toString())
  if (classification.blocked) {
    throw new Error(
      `SSRF policy rejected non-public URL (${classification.category ?? 'internal'}): ${classification.reason ?? rawUrl}`,
    )
  }
  return parsed.toString()
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
