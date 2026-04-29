import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import { definePlugin } from '@/plugin'

import { dreamingSubagent, type DreamingPayload } from './dreaming'
import { loadMemory } from './load-memory'
import { memoryLoggerSubagent, type MemoryLoggerPayload } from './memory-logger'

const DEFAULT_IDLE_MS = 30_000
const DEFAULT_DREAMING_SCHEDULE = '0 4 * * *'

function isValidCronExpression(schedule: string): boolean {
  try {
    CronExpressionParser.parse(schedule).next()
    return true
  } catch {
    return false
  }
}

const dreamingConfigSchema = z.object({
  schedule: z
    .string()
    .min(1)
    .default(DEFAULT_DREAMING_SCHEDULE)
    .refine(isValidCronExpression, { message: 'memory.dreaming.schedule must be a valid cron expression' }),
})

const memoryConfigSchema = z
  .object({
    idleMs: z.number().int().min(1000).default(DEFAULT_IDLE_MS),
    dreaming: dreamingConfigSchema.optional(),
  })
  .default({ idleMs: DEFAULT_IDLE_MS })

export default definePlugin({
  configSchema: memoryConfigSchema,
  plugin: async (ctx) => {
    const idleMs = ctx.config.idleMs
    const dreamingSchedule = ctx.config.dreaming?.schedule

    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const lastIdleEvent = new Map<string, { parentTranscriptPath: string | undefined }>()

    const fireMemoryLogger = async (sessionId: string): Promise<void> => {
      const last = lastIdleEvent.get(sessionId)
      if (!last || last.parentTranscriptPath === undefined) return
      const payload: MemoryLoggerPayload = {
        parentSessionId: sessionId,
        parentTranscriptPath: last.parentTranscriptPath,
        agentDir: ctx.agentDir,
      }
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

    return {
      subagents: {
        'memory-logger': memoryLoggerSubagent,
        dreaming: dreamingSubagent,
      },
      ...(dreamingSchedule !== undefined
        ? {
            cronJobs: {
              dreaming: {
                schedule: dreamingSchedule,
                kind: 'prompt' as const,
                prompt: '(internal: dreaming consolidation; user prompt is built by the dreaming subagent handler)',
                subagent: 'dreaming',
                payload: { agentDir: ctx.agentDir } satisfies DreamingPayload,
              },
            },
          }
        : {}),
      hooks: {
        'session.prompt': async (event) => {
          const memorySection = await loadMemory(ctx.agentDir)
          event.prompt = `${event.prompt}\n\n${memorySection}`
        },
        // Core fires `session.idle` immediately after every prompt completion;
        // the plugin owns the debounce timer so memory-logger only spawns
        // after the user has been quiet for `idleMs`. Re-arming a still-armed
        // timer cancels it first, matching the previous core IdleDetector.
        'session.idle': (event) => {
          lastIdleEvent.set(event.sessionId, { parentTranscriptPath: event.parentTranscriptPath })
          cancelTimer(event.sessionId)
          const sessionId = event.sessionId
          const timer = setTimeout(() => {
            idleTimers.delete(sessionId)
            void fireMemoryLogger(sessionId)
          }, idleMs)
          idleTimers.set(sessionId, timer)
        },
        'session.end': async (event) => {
          cancelTimer(event.sessionId)
          await fireMemoryLogger(event.sessionId)
          lastIdleEvent.delete(event.sessionId)
        },
      },
    }
  },
})
