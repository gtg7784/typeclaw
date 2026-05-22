import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { parseCronJson, type ParsedCronJob } from '@/cron'

import type { SecuritySeverity } from '../permissions'
import { ACKNOWLEDGE_GUARDS, type SecurityBlock, isGuardAcknowledged } from '../policy'

export const GUARD_CRON_PROMOTION = 'cronPromotion'
// Classified `high` (audience-leak axis, adapted — same reasoning as
// `rolePromotion`).
//
// Cron is the deferred-execution sibling of `roles`. Every cron job
// carries a `scheduledByRole` field that the runtime stamps into the
// firing session's origin; the permission service then trusts that
// stamp (subject to "named role must exist in the resolved role
// table"). The `parseCronFile` boot gate rejects entries without
// `scheduledByRole`, but it accepts any role name the file declares.
//
// Concrete breach pattern: a `member`-role agent that can `write`
// `cron.json` authors a brand-new job with `"scheduledByRole": "owner"`
// and a prompt that does whatever the agent's tool surface allows when
// running as owner. The cron consumer fires it on schedule; the firing
// session resolves to `owner` because that role name exists in the role
// table. The agent has laundered itself into owner via the schedule.
//
// Same two-step shape as `gitRemoteTainted`: "do a privileged write
// now, run the privileged thing later." This guard blocks the first
// step.
//
// What counts as a cron promotion (any of):
//   1. A new job (by id) was added. The job's `scheduledByRole` is the
//      privilege grant being introduced; the audit point is the
//      addition itself, regardless of the role value.
//   2. An existing job's `scheduledByRole` changed to a different value.
//   3. An existing job's EXECUTABLE BODY changed — `kind`, `prompt`,
//      `command`, `subagent`, or `payload`. Rewriting only the body of
//      an existing privileged job (leaving `scheduledByRole` untouched)
//      is the same deferred-laundering attack as job creation: the
//      cron consumer fires the new body as the stamped role, and the
//      attacker has co-opted the role without changing it. Oracle
//      review (PR #305) called this out as a critical bypass of the
//      first design. The fields chosen are exactly those the cron
//      consumer reads when it fires; metadata-only edits do not
//      reach this list.
//   4. An existing job had `enabled: false` flipped to true (or
//      unset, which schema-defaults to true). A previously-disabled
//      privileged job becoming live is a privilege grant in the
//      same sense as adding the job fresh.
//
// What does NOT count (allowed without ack):
//   - Removing a job entirely.
//   - Changing `schedule` or `timezone` on an existing job (cadence
//     decisions; do not change what runs, only when).
//   - Setting `enabled: true -> false` (disabling a privileged job is
//     a privilege REDUCTION; allowed).
//   - Any change to a job that has no `scheduledByRole` at all (the
//     schema rejects such jobs at managedConfig before we run, so
//     this branch is unreachable in practice; the guard treats it as
//     a non-finding for forward compatibility).
//
// Failure-open is deliberate, same direction as `rolePromotion`: if
// the existing `cron.json` cannot be read or parsed, every proposed job
// is treated as new and flagged. The only false positive is "operator
// authored a fresh `cron.json` with privileged jobs," which they
// acknowledge in the same call.
export const GUARD_CRON_PROMOTION_SEVERITY: SecuritySeverity = 'high'

export type CronPromotionFinding =
  | { kind: 'job-added'; id: string; scheduledByRole: string }
  | { kind: 'role-changed'; id: string; from: string; to: string }
  | { kind: 'body-changed'; id: string; scheduledByRole: string; fields: readonly string[] }
  | { kind: 'enabled-flipped'; id: string; scheduledByRole: string }

export async function checkCronPromotionGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<SecurityBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = path.resolve(agentDir, rawPath)
  const isCronJson = await pathIsCronJson(agentDir, targetPath)
  if (!isCronJson) return undefined

  if (isGuardAcknowledged(args, GUARD_CRON_PROMOTION)) return undefined

  const editRefusal = refuseRiskyEdit(tool, args, targetPath)
  if (editRefusal) return editRefusal

  const newContent = await intendedContent(tool, args, targetPath)
  if (newContent === undefined) return undefined

  const newJobs = parseJobsFromContent(newContent)
  if (newJobs === undefined) return undefined

  const oldJobs = await readExistingJobs(targetPath)
  const findings = diffJobs(oldJobs, newJobs)
  if (findings.length === 0) return undefined

  return {
    block: true,
    reason: buildBlockReason(tool, targetPath, findings),
  }
}

