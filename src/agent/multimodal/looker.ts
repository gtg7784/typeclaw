import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

import { z } from 'zod'

const SUPPORTED_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
} as const

// Caps on URL-fetched images. The agent chooses URLs autonomously, so a
// malicious or accidentally-large response could otherwise hang the tool
// (no timeout) or fill memory (no size cap). 20 MB is well above any
// reasonable screenshot/photo and well below container memory budgets;
// 30 s is generous for a single HTTP image fetch over a slow link.
export const URL_FETCH_TIMEOUT_MS = 30_000
export const URL_FETCH_MAX_BYTES = 20 * 1024 * 1024

type Mime = (typeof SUPPORTED_MIME_TYPES)[keyof typeof SUPPORTED_MIME_TYPES]

export type ImageInput =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'base64'; data: string; mimeType: string }

export const imageInputSchema = z.union([
  z.object({ kind: z.literal('url'), url: z.string().url() }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('base64'), data: z.string().min(1), mimeType: z.string().min(1) }),
])

export const multimodalLookerPayloadSchema = z.object({
  images: z.array(imageInputSchema).min(1),
  prompt: z.string().min(1).optional(),
})

export type MultimodalLookerPayload = z.infer<typeof multimodalLookerPayloadSchema>

// System prompt is built per-invocation so the agent sees the exact task. With
// `prompt`: focused Q&A. Without: open-ended description. Tone the same in
// both branches so callers can plug either form into the same downstream
// pipeline (the look_at tool just relays the resulting text).
export function buildMultimodalLookerSystemPrompt(prompt: string | undefined): string {
  const base =
    'You are a multimodal vision subagent. The user message contains one or more images attached to a short instruction.'
  if (prompt !== undefined && prompt.trim() !== '') {
    return [
      base,
      '',
      'Your job is to ANSWER the question below using ONLY what is visible in the attached image(s). Be precise, concrete, and faithful to the visual content. If the image does not contain enough information to answer, say so explicitly.',
      '',
      `Question: ${prompt.trim()}`,
      '',
      'Reply with the answer directly. No preamble, no acknowledgement of the task, no markdown headings.',
    ].join('\n')
  }
  return [
    base,
    '',
    "Your job is to DESCRIBE the attached image(s) faithfully and in detail. Cover: subject(s), composition, colors, text content (transcribed verbatim if legible), notable visual details, and anything that would help a downstream reader who cannot see the image. Do not speculate beyond what's visible.",
    '',
    'Reply with the description directly. No preamble, no markdown headings, no bullet list unless multiple images.',
  ].join('\n')
}

export type ResolvedImage = {
  data: string
  mimeType: string
}

// Materializes an ImageInput into the base64-encoded form pi-ai expects.
// - `url`: passthrough; pi-ai's image content does not accept URLs, so we fetch
//   the bytes and base64-encode here (lazy; only when the tool is invoked).
// - `file`: read from disk, infer MIME from extension. Path must be absolute or
//   resolvable against the caller's cwd (callers should normalize ahead of
//   time; this function rejects relative paths to avoid ambiguity).
// - `base64`: passthrough.
export async function resolveImage(input: ImageInput, signal?: AbortSignal): Promise<ResolvedImage> {
  if (input.kind === 'base64') {
    if (!input.mimeType.startsWith('image/')) {
      throw new Error(`look_at: base64 mimeType must be image/* (got "${input.mimeType}")`)
    }
    return { data: input.data, mimeType: input.mimeType }
  }
  if (input.kind === 'file') {
    if (!isAbsolute(input.path)) {
      throw new Error(`look_at: file path must be absolute (got "${input.path}")`)
    }
    if (!existsSync(input.path)) {
      throw new Error(`look_at: file not found at ${input.path}`)
    }
    const ext = extname(input.path).toLowerCase() as keyof typeof SUPPORTED_MIME_TYPES
    const mimeType = (SUPPORTED_MIME_TYPES[ext] ?? null) as Mime | null
    if (mimeType === null) {
      throw new Error(
        `look_at: unsupported image extension "${ext}" for ${input.path} (supported: ${Object.keys(SUPPORTED_MIME_TYPES).join(', ')})`,
      )
    }
    const bytes = readFileSync(input.path)
    return { data: bytes.toString('base64'), mimeType }
  }
  // URL branch: independent timeout + size cap on top of any caller-provided
  // signal. The two abort signals are merged so the tool's overall abort wins
  // over our timeout AND vice versa.
  const timeoutSignal = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS)
  const mergedSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const res = await fetch(input.url, { signal: mergedSignal })
  if (!res.ok) {
    throw new Error(`look_at: failed to fetch ${input.url}: HTTP ${res.status}`)
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream'
  if (!mimeType.startsWith('image/')) {
    throw new Error(`look_at: ${input.url} did not return an image content-type (got "${mimeType}")`)
  }
  // Streaming size check: arrayBuffer() would read the whole body before we
  // could enforce a cap. Read chunk-by-chunk and abort once we cross the
  // limit. Content-Length is checked first when present, but absent or lying
  // headers fall through to the streaming check.
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > URL_FETCH_MAX_BYTES) {
    throw new Error(`look_at: ${input.url} response too large (${declared} bytes > ${URL_FETCH_MAX_BYTES} cap)`)
  }
  const reader = res.body?.getReader()
  if (reader === undefined) {
    throw new Error(`look_at: ${input.url} returned an empty body`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > URL_FETCH_MAX_BYTES) {
      await reader.cancel()
      throw new Error(`look_at: ${input.url} response exceeded ${URL_FETCH_MAX_BYTES}-byte cap`)
    }
    chunks.push(value)
  }
  const buf = Buffer.concat(chunks)
  return { data: buf.toString('base64'), mimeType }
}
