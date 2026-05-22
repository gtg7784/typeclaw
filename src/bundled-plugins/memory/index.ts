import { existsSync } from 'node:fs'
import { access, constants as fsConstants, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { definePlugin } from '@/plugin'

import { createDreamingSubagent, type DreamingPayload } from './dreaming'
import { buildInjectionPlan, DEFAULT_INJECTION_BUDGET_BYTES, MIN_INJECTION_BUDGET_BYTES } from './injection-plan'
import { loadAllShards } from './load-shards'
import { createMemoryLoggerSubagent, type MemoryLoggerPayload } from './memory-logger'
import { createMemoryRetrievalSubagent, type MemoryRetrievalPayload } from './memory-retrieval'
import { runMigration, runShardingMigration } from './migration'
import { preShardBackupPath, streamFilePath, streamsDir, topicsDir } from './paths'
import { memorySearchTool } from './search-tool'

const DEFAULT_IDLE_MS = 60_000
const DEFAULT_BUFFER_BYTES = 500_000
const MIN_BUFFER_BYTES = 10_000
// 30-minute default. Fires short-circuit before any LLM call when nothing
// sits past the watermark (`dreaming.ts` handler returns when
// `snapshots.undreamed.length === 0`), so frequent no-op fires are cheap.
// The scheduler has no catchup for missed fires; a daily default would starve
// sporadic agents entirely. Operators can override via `memory.dreaming.schedule`.
const DEFAULT_DREAMING_SCHEDULE = '*/30 * * * *'

// Hard ceiling on a single memory-logger spawn. The chain serializes spawns
// per agent, so a non-settling spawn would otherwise wedge every subsequent
// fire — including the session.end hook path that gates cron consumer's
// inFlight cleanup. Set strictly below END_HANDLER_TIMEOUT_MS so the inner
// spawn rejects first and the memory plugin's logger gets the attribution
// instead of the generic hook ceiling.
//
// The bound detaches the orphaned spawn from the chain; it does not cancel
// the underlying subagent session. ctx.spawnSubagent returns Promise<void>
// with no handle, and pi-coding-agent's session.prompt accepts no
// AbortSignal, so the half-open LLM stream stays alive until the OS reaps
// it. The chain advances and cron resumes; the network defect is upstream.
const SPAWN_TIMEOUT_MS = 50_000

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
    injectionBudgetBytes: z.number().int().min(MIN_INJECTION_BUDGET_BYTES).default(DEFAULT_INJECTION_BUDGET_BYTES),
    // Test seam: per-spawn ceiling for memory-logger. Operators have no
    // reason to tune this; it exists so the wedge-recovery test can fire
    // the timeout in milliseconds instead of the production 50s. Kept
    // undocumented for users.
    spawnTimeoutMs: z.number().int().min(1).default(SPAWN_TIMEOUT_MS),
    dreaming: dreamingConfigSchema.optional(),
  })
  .default({
    idleMs: DEFAULT_IDLE_MS,
    bufferBytes: DEFAULT_BUFFER_BYTES,
    injectionBudgetBytes: DEFAULT_INJECTION_BUDGET_BYTES,
    spawnTimeoutMs: SPAWN_TIMEOUT_MS,
  })

