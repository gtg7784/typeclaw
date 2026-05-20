// Webfetch's HTTP transport.
//
// Production path (container, curl-impersonate available): we shell out to
// `curl_chrome136` so outbound requests carry Chrome 136's TLS handshake
// (JA3/JA4), HTTP/2 SETTINGS frame, and full header set. This is what gets
// us past the modern bot-detection stacks on Cloudflare/Akamai-protected
// sites (Reuters, MarketWatch, etc.) when the agent is running from the
// user's home network — the IP is already residential, so impersonating
// the browser is the only remaining missing piece. See AGENTS.md §"Web
// search" and src/agent/tools/curl-impersonate.ts for the full story.
//
// Test/dev fallback (curl_chrome136 not on PATH): we transparently fall
// back to Bun's native `fetch()` with a static User-Agent. This keeps unit
// tests on developer macOS machines working without forcing every contributor
// to install curl-impersonate locally. Production runs always have the binary
// because the typeclaw Dockerfile pins it.
//
// Best-effort doctrine: this transport does NOT guarantee the fetch succeeds.
// Bot-detected sites can still serve 403/CAPTCHA pages. We surface what we
// got (status, body, final URL) and let the caller decide. The webfetch tool
// translates non-2xx into a tool-level error message that's useful to the
// model.

import {
  CurlImpersonateError,
  curlImpersonate,
  isCurlExitFilesizeExceeded,
  isCurlExitTimeout,
  isCurlImpersonateAvailable,
} from '../curl-impersonate'
import { MAX_RESPONSE_BYTES } from './types'

export type FetchResult = {
  body: string
  contentType: string
  finalUrl: string
  httpStatus: number
  bytesIn: number
}

export class WebfetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebfetchError'
  }
}

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent': 'typeclaw/0 (+https://github.com/code-yeongyu/typeclaw)',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
  'Accept-Language': 'en-US,en;q=0.9',
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      throw new WebfetchError('URL must use http:// or https://')
    }
    return trimmed
  }
  return `https://${trimmed}`
}

// Test-only seam: forces fetchWithLimits to use the native-fetch fallback
// even when curl-impersonate is detected. Used by fetch.test.ts to keep its
// existing mocked-fetch contract working without the test having to install
// a fake curl binary. Production code never calls this.
let forceFallbackForTest = false

export function _setForceFallbackForTest(value: boolean): void {
  forceFallbackForTest = value
}

export async function fetchWithLimits(
  url: string,
  timeoutSeconds: number,
  parentSignal?: AbortSignal,
): Promise<FetchResult> {
  const useImpersonate = !forceFallbackForTest && (await isCurlImpersonateAvailable())
  if (useImpersonate) {
    return fetchWithCurlImpersonate(url, timeoutSeconds, parentSignal)
  }
  return fetchWithBunFetch(url, timeoutSeconds, parentSignal)
}

async function fetchWithCurlImpersonate(
  url: string,
  timeoutSeconds: number,
  parentSignal?: AbortSignal,
): Promise<FetchResult> {
  let response
  try {
    response = await curlImpersonate({
      url,
      method: 'GET',
      timeoutSeconds,
      maxBytes: MAX_RESPONSE_BYTES,
      signal: parentSignal,
    })
  } catch (error) {
    if (parentSignal?.aborted) {
      throw new WebfetchError('Request aborted')
    }
    if (error instanceof CurlImpersonateError) {
      if (isCurlExitTimeout(error)) {
        throw new WebfetchError(`Request timed out after ${timeoutSeconds}s`)
      }
      if (isCurlExitFilesizeExceeded(error)) {
        throw new WebfetchError(`Response too large (exceeds ${formatBytes(MAX_RESPONSE_BYTES)} limit)`)
      }
      throw new WebfetchError(`Fetch failed: ${error.message}`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new WebfetchError(`Fetch failed: ${message}`)
  }

  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    throw new WebfetchError(`Fetch failed: HTTP ${response.httpStatus}`)
  }

  const bodyByteLength = new TextEncoder().encode(response.body).byteLength
  if (bodyByteLength > MAX_RESPONSE_BYTES) {
    throw new WebfetchError(
      `Response too large (${formatBytes(bodyByteLength)} exceeds ${formatBytes(MAX_RESPONSE_BYTES)} limit)`,
    )
  }

  return {
    body: response.body,
    contentType: response.contentType,
    finalUrl: response.finalUrl || url,
    httpStatus: response.httpStatus,
    bytesIn: bodyByteLength,
  }
}

async function fetchWithBunFetch(
  url: string,
  timeoutSeconds: number,
  parentSignal?: AbortSignal,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutSeconds * 1000)
  const onAbort = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(url, { headers: FALLBACK_HEADERS, signal: controller.signal, redirect: 'follow' })
    if (!response.ok) {
      throw new WebfetchError(`Fetch failed: HTTP ${response.status} ${response.statusText}`)
    }

    const contentLengthHeader = response.headers.get('content-length')
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader)
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        throw new WebfetchError(
          `Response too large (${formatBytes(declared)} exceeds ${formatBytes(MAX_RESPONSE_BYTES)} limit)`,
        )
      }
    }

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new WebfetchError(
        `Response too large (${formatBytes(buffer.byteLength)} exceeds ${formatBytes(MAX_RESPONSE_BYTES)} limit)`,
      )
    }

    const body = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    return {
      body,
      contentType: response.headers.get('content-type') ?? '',
      finalUrl: response.url || url,
      httpStatus: response.status,
      bytesIn: buffer.byteLength,
    }
  } catch (error) {
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof Error &&
      controller.signal.reason.message === 'timeout'
    ) {
      throw new WebfetchError(`Request timed out after ${timeoutSeconds}s`)
    }
    if (error instanceof WebfetchError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new WebfetchError(`Fetch failed: ${message}`)
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', onAbort)
  }
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
