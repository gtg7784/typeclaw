import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SubagentRegistry } from '@/agent/subagents'
import { validateSubagentPayload } from '@/agent/subagents'
import type { CronHandlerContext } from '@/plugin/types'

const idPattern = /^[a-zA-Z0-9_-]+$/

const baseJob = z.object({
  id: z.string().min(1).regex(idPattern, 'id must contain only letters, digits, hyphens, or underscores'),
  // `schedule` (recurring cron expression) and `at` (one-shot ISO instant) are
  // mutually exclusive: exactly one must be present. Zod marks both optional so
  // the discriminated union still parses; the XOR is enforced in parseCronFile
  // where we can emit a job-id-scoped error message.
  schedule: z.string().min(1).optional(),
  at: z.string().min(1).optional(),
  // End boundaries. `until` is an absolute ISO instant (last allowed fire,
  // inclusive); `count` stops after N accepted fires. Both may coexist on one
  // job — the scheduler stops at whichever limit is reached first. `count`
  // progress is tracked out-of-band in cron-state.json, never written back here.
  until: z.string().min(1).optional(),
  count: z.number().int().positive().optional(),
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

export type ParsedCronJob = z.infer<typeof cronJobSchema>
export type PromptJob = Extract<ParsedCronJob, { kind: 'prompt' }>
export type ExecJob = Extract<ParsedCronJob, { kind: 'exec' }>

export type HandlerJob = z.infer<typeof baseJob> & {
  kind: 'handler'
  handler: (ctx: CronHandlerContext) => Promise<void>
}

export type CronJob = ParsedCronJob | HandlerJob
export type CronFile = z.infer<typeof cronFileSchema>

export type ParseCronResult = { ok: true; file: CronFile } | { ok: false; reason: string }

export type ParseCronOptions = {
  // When provided, prompt jobs with a `subagent` field are validated against
  // the registry: the name must exist, and the optional `payload` must match
  // the registered subagent's payloadSchema (or be absent if no schema).
  subagents?: SubagentRegistry
  // Injected by tests so past/future boundary checks on `at`/`until` are
  // deterministic. Production omits it and validation reads the wall clock.
  now?: number
}

export type ParseCronJsonOptions = ParseCronOptions

export function parseCronJson(raw: string, options: ParseCronJsonOptions = {}): ParseCronResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { ok: false, reason: `cron.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }

  return parseCronFile(json, options.subagents !== undefined ? { subagents: options.subagents } : {})
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

    const timingError = validateTiming(job, options.now ?? Date.now())
    if (timingError !== null) {
      return { ok: false, reason: `job ${job.id}: ${timingError}` }
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

type TimingJob = {
  schedule?: string | undefined
  at?: string | undefined
  until?: string | undefined
  count?: number | undefined
  timezone?: string | undefined
  enabled: boolean
}

function validateTiming(job: TimingJob, now: number = Date.now()): string | null {
  const hasSchedule = job.schedule !== undefined
  const hasAt = job.at !== undefined
  if (hasSchedule === hasAt) {
    return `must set exactly one of "schedule" (recurring) or "at" (one-shot)`
  }

  if (hasAt) {
    if (job.timezone !== undefined) return `"timezone" is only valid with "schedule", not "at"`
    if (job.until !== undefined) return `"until" is only valid with "schedule", not "at"`
    if (job.count !== undefined && job.count !== 1) return `one-shot "at" jobs may only set "count": 1`
    const at = parseInstant(job.at!)
    if (at === null) return `invalid "at": "${job.at}" is not an ISO datetime with an explicit zone/offset`
    if (job.enabled && at <= now) return `"at" is in the past: "${job.at}"`
    return null
  }

  let until: number | null = null
  if (job.until !== undefined) {
    until = parseInstant(job.until)
    if (until === null) return `invalid "until": "${job.until}" is not an ISO datetime with an explicit zone/offset`
    if (job.enabled && until <= now) return `"until" is in the past: "${job.until}"`
  }

  let firstFire: number
  try {
    const expr = CronExpressionParser.parse(job.schedule!, {
      currentDate: new Date(now),
      ...(job.timezone ? { tz: job.timezone } : {}),
    })
    firstFire = expr.next().getTime()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (job.timezone && /invalid|unhandled timestamp|unrecognized/i.test(message)) {
      return `invalid timezone "${job.timezone}": ${message}`
    }
    return `invalid schedule "${job.schedule}": ${message}`
  }

  if (job.enabled && until !== null && firstFire > until) {
    return `schedule has no occurrence at or before "until" ("${job.until}")`
  }

  return null
}

// Accepts only absolute instants: an explicit `Z` or numeric offset is
// required so "remind me at 9am" can never silently resolve to the host's
// local zone. A bare `2026-06-09T09:00:00` (no zone) is rejected.
function parseInstant(value: string): number | null {
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
