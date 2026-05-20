import type { AgentSession } from '@/agent'
import { promptWithFallback, resolveFallbackChain } from '@/agent/model-fallback'
import type { SessionOrigin } from '@/agent/session-origin'
import { getConfig } from '@/config'
import type { KnownModelRef } from '@/config/providers'
import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import type { CronJob, ExecJob, HandlerJob, PromptJob } from './schema'

export type CronHandlerInvoker = (job: HandlerJob) => Promise<void>

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
  // Underlying agent session, exposed so the consumer can subscribe to
  // `message_end` events and surface soft provider errors (billing, rate
  // limit, network — pi-coding-agent encodes these in the assistant message
  // instead of throwing, so the outer try/catch never sees them). Optional
  // so existing test fakes that only need `prompt` keep working.
  session?: AgentSession
}

export type CronConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateCronConsumerOptions = {
  stream: Stream
  cwd: string
  // The optional `refOverride` argument is consumed by the fallback loop: the
  // consumer calls this factory once per ref in the profile's chain, pinning
  // each attempt to the specified model. Factories that don't honor the
  // override silently lose fallback semantics, so production wiring threads
  // it through to `createSession({ refOverride })`.
  createSessionForCron: (job: PromptJob, refOverride?: KnownModelRef) => Promise<CronSession>
  // Builds the `CronHandlerContext` for the job and awaits its `handler`.
  // Wired by `src/run/index.ts` to reuse `runPromptForCommand` /
  // `runExecForCommand` from the command runner so plugin cron handlers and
  // container plugin commands share one implementation of `ctx.prompt` /
  // `ctx.exec`. Optional so unit-test fakes that never schedule handler jobs
  // stay one-liners.
  invokeHandler?: CronHandlerInvoker
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
  invokeHandler,
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
            await runPrompt(job, createSessionForCron, stream, logger)
          } else if (job.kind === 'exec') {
            await runExec(job, cwd)
          } else {
            if (invokeHandler === undefined) {
              throw new Error(
                `handler job dispatched but no invokeHandler wired into the consumer (likely a misconfigured test or boot path)`,
              )
            }
            await invokeHandler(job)
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
  createSessionForCron: (job: PromptJob, refOverride?: KnownModelRef) => Promise<CronSession>,
  stream: Stream,
  logger: CronConsumerLogger,
): Promise<void> {
  if (job.subagent !== undefined) {
    // Propagate the cron job's role and origin into the spawned subagent.
    // Without this, every cron-triggered subagent (e.g. memory dreaming)
    // resolves to `guest` because the new-session consumer reads provenance
    // off the stream target rather than rebuilding it. Encode the parent
    // origin as JSON since StreamTarget is a flat-string shape.
    const parentOrigin: SessionOrigin = {
      kind: 'cron',
      jobId: job.id,
      jobKind: 'prompt',
      ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
    }
    stream.publish({
      target: {
        kind: 'new-session',
        subagent: job.subagent,
        ...(job.scheduledByRole !== undefined ? { spawnedByRole: job.scheduledByRole } : {}),
        spawnedByOriginJson: JSON.stringify(parentOrigin),
      },
      payload: job.payload,
    })
    return
  }
  // Resolve the model fallback chain for the cron profile (cron jobs run
  // under the `default` profile today). Single-ref configs produce a length-1
  // chain; multi-ref configs (e.g. `"default": ["openai/...", "fireworks/..."]`)
  // drive the retry-on-failure loop inside `runPromptOnce`.
  const refs = resolveFallbackChain(getConfig().models, undefined)
  await runPromptOnce(job, refs, createSessionForCron, logger)
}

