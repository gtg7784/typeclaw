import { join } from 'node:path'

import { originLabel, shortSessionId } from './label'
import { renderEvent } from './render'
import { replayJsonl } from './replay'
import type { SessionSummary } from './session-list'
import { isSessionIdShape, listSessions, resolveSession } from './session-list'
import type { InspectEvent, InspectFilter } from './types'
import { matchesFilter, parseDuration, parseFilter } from './types'

export { listSessions, resolveSession } from './session-list'
export type { SessionSummary } from './session-list'
export { originLabel, shortSessionId } from './label'
export { renderEvent } from './render'
export { replayJsonl } from './replay'
export { streamLive } from './live'
export { parseDuration, parseFilter } from './types'
export type { InspectCategory, InspectEvent, InspectFilter } from './types'
export { runInspectLoop, runViewerLoop } from './loop'
export type {
  OpenItem,
  OpenItemContext,
  RunInspectLoopOptions,
  RunViewerLoopOptions,
  SelectItem,
  TailController,
} from './loop'
export type { ViewerItem } from './item'
export { isWritable, itemKey } from './item'
export { listViewerItems } from './item-list'
export type { ListViewerItemsOptions, ViewerList } from './item-list'
export { openViewerItem } from './open-item'
export type { OpenViewerDeps } from './open-item'
export { runTuiViewer } from './tui-item'
export type { RunTuiViewerOptions } from './tui-item'
export { streamLogs } from './logs-item'
export { createTranscriptView } from './transcript-view'
export type { TranscriptViewOptions, TranscriptViewOutcome } from './transcript-view'

export type RunInspectOptions = {
  agentDir: string
  sessionIdOrPrefix?: string
  filter?: string
  since?: string
  json?: boolean
  color: boolean
  selectSession: SelectSession
  stdout: (line: string) => void
  stderr: (line: string) => void
  liveSource?: LiveSourceFactory
  // Aborting this signal stops the live tail and returns escToPicker=true; the
  // caller's loop inspects its own scope intent to tell back from exit.
  signal?: AbortSignal
  liveHint?: string
  interactive?: boolean
}

export type SelectSessionOptions = {
  initialSessionId?: string
}

export type SelectSession = (sessions: SessionSummary[], opts?: SelectSessionOptions) => Promise<SessionSummary | null>

export type LiveSourceFactory = (opts: {
  sessionId: string
  sinceMs?: number
  signal?: AbortSignal
  onSubscribed?: (sessionLive: boolean) => void
}) => AsyncIterable<InspectEvent>

export type RunInspectResult =
  | { ok: true; exitCode: number; escToPicker?: boolean }
  | { ok: false; exitCode: number; reason: string }

export type InspectTarget = {
  summary: SessionSummary
  filter: InspectFilter
  sinceMs: number | undefined
}

export type ResolveInspectResult = { ok: true; target: InspectTarget } | { ok: false; exitCode: number; reason: string }

// Picker phase, split out from the streaming phase so the tail scope is created
// AFTER the picker, never before. A raw-mode 'data' listener active during the
// Clack picker (which forces cooked mode via prepareStdinForClack) fights Clack
// for stdin and leaves the later stream in cooked mode — that was the recurring
// "esc does nothing" regression.
export async function resolveInspectTarget(opts: Omit<RunInspectOptions, 'signal'>): Promise<ResolveInspectResult> {
  const filterResult = parseFilter(opts.filter)
  if (!filterResult.ok) return { ok: false, exitCode: 2, reason: filterResult.reason }
  const filter = filterResult.filter

  let sinceMs: number | undefined
  if (opts.since !== undefined) {
    const d = parseDuration(opts.since)
    if (!d.ok) return { ok: false, exitCode: 2, reason: d.reason }
    sinceMs = Date.now() - d.ms
  }

  const sessionsDir = join(opts.agentDir, 'sessions')

  const summary = await chooseSession(opts, sessionsDir, sinceMs)
  if (!summary.ok) return summary

  return { ok: true, target: { summary: summary.summary, filter, sinceMs } }
}

export async function runInspect(opts: RunInspectOptions): Promise<RunInspectResult> {
  const resolved = await resolveInspectTarget(opts)
  if (!resolved.ok) return resolved
  return streamInspectTarget({ ...opts, target: resolved.target })
}

