import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type CronFile, type ExecJob, parseCronFile, type PromptJob } from './schema'

export { createScheduler, type JobRunner, type Scheduler, type SchedulerLogger } from './scheduler'
export { cronFileSchema, cronJobSchema, type CronFile, type CronJob, type ExecJob, type PromptJob } from './schema'

const CRON_FILE = 'cron.json'

export type LoadCronResult = { ok: true; file: CronFile | null } | { ok: false; reason: string }

export async function loadCron(agentDir: string): Promise<LoadCronResult> {
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

  const result = parseCronFile(parsed)
  if (!result.ok) return { ok: false, reason: result.reason }

  return { ok: true, file: result.file }
}

export function createExecRunner({ cwd }: { cwd: string }): { runExec: (job: ExecJob) => Promise<void> } {
  return {
    async runExec(job) {
      const [cmd, ...args] = job.command
      if (!cmd) throw new Error(`exec job ${job.id}: empty command`)
      const proc = Bun.spawn({ cmd: [cmd, ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
      const code = await proc.exited
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`exec job ${job.id} exited with code ${code}: ${stderr.trim() || 'no stderr'}`)
      }
    },
  }
}

export type PromptRunnerDeps = {
  createSessionForCron: (job: PromptJob) => Promise<{ prompt: (text: string) => Promise<void> }>
}

export function createPromptRunner({ createSessionForCron }: PromptRunnerDeps): {
  runPrompt: (job: PromptJob) => Promise<void>
} {
  return {
    async runPrompt(job) {
      const session = await createSessionForCron(job)
      await session.prompt(job.prompt)
    },
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
