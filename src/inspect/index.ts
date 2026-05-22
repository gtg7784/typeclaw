import { join } from 'node:path'

import { originLabel, shortSessionId } from './label'
import { renderEvent } from './render'
import { replayJsonl } from './replay'
import type { SessionSummary } from './session-list'
import { listSessions, resolveSession } from './session-list'
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
  signal?: AbortSignal
}

export type SelectSession = (sessions: SessionSummary[]) => Promise<SessionSummary | null>

export type LiveSourceFactory = (opts: {
  sessionId: string
  sinceMs?: number
  signal?: AbortSignal
  onSubscribed?: (sessionLive: boolean) => void
}) => AsyncIterable<InspectEvent>

export type RunInspectResult = { ok: true; exitCode: 0 } | { ok: false; exitCode: number; reason: string }

export async function runInspect(opts: RunInspectOptions): Promise<RunInspectResult> {
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

  await streamSession({
    summary: summary.summary,
    filter,
    sinceMs,
    json: opts.json === true,
    color: opts.color,
    stdout: opts.stdout,
    stderr: opts.stderr,
    ...(opts.liveSource !== undefined ? { liveSource: opts.liveSource } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
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
}): Promise<void> {
  if (!opts.json) writeHeader(opts.summary, opts.color, opts.stdout)
  const emit = (event: InspectEvent): void => {
    if (opts.sinceMs !== undefined && event.ts > 0 && event.ts < opts.sinceMs) return
    if (!matchesFilter(event, opts.filter)) return
    if (opts.json) {
      opts.stdout(JSON.stringify({ sessionId: opts.summary.sessionId, ...event }))
    } else {
      opts.stdout(renderEvent(event, { color: opts.color }))
    }
  }

  for await (const event of replayJsonl(opts.summary.sessionFile, { onWarn: opts.stderr })) {
    emit(event)
  }

  if (opts.liveSource === undefined) {
    if (!opts.json) opts.stdout('─── end of transcript ───')
    return
  }

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
      if (!liveAnnounced && !opts.json) {
        opts.stdout(divider(opts.color, sessionLive ? '─── live ───' : '─── live (session not in registry; broadcasts only) ───'))
        liveAnnounced = true
      }
      emit(event)
    }
  } catch (err) {
    opts.stderr(`live tail ended: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!opts.json) opts.stdout('─── end of transcript ───')
}

function divider(color: boolean, text: string): string {
  if (color) return `\u001b[2m${text}\u001b[0m`
  return text
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

function looksLikeSessionId(value: string): boolean {
  return value.startsWith('ses_')
}