export async function streamInspectTarget(
  opts: Omit<RunInspectOptions, 'sessionIdOrPrefix' | 'filter' | 'since' | 'selectSession'> & {
    target: InspectTarget
  },
): Promise<RunInspectResult> {
  const streamResult = await streamSession({
    summary: opts.target.summary,
    filter: opts.target.filter,
    sinceMs: opts.target.sinceMs,
    json: opts.json === true,
    color: opts.color,
    stdout: opts.stdout,
    stderr: opts.stderr,
    ...(opts.liveSource !== undefined ? { liveSource: opts.liveSource } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.liveHint !== undefined ? { liveHint: opts.liveHint } : {}),
    ...(opts.interactive === true ? { interactive: true } : {}),
  })
  if (streamResult.escToPicker) return { ok: true, exitCode: 0, escToPicker: true }
  return { ok: true, exitCode: 0 }
}

async function chooseSession(
  opts: RunInspectOptions,
  sessionsDir: string,
  sinceMs: number | undefined,
): Promise<{ ok: true; summary: SessionSummary } | { ok: false; exitCode: number; reason: string }> {
  if (opts.sessionIdOrPrefix !== undefined) {
    if (opts.json === true && !looksLikeSessionId(opts.sessionIdOrPrefix)) {
      return {
        ok: false,
        exitCode: 2,
        reason: `--json requires an explicit session id (got "${opts.sessionIdOrPrefix}")`,
      }
    }
    const resolved = await resolveSession(sessionsDir, opts.sessionIdOrPrefix, opts.stderr)
    if (resolved.ok) return { ok: true, summary: resolved.summary }
    if (resolved.reason === 'ambiguous') {
      const lines = ['Ambiguous session prefix matches multiple sessions:']
      for (const m of resolved.matches) {
        lines.push(`  ${m.sessionId}  ${m.origin === null ? '(unknown origin)' : originLabel(m.origin)}`)
      }
      lines.push('Use the full id or run `typeclaw inspect` without args.')
      return { ok: false, exitCode: 2, reason: lines.join('\n') }
    }
    return { ok: false, exitCode: 1, reason: `No session matching "${opts.sessionIdOrPrefix}" in ${sessionsDir}/` }
  }

  if (opts.json === true) {
    return { ok: false, exitCode: 2, reason: '--json requires an explicit session id (interactive picker is disabled)' }
  }

  const listOpts: Parameters<typeof listSessions>[0] = {
    sessionsDir,
    limit: 20,
    onWarn: opts.stderr,
  }
  if (sinceMs !== undefined) listOpts.sinceMs = sinceMs
  const sessions = await listSessions(listOpts)
  if (sessions.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      reason: `No sessions found in ${sessionsDir}/.\nStart a session with \`typeclaw tui\` or send a message from a configured channel.`,
    }
  }
  const picked = await opts.selectSession(sessions)
  if (picked === null) return { ok: false, exitCode: 130, reason: 'cancelled' }
  return { ok: true, summary: picked }
}

// Lifecycle phases surfaced to a consumer so renderers can react (e.g. batch a
// pi-tui render at replay-end, announce a live divider). `sessionLive` on
// 'live-start' is the registry hit/miss from the live source's onSubscribed.
export type StreamPhase =
  | { phase: 'replay-end' }
  | { phase: 'replay-only-idle' }
  | { phase: 'live-start'; sessionLive: boolean }
  | { phase: 'end' }

export type StreamSessionEventsOptions = {
  summary: SessionSummary
  filter: InspectFilter
  sinceMs: number | undefined
  onEvent: (event: InspectEvent) => void
  onPhase?: (phase: StreamPhase) => void
  onWarn?: (msg: string) => void
  liveSource?: LiveSourceFactory
  signal?: AbortSignal
  // When true and replay-only with a signal, block until aborted instead of
  // returning immediately — a stable interactive viewer that esc/q dismisses.
  blockWhenReplayOnly?: boolean
}

