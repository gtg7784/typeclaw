import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

// Narrow projection: session files can grow into tens of MB on long-lived
// agents, so we deliberately drop content/tool blocks before aggregation.
export type AssistantRow = {
  sessionFile: string
  sessionBasename: string
  timestamp: number
  provider: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

export type ScanOptions = {
  sessionsDir: string
  since?: number
  until?: number
  onWarn?: (msg: string) => void
}

// Missing sessions/ resolves to empty (fresh agent, no turns yet). Per-line
// JSON parse failures are routed to onWarn and skipped rather than thrown — a
// crashed mid-line write should not bomb the whole report.
export async function* scanAssistantRows(opts: ScanOptions): AsyncGenerator<AssistantRow> {
  const files = await listJsonlFiles(opts.sessionsDir, opts.onWarn)
  for (const file of files) {
    yield* readSessionFile(file, opts)
  }
}

async function listJsonlFiles(dir: string, onWarn: ScanOptions['onWarn']): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    if (isNoEntError(err)) return []
    throw err
  }
  const files: string[] = []
  for (const entry of entries) {
    const name = entry.name
    if (!name.endsWith('.jsonl')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      onWarn?.(`skipping non-file in sessions/: ${name}`)
      continue
    }
    files.push(join(dir, name))
  }
  return files
}

async function* readSessionFile(file: string, opts: ScanOptions): AsyncGenerator<AssistantRow> {
  const basename = file.split('/').pop() ?? file
  let stream: ReadableStream<Uint8Array>
  try {
    stream = Bun.file(file).stream()
  } catch (err) {
    opts.onWarn?.(`could not open ${basename}: ${describeFileError(err)}`)
    return
  }
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const row = parseLine(line, file, basename, opts)
        if (row !== null) yield row
        nl = buf.indexOf('\n')
      }
    }
  } catch (err) {
    opts.onWarn?.(`error reading ${basename}: ${describeFileError(err)}`)
    return
  }
  // Tail line with no terminating \n: only emit if it parses cleanly so a
  // half-written record from a live writer is silently skipped (parseLine
  // returns null and does NOT warn for the tail).
  if (buf.length > 0) {
    const row = parseLine(buf, file, basename, opts, { isTail: true })
    if (row !== null) yield row
  }
}

function parseLine(
  line: string,
  file: string,
  basename: string,
  opts: ScanOptions,
  ctx: { isTail?: boolean } = {},
): AssistantRow | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let entry: unknown
  try {
    entry = JSON.parse(trimmed)
  } catch {
    // Silently skip the trailing tail: a live writer may be mid-append.
    if (ctx.isTail !== true) opts.onWarn?.(`skipping malformed JSONL line in ${basename}`)
    return null
  }

  if (!isMessageEntry(entry)) return null
  const message = entry.message
  if (!isAssistantMessage(message)) return null

  // Aborted/error messages are intentionally counted: pi-ai's `usage` carries
  // partial token counts that the provider still billed for.

  const ts = typeof message.timestamp === 'number' ? message.timestamp : 0
  if (opts.since !== undefined && ts < opts.since) return null
  if (opts.until !== undefined && ts >= opts.until) return null

  const u = message.usage
  return {
    sessionFile: file,
    sessionBasename: basename,
    timestamp: ts,
    provider: typeof message.provider === 'string' ? message.provider : 'unknown',
    model: typeof message.model === 'string' ? message.model : 'unknown',
    input: numberOrZero(u.input),
    output: numberOrZero(u.output),
    cacheRead: numberOrZero(u.cacheRead),
    cacheWrite: numberOrZero(u.cacheWrite),
    totalTokens: numberOrZero(u.totalTokens),
    cost: numberOrZero(u.cost?.total),
  }
}

type MessageEntry = { type: 'message'; message: { role: string; [k: string]: unknown } }
type AssistantMessageShape = {
  role: 'assistant'
  timestamp?: unknown
  provider?: unknown
  model?: unknown
  usage: {
    input?: unknown
    output?: unknown
    cacheRead?: unknown
    cacheWrite?: unknown
    totalTokens?: unknown
    cost?: { total?: unknown }
  }
}

function isMessageEntry(value: unknown): value is MessageEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.type !== 'message') return false
  if (typeof v.message !== 'object' || v.message === null) return false
  const m = v.message as Record<string, unknown>
  return typeof m.role === 'string'
}

function isAssistantMessage(message: unknown): message is AssistantMessageShape {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  if (m.role !== 'assistant') return false
  if (typeof m.usage !== 'object' || m.usage === null) return false
  return true
}

function numberOrZero(value: unknown): number {
  if (typeof value !== 'number') return 0
  if (!Number.isFinite(value)) return 0
  return value
}

function isNoEntError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

function describeFileError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
