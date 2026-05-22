import { SESSION_META_CUSTOM_TYPE } from '@/agent/session-meta'
import type { MinimalSessionOrigin } from '@/agent/session-meta'

import type { InspectEvent } from './types'

export type ReplayOptions = {
  onWarn?: (msg: string) => void
}

export async function* replayJsonl(filePath: string, opts: ReplayOptions = {}): AsyncGenerator<InspectEvent> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    opts.onWarn?.(`could not open ${filePath}: file does not exist`)
    return
  }
  let stream: ReadableStream<Uint8Array>
  try {
    stream = file.stream()
  } catch (err) {
    opts.onWarn?.(`could not open ${filePath}: ${describeErr(err)}`)
    return
  }
  yield* replayLines(safeStreamLines(stream, filePath, opts), opts)
}

async function* safeStreamLines(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  opts: ReplayOptions,
): AsyncGenerator<string> {
  try {
    yield* streamLines(stream)
  } catch (err) {
    opts.onWarn?.(`error reading ${filePath}: ${describeErr(err)}`)
  }
}

export async function* replayLines(
  lines: AsyncIterable<string>,
  opts: ReplayOptions = {},
): AsyncGenerator<InspectEvent> {
  const pending = new Map<string, { name: string; startTs: number }>()
  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      opts.onWarn?.('skipping malformed JSONL line')
      continue
    }
    yield* eventsFromEntry(entry, pending)
  }
}

function* eventsFromEntry(entry: unknown, pending: Map<string, { name: string; startTs: number }>): Iterable<InspectEvent> {
  const meta = readSessionMeta(entry)
  if (meta !== null) {
    yield { cat: 'meta', ts: numberOr(readField(entry, 'timestamp'), 0), origin: meta }
    return
  }
  if (!isMessageEntry(entry)) return
  const message = entry.message
  const role = message.role
  const ts = numberOr(readField(message, 'timestamp'), 0)
  if (role === 'user') {
    const text = readTextContent(message.content)
    if (text !== null) yield { cat: 'user', ts, text }
    return
  }
  if (role === 'assistant') {
    yield* assistantEvents(message, ts, pending)
    return
  }
}

function* assistantEvents(
  message: AssistantMessage,
  ts: number,
  pending: Map<string, { name: string; startTs: number }>,
): Iterable<InspectEvent> {
  const text = readTextContent(message.content)
  if (text !== null && text !== '') {
    const ev: InspectEvent = {
      cat: 'assistant',
      ts,
      text,
      ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
      ...(typeof message.model === 'string' ? { model: message.model } : {}),
    }
    yield ev
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const callEvents = readToolCall(block, ts)
      for (const ev of callEvents) {
        if (ev.cat === 'tool' && ev.phase === 'start') pending.set(ev.toolCallId, { name: ev.name, startTs: ev.ts })
        yield ev
      }
      const resultEvents = readToolResult(block, ts, pending)
      yield* resultEvents
    }
  }
  if (typeof message.errorMessage === 'string' && message.errorMessage !== '') {
    yield { cat: 'error', ts, message: message.errorMessage }
  }
  const usage = readUsage(message.usage)
  if (usage !== null) {
    yield {
      cat: 'done',
      ts,
      ...(typeof message.stopReason === 'string' ? { stopReason: message.stopReason } : {}),
      ...usage,
    }
  }
}

function readToolCall(block: unknown, ts: number): InspectEvent[] {
  if (typeof block !== 'object' || block === null) return []
  const b = block as Record<string, unknown>
  if (b.type !== 'toolCall') return []
  const toolCallId = typeof b.id === 'string' ? b.id : null
  const name = typeof b.name === 'string' ? b.name : null
  if (toolCallId === null || name === null) return []
  return [
    {
      cat: 'tool',
      ts,
      phase: 'start',
      toolCallId,
      name,
      ...(b.arguments !== undefined ? { args: b.arguments } : {}),
    },
  ]
}

function readToolResult(
  block: unknown,
  ts: number,
  pending: Map<string, { name: string; startTs: number }>,
): InspectEvent[] {
  if (typeof block !== 'object' || block === null) return []
  const b = block as Record<string, unknown>
  if (b.type !== 'toolResult') return []
  const toolCallId = typeof b.toolCallId === 'string' ? b.toolCallId : null
  if (toolCallId === null) return []
  const entry = pending.get(toolCallId)
  pending.delete(toolCallId)
  const name = entry?.name ?? (typeof b.name === 'string' ? b.name : 'unknown')
  const durationMs = entry !== undefined ? Math.max(0, ts - entry.startTs) : 0
  const isError = b.isError === true
  return [
    {
      cat: 'tool',
      ts,
      phase: 'end',
      toolCallId,
      name,
      ...(b.output !== undefined ? { result: b.output } : {}),
      isError,
      durationMs,
    },
  ]
}

function readUsage(value: unknown): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
} | null {
  if (typeof value !== 'object' || value === null) return null
  const u = value as Record<string, unknown>
  const cost = u.cost as Record<string, unknown> | undefined
  return {
    input: numberOr(u.input, 0),
    output: numberOr(u.output, 0),
    cacheRead: numberOr(u.cacheRead, 0),
    cacheWrite: numberOr(u.cacheWrite, 0),
    totalTokens: numberOr(u.totalTokens, 0),
    cost: numberOr(cost?.total, 0),
  }
}

function readTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  if (parts.length === 0) return null
  return parts.join('')
}

type AssistantMessage = {
  role: 'assistant'
  content?: unknown
  provider?: unknown
  model?: unknown
  usage?: unknown
  errorMessage?: unknown
  stopReason?: unknown
}

function isMessageEntry(value: unknown): value is { type: 'message'; message: { role: string; [k: string]: unknown } } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.type !== 'message') return false
  if (typeof v.message !== 'object' || v.message === null) return false
  const m = v.message as Record<string, unknown>
  return typeof m.role === 'string'
}

function readSessionMeta(value: unknown): MinimalSessionOrigin | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.type !== 'custom') return null
  if (v.customType !== SESSION_META_CUSTOM_TYPE) return null
  if (typeof v.data !== 'object' || v.data === null) return null
  const d = v.data as Record<string, unknown>
  if (typeof d.origin !== 'object' || d.origin === null) return null
  const o = d.origin as Record<string, unknown>
  if (typeof o.kind !== 'string') return null
  return d.origin as MinimalSessionOrigin
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      yield line
      nl = buf.indexOf('\n')
    }
  }
  if (buf.length > 0) yield buf
}
