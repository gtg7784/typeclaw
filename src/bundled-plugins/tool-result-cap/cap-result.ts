import type { ContentPart, ToolResult } from '@/plugin'

export type CapOptions = {
  imageMaxBytes: number
  textMaxBytes: number
  exemptTools: ReadonlySet<string>
}

export type CapStats = {
  imagesReplaced: number
  textsTruncated: number
  bytesElided: number
}

// Sentinel marker used in both image and text replacement payloads so a future
// pass (or the LLM itself) can recognize that a value was capped rather than
// truthfully short. Plain English on purpose — these strings get fed to the
// model on every turn, and unfamiliar tokens cost reasoning bandwidth.
const ELIDED_MARKER = '[tool-result-cap: '

export function capToolResult(tool: string, result: ToolResult, options: CapOptions): CapStats {
  const stats: CapStats = { imagesReplaced: 0, textsTruncated: 0, bytesElided: 0 }
  if (options.exemptTools.has(tool)) return stats

  for (let i = 0; i < result.content.length; i++) {
    const part = result.content[i]
    if (!part) continue
    if (part.type === 'image') {
      const size = part.data.length
      if (size <= options.imageMaxBytes) continue
      result.content[i] = {
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
      // Keep a head slice of the original text so the LLM still has a hint of
      // shape (e.g. "fetched HTML starts with <!DOCTYPE..."). Tail is dropped.
      const head = part.text.slice(0, options.textMaxBytes)
      const elided = size - options.textMaxBytes
      const replacement: ContentPart = {
        type: 'text',
        text: `${head}\n\n${ELIDED_MARKER}${elided} bytes truncated from text part; original was ${size} bytes, textMaxBytes=${options.textMaxBytes}]`,
      }
      result.content[i] = replacement
      stats.textsTruncated += 1
      stats.bytesElided += elided
    }
  }
  return stats
}
