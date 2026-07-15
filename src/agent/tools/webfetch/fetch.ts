import { CookieJar } from 'tough-cookie'

import {
  defaultPublicHttpDependencies,
  headerValue,
  requestPublicHttpUrl,
  type PublicHttpDependencies,
  type PublicHttpResponse,
} from '@/agent/network/safe-http'

import { MAX_RESPONSE_BYTES } from './types'

export type AntibotWarmup = 'auto' | 'off'

export type AntibotWarmupInfo = {
  attempted: boolean
  triggered: boolean
  initialStatus?: number
  initialSetCookieNames?: string[]
  replayStatus?: number
}

export type FetchResult = {
  body: string
  contentType: string
  finalUrl: string
  httpStatus: number
  bytesIn: number
  antibotWarmup?: AntibotWarmupInfo
}

export type WebFetchNetworkDependencies = PublicHttpDependencies

const AKAMAI_BOTMANAGER_COOKIE = /^(_abck|bm_sz|bm_s|bm_ss|bm_so|ak_bmsc)$/i

export class WebFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebFetchError'
  }
}

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'typeclaw/0 (+https://github.com/code-yeongyu/typeclaw)',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
  'Accept-Language': 'en-US,en;q=0.9',
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      throw new WebFetchError('URL must use http:// or https://')
    }
    return trimmed
  }
  return `https://${trimmed}`
}

let forceFallbackForTest = false

export function _setForceFallbackForTest(value: boolean): void {
  forceFallbackForTest = value
}

export async function fetchWithLimits(
  url: string,
  timeoutSeconds: number,
  parentSignal?: AbortSignal,
  antibotWarmup: AntibotWarmup = 'auto',
  network: WebFetchNetworkDependencies = forceFallbackForTest ? testFetchDependencies : defaultPublicHttpDependencies,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutSeconds * 1000)
  const onAbort = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', onAbort, { once: true })
  const startedAt = Date.now()
  try {
    const cookieJar = new WarmupCookieJar()
    const visitedUrls = new Set<string>()
    const first = await fetchOnce(url, controller.signal, network, REQUEST_HEADERS, cookieJar, visitedUrls)
    const cookieNames = cookieJar.names()
    const warmup =
      antibotWarmup === 'auto' &&
      first.statusCode === 403 &&
      [...visitedUrls].some((visitedUrl) => cookieJar.hasMatching(visitedUrl, AKAMAI_BOTMANAGER_COOKIE))
    if (!warmup) {
      return toFetchResult(first, { attempted: antibotWarmup === 'auto', triggered: false })
    }

    const remainingMs = timeoutSeconds * 1000 - (Date.now() - startedAt)
    if (remainingMs < 1_000) {
      return toFetchResult(first, {
        attempted: true,
        triggered: false,
        initialStatus: first.statusCode,
        initialSetCookieNames: cookieNames,
      })
    }
    const replay = await fetchOnce(url, controller.signal, network, REQUEST_HEADERS, cookieJar)
    return toFetchResult(replay, {
      attempted: true,
      triggered: true,
      initialStatus: first.statusCode,
      initialSetCookieNames: cookieNames,
      replayStatus: replay.statusCode,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      if (controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout') {
        throw new WebFetchError(`Request timed out after ${timeoutSeconds}s`)
      }
      throw new WebFetchError('Request aborted')
    }
    if (error instanceof WebFetchError) throw error
    throw new WebFetchError(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', onAbort)
  }
}

const testFetchDependencies: WebFetchNetworkDependencies = {
  resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
  async request(options) {
    const url = `${options.protocol}//${options.headers.Host}${options.path}`
    const response = await fetch(url, { headers: options.headers, signal: options.signal, redirect: 'manual' })
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body ?? emptyBody(),
      cancel: () => {
        void response.body?.cancel()
      },
    }
  },
}

async function* emptyBody(): AsyncIterable<Uint8Array> {}

type BufferedResponse = {
  body: Uint8Array
  headers: PublicHttpResponse['headers']
  statusCode: number
  finalUrl: string
}

async function fetchOnce(
  url: string,
  signal: AbortSignal,
  network: WebFetchNetworkDependencies,
  headers: Record<string, string>,
  cookieJar?: WarmupCookieJar,
  visitedUrls?: Set<string>,
): Promise<BufferedResponse> {
  const { response, finalUrl } = await requestPublicHttpUrl(url, {
    signal,
    headers,
    dependencies: network,
    headersForUrl(currentUrl): Record<string, string> {
      visitedUrls?.add(currentUrl)
      const cookie = cookieJar?.header(currentUrl)
      if (cookie === undefined) return {}
      return { Cookie: cookie }
    },
    onResponse(response, responseUrl) {
      cookieJar?.store(response.headers, responseUrl)
    },
  })
  try {
    const declared = Number(headerValue(response.headers, 'content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw tooLarge(declared)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > MAX_RESPONSE_BYTES) throw tooLarge(total)
      chunks.push(chunk)
    }
    return { body: Buffer.concat(chunks), headers: response.headers, statusCode: response.statusCode, finalUrl }
  } finally {
    response.cancel()
  }
}

function toFetchResult(response: BufferedResponse, antibotWarmup?: AntibotWarmupInfo): FetchResult {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new WebFetchError(`Fetch failed: HTTP ${response.statusCode}`)
  }
  return {
    body: new TextDecoder('utf-8', { fatal: false }).decode(response.body),
    contentType: headerValue(response.headers, 'content-type') ?? '',
    finalUrl: response.finalUrl,
    httpStatus: response.statusCode,
    bytesIn: response.body.byteLength,
    ...(antibotWarmup !== undefined ? { antibotWarmup } : {}),
  }
}

function setCookieValues(headers: PublicHttpResponse['headers']): string[] {
  const value = headers['set-cookie']
  if (Array.isArray(value)) return value
  return value === undefined ? [] : [value]
}

class WarmupCookieJar {
  readonly #jar = new CookieJar()
  readonly #names = new Set<string>()

  store(headers: PublicHttpResponse['headers'], responseUrl: string): void {
    for (const value of setCookieValues(headers)) {
      const cookie = this.#jar.setCookieSync(value, responseUrl, { ignoreError: true })
      if (cookie !== undefined) this.#names.add(cookie.key)
    }
  }

  names(): string[] {
    return [...this.#names]
  }

  hasMatching(rawUrl: string, namePattern: RegExp): boolean {
    return this.#jar.getCookiesSync(rawUrl).some((cookie) => namePattern.test(cookie.key))
  }

  header(rawUrl: string): string | undefined {
    const header = this.#jar.getCookieStringSync(rawUrl)
    return header === '' ? undefined : header
  }
}

function tooLarge(bytes: number): WebFetchError {
  return new WebFetchError(
    `Response too large (${formatBytes(bytes)} exceeds ${formatBytes(MAX_RESPONSE_BYTES)} limit)`,
  )
}

export function parseMimeType(contentType: string): string {
  const semi = contentType.indexOf(';')
  return (semi >= 0 ? contentType.slice(0, semi) : contentType).trim().toLowerCase()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
