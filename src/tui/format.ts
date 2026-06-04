import { colors } from './theme'

const ARGS_PREVIEW_MAX = 200
const RESULT_PREVIEW_MAX = 400

export function formatToolStart(name: string, args: unknown): string {
  const head = `${colors.cyan('●')} ${colors.bold(name)}`
  const preview = previewArgs(name, args)
  return preview === null ? head : `${head} ${colors.dim(preview)}`
}

export function formatToolEnd(name: string, error: boolean, result: unknown, durationMs: number): string {
  const glyph = error ? colors.red('✗') : colors.green('✓')
  const dur = colors.gray(formatDuration(durationMs))
  const head = `${glyph} ${colors.bold(name)} ${dur}`
  const preview = previewResult(name, error, result)
  return preview === null ? head : `${head}\n${preview}`
}

export function formatUserPromptHistory(text: string): string {
  return stripHiddenBlocks(text)
    .split('\n')
    .map((line, idx) => `${colors.dim(idx === 0 ? '>' : '.')} ${line}`)
    .join('\n')
}

function stripHiddenBlocks(text: string): string {
  return text.replace(/<hatching>[\s\S]*?<\/hatching>\s*/g, '').trimStart()
}

export function formatQueuePanel(items: ReadonlyArray<{ text: string }>): string {
  return items.map((item) => `${colors.dim('[QUEUED]')} ${firstLine(item.text)}`).join('\n')
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n')
  if (idx === -1) return text
  const head = text.slice(0, idx)
  const remaining = text.length - idx
  return `${head} ${colors.dim(`(+${remaining} chars)`)}`
}

// Tool-specific argument summaries. Each humanizer collapses the typical
// `{path, pattern, command, …}` parameter object into a single line that
// reads naturally next to the tool name. Returning null means "I don't
// recognize this shape, fall back to the generic compact JSON".
type ArgRecord = Record<string, unknown>

function humanizeArgs(name: string, args: unknown): string | null {
  if (!isObject(args)) return null
  switch (name) {
    case 'read':
      return humanizeReadArgs(args)
    case 'bash':
      return humanizeBashArgs(args)
    case 'edit':
      return humanizeEditArgs(args)
    case 'write':
      return humanizeWriteArgs(args)
    case 'grep':
      return humanizeGrepArgs(args)
    case 'find':
      return humanizeFindArgs(args)
    case 'ls':
      return humanizeLsArgs(args)
    case 'web_search':
      return humanizeWebSearchArgs(args)
    case 'web_fetch':
      return humanizeWebFetchArgs(args)
    default:
      return null
  }
}

function humanizeReadArgs(args: ArgRecord): string | null {
  const path = asString(args.path)
  if (path === null) return null
  const offset = asNumber(args.offset)
  const limit = asNumber(args.limit)
  if (offset !== null && limit !== null) return `${path} (lines ${offset}-${offset + limit - 1})`
  if (offset !== null) return `${path} (from line ${offset})`
  if (limit !== null) return `${path} (first ${limit} lines)`
  return path
}

function humanizeBashArgs(args: ArgRecord): string | null {
  const command = asString(args.command)
  if (command === null) return null
  return command.replace(/\s+/g, ' ').trim()
}

function humanizeEditArgs(args: ArgRecord): string | null {
  const path = asString(args.path)
  if (path === null) return null
  const edits = Array.isArray(args.edits) ? args.edits.length : 0
  return edits > 0 ? `${path} (${edits} edit${edits === 1 ? '' : 's'})` : path
}

function humanizeWriteArgs(args: ArgRecord): string | null {
  const path = asString(args.path)
  if (path === null) return null
  const content = asString(args.content)
  if (content === null) return path
  const bytes = Buffer.byteLength(content, 'utf-8')
  return `${path} (${formatBytes(bytes)})`
}

function humanizeGrepArgs(args: ArgRecord): string | null {
  const pattern = asString(args.pattern)
  if (pattern === null) return null
  const where = asString(args.path) ?? asString(args.glob)
  return where ? `"${pattern}" in ${where}` : `"${pattern}"`
}

function humanizeFindArgs(args: ArgRecord): string | null {
  const pattern = asString(args.pattern)
  if (pattern === null) return null
  const where = asString(args.path)
  return where ? `${pattern} in ${where}` : pattern
}

function humanizeLsArgs(args: ArgRecord): string | null {
  return asString(args.path) ?? '.'
}

function humanizeWebSearchArgs(args: ArgRecord): string | null {
  const query = asString(args.query)
  if (query === null) return null
  const source = asString(args.source)
  return source && source !== 'web' ? `"${query}" (${source})` : `"${query}"`
}

function humanizeWebFetchArgs(args: ArgRecord): string | null {
  return asString(args.url)
}

