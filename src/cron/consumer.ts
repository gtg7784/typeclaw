import type { AgentSession } from '@/agent'
import { invokeSubagent, type Subagent, type SubagentRegistry } from '@/agent/subagents'
import type { Stream, Unsubscribe } from '@/stream'

import type { CronJob, ExecJob, PromptJob } from './schema'

export type CronSession = { prompt: (text: string) => Promise<void>; dispose?: () => void }

export type CronConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateCronConsumerOptions = {
  stream: Stream
  cwd: string
  createSessionForCron: (job: PromptJob) => Promise<CronSession>
  subagents?: SubagentRegistry
  createSessionForSubagent?: (subagent: Subagent<any>) => Promise<AgentSession>
  logger?: CronConsumerLogger
}

export type CronConsumer = {
  start: () => void
  stop: () => void
  inFlightCount: () => number
}

const consoleLogger: CronConsumerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createCronConsumer({
  stream,
  cwd,
  createSessionForCron,
  subagents = {},
  createSessionForSubagent,
  logger = consoleLogger,
}: CreateCronConsumerOptions): CronConsumer {
  const inFlight = new Set<string>()
  let unsubscribe: Unsubscribe | null = null

  return {
    start() {
      if (unsubscribe !== null) return
      unsubscribe = stream.subscribe({ target: { kind: 'cron' } }, async (msg) => {
        const job = msg.payload as CronJob
        if (!isCronJob(job)) {
          logger.warn(`[cron-consumer] received message ${msg.id} with invalid payload, ignoring`)
          return
        }
        if (inFlight.has(job.id)) {
          logger.warn(`[cron] ${job.id}: previous run still in progress, skipping`)
          return
        }
        inFlight.add(job.id)
        try {
          if (job.kind === 'prompt') {
            await runPrompt(job, { createSessionForCron, subagents, createSessionForSubagent, cwd })
          } else {
            await runExec(job, cwd)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[cron] ${job.id} failed: ${message}`)
        } finally {
          inFlight.delete(job.id)
        }
      })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
    inFlightCount() {
      return inFlight.size
    },
  }
}

type RunPromptDeps = {
  createSessionForCron: (job: PromptJob) => Promise<CronSession>
  subagents: SubagentRegistry
  createSessionForSubagent?: (subagent: Subagent<any>) => Promise<AgentSession>
  cwd: string
}

async function runPrompt(job: PromptJob, deps: RunPromptDeps): Promise<void> {
  if (job.subagent !== undefined) {
    if (deps.createSessionForSubagent === undefined) {
      throw new Error(`prompt job ${job.id}: subagent "${job.subagent}" requested but no subagent runtime is wired`)
    }
    await invokeSubagent(job.subagent, {
      registry: deps.subagents,
      createSessionForSubagent: deps.createSessionForSubagent,
      agentDir: deps.cwd,
      userPrompt: job.prompt,
      payload: job.payload,
    })
    return
  }
  const session = await deps.createSessionForCron(job)
  try {
    await session.prompt(job.prompt)
  } finally {
    session.dispose?.()
  }
}

async function runExec(job: ExecJob, cwd: string): Promise<void> {
  const [cmd, ...args] = job.command
  if (!cmd) throw new Error(`exec job ${job.id}: empty command`)
  const proc = Bun.spawn({ cmd: [cmd, ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`exec job ${job.id} exited with code ${code}: ${stderr.trim() || 'no stderr'}`)
  }
}

function isCronJob(value: unknown): value is CronJob {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { id?: unknown; kind?: unknown }
  if (typeof v.id !== 'string') return false
  return v.kind === 'prompt' || v.kind === 'exec'
}
