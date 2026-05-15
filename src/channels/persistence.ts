import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ChannelParticipant } from '@/agent/session-origin'

import type { AdapterId } from './schema'
import type { ChannelKey } from './types'

const FILE_VERSION = 4

// `sessionFile` is the basename (not the full path) of the JSONL transcript
// for this (adapter, workspace, chat, thread) tuple. pi-coding-agent writes
// session files as `${ISO_TIMESTAMP}_${UUID}.jsonl`, where the UUID matches
// `sessionId` but the timestamp prefix only exists at write time. Without
// the basename persisted, reopen attempts can only guess the path from the
// UUID, which never matches on disk — every restart silently creates a
// fresh session and the channel loses its transcript memory.
//
// `sessionFile` is optional because v2 records (pre-fix) only carried the
// UUID. Those are migrated in-place at load time by globbing the sessions
// directory for `*_${sessionId}.jsonl`; if no match is found the file is
// considered lost and reopen will fall back to a fresh session.
export type ChannelSessionRecord = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  sessionId?: string
  sessionFile?: string
  lastInboundAt?: number
  participants: ChannelParticipant[]
}

type FileV4 = {
  version: 4
  sessions: ChannelSessionRecord[]
}

type FileV3 = {
  version: 3
  sessions: ChannelSessionRecord[]
}

type FileV2 = {
  version: 2
  sessions: Array<Omit<ChannelSessionRecord, 'sessionFile'>>
}

export type ChannelSessionsLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ChannelSessionsLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function channelsSessionsPath(agentDir: string): string {
  return join(agentDir, 'channels', 'sessions.json')
}

function sessionsDirOf(agentDir: string): string {
  return join(agentDir, 'sessions')
}

export async function loadChannelSessions(
  agentDir: string,
  logger: ChannelSessionsLogger = consoleLogger,
): Promise<ChannelSessionRecord[]> {
  const path = channelsSessionsPath(agentDir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.error(`[channels] ${path} corrupted: ${describe(err)}; starting fresh`)
    return []
  }
  if (!isObject(parsed)) {
    logger.warn(`[channels] ${path} not an object; ignored`)
    return []
  }
  const version = (parsed as { version?: unknown }).version
  if (version === FILE_VERSION) {
    const file = parsed as FileV4
    if (!Array.isArray(file.sessions)) return []
    return file.sessions.filter(isValidRecord)
  }
  if (version === 3) {
    const file = parsed as FileV3
    if (!Array.isArray(file.sessions)) return []
    return migrateV3ToV4(file.sessions.filter(isValidRecord), logger)
  }
  if (version === 2) {
    const file = parsed as FileV2
    if (!Array.isArray(file.sessions)) return []
    const v2Records = file.sessions.filter(isValidV2Record)
    const v3Records = await migrateV2Records(agentDir, v2Records, logger)
    return migrateV3ToV4(v3Records, logger)
  }
  logger.warn(
    `[channels] ${path} version ${String(version)} not supported (expected 2, 3, or ${FILE_VERSION}); ignored`,
  )
  return []
}

export async function saveChannelSessions(
  agentDir: string,
  sessions: readonly ChannelSessionRecord[],
  logger: ChannelSessionsLogger = consoleLogger,
): Promise<void> {
  const path = channelsSessionsPath(agentDir)
  const payload: FileV4 = { version: FILE_VERSION, sessions: dedupe(sessions) }
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    const { rename } = await import('node:fs/promises')
    await rename(tmp, path)
  } catch (err) {
    logger.error(`[channels] failed to persist sessions: ${describe(err)}`)
  }
}