// Tool-specific result enrichments. Most tools already embed a human-readable
// summary in `content[].text`, so the default path simply extracts that. The
// exceptions: `edit` benefits from showing the diff, `bash` likes a footer
// with truncation/full-output info, image reads collapse to `[image]`.
function humanizeResult(name: string, result: unknown): string | null {
  if (!isObject(result)) return null
  const enriched = enrichResult(name, result)
  if (enriched !== null) return enriched
  return extractContentText(result)
}

function enrichResult(name: string, result: ArgRecord): string | null {
  switch (name) {
    case 'edit':
      return enrichEditResult(result)
    case 'bash':
      return enrichBashResult(result)
    case 'read':
      return enrichReadResult(result)
    case 'web_search':
      return enrichWebSearchResult(result)
    default:
      return null
  }
}

function enrichEditResult(result: ArgRecord): string | null {
  const details = isObject(result.details) ? result.details : null
  const diff = details ? asString(details.diff) : null
  if (diff !== null) return diff
  return null
}

function enrichBashResult(result: ArgRecord): string | null {
  const text = extractContentText(result)
  if (text === null) return null
  const details = isObject(result.details) ? result.details : null
  const fullOutput = details ? asString(details.fullOutputPath) : null
  if (fullOutput === null) return text
  return `${text}\n\nFull output saved to: ${fullOutput}`
}

function enrichReadResult(result: ArgRecord): string | null {
  const content = Array.isArray(result.content) ? result.content : null
  if (content === null) return null
  const hasImage = content.some((part) => isObject(part) && part.type === 'image')
  if (!hasImage) return null
  const mime = content
    .map((part) => (isObject(part) && part.type === 'image' ? asString(part.mimeType) : null))
    .find((m) => m !== null)
  return mime ? `[image: ${mime}]` : '[image]'
}

function enrichWebSearchResult(result: ArgRecord): string | null {
  const details = isObject(result.details) ? result.details : null
  if (details === null) return null
  const results = Array.isArray(details.results) ? details.results : null
  if (results === null || results.length === 0) {
    return extractContentText(result)
  }
  const query = asString(details.query) ?? ''
  const source = asString(details.source) ?? ''
  const header = query ? `${results.length} result${results.length === 1 ? '' : 's'} for "${query}" (${source})` : null
  const lines = results
    .map((entry, i) => formatWebSearchEntry(entry, i + 1))
    .filter((line): line is string => line !== null)
  if (lines.length === 0) return extractContentText(result)
  return header === null ? lines.join('\n') : `${header}\n${lines.join('\n')}`
}

function formatWebSearchEntry(entry: unknown, index: number): string | null {
  if (!isObject(entry)) return null
  const title = asString(entry.title)
  const url = asString(entry.url)
  if (title === null || url === null) return null
  return `${index}. ${title} — ${url}`
}

// AI-SDK style results carry a `content` array of `{type, text|data, …}` parts.
// We join all `text` parts with blank lines between them and replace any
// non-text parts with a placeholder so the user sees that something was there.
function extractContentText(result: ArgRecord): string | null {
  const content = result.content
  if (!Array.isArray(content) || content.length === 0) return null
  const parts: string[] = []
  for (const part of content) {
    if (!isObject(part)) continue
    if (part.type === 'text') {
      const text = asString(part.text)
      if (text !== null) parts.push(text)
      continue
    }
    if (part.type === 'image') {
      const mime = asString(part.mimeType)
      parts.push(mime ? `[image: ${mime}]` : '[image]')
      continue
    }
    parts.push(`[${asString(part.type) ?? 'attachment'}]`)
  }
  if (parts.length === 0) return null
  return parts.join('\n\n')
}

function previewArgs(name: string, args: unknown): string | null {
  if (args === undefined || args === null) return null
  if (typeof args === 'object' && Object.keys(args as object).length === 0) return null
  const humanized = humanizeArgs(name, args)
  const raw = humanized ?? toCompactString(args)
  return truncate(raw, ARGS_PREVIEW_MAX)
}

function previewResult(name: string, error: boolean, result: unknown): string | null {
  if (result === undefined || result === null) return null
  if (typeof result === 'string') return formatPreviewBlock(result, error)
  const humanized = humanizeResult(name, result)
  const raw = humanized ?? toReadableString(result)
  return raw.length === 0 ? null : formatPreviewBlock(raw, error)
}

function formatPreviewBlock(raw: string, error: boolean): string {
  const truncated = truncate(raw, RESULT_PREVIEW_MAX)
  const colorize = error ? colors.red : colors.gray
  return truncated
    .split('\n')
    .map((line) => `  ${colorize(line)}`)
    .join('\n')
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds - minutes * 60)
  return `${minutes}m${remaining}s`
}

function toCompactString(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toReadableString(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const remaining = text.length - max
  return `${cut}… (+${remaining} chars)`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