// The read path shared by the line renderer and the pi-tui transcript view:
// replay the JSONL transcript, then optionally live-tail, applying since/filter
// and honoring signal.aborted (-> escToPicker). Knows nothing about rendering —
// it just delivers ordered, filtered InspectEvents to onEvent and announces
// phase transitions via onPhase.
export async function streamSessionEvents(opts: StreamSessionEventsOptions): Promise<{ escToPicker: boolean }> {
  const aborted = (): boolean => opts.signal?.aborted === true
  const deliver = (event: InspectEvent): void => {
    if (opts.sinceMs !== undefined && event.ts > 0 && event.ts < opts.sinceMs) return
    if (!matchesFilter(event, opts.filter)) return
    opts.onEvent(event)
  }

  for await (const event of replayJsonl(
    opts.summary.sessionFile,
    opts.onWarn !== undefined ? { onWarn: opts.onWarn } : {},
  )) {
    if (aborted()) return { escToPicker: true }
    deliver(event)
  }
  opts.onPhase?.({ phase: 'replay-end' })

  if (opts.liveSource === undefined) {
    if (aborted()) return { escToPicker: true }
    if (opts.blockWhenReplayOnly === true && opts.signal !== undefined) {
      opts.onPhase?.({ phase: 'replay-only-idle' })
      await waitForAbort(opts.signal)
    }
    opts.onPhase?.({ phase: 'end' })
    return { escToPicker: aborted() }
  }

  if (aborted()) return { escToPicker: true }

  let sessionLive = false
  const liveIter = opts.liveSource({
    sessionId: opts.summary.sessionId,
    ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    onSubscribed: (live) => {
      sessionLive = live
    },
  })

  let liveAnnounced = false
  try {
    for await (const event of liveIter) {
      if (!liveAnnounced) {
        opts.onPhase?.({ phase: 'live-start', sessionLive })
        liveAnnounced = true
      }
      deliver(event)
    }
  } catch (err) {
    opts.onWarn?.(`live tail ended: ${err instanceof Error ? err.message : String(err)}`)
  }
  opts.onPhase?.({ phase: 'end' })
  return { escToPicker: aborted() }
}

// Line/JSON renderer: the original streamSession behavior, now expressed as a
// streamSessionEvents consumer. Preserves the exact header/divider output and
// scriptable stdout/JSON contract.
async function streamSession(opts: {
  summary: SessionSummary
  filter: InspectFilter
  sinceMs: number | undefined
  json: boolean
  color: boolean
  stdout: (line: string) => void
  stderr: (line: string) => void
  liveSource?: LiveSourceFactory
  signal?: AbortSignal
  liveHint?: string
  interactive?: boolean
}): Promise<{ escToPicker: boolean }> {
  if (!opts.json) writeHeader(opts.summary, opts.color, opts.stdout)

  const onEvent = (event: InspectEvent): void => {
    if (opts.json) opts.stdout(JSON.stringify({ sessionId: opts.summary.sessionId, ...event }))
    else opts.stdout(renderEvent(event, { color: opts.color }))
  }

  const emitHint = (): void => {
    if (!opts.json && opts.liveHint !== undefined && opts.liveHint !== '') {
      opts.stdout(divider(opts.color, opts.liveHint))
    }
  }

  // Replay-only prints the end-of-transcript footer once at the idle point (the
  // viewer then blocks); the terminal 'end' phase must not print it a second
  // time. Live mode skips the idle phase and prints the footer only at 'end'.
  let footerPrinted = false
  const printFooter = (): void => {
    opts.stdout('─── end of transcript ───')
    footerPrinted = true
  }

  const onPhase = (p: StreamPhase): void => {
    if (opts.json) return
    if (p.phase === 'replay-only-idle') {
      printFooter()
      emitHint()
    } else if (p.phase === 'live-start') {
      opts.stdout(
        divider(opts.color, p.sessionLive ? '─── live ───' : '─── live (session not in registry; broadcasts only) ───'),
      )
      emitHint()
    } else if (p.phase === 'end' && !footerPrinted) {
      printFooter()
    }
  }

  return streamSessionEvents({
    summary: opts.summary,
    filter: opts.filter,
    sinceMs: opts.sinceMs,
    onEvent,
    onPhase,
    onWarn: opts.stderr,
    ...(opts.liveSource !== undefined ? { liveSource: opts.liveSource } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    blockWhenReplayOnly: opts.interactive === true && !opts.json,
  })
}

function divider(color: boolean, text: string): string {
  if (color) return `\u001b[2m${text}\u001b[0m`
  return text
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function writeHeader(summary: SessionSummary, color: boolean, stdout: (line: string) => void): void {
  const id = shortSessionId(summary.sessionId)
  const label = summary.origin === null ? '(unknown origin)' : originLabel(summary.origin)
  const started = formatDate(summary.mtimeMs)
  const headerLine = `─── ${id} · ${label} · last activity ${started} ───`
  if (color) stdout(`\u001b[2m${headerLine}\u001b[0m`)
  else stdout(headerLine)
}

function formatDate(ms: number): string {
  if (ms === 0) return '--'
  const d = new Date(ms)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

const MIN_EXPLICIT_ID_LENGTH = 8

function looksLikeSessionId(value: string): boolean {
  return value.length >= MIN_EXPLICIT_ID_LENGTH && isSessionIdShape(value)
}
