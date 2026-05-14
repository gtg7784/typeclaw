import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SubagentRegistry } from '@/agent/subagents'
import { validateSubagentPayload } from '@/agent/subagents'

const idPattern = /^[a-zA-Z0-9_-]+$/

const baseJob = z.object({
  id: z.string().min(1).regex(idPattern, 'id must contain only letters, digits, hyphens, or underscores'),
  schedule: z.string().min(1),
  enabled: z.boolean().default(true),
  timezone: z.string().optional(),
  scheduledByRole: z.string().optional(),
  // Audit snapshot of the SessionOrigin that scheduled this job. Persisted
  // as opaque z.unknown() because SessionOrigin is recursive (a cron origin
  // can contain a subagent origin can contain another cron origin, etc.)
  // and we do not want to mirror that union in the cron schema. The cron
  // consumer reads this back as-is and stamps it into the firing session's
  // origin without further validation -- if it's malformed, role
  // resolution falls back to `guest` via the same path that handles
  // missing fields.
  scheduledByOrigin: z.unknown().optional(),
})

const promptJob = baseJob.extend({
  kind: z.literal('prompt'),
  prompt: z.string().min(1),
  subagent: z.string().min(1).optional(),
  payload: z.unknown().optional(),
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

export type CronJob = z.infer<typeof cronJobSchema>
export type PromptJob = Extract<CronJob, { kind: 'prompt' }>
export type ExecJob = Extract<CronJob, { kind: 'exec' }>
export type CronFile = z.infer<typeof cronFileSchema>

export type ParseCronResult = { ok: true; file: CronFile } | { ok: false; reason: string }

export type ParseCronOptions = {
  // When provided, prompt jobs with a `subagent` field are validated against
  // the registry: the name must exist, and the optional `payload` must match
  // the registered subagent's payloadSchema (or be absent if no schema).
  subagents?: SubagentRegistry
}

export function parseCronFile(raw: unknown, options: ParseCronOptions = {}): ParseCronResult {
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

    if (job.scheduledByRole === undefined) {
      return {
        ok: false,
        reason: `job ${job.id}: missing 'scheduledByRole'. Add "scheduledByRole": "owner" if you authored this entry manually.`,
      }
    }

    if (job.kind === 'prompt' && job.subagent !== undefined && options.subagents !== undefined) {
      const subagent = options.subagents[job.subagent]
      if (!subagent) {
        return { ok: false, reason: `job ${job.id}: unknown subagent "${job.subagent}"` }
      }
      try {
        validateSubagentPayload(job.subagent, subagent, job.payload)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, reason: `job ${job.id}: ${message}` }
      }
    }
  }

  return { ok: true, file }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
