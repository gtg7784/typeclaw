import { defineCommand } from 'citty'

import { requireContainerRunning } from '@/container'
import { fetchCronList, type CronListBridgeResult } from '@/cron/bridge'
import { findAgentDir } from '@/init'
import type { CronListEntryPayload } from '@/shared'

import { c, errorLine } from './ui'

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'list all cron jobs (user-authored + plugin-contributed) registered in the running agent',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'emit the cron list as JSON',
      default: false,
    },
    url: {
      type: 'string',
      description:
        "agent websocket url (defaults to ws://127.0.0.1:<host port> discovered from the running container's published port)",
    },
    timeout: {
      type: 'string',
      description: 'milliseconds to wait for the agent to respond',
      default: '15000',
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const timeoutMs = Number(args.timeout)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.error(errorLine(`invalid --timeout value: ${args.timeout}`))
      process.exit(1)
    }

    let url: string | undefined = args.url
    if (url === undefined) {
      const precheck = await requireContainerRunning({ cwd })
      if (!precheck.ok) {
        console.error(errorLine(precheck.reason))
        process.exit(1)
      }
    }

    const result = await fetchCronList({ cwd, timeoutMs, ...(url !== undefined ? { url } : {}) })

    if (args.json) {
      process.stdout.write(`${JSON.stringify(toJsonShape(result), null, 2)}\n`)
      process.exit(result.kind === 'ok' ? 0 : 1)
    }

    if (result.kind !== 'ok') {
      console.error(errorLine(describeFailure(result)))
      process.exit(1)
    }

    process.stdout.write(`${formatList(result.jobs, result.nowMs)}\n`)
  },
})

export const cronCommand = defineCommand({
  meta: {
    name: 'cron',
    description: 'inspect cron jobs registered in the running agent (user-authored + plugin-contributed)',
  },
  subCommands: {
    list: listSub,
  },
})

export function describeFailure(
  result: Extract<CronListBridgeResult, { kind: Exclude<CronListBridgeResult['kind'], 'ok'> }>,
): string {
  switch (result.kind) {
    case 'unreachable':
      return `cannot reach the agent: ${result.reason}`
    case 'timeout':
      return 'timed out waiting for the agent to respond'
    case 'error':
      return result.reason
  }
}

function toJsonShape(result: CronListBridgeResult): unknown {
  if (result.kind === 'ok') {
    return { ok: true, nowMs: result.nowMs, jobs: result.jobs }
  }
  return { ok: false, reason: describeFailure(result) }
}

export function formatList(jobs: readonly CronListEntryPayload[], nowMs: number): string {
  if (jobs.length === 0) {
    return c.dim('No cron jobs registered.')
  }

  const lines: string[] = []
  lines.push(c.bold(`${jobs.length} cron job(s):`))
  lines.push('')
  for (const job of jobs) {
    lines.push(formatEntry(job, nowMs))
    lines.push('')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function formatEntry(job: CronListEntryPayload, nowMs: number): string {
  const lines: string[] = []
  const sourceLabel =
    job.source.kind === 'user' ? c.cyan('user') : c.magenta(`plugin:${job.source.pluginName}.${job.source.localId}`)
  const enabledBadge = job.enabled ? '' : ` ${c.yellow('(disabled)')}`
  const kindBadge = c.dim(`[${job.kind}]`)
  lines.push(`${c.bold(displayId(job))} ${kindBadge} ${sourceLabel}${enabledBadge}`)

  const tz = job.timezone !== undefined ? ` ${c.dim(`(${job.timezone})`)}` : ''
  lines.push(`  ${c.dim('schedule')} ${job.schedule}${tz}`)

  if (job.nextFireMs === null) {
    const why = job.scheduleError !== undefined ? `: ${job.scheduleError}` : ''
    lines.push(`  ${c.dim('next    ')} ${c.red('invalid schedule')}${why}`)
  } else {
    lines.push(`  ${c.dim('next    ')} ${formatNextFire(job.nextFireMs, nowMs)}`)
  }

  if (job.scheduledByRole !== undefined) {
    lines.push(`  ${c.dim('role    ')} ${job.scheduledByRole}`)
  }

  if (job.kind === 'prompt') {
    if (job.subagent !== undefined) {
      lines.push(`  ${c.dim('subagent')} ${job.subagent}`)
    }
    if (job.prompt !== undefined && job.subagent === undefined) {
      lines.push(`  ${c.dim('prompt  ')} ${truncate(job.prompt, 80)}`)
    }
  } else if (job.command !== undefined) {
    lines.push(`  ${c.dim('command ')} ${job.command.join(' ')}`)
  }

  return lines.join('\n')
}

function displayId(job: CronListEntryPayload): string {
  if (job.source.kind === 'plugin') {
    return `${job.source.pluginName}.${job.source.localId}`
  }
  return job.id
}

export function formatNextFire(nextFireMs: number, nowMs: number): string {
  const iso = new Date(nextFireMs).toISOString()
  const diffMs = nextFireMs - nowMs
  return `${iso} ${c.dim(`(${formatDuration(diffMs)})`)}`
}

export function formatDuration(diffMs: number): string {
  if (diffMs <= 0) return 'now'
  const seconds = Math.round(diffMs / 1000)
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${hours}h`
  const days = Math.round(hours / 24)
  return `in ${days}d`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}
