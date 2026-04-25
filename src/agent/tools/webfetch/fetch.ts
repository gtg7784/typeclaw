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

const DEFAULT_HEADERS: Record<string, string> = {
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

export async function fetchWithLimits(
  url: string,
  timeoutSeconds: number,
  parentSignal?: AbortSignal,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutSeconds * 1000)
  const onAbort = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(url, { headers: DEFAULT_HEADERS, signal: controller.signal, redirect: 'follow' })
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
