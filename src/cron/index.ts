import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SubagentRegistry } from '@/agent/subagents'
import { commitSystemFile } from '@/git/system-commit'

import {
  buildCronMigrationCommitMessage,
  type CronFile,
  type CronMigrationStep,
  migrateLegacyCronShape,
  parseCronFile,
} from './schema'

export { createCronReloadable, type CreateCronReloadableOptions } from './reloadable'
export {
  createCronConsumer,
  type CreateCronConsumerOptions,
  type CronConsumer,
  type CronConsumerLogger,
  type CronSession,
} from './consumer'
export { createScheduler, type JobDiff, type Scheduler, type SchedulerLogger } from './scheduler'
export {
  buildCronMigrationCommitMessage,
  cronFileSchema,
  cronJobSchema,
  type CronFile,
  type CronJob,
  type CronMigrationResult,
  type CronMigrationStep,
  type ExecJob,
  migrateLegacyCronShape,
  type PromptJob,
} from './schema'

const CRON_FILE = 'cron.json'

export type LoadCronResult = { ok: true; file: CronFile | null } | { ok: false; reason: string }

export type LoadCronOptions = {
  subagents?: SubagentRegistry
}

export async function loadCron(agentDir: string, options: LoadCronOptions = {}): Promise<LoadCronResult> {
  const path = join(agentDir, CRON_FILE)
  if (!existsSync(path)) return { ok: true, file: null }

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    return { ok: false, reason: `failed to read cron.json: ${errorMessage(err)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, reason: `cron.json is not valid JSON: ${errorMessage(err)}` }
  }

  const migrated = migrateLegacyCronShape(parsed)
  if (migrated.changed) {
    await persistMigratedCron(path, migrated.json, agentDir, migrated.applied)
  }

  const result = parseCronFile(migrated.json, options.subagents !== undefined ? { subagents: options.subagents } : {})
  if (!result.ok) return { ok: false, reason: result.reason }

  return { ok: true, file: result.file }
}

async function persistMigratedCron(
  path: string,
  json: unknown,
  agentDir: string,
  applied: readonly CronMigrationStep[],
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(json, null, 2)}\n`)
  } catch {
    return
  }

  const message = buildCronMigrationCommitMessage(applied)
  if (message !== null) {
    await commitSystemFile(agentDir, CRON_FILE, message)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
