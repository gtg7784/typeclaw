import type { SessionOrigin } from '@/agent/session-origin'
import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import type { CronJob, ExecJob, PromptJob } from './schema'

// `hooks`, `sessionId`, `agentDir`, and `getTranscriptPath` are optional so
// test fakes can stay one-liners. When present, the consumer fires
// `session.turn.start`/`session.turn.end` around `prompt()`, then
// `session.idle` after, then `session.end` on dispose — mirroring the
// lifecycle signals the TUI server emits in `src/server/index.ts`. Without
// this the bundled memory plugin's debounced `memory-logger` never spawns for
// cron prompt jobs (it only wakes on `session.idle`), and the bundled backup
// plugin's turn counter would miss cron-driven activity.
export type CronSession = {
  prompt: (text: string) => Promise<void>
  dispose?: () => void
  hooks?: HookBus
  sessionId?: string
  agentDir?: string
  getTranscriptPath?: () => string | undefined
  origin?: SessionOrigin
}

export type CronConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateCronConsumerOptions = {
  stream: Stream
  cwd: string
  createSessionForCron: (job: PromptJob) => Promise<CronSession>
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
            await runPrompt(job, createSessionForCron, stream)
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

async function runPrompt(
  job: PromptJob,
  createSessionForCron: (job: PromptJob) => Promise<CronSession>,
  stream: Stream,
): Promise<void> {
  if (job.subagent !== undefined) {
    stream.publish({
      target: { kind: 'new-session', subagent: job.subagent },
      payload: job.payload,
    })
    return
  }
  const session = await createSessionForCron(job)
  const turnEvent =
    session.hooks && session.sessionId !== undefined && session.agentDir !== undefined
      ? {
          sessionId: session.sessionId,
          agentDir: session.agentDir,
          ...(session.origin !== undefined ? { origin: session.origin } : {}),
        }
      : undefined
  try {
    if (session.hooks && turnEvent !== undefined) {
      await session.hooks.runSessionTurnStart(turnEvent)
    }
    try {
      await session.prompt(job.prompt)
    } finally {
      if (session.hooks && turnEvent !== undefined) {
        await session.hooks.runSessionTurnEnd(turnEvent)
      }
    }
    if (session.hooks && session.sessionId !== undefined) {
      await session.hooks.runSessionIdle({
        sessionId: session.sessionId,
        parentTranscriptPath: session.getTranscriptPath?.(),
        idleMs: 0,
      })
    }
  } finally {
    if (session.hooks && session.sessionId !== undefined) {
      await session.hooks.runSessionEnd({ sessionId: session.sessionId })
    }
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
