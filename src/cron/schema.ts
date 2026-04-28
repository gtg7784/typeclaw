import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

const idPattern = /^[a-zA-Z0-9_-]+$/

const baseJob = z.object({
  id: z.string().min(1).regex(idPattern, 'id must contain only letters, digits, hyphens, or underscores'),
  schedule: z.string().min(1),
  enabled: z.boolean().default(true),
  timezone: z.string().optional(),
})

const promptJob = baseJob.extend({
  kind: z.literal('prompt'),
  prompt: z.string().min(1),
})

const execJob = baseJob.extend({
  kind: z.literal('exec'),
  command: z.array(z.string().min(1)).min(1),
})

export const cronJobSchema = z.discriminatedUnion('kind', [promptJob, execJob])

export const cronFileSchema = z.object({
  $schema: z.string().optional(),
  jobs: z.array(cronJobSchema).default([]),
})

export type UserCronJob = z.infer<typeof cronJobSchema>
export type PromptJob = Extract<UserCronJob, { kind: 'prompt' }>
export type ExecJob = Extract<UserCronJob, { kind: 'exec' }>
export type CronFile = z.infer<typeof cronFileSchema>

// Internal cron jobs. Constructed only from code (e.g., from typeclaw.json's
// `memory.dreaming` config), never accepted from cron.json. They share the
// scheduler's clock and the consumer's coalescing, but dispatch by handing
// the payload to a registered subagent.
export type SubagentJob = {
  id: string
  schedule: string
  enabled: boolean
  timezone?: string
  kind: 'subagent'
  subagent: string
  payload: unknown
}

// The runtime job union. The scheduler and consumer accept `CronJob`; only
// `cronJobSchema` is parsed from disk.
export type CronJob = UserCronJob | SubagentJob

export type ParseCronResult = { ok: true; file: CronFile } | { ok: false; reason: string }

export function parseCronFile(raw: unknown): ParseCronResult {
  const parsed = cronFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map(formatIssue).join('; ') }
  }

  const file = parsed.data
  const seen = new Set<string>()
  for (const job of file.jobs) {
    if (seen.has(job.id)) {
      return { ok: false, reason: `duplicate job id: ${job.id}` }
    }
    seen.add(job.id)

    try {
      const expr = CronExpressionParser.parse(job.schedule, job.timezone ? { tz: job.timezone } : undefined)
      // cron-parser validates the timezone lazily on first next() call, not at
      // parse time, so we must force evaluation here to catch bogus zones.
      expr.next()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (job.timezone && /invalid|unhandled timestamp|unrecognized/i.test(message)) {
        return { ok: false, reason: `job ${job.id}: invalid timezone "${job.timezone}": ${message}` }
      }
      return { ok: false, reason: `job ${job.id}: invalid schedule "${job.schedule}": ${message}` }
    }
  }

  return { ok: true, file }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