// One-shot migration from v2 (sessionId only) to v3 (sessionId + sessionFile).
// pi-coding-agent writes session files as `${ISO_TIMESTAMP}_${UUID}.jsonl`,
// so we look for any file ending in `_${sessionId}.jsonl`. If a directory
// scan fails we leave sessionFile undefined; the next reopen attempt will
// fall back to a fresh session (the same broken behavior v2 had — but at
// least the next successful create will populate sessionFile correctly and
// we'll be migrated forward.)
async function migrateV2Records(
  agentDir: string,
  v2Records: readonly (Omit<ChannelSessionRecord, 'sessionFile' | 'sessionId'> & { sessionId: string })[],
  logger: ChannelSessionsLogger,
): Promise<ChannelSessionRecord[]> {
  if (v2Records.length === 0) return []
  const sessionsDir = sessionsDirOf(agentDir)
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    logger.warn(`[channels] could not scan ${sessionsDir} for v2→v3 migration; sessionFile left empty`)
    return v2Records.map((r) => ({ ...r }))
  }
  // pi-coding-agent writes files as `${ISO_TIMESTAMP}_${UUID}.jsonl` where
  // the ISO timestamp uses `-` (no `_`) and the UUID may contain `-`. Split
  // on the FIRST underscore so the trailing portion is the full UUID even
  // when the UUID contains hyphens.
  const bySessionIdSuffix = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const underscore = entry.indexOf('_')
    if (underscore < 0) continue
    const trailing = entry.slice(underscore + 1, -'.jsonl'.length)
    bySessionIdSuffix.set(trailing, entry)
  }
  return v2Records.map((r) => {
    const matched = bySessionIdSuffix.get(r.sessionId)
    if (matched === undefined) {
      logger.warn(
        `[channels] v2→v3: no session file matching *_${r.sessionId}.jsonl in ${sessionsDir}; ` +
          `sessionFile left empty (next inbound will create a fresh session for ${r.adapter}:${r.chat}:${r.thread ?? ''})`,
      )
      return { ...r }
    }
    return { ...r, sessionFile: matched }
  })
}

function migrateV3ToV4(v3Records: ChannelSessionRecord[], logger: ChannelSessionsLogger): ChannelSessionRecord[] {
  logger.info(
    `[channels] v3→v4: ${v3Records.length} record(s) migrated; first post-upgrade inbound will force fresh session`,
  )
  return v3Records.map((r) => ({ ...r, lastInboundAt: 0 }))
}

function dedupe(sessions: readonly ChannelSessionRecord[]): ChannelSessionRecord[] {
  const seen = new Map<string, ChannelSessionRecord>()
  for (const s of sessions) {
    seen.set(`${s.adapter}:${s.workspace}:${s.chat}:${s.thread ?? ''}`, s)
  }
  return Array.from(seen.values())
}

export function findRecord(
  sessions: readonly ChannelSessionRecord[],
  key: ChannelKey,
): ChannelSessionRecord | undefined {
  return sessions.find(
    (s) =>
      s.adapter === key.adapter &&
      s.workspace === key.workspace &&
      s.chat === key.chat &&
      (s.thread ?? null) === (key.thread ?? null),
  )
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidV2Record(
  v: unknown,
): v is Omit<ChannelSessionRecord, 'sessionFile' | 'sessionId'> & { sessionId: string } {
  if (!isObject(v)) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.adapter === 'string' &&
    typeof r.workspace === 'string' &&
    typeof r.chat === 'string' &&
    (r.thread === null || typeof r.thread === 'string') &&
    typeof r.sessionId === 'string' &&
    Array.isArray(r.participants)
  )
}

function isValidRecord(v: unknown): v is ChannelSessionRecord {
  if (!isObject(v)) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.adapter === 'string' &&
    typeof r.workspace === 'string' &&
    typeof r.chat === 'string' &&
    (r.thread === null || typeof r.thread === 'string') &&
    (r.sessionId === undefined || typeof r.sessionId === 'string') &&
    (r.sessionFile === undefined || typeof r.sessionFile === 'string') &&
    (r.lastInboundAt === undefined || typeof r.lastInboundAt === 'number') &&
    Array.isArray(r.participants)
  )
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
