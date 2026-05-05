import { stat } from 'node:fs/promises'

import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { definePlugin } from '@/plugin'

import { createDreamingSubagent, type DreamingPayload } from './dreaming'
import { loadMemory } from './load-memory'
import { createMemoryLoggerSubagent, type MemoryLoggerPayload } from './memory-logger'

const DEFAULT_IDLE_MS = 10_000
const DEFAULT_BUFFER_BYTES = 100_000
const MIN_BUFFER_BYTES = 10_000
const DEFAULT_DREAMING_SCHEDULE = '0 4 * * *'

function isValidCronExpression(schedule: string): boolean {
  try {
    CronExpressionParser.parse(schedule).next()
    return true
  } catch {
    return false
  }
}

function hasFiveCronFields(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5
}

const dreamingConfigSchema = z.object({
  schedule: z
    .string()
    .min(1)
    .refine(hasFiveCronFields, { message: 'memory.dreaming.schedule must be a five-field cron expression' })
    .refine(isValidCronExpression, { message: 'memory.dreaming.schedule must be a valid cron expression' })
    .optional(),
})

// `bufferBytes` is a size-based ceiling on top of the `idleMs` debounce. In
// busy channel sessions the agent rarely goes idle long enough to trip the
// timer, so memory-logger needs a second trigger that responds to accumulated
// transcript volume. `0` disables the size trigger (idle-only legacy
// behavior); any non-zero value must be >= 10_000 to avoid thrashing the
// subagent on tiny conversations.
const memoryConfigSchema = z
  .object({
    idleMs: z.number().int().min(1000).default(DEFAULT_IDLE_MS),
    bufferBytes: z
      .number()
      .int()
      .min(0)
      .refine((n) => n === 0 || n >= MIN_BUFFER_BYTES, {
        message: `memory.bufferBytes must be 0 (disabled) or >= ${MIN_BUFFER_BYTES}`,
      })
      .default(DEFAULT_BUFFER_BYTES),
    dreaming: dreamingConfigSchema.optional(),
  })
  .default({ idleMs: DEFAULT_IDLE_MS, bufferBytes: DEFAULT_BUFFER_BYTES })

export default definePlugin({
  configSchema: memoryConfigSchema,
  plugin: async (ctx) => {
    const idleMs = ctx.config.idleMs
    const bufferBytes = ctx.config.bufferBytes
    const dreamingSchedule = ctx.config.dreaming?.schedule ?? DEFAULT_DREAMING_SCHEDULE

    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const lastIdleEvent = new Map<string, { parentTranscriptPath: string | undefined; origin?: SessionOrigin }>()
    const bytesAtLastRun = new Map<string, number>()

    const fireMemoryLogger = async (
      sessionId: string,
      reason: 'idle' | 'buffer-trip' | 'session-end',
    ): Promise<void> => {
      const last = lastIdleEvent.get(sessionId)
      if (!last || last.parentTranscriptPath === undefined) return
      const payload: MemoryLoggerPayload = {
        parentSessionId: sessionId,
        parentTranscriptPath: last.parentTranscriptPath,
        agentDir: ctx.agentDir,
        ...(last.origin !== undefined ? { origin: last.origin } : {}),
      }
      const currentSize = await readSize(last.parentTranscriptPath)
      bytesAtLastRun.set(sessionId, currentSize)
      ctx.logger.info(`memory-logger spawn ${sessionId} reason=${reason} transcript_bytes=${currentSize}`)
      try {
        await ctx.spawnSubagent('memory-logger', payload)
      } catch (err) {
        ctx.logger.error(`memory-logger spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const cancelTimer = (sessionId: string): void => {
      const t = idleTimers.get(sessionId)
      if (t !== undefined) {
        clearTimeout(t)
        idleTimers.delete(sessionId)
      }
    }

    const shouldTripBufferCeiling = async (sessionId: string, transcriptPath: string): Promise<boolean> => {
      if (bufferBytes === 0) return false
      const currentSize = await readSize(transcriptPath)
      const baseline = bytesAtLastRun.get(sessionId)
      if (baseline === undefined) {
        bytesAtLastRun.set(sessionId, currentSize)
        return false
      }
      return currentSize - baseline >= bufferBytes
    }

    // Subagents are constructed at boot here (rather than imported as constants)
    // so their lifecycle logs route through the plugin logger and pick up the
    // `[plugin:memory]` prefix. Without this, they would write directly to
    // console and bypass the plugin namespace.
    const subagentLogger = {
      info: (m: string) => ctx.logger.info(m),
      warn: (m: string) => ctx.logger.warn(m),
      error: (m: string) => ctx.logger.error(m),
    }

    return {
      subagents: {
        'memory-logger': createMemoryLoggerSubagent({ logger: subagentLogger }),
        dreaming: createDreamingSubagent({ logger: subagentLogger }),
      },
      cronJobs: {
        dreaming: {
          schedule: dreamingSchedule,
          kind: 'prompt' as const,
          prompt: '(internal: dreaming consolidation; user prompt is built by the dreaming subagent handler)',
          subagent: 'dreaming',
          payload: { agentDir: ctx.agentDir } satisfies DreamingPayload,
        },
      },
      hooks: {
        'session.prompt': async (event) => {
          const memorySection = await loadMemory(ctx.agentDir)
          event.prompt = `${event.prompt}\n\n${memorySection}`
        },
        // Core fires `session.idle` immediately after every prompt completion;
        // the plugin owns the debounce timer so memory-logger only spawns
        // after the user has been quiet for `idleMs`. Re-arming a still-armed
        // timer cancels it first, matching the previous core IdleDetector.
        // The size-based ceiling fires synchronously when the transcript has
        // grown by `bufferBytes` since the last run, so busy channel sessions
        // (which rarely go idle) still produce memory updates.
        'session.idle': async (event) => {
          lastIdleEvent.set(event.sessionId, {
            parentTranscriptPath: event.parentTranscriptPath,
            ...(event.origin !== undefined ? { origin: event.origin } : {}),
          })
          cancelTimer(event.sessionId)
          const sessionId = event.sessionId
          const timer = setTimeout(() => {
            idleTimers.delete(sessionId)
            void fireMemoryLogger(sessionId, 'idle')
          }, idleMs)
          idleTimers.set(sessionId, timer)
          if (
            event.parentTranscriptPath !== undefined &&
            (await shouldTripBufferCeiling(sessionId, event.parentTranscriptPath))
          ) {
            ctx.logger.info(`buffer-ceiling trip ${sessionId} bufferBytes=${bufferBytes}`)
            cancelTimer(sessionId)
            await fireMemoryLogger(sessionId, 'buffer-trip')
          }
        },
        'session.end': async (event) => {
          cancelTimer(event.sessionId)
          await fireMemoryLogger(event.sessionId, 'session-end')
          lastIdleEvent.delete(event.sessionId)
          bytesAtLastRun.delete(event.sessionId)
        },
      },
    }
  },
})

async function readSize(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.size
  } catch {
    return 0
  }
}