// See the parallel `identifiesManagedFile` rationale block in
// role-promotion.ts — Oracle PR #305 findings #5 and #6 (symlinked
// managed file + case-insensitive FS).
async function pathIsCronJson(agentDir: string, targetPath: string): Promise<boolean> {
  const resolvedAgentDir = path.resolve(agentDir)
  const canonicalManagedPath = path.join(resolvedAgentDir, 'cron.json')
  const resolvedTarget = path.resolve(targetPath)
  if (canonicalManagedPath === resolvedTarget) return true
  const realCanonical = await resolveRealPath(canonicalManagedPath)
  const realTarget = await resolveRealPath(resolvedTarget)
  return realCanonical === realTarget
}

// Symmetric with role-promotion's refuseRiskyEdit. See Oracle PR #305
// finding #4: simulator-vs-real divergence on multi-edit, plus
// non-unique-oldText ambiguity. Conservative refusal keeps the guard
// honest without re-implementing pi-coding-agent/edit-diff.js inside
// the security plugin.
function refuseRiskyEdit(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
): SecurityBlock | undefined {
  if (tool !== 'edit') return undefined
  const edits = args.edits
  if (!Array.isArray(edits)) return undefined
  if (edits.length > 1) {
    return {
      block: true,
      reason: [
        `Guard \`${GUARD_CRON_PROMOTION}\` refuses multi-edit on ${targetPath}: the security guard's edit simulator cannot match the pi-coding-agent edit tool's original-content semantics for multi-edit calls.`,
        'Use `write` with the full file content instead — this is the canonical workflow for managed config files (see the `typeclaw-cron` skill).',
      ].join(' '),
    }
  }
  return undefined
}

async function intendedContent(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
): Promise<string | undefined> {
  if (tool === 'write') {
    return typeof args.content === 'string' ? args.content : undefined
  }
  const edits = args.edits
  if (!Array.isArray(edits)) return undefined
  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch {
    return undefined
  }
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return undefined
    const { oldText, newText } = edit as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
    if (oldText.length === 0) return undefined
    const firstIdx = content.indexOf(oldText)
    if (firstIdx === -1) return undefined
    if (content.indexOf(oldText, firstIdx + 1) !== -1) return undefined
    content = content.slice(0, firstIdx) + newText + content.slice(firstIdx + oldText.length)
  }
  return content
}

function parseJobsFromContent(content: string): readonly ParsedCronJob[] | undefined {
  const result = parseCronJson(content, { migrate: false })
  if (!result.ok) return undefined
  return result.file.jobs
}

async function readExistingJobs(targetPath: string): Promise<readonly ParsedCronJob[]> {
  let raw: string
  try {
    raw = await readFile(targetPath, 'utf8')
  } catch {
    return []
  }
  const result = parseCronJson(raw, { migrate: true })
  if (!result.ok) return []
  return result.file.jobs
}

export function diffJobs(before: readonly ParsedCronJob[], after: readonly ParsedCronJob[]): CronPromotionFinding[] {
  const findings: CronPromotionFinding[] = []
  const beforeById = new Map<string, ParsedCronJob>()
  for (const job of before) beforeById.set(job.id, job)

  for (const job of after) {
    const prior = beforeById.get(job.id)
    const newRole = job.scheduledByRole
    if (prior === undefined) {
      findings.push({
        kind: 'job-added',
        id: job.id,
        scheduledByRole: newRole ?? '<unset>',
      })
      continue
    }
    const oldRole = prior.scheduledByRole
    if (oldRole !== newRole) {
      findings.push({
        kind: 'role-changed',
        id: job.id,
        from: oldRole ?? '<unset>',
        to: newRole ?? '<unset>',
      })
    }
    const bodyDelta = diffJobBody(prior, job)
    if (bodyDelta.length > 0) {
      findings.push({
        kind: 'body-changed',
        id: job.id,
        scheduledByRole: newRole ?? '<unset>',
        fields: bodyDelta,
      })
    }
    if (isPreviouslyDisabled(prior) && !isPreviouslyDisabled(job)) {
      findings.push({
        kind: 'enabled-flipped',
        id: job.id,
        scheduledByRole: newRole ?? '<unset>',
      })
    }
  }
  return findings
}

