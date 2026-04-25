import { colors } from './theme'

const ARGS_PREVIEW_MAX = 200
const RESULT_PREVIEW_MAX = 400

export function formatToolStart(name: string, args: unknown): string {
  const head = `${colors.cyan('●')} ${colors.bold(name)}`
  const preview = previewArgs(args)
  return preview === null ? head : `${head} ${colors.dim(preview)}`
}

export function formatToolEnd(name: string, error: boolean, result: unknown, durationMs: number): string {
  const glyph = error ? colors.red('✗') : colors.green('✓')
  const dur = colors.gray(formatDuration(durationMs))
  const head = `${glyph} ${colors.bold(name)} ${dur}`
  const preview = previewResult(result, error)
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

function previewArgs(args: unknown): string | null {
  if (args === undefined || args === null) return null
  if (typeof args === 'object' && Object.keys(args as object).length === 0) return null
  return truncate(toCompactString(args), ARGS_PREVIEW_MAX)
}

function previewResult(result: unknown, error: boolean): string | null {
  if (result === undefined || result === null) return null
  const raw = toReadableString(result)
  if (raw.length === 0) return null
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