async function runPromptOnce(
  job: PromptJob,
  refs: KnownModelRef[],
  createSessionForCron: (job: PromptJob, refOverride?: KnownModelRef) => Promise<CronSession>,
  logger: CronConsumerLogger,
): Promise<void> {
  // The fallback helper manages session creation, the prompt attempt, soft-
  // error detection, and disposal between attempts. Each `createSessionForRef`
  // call pins the new session to a specific ref via `refOverride`; on failure
  // the helper disposes and advances. The hooks (turn.start, turn.end,
  // session.idle, session.end) all fire against the session that ultimately
  // handled the turn — soft-failed sessions get only disposal, since they
  // never produced a usable turn.
  let cronSession: CronSession | null = null
  const result = await promptWithFallback({
    refs,
    text: job.prompt,
    createSessionForRef: async (ref) => {
      const created = await createSessionForCron(job, ref)
      cronSession = created
      const turnEvent =
        created.hooks && created.sessionId !== undefined && created.agentDir !== undefined
          ? {
              sessionId: created.sessionId,
              agentDir: created.agentDir,
              ...(created.origin !== undefined ? { origin: created.origin } : {}),
            }
          : undefined
      if (created.hooks && turnEvent !== undefined) {
        await created.hooks.runSessionTurnStart(turnEvent)
      }
      // Bridge the CronSession wrapper into the AgentSession surface the
      // fallback helper expects:
      //   prompt   → CronSession.prompt (wrapper that calls AgentSession.prompt
      //              in production, or a hand-rolled test fake)
      //   subscribe → CronSession.session.subscribe when an underlying agent
      //              session is supplied, else a no-op (soft-error detection
      //              degrades to "off" in that mode; only hard throws drive
      //              fallback)
      // Going through the wrapper for `prompt` preserves any pre/post hooks
      // a future CronSession may layer around the call.
      const sessionForHelper: AgentSession = {
        prompt: (text: string) => created.prompt(text),
        subscribe: created.session?.subscribe.bind(created.session) ?? (() => () => {}),
      } as unknown as AgentSession
      return {
        session: sessionForHelper,
        dispose: async () => {
          if (created.hooks && turnEvent !== undefined) {
            try {
              await created.hooks.runSessionTurnEnd(turnEvent)
            } catch (e) {
              logger.warn(`[cron] ${job.id}: turn-end hook threw: ${describe(e)}`)
            }
          }
          created.dispose?.()
        },
      }
    },
    onAttemptFailed: (attempt) => {
      logger.warn(
        `[cron] ${job.id}: ${attempt.outcome} failure on ${attempt.ref}: ${attempt.errorMessage ?? 'unknown'}; falling back`,
      )
    },
  })

  if (!result.success) {
    logger.error(
      `[cron] ${job.id}: all ${result.attempts.length} model(s) failed; last error: ${result.lastError?.message ?? 'unknown'}`,
    )
  }

  // Lifecycle hooks fire against the last session created. `session.idle`
  // only fires on success (matching the pre-fallback behavior where the
  // idle hook was nested inside the try-block around `prompt()`); `session.end`
  // always fires so plugins can react to abnormal termination.
  if (cronSession !== null) {
    const finalSession: CronSession = cronSession
    if (result.success && finalSession.hooks && finalSession.sessionId !== undefined) {
      await finalSession.hooks.runSessionIdle({
        sessionId: finalSession.sessionId,
        parentTranscriptPath: finalSession.getTranscriptPath?.(),
        idleMs: 0,
        ...(finalSession.origin !== undefined ? { origin: finalSession.origin } : {}),
      })
    }
    if (finalSession.hooks && finalSession.sessionId !== undefined) {
      await finalSession.hooks.runSessionEnd({
        sessionId: finalSession.sessionId,
        ...(finalSession.origin !== undefined ? { origin: finalSession.origin } : {}),
      })
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runExec(job: ExecJob, cwd: string): Promise<void> {
  const [cmd, ...args] = job.command
  if (!cmd) throw new Error(`exec job ${job.id}: empty command`)
  // Inject TYPECLAW_PARENT_ORIGIN_JSON so a child that proxies into the
  // agent (typically a `typeclaw <container-cmd>` invocation through the
  // host CLI's container-command-client) can stamp its session's
  // spawnedByOrigin with the cron job's provenance. Without this the
  // proxy would default to a synthetic owner origin and silently elevate
  // a guest- or member-scheduled cron job to owner.
  const parentOrigin = {
    kind: 'cron',
    jobId: job.id,
    jobKind: 'exec',
    ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
    ...(job.scheduledByOrigin !== undefined ? { scheduledByOrigin: job.scheduledByOrigin } : {}),
  }
  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      TYPECLAW_PARENT_ORIGIN_JSON: JSON.stringify(parentOrigin),
    },
  })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`exec job ${job.id} exited with code ${code}: ${stderr.trim() || 'no stderr'}`)
  }
}

function isCronJob(value: unknown): value is CronJob {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { id?: unknown; kind?: unknown; handler?: unknown }
  if (typeof v.id !== 'string') return false
  if (v.kind === 'prompt' || v.kind === 'exec') return true
  return v.kind === 'handler' && typeof v.handler === 'function'
}