// `enabled` defaults to true at the schema layer (parseCronJson fills
// it in). After parse, the field is always boolean-typed. "Previously
// disabled" means literally `false`; everything else is live.
function isPreviouslyDisabled(job: ParsedCronJob): boolean {
  return job.enabled === false
}

// Executable-body field set. Anything the cron consumer reads when it
// fires a job belongs here; metadata/cadence fields (schedule, timezone,
// id, enabled) are out of scope for body-mutation detection because
// they are handled separately (role-changed, enabled-flipped) or are
// not privilege grants at all (schedule, timezone).
function diffJobBody(before: ParsedCronJob, after: ParsedCronJob): string[] {
  const changed: string[] = []
  if (before.kind !== after.kind) {
    changed.push('kind')
    return changed
  }
  if (before.kind === 'prompt' && after.kind === 'prompt') {
    if (before.prompt !== after.prompt) changed.push('prompt')
    if (before.subagent !== after.subagent) changed.push('subagent')
    if (!stableEqual(before.payload, after.payload)) changed.push('payload')
  } else if (before.kind === 'exec' && after.kind === 'exec') {
    if (!arrayEqual(before.command, after.command)) changed.push('command')
  }
  return changed
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// JSON-stable equality for the opaque `payload` field. We use canonical
// JSON serialization (sorted keys via the comparator below) so a write
// that only reorders payload object keys does not flag.
function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
      return sorted
    }
    return v
  })
}

function buildBlockReason(tool: string, targetPath: string, findings: readonly CronPromotionFinding[]): string {
  const lines: string[] = []
  for (const f of findings) {
    const id = sanitizeForReason(f.id)
    if (f.kind === 'job-added') {
      lines.push(`new job \`${id}\` would run as role \`${sanitizeForReason(f.scheduledByRole)}\``)
    } else if (f.kind === 'body-changed') {
      const fieldList = f.fields.map(sanitizeForReason).join(', ')
      lines.push(
        `job \`${id}\` (running as \`${sanitizeForReason(f.scheduledByRole)}\`) executable body changed: ${fieldList}`,
      )
    } else if (f.kind === 'enabled-flipped') {
      lines.push(`job \`${id}\` re-enabled (would now fire as role \`${sanitizeForReason(f.scheduledByRole)}\`)`)
    } else {
      lines.push(
        `job \`${id}\` changes scheduledByRole \`${sanitizeForReason(f.from)}\` -> \`${sanitizeForReason(f.to)}\``,
      )
    }
  }
  return [
    `Guard \`${GUARD_CRON_PROMOTION}\` blocked ${tool} on ${sanitizeForReason(targetPath)}: this change introduces a deferred privilege grant — ${lines.join('; ')}.`,
    'Cron jobs carry `scheduledByRole`, which the runtime stamps into the firing session\'s origin. Adding a job (or changing its scheduledByRole) is the same shape as the `rolePromotion` attack but deferred: "schedule a privileged prompt now, the cron consumer runs it as that role later." Even an `owner` operating from TUI must not silently author cron jobs that fire as elevated roles on behalf of a channel message.',
    `If this is genuinely intentional and the operator explicitly asked for it (not a channel message), retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_CRON_PROMOTION}: true\` in the tool arguments.`,
  ].join(' ')
}

const MAX_REASON_TOKEN_LEN = 200

function sanitizeForReason(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/`/g, "'")
  if (cleaned.length <= MAX_REASON_TOKEN_LEN) return cleaned
  return `${cleaned.slice(0, MAX_REASON_TOKEN_LEN)}...`
}

async function resolveRealPath(absolutePath: string): Promise<string> {
  const pending: string[] = []
  let current = absolutePath
  while (true) {
    try {
      const real = await realpath(current)
      return path.join(real, ...pending.reverse())
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    const parent = path.dirname(current)
    if (parent === current) return absolutePath
    pending.push(path.basename(current))
    current = parent
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'ENOENT'
}
