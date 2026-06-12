import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { MinimalSessionOrigin } from '@/agent/session-meta'
import type { LiveSessionPayload } from '@/shared'

import { previewForHint } from './preview'
import { replayJsonl } from './replay'

export type SessionSummary = {
  sessionId: string
  sessionFile: string
  basename: string
  mtimeMs: number
  origin: MinimalSessionOrigin | null
  firstPrompt: string | null
  // True only for a registry-derived session with no .jsonl on disk yet (a
  // reply is in flight). Disk sessions leave this undefined. Selecting one tails
  // live-only: streamSessionEvents replays an empty file, then the WS delivers
  // events as they happen.
  live?: boolean
}

export type ListSessionsOptions = {
  sessionsDir: string
  limit?: number
  sinceMs?: number
  onWarn?: (msg: string) => void
}

// pi-coding-agent writes session files as `${ISO_TIMESTAMP}_${SESSION_ID}.jsonl`,
// where SESSION_ID is a UUIDv7 by default. Older typeclaw versions (pre-May
// 2026, before the channel session-file basename was persisted) also produced
// bare `${SESSION_ID}.jsonl` files; legacy agent folders still carry those
// alongside the canonical form, and skipping them hides real history from
// `typeclaw inspect`. Accept both shapes: take whatever follows the last `_`
// as the id, or the whole stem when no `_` is present. The id must be
// filesystem-safe (no `/`, `\`, or whitespace) and must start with a non-`_`
// character so empty-id filenames like `_.jsonl` don't slip through.
const FILENAME_PATTERN = /^(?:.*_)?([^_/\\\s][^/\\\s]*)\.jsonl$/

export async function listSessions(opts: ListSessionsOptions): Promise<SessionSummary[]> {
  const entries = await readSessionFiles(opts.sessionsDir, opts.onWarn)
  const withStats = await Promise.all(
    entries.map(async (entry) => {
      const s = await safeStat(entry.path)
      if (s === null) return null
      const mtimeMs = s.mtimeMs
      if (opts.sinceMs !== undefined && mtimeMs < opts.sinceMs) return null
      return { ...entry, mtimeMs }
    }),
  )
  const valid = withStats.filter(
    (v): v is { path: string; basename: string; sessionId: string; mtimeMs: number } => v !== null,
  )
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const limited = opts.limit !== undefined ? valid.slice(0, opts.limit) : valid

  return Promise.all(
    limited.map(async ({ path, basename, sessionId, mtimeMs }) => {
      const peek = await peekSession(path, opts.onWarn)
      return {
        sessionId,
        sessionFile: path,
        basename,
        mtimeMs,
        origin: peek.origin,
        firstPrompt: peek.firstPrompt,
      }
    }),
  )
}

// Overlay container-registry sessions onto the disk listing. A live session
// already flushed to disk (post-reply) is dropped from the overlay — the disk
// summary wins, carrying its real mtime and prompt preview. Only sessions with
// no .jsonl yet become synthetic live rows, sorted to the top by registration
// time so an in-flight reply surfaces above settled history.
export function mergeLiveSessions(disk: SessionSummary[], live: LiveSessionPayload[]): SessionSummary[] {
  const onDisk = new Set(disk.map((s) => s.sessionId))
  const liveOnly = live
    .filter((l) => !onDisk.has(l.sessionId))
    .map(
      (l): SessionSummary => ({
        sessionId: l.sessionId,
        sessionFile: '',
        basename: '',
        mtimeMs: l.registeredAtMs,
        origin: l.origin,
        firstPrompt: null,
        live: true,
      }),
    )
  return [...liveOnly, ...disk].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export type ResolveResult =
  | { ok: true; summary: SessionSummary }
  | { ok: false; reason: 'not-found' | 'ambiguous'; matches: SessionSummary[] }

const MIN_PREFIX_LENGTH = 4

export async function resolveSession(
  sessionsDir: string,
  sessionIdOrPrefix: string,
  onWarn?: (msg: string) => void,
): Promise<ResolveResult> {
  const all = await listSessions({ sessionsDir, ...(onWarn !== undefined ? { onWarn } : {}) })
  const exact = all.find((s) => s.sessionId === sessionIdOrPrefix)
  if (exact !== undefined) return { ok: true, summary: exact }

  if (sessionIdOrPrefix.length < MIN_PREFIX_LENGTH || !isSessionIdShape(sessionIdOrPrefix)) {
    return { ok: false, reason: 'not-found', matches: [] }
  }
  const prefixMatches = all.filter((s) => s.sessionId.startsWith(sessionIdOrPrefix))
  if (prefixMatches.length === 0) return { ok: false, reason: 'not-found', matches: [] }
  if (prefixMatches.length === 1) return { ok: true, summary: prefixMatches[0]! }
  return { ok: false, reason: 'ambiguous', matches: prefixMatches }
}

const SESSION_ID_SHAPE = /^[^_/\\\s][^/\\\s]*$/

export function isSessionIdShape(value: string): boolean {
  return SESSION_ID_SHAPE.test(value)
}

async function readSessionFiles(
  dir: string,
  onWarn?: (msg: string) => void,
): Promise<{ path: string; basename: string; sessionId: string }[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    if (isNoEnt(err)) return []
    throw err
  }
  const out: { path: string; basename: string; sessionId: string }[] = []
  for (const entry of entries) {
    const name = entry.name
    if (!name.endsWith('.jsonl')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      onWarn?.(`skipping non-file in sessions/: ${name}`)
      continue
    }
    const match = FILENAME_PATTERN.exec(name)
    if (!match) {
      onWarn?.(`skipping session file with unexpected name: ${name}`)
      continue
    }
    out.push({ path: join(dir, name), basename: name, sessionId: match[1]! })
  }
  return out
}

async function safeStat(path: string): Promise<{ mtimeMs: number } | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

const PREVIEW_MAX_BYTES = 64 * 1024

async function peekSession(
  path: string,
  onWarn?: (msg: string) => void,
): Promise<{ origin: MinimalSessionOrigin | null; firstPrompt: string | null }> {
  let origin: MinimalSessionOrigin | null = null
  const userTexts: string[] = []
  let bytesRead = 0
  for await (const event of replayJsonl(path, onWarn !== undefined ? { onWarn } : {})) {
    if (event.cat === 'meta' && origin === null) origin = event.origin
    if (event.cat === 'user' && userTexts.length < MAX_PREVIEW_CANDIDATES) userTexts.push(event.text)
    if (origin !== null && userTexts.length >= MAX_PREVIEW_CANDIDATES) break
    bytesRead += approximateSize(event)
    if (bytesRead > PREVIEW_MAX_BYTES) break
  }
  // Resolve the hint after the loop so origin (which selects the extraction
  // strategy) is known even if a user event precedes the meta event. A turn
  // that is pure injected preamble yields null, so fall through to the next user
  // turn for a useful glance.
  let firstPrompt: string | null = null
  for (const text of userTexts) {
    firstPrompt = previewForHint(origin, text)
    if (firstPrompt !== null) break
  }
  return { origin, firstPrompt }
}

const MAX_PREVIEW_CANDIDATES = 5

function approximateSize(event: { ts: number }): number {
  return JSON.stringify(event).length
}

function isNoEnt(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}
