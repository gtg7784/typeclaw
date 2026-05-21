import type { AgentSession } from './index'

export type SubagentProgressEvent =
  | { kind: 'started'; ts: number }
  | { kind: 'tool'; name: string; ok: boolean; ts: number }
  | { kind: 'message'; preview: string; ts: number }

export type SubagentStatus = 'running' | 'completed' | 'failed'

export type SubagentCompletion = {
  ok: boolean
  finalMessage?: string
  error?: string
  durationMs: number
}

export type LiveSubagent = {
  taskId: string
  sessionId: string
  subagentName: string
  parentSessionId?: string
  startedAt: number
  status: SubagentStatus
  completion?: SubagentCompletion
  abort: () => Promise<void>
  awaitCompletion: () => Promise<SubagentCompletion>
}

export const MAX_EVENTS_PER_SUBAGENT = 100
export const MESSAGE_PREVIEW_CHARS = 200

type AgentSessionEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: string; delta?: string } }
  | { type: 'message_end'; message: unknown }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: string }

export function coarsen(event: AgentSessionEvent, now: number): SubagentProgressEvent | null {
  if (event.type === 'tool_execution_end') {
    const ev = event as Extract<AgentSessionEvent, { type: 'tool_execution_end' }>
    return { kind: 'tool', name: ev.toolName, ok: !ev.isError, ts: now }
  }
  if (event.type === 'message_end') {
    const ev = event as Extract<AgentSessionEvent, { type: 'message_end' }>
    const preview = extractMessagePreview(ev.message)
    if (preview === null) return null
    return { kind: 'message', preview, ts: now }
  }
  return null
}

function extractMessagePreview(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? trimmed.slice(0, MESSAGE_PREVIEW_CHARS) : null
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') {
          const trimmed = text.trim()
          if (trimmed) return trimmed.slice(0, MESSAGE_PREVIEW_CHARS)
        }
      }
    }
  }
  return null
}

export type StatusSnapshot = {
  taskId: string
  sessionId: string
  subagentName: string
  status: SubagentStatus
  startedAt: number
  elapsedMs: number
  eventsCount: number
  eventsRecent: SubagentProgressEvent[]
  lastActivity: SubagentProgressEvent | null
  statusSummary: string
  completion?: SubagentCompletion
}

export class LiveSubagentRegistry {
  private readonly entries = new Map<string, LiveSubagent>()
  private readonly events = new Map<string, SubagentProgressEvent[]>()

  register(live: LiveSubagent): void {
    if (this.entries.has(live.taskId)) {
      throw new Error(`task ${live.taskId} already registered`)
    }
    this.entries.set(live.taskId, live)
    this.events.set(live.taskId, [{ kind: 'started', ts: live.startedAt }])
  }

  unregister(taskId: string): void {
    this.entries.delete(taskId)
    this.events.delete(taskId)
  }

  get(taskId: string): LiveSubagent | undefined {
    return this.entries.get(taskId)
  }

  list(filter?: { parentSessionId?: string }): LiveSubagent[] {
    const all = Array.from(this.entries.values())
    if (filter?.parentSessionId === undefined) return all
    return all.filter((e) => e.parentSessionId === filter.parentSessionId)
  }

  hasLiveForSession(sessionId: string): boolean {
    for (const e of this.entries.values()) {
      if (e.sessionId === sessionId && e.status === 'running') return true
    }
    return false
  }

  recordEvent(taskId: string, event: SubagentProgressEvent): void {
    const ring = this.events.get(taskId)
    if (ring === undefined) return
    ring.push(event)
    if (ring.length > MAX_EVENTS_PER_SUBAGENT) {
      ring.splice(0, ring.length - MAX_EVENTS_PER_SUBAGENT)
    }
  }

  recordCompletion(taskId: string, completion: SubagentCompletion): void {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return
    entry.completion = completion
    entry.status = completion.ok ? 'completed' : 'failed'
  }

  snapshot(taskId: string, now: number = Date.now()): StatusSnapshot | undefined {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return undefined
    const events = this.events.get(taskId) ?? []
    const eventsRecent = events.slice(-10)
    const lastActivity: SubagentProgressEvent | null = events.length > 0 ? (events[events.length - 1] ?? null) : null
    const elapsedMs = (entry.completion ? entry.startedAt + entry.completion.durationMs : now) - entry.startedAt
    return {
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      subagentName: entry.subagentName,
      status: entry.status,
      startedAt: entry.startedAt,
      elapsedMs,
      eventsCount: events.length,
      eventsRecent,
      lastActivity,
      statusSummary: renderStatusSummary(entry, events.length, lastActivity, elapsedMs),
      ...(entry.completion ? { completion: entry.completion } : {}),
    }
  }

  clear(): void {
    this.entries.clear()
    this.events.clear()
  }
}

function renderStatusSummary(
  entry: LiveSubagent,
  eventsCount: number,
  lastActivity: SubagentProgressEvent | null,
  elapsedMs: number,
): string {
  const elapsed = formatElapsed(elapsedMs)
  if (entry.status === 'completed') return `Completed in ${elapsed}.`
  if (entry.status === 'failed') {
    const err = entry.completion?.error ?? 'unknown error'
    return `Failed after ${elapsed}: ${err}`
  }
  const last = describeLastActivity(lastActivity)
  return `Running for ${elapsed}. ${eventsCount} event${eventsCount === 1 ? '' : 's'} so far${last ? `. Last: ${last}` : ''}.`
}

function describeLastActivity(event: SubagentProgressEvent | null): string | null {
  if (event === null) return null
  if (event.kind === 'tool') return `${event.ok ? '' : 'failed '}tool ${event.name}`
  if (event.kind === 'message') {
    const preview = event.preview.length > 60 ? `${event.preview.slice(0, 60)}…` : event.preview
    return `message "${preview}"`
  }
  return null
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m${sec}s`
}

export function attachProgressCapture(
  registry: LiveSubagentRegistry,
  taskId: string,
  session: Pick<AgentSession, 'subscribe'>,
): () => void {
  const unsubscribe = session.subscribe((event: unknown) => {
    const coarsened = coarsen(event as AgentSessionEvent, Date.now())
    if (coarsened !== null) {
      registry.recordEvent(taskId, coarsened)
    }
  })
  return () => {
    if (typeof unsubscribe === 'function') unsubscribe()
  }
}
