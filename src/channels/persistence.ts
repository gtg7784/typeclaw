import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ChannelParticipant } from '@/agent/session-origin'

import type { AdapterId } from './schema'
import type { ChannelKey } from './types'

const FILE_VERSION = 2

export type ChannelSessionRecord = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  sessionId: string
  participants: ChannelParticipant[]
}

type FileV2 = {
  version: 2
  sessions: ChannelSessionRecord[]
}

export type ChannelSessionsLogger = {
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ChannelSessionsLogger = {
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function channelsSessionsPath(agentDir: string): string {
  return join(agentDir, 'channels', 'sessions.json')
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
  if (!isObject(parsed) || (parsed as { version?: unknown }).version !== FILE_VERSION) {
    logger.warn(`[channels] ${path} not version ${FILE_VERSION}; ignored`)
    return []
  }
  const file = parsed as FileV2
  if (!Array.isArray(file.sessions)) return []
  return file.sessions.filter(isValidRecord)
}

export async function saveChannelSessions(
  agentDir: string,
  sessions: readonly ChannelSessionRecord[],
  logger: ChannelSessionsLogger = consoleLogger,
): Promise<void> {
  const path = channelsSessionsPath(agentDir)
  const payload: FileV2 = { version: FILE_VERSION, sessions: dedupe(sessions) }
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

function isValidRecord(v: unknown): v is ChannelSessionRecord {
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