export default definePlugin({
  configSchema: memoryConfigSchema,
  plugin: async (ctx) => {
    const idleMs = ctx.config.idleMs
    const bufferBytes = ctx.config.bufferBytes
    const spawnTimeoutMs = ctx.config.spawnTimeoutMs
    const dreamingSchedule = ctx.config.dreaming?.schedule ?? DEFAULT_DREAMING_SCHEDULE

    const migrationResult = await runMigration({
      agentDir: ctx.agentDir,
      logger: ctx.logger,
    })
    if (migrationResult.migrated.length > 0) {
      ctx.logger.info(`[memory] migrated ${migrationResult.migrated.length} daily stream(s) to JSONL`)
    }

    const shardingResult = await runShardingMigration({
      agentDir: ctx.agentDir,
      logger: ctx.logger,
    })
    if (shardingResult.migrated) {
      ctx.logger.info(
        `[memory] sharded ${shardingResult.topicCount} topics + ${shardingResult.streamCount} streams (pre-shard backup at memory/MEMORY.md.pre-shard.bak)`,
      )
    } else if (shardingResult.error !== undefined) {
      ctx.logger.warn(`[memory] sharding migration aborted: ${shardingResult.error}`)
    }

    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const lastIdleEvent = new Map<string, { parentTranscriptPath: string | undefined; origin?: SessionOrigin }>()
    const bytesAtLastRun = new Map<string, number>()

    // memory-logger is now coalesced per agentDir (not per parentSessionId) so that
    // two concurrent channel sessions for the same agent never write to the same
    // daily stream file at the same time. The subagent consumer would silently drop
    // a colliding fire, so we serialize spawn calls *here* (chaining each onto the
    // previous one's settlement) instead of letting the consumer choose between
    // dropping or queueing. The chain holds at most one in-flight promise plus one
    // queued; older queued fires for the same session are superseded by newer ones
    // through the lastIdleEvent map (each fire reads the latest snapshot).
    let spawnChain: Promise<void> = Promise.resolve()

    const fireMemoryLogger = (sessionId: string, reason: 'idle' | 'buffer-trip' | 'session-end'): Promise<void> => {
      const next = spawnChain
        .catch(() => undefined)
        .then(async () => {
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
            await raceSpawn(
              ctx.spawnSubagent('memory-logger', payload, {
                parentSessionId: sessionId,
                ...(last.origin !== undefined ? { spawnedByOrigin: last.origin } : {}),
              }),
              spawnTimeoutMs,
            )
          } catch (err) {
            ctx.logger.error(`memory-logger spawn failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        })
      spawnChain = next
      return next
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
        'memory-retrieval': createMemoryRetrievalSubagent({ logger: subagentLogger }),
        dreaming: createDreamingSubagent({ logger: subagentLogger }),
      },
      tools: {
        memory_search: memorySearchTool,
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
        // Memory injection lives in core (`createResourceLoader` calls `loadMemory`
        // directly, appended LAST in the system prompt). It does not run from a
        // plugin hook because positioning matters for cache-prefix stability:
        // the daily-stream file grows after every channel turn (memory-logger
        // appends a fragment + watermark) and memory/topics/ changes on every dream.
        // A volatile region in the middle of the system prompt invalidates the
        // entire cacheable suffix below it on every session resurrection
        // (channel sessions evicted by idle GC, container restarts). Pinning
        // memory to the bottom of the system prompt keeps everything above it
        // cacheable across resurrections, at the cost of re-billing only the
        // memory section itself when it grows.
        //
        // Core fires `session.idle` immediately after every prompt completion;
        // the plugin owns the debounce timer so memory-logger only spawns
        // after the user has been quiet for `idleMs`. Re-arming a still-armed
        // timer cancels it first, matching the previous core IdleDetector.
        // The size-based ceiling fires synchronously when the transcript has
        // grown by `bufferBytes` since the last run, so busy channel sessions
        // (which rarely go idle) still produce memory updates.
        'session.idle': async (event) => {
          if (event.origin?.kind === 'subagent') return
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
        'session.prompt': async (event) => {
          if (event.origin?.kind === 'subagent') return

          const shards = await loadAllShards(event.agentDir)
          const plan = buildInjectionPlan(shards, { budgetBytes: ctx.config.injectionBudgetBytes })
          if (plan.mode === 'direct') return

          const cacheFilePath = join(ctx.agentDir, 'memory', '.retrieval-cache', `${event.sessionId}.md`)
          const payload: MemoryRetrievalPayload = {
            parentSessionId: event.sessionId,
            agentDir: event.agentDir,
            recentPrompt: event.prompt,
            cacheFilePath,
            ...(event.origin !== undefined ? { origin: event.origin } : {}),
          }
          await ctx.spawnSubagent('memory-retrieval', payload, {
            parentSessionId: event.sessionId,
            ...(event.origin !== undefined ? { spawnedByOrigin: event.origin } : {}),
          })
        },
        'session.end': async (event) => {
          if (event.origin?.kind === 'subagent') return
          cancelTimer(event.sessionId)
          await fireMemoryLogger(event.sessionId, 'session-end')
          const cacheFilePath = join(ctx.agentDir, 'memory', '.retrieval-cache', `${event.sessionId}.md`)
          try {
            await unlink(cacheFilePath)
          } catch (err) {
            if (!isEnoent(err)) ctx.logger.warn(`[memory] failed to clean retrieval cache: ${err}`)
          }
          lastIdleEvent.delete(event.sessionId)
          bytesAtLastRun.delete(event.sessionId)
        },
      },
      doctorChecks: {
        'dir-writable': {
          description: 'memory/topics/ exists and is writable',
          run: async (dctx) => {
            const dir = topicsDir(dctx.agentDir)
            try {
              await access(dir, fsConstants.W_OK)
              return { status: 'ok', message: `${dir} writable` }
            } catch {
              try {
                await mkdir(dir, { recursive: true })
                return { status: 'ok', message: `created ${dir}` }
              } catch {
                return {
                  status: 'error',
                  message: `${dir} is missing and could not be created`,
                  fix: { description: 'Create memory/topics/ in the agent folder or fix its permissions on the host.' },
                }
              }
            }
          },
        },
        'daily-stream-current': {
          description: "today's daily stream file exists",
          run: async (dctx) => {
            const today = new Date().toISOString().slice(0, 10)
            const rel = join('memory', 'streams', `${today}.jsonl`)
            const abs = streamFilePath(dctx.agentDir, today)
            if (existsSync(abs)) return { status: 'ok', message: `${rel} present` }
            return {
              status: 'warning',
              message: `${rel} missing`,
              fix: {
                description: `Create empty ${rel} so memory-logger has a target.`,
                apply: async () => {
                  await mkdir(streamsDir(dctx.agentDir), { recursive: true })
                  await writeFile(abs, '', 'utf8')
                  return { summary: `created ${rel}`, changedPaths: [rel] }
                },
              },
            }
          },
        },
        'legacy-md-cleanup': {
          description: 'Check for legacy .md daily stream files and un-migrated root MEMORY.md',
          run: async (dctx) => {
            const memoryDir = join(dctx.agentDir, 'memory')
            const rootMemoryPath = join(dctx.agentDir, 'MEMORY.md')
            const hasRootMemory = existsSync(rootMemoryPath)
            const hasTopicsDir = existsSync(topicsDir(dctx.agentDir))

            let files: string[]
            try {
              files = await readdir(memoryDir)
            } catch {
              if (!hasRootMemory) return { status: 'ok', message: 'memory/ does not exist yet' }
              return {
                status: 'warning',
                message: 'root MEMORY.md present but not sharded',
                fix: {
                  description: 'Run sharding migration to convert root MEMORY.md to topic shards',
                  apply: async (fixCtx) => {
                    const result = await runShardingMigration({ agentDir: fixCtx.agentDir, logger: fixCtx.logger })
                    return {
                      summary: result.migrated
                        ? `sharded ${result.topicCount} topic(s) and ${result.streamCount} stream(s)`
                        : `sharding migration did not run${result.error ? `: ${result.error}` : ''}`,
                      changedPaths: result.migrated
                        ? [
                            join('memory', 'topics'),
                            join('memory', 'streams'),
                            join('memory', 'MEMORY.md.pre-shard.bak'),
                          ]
                        : [],
                    }
                  },
                },
              }
            }

            const mdFiles = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))

            if (hasRootMemory) {
              if (!hasTopicsDir) {
                const mdMsg = mdFiles.length > 0 ? `; also ${mdFiles.length} legacy .md daily stream(s)` : ''
                return {
                  status: 'warning',
                  message: `root MEMORY.md present but not sharded${mdMsg}`,
                  fix: {
                    description: 'Run sharding migration to convert root MEMORY.md to topic shards',
                    apply: async (fixCtx) => {
                      const result = await runShardingMigration({ agentDir: fixCtx.agentDir, logger: fixCtx.logger })
                      return {
                        summary: result.migrated
                          ? `sharded ${result.topicCount} topic(s) and ${result.streamCount} stream(s)`
                          : `sharding migration did not run${result.error ? `: ${result.error}` : ''}`,
                        changedPaths: result.migrated
                          ? [
                              join('memory', 'topics'),
                              join('memory', 'streams'),
                              join('memory', 'MEMORY.md.pre-shard.bak'),
                            ]
                          : [],
                      }
                    },
                  },
                }
              }
              const mdMsg = mdFiles.length > 0 ? `; also ${mdFiles.length} legacy .md daily stream(s)` : ''
              return {
                status: 'warning',
                message: `orphaned root MEMORY.md after sharding migration${mdMsg}`,
                fix: {
                  description: 'Delete the orphaned root MEMORY.md file',
                  apply: async () => {
                    await unlink(rootMemoryPath)
                    return { summary: 'deleted orphaned root MEMORY.md', changedPaths: ['MEMORY.md'] }
                  },
                },
              }
            }

            if (mdFiles.length === 0) return { status: 'ok', message: 'no legacy .md daily streams found' }

            const caseA: string[] = []
            const caseB: string[] = []

            for (const mdFile of mdFiles) {
              const date = mdFile.replace('.md', '')
              const jsonlFile = `${date}.jsonl`
              if (files.includes(jsonlFile)) {
                caseB.push(date)
              } else {
                caseA.push(date)
              }
            }

            if (caseA.length > 0 && caseB.length === 0) {
              return {
                status: 'warning',
                message: `${caseA.length} legacy .md daily stream(s) still present; boot-time migration likely failed`,
                fix: {
                  description: 'Re-run migration to convert .md files to .jsonl',
                  apply: async (fixCtx) => {
                    const result = await runMigration({ agentDir: fixCtx.agentDir, logger: fixCtx.logger })
                    return {
                      summary: `migrated ${result.migrated.length} legacy .md daily stream(s) to .jsonl`,
                      changedPaths: result.migrated.map((d) => `memory/${d}.jsonl`),
                    }
                  },
                },
              }
            }

            if (caseB.length > 0) {
              const allDates = [...caseA, ...caseB]
              return {
                status: 'warning',
                message: `Conflicting .md+.jsonl pair for dates: ${allDates.join(', ')}. Inspect manually: the .jsonl is the authoritative new format; if its contents match or supersede the .md, delete the .md by hand.`,
                fix: {
                  description: 'Manual inspection required. Delete the .md file if the .jsonl is correct.',
                  // No apply — this is an operator decision
                },
              }
            }

            return { status: 'ok', message: 'no legacy .md daily streams found' }
          },
        },
        'pre-shard-backup-age': {
          description: 'Warn when pre-shard backup is older than 30 days',
          run: async (dctx) => {
            const backupPath = preShardBackupPath(dctx.agentDir)
            let s
            try {
              s = await stat(backupPath)
            } catch {
              return { status: 'ok', message: 'no pre-shard backup present' }
            }
            const ageDays = (Date.now() - s.mtimeMs) / 86_400_000
            if (ageDays > 30) {
              return {
                status: 'warning',
                message: `pre-shard backup is ${Math.round(ageDays)} days old; safe to delete if migration is verified`,
                fix: {
                  description: 'Delete the pre-shard backup file',
                  apply: async () => {
                    await unlink(backupPath)
                    return {
                      summary: 'deleted pre-shard backup',
                      changedPaths: [join('memory', 'MEMORY.md.pre-shard.bak')],
                    }
                  },
                },
              }
            }
            return {
              status: 'ok',
              message: `pre-shard backup is ${Math.round(ageDays)} days old (under 30-day threshold)`,
            }
          },
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

async function raceSpawn(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`memory-logger spawn timed out after ${ms}ms`)), ms)
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
