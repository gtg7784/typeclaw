import { isAbsolute, normalize } from 'node:path'

import type {
  PluginCheckResult,
  PluginCheckStatus,
  PluginDoctorContext,
  PluginFixResult,
  PluginRegistry,
  RegisteredDoctorCheck,
} from '@/plugin'

export type PluginCheckRecord = {
  id: string
  pluginName: string
  checkName: string
  description: string
  category: string
  status: PluginCheckStatus
  message: string
  details?: string[]
  fix?: { description: string; hasApply: boolean }
}

export type PluginFixOutcome = { ok: true; summary: string; changedPaths: string[] } | { ok: false; error: string }

export type RunPluginDoctorOptions = {
  registry: PluginRegistry
  agentDir: string
  checkTimeoutMs?: number
}

export type RunPluginDoctorFixOptions = RunPluginDoctorOptions & {
  checkId: string
  fixTimeoutMs?: number
}

const DEFAULT_CHECK_TIMEOUT_MS = 5_000
const DEFAULT_FIX_TIMEOUT_MS = 30_000

export function checkId(pluginName: string, checkName: string): string {
  return `${pluginName}.${checkName}`
}

export async function runPluginDoctorChecks(opts: RunPluginDoctorOptions): Promise<PluginCheckRecord[]> {
  const timeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const records: PluginCheckRecord[] = []
  for (const entry of opts.registry.doctorChecks) {
    records.push(await runOneCheck(entry, opts.agentDir, timeoutMs))
  }
  return records
}

export async function runPluginDoctorFix(opts: RunPluginDoctorFixOptions): Promise<PluginFixOutcome> {
  const entry = opts.registry.doctorChecks.find((c) => checkId(c.pluginName, c.checkName) === opts.checkId)
  if (!entry) return { ok: false, error: `doctor check ${opts.checkId} is not registered` }

  const ctx = buildPluginCtx(entry, opts.agentDir)
  let result: PluginCheckResult
  try {
    result = await raceWithTimeout(entry.check.run(ctx), opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, 'check')
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
  const apply = result.fix?.apply
  if (!apply) return { ok: false, error: `${opts.checkId}: no auto-fix available` }

  let fix: PluginFixResult
  try {
    fix = await raceWithTimeout(apply(ctx), opts.fixTimeoutMs ?? DEFAULT_FIX_TIMEOUT_MS, 'fix')
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }

  const sanitized = sanitizeChangedPaths(fix.changedPaths)
  if (sanitized.rejected.length > 0) {
    entry.logger.warn(
      `${opts.checkId}: dropped ${sanitized.rejected.length} invalid changedPaths (${sanitized.rejected.join(', ')})`,
    )
  }
  return { ok: true, summary: fix.summary, changedPaths: sanitized.accepted }
}

async function runOneCheck(
  entry: RegisteredDoctorCheck,
  agentDir: string,
  timeoutMs: number,
): Promise<PluginCheckRecord> {
  const id = checkId(entry.pluginName, entry.checkName)
  const ctx = buildPluginCtx(entry, agentDir)
  try {
    const result = await raceWithTimeout(entry.check.run(ctx), timeoutMs, 'check')
    return buildRecord(entry, id, result)
  } catch (err) {
    return {
      id,
      pluginName: entry.pluginName,
      checkName: entry.checkName,
      description: entry.check.description,
      category: entry.check.category ?? `plugin:${entry.pluginName}`,
      status: 'error',
      message: messageOf(err),
    }
  }
}

function buildRecord(entry: RegisteredDoctorCheck, id: string, result: PluginCheckResult): PluginCheckRecord {
  const record: PluginCheckRecord = {
    id,
    pluginName: entry.pluginName,
    checkName: entry.checkName,
    description: entry.check.description,
    category: entry.check.category ?? `plugin:${entry.pluginName}`,
    status: result.status,
    message: result.message,
  }
  if (result.details !== undefined && result.details.length > 0) record.details = result.details
  if (result.fix !== undefined) {
    record.fix = { description: result.fix.description, hasApply: result.fix.apply !== undefined }
  }
  return record
}

function buildPluginCtx(entry: RegisteredDoctorCheck, agentDir: string): PluginDoctorContext {
  return Object.freeze({
    pluginName: entry.pluginName,
    agentDir,
    config: entry.pluginConfig,
    logger: entry.logger,
  })
}

async function raceWithTimeout<T>(work: Promise<T>, ms: number, label: 'check' | 'fix'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`plugin doctor ${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type PathSanitization = { accepted: string[]; rejected: string[] }

// Plugin fixes declare paths relative to agentDir; the host re-validates on
// receipt for defense in depth, but rejecting here first keeps the wire
// payload small and the failure attribution accurate.
export function sanitizeChangedPaths(paths: readonly string[]): PathSanitization {
  const accepted: string[] = []
  const rejected: string[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      rejected.push(String(raw))
      continue
    }
    if (isAbsolute(raw) || raw.includes('\\')) {
      rejected.push(raw)
      continue
    }
    const normalized = normalize(raw)
    if (normalized.startsWith('..') || normalized.split('/').includes('..')) {
      rejected.push(raw)
      continue
    }
    accepted.push(normalized)
  }
  return { accepted, rejected }
}
