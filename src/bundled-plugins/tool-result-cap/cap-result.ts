import type { ContentPart, ToolResult } from '@/plugin'

export type CapOptions = {
  imageMaxBytes: number
  textMaxBytes: number
  exemptTools?: ReadonlySet<string>
}

export type CapStats = {
  imagesReplaced: number
  textsTruncated: number
  bytesElided: number
}

const ELIDED_MARKER = '[tool-result-cap: '

// A capped text part is exactly the placeholder we generated: starts with
// `[tool-result-cap: `, ends with `]`, and contains no inner `]`. The shape
// check exists for idempotency so a previously-capped entry survives a second
// pass untouched — but tight enough that real tool output that merely STARTS
// with the marker (e.g. quotes a prior placeholder then continues with more
// content) still gets capped on its trailing bulk. A prefix-only check would
// be an oversized-text bypass.
const ELIDED_PLACEHOLDER_PATTERN = /^\[tool-result-cap: [^\]]*\]$/

function isElidedPlaceholderText(text: string): boolean {
  return ELIDED_PLACEHOLDER_PATTERN.test(text)
}

export function capContentParts(tool: string, content: ContentPart[], options: CapOptions): CapStats {
  const stats: CapStats = { imagesReplaced: 0, textsTruncated: 0, bytesElided: 0 }
  if (options.exemptTools?.has(tool)) return stats

  for (let i = 0; i < content.length; i++) {
    const part = content[i]
    if (!part) continue
    if (part.type === 'image') {
      const size = part.data.length
      if (size <= options.imageMaxBytes) continue
      content[i] = {
        type: 'text',
        text: `${ELIDED_MARKER}image ${part.mimeType} elided, ${size} bytes of base64 exceeded imageMaxBytes=${options.imageMaxBytes}]`,
      }
      stats.imagesReplaced += 1
      stats.bytesElided += size
      continue
    }
    if (part.type === 'text') {
      const size = part.text.length
      if (size <= options.textMaxBytes) continue
      if (isElidedPlaceholderText(part.text)) continue
      const head = part.text.slice(0, options.textMaxBytes)
      const elided = size - options.textMaxBytes
      const replacement: ContentPart = {
        type: 'text',
        text: `${head}\n\n${ELIDED_MARKER}${elided} bytes truncated from text part; original was ${size} bytes, textMaxBytes=${options.textMaxBytes}]`,
      }
      content[i] = replacement
      stats.textsTruncated += 1
      stats.bytesElided += elided
    }
  }
  return stats
}

export function capToolResult(tool: string, result: ToolResult, options: CapOptions): CapStats {
  return capContentParts(tool, result.content, options)
}
