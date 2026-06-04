import { z } from 'zod'

import { withGitLock } from '@/git/mutex'
import { definePlugin, type PluginContext, type SpawnSubagentOptions, type Subagent } from '@/plugin'

import { COMMIT_TIMEOUT_MS, makeDefaultGitSpawn, NETWORK_TIMEOUT_MS, runBackup, type BackupResult } from './runner'
import {
  cleanupMessageFile,
  type CommitMessagePayload,
  createCommitMessageSubagent,
  createDiagnoseFailureSubagent,
  type DiagnoseFailurePayload,
  ensureMessageDir,
  messageFilePath,
  readMessageFile,
} from './subagents'

const DEFAULT_IDLE_MS = 30_000
const MIN_IDLE_MS = 1_000

const SUBAGENT_BACKUP_RUNNER = 'backup'
const SUBAGENT_COMMIT_MESSAGE = 'backup-message'
const SUBAGENT_DIAGNOSE = 'backup-diagnose'

const SELF_INDUCED_SUBAGENT_NAMES = new Set<string>([
  SUBAGENT_BACKUP_RUNNER,
  SUBAGENT_COMMIT_MESSAGE,
  SUBAGENT_DIAGNOSE,
])

const backupConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    idleMs: z.number().int().min(MIN_IDLE_MS).default(DEFAULT_IDLE_MS),
    pushToOrigin: z.boolean().default(true),
    commitTimeoutMs: z.number().int().min(1).default(COMMIT_TIMEOUT_MS),
    networkTimeoutMs: z.number().int().min(1).default(NETWORK_TIMEOUT_MS),
  })
  .default({
    enabled: true,
    idleMs: DEFAULT_IDLE_MS,
    pushToOrigin: true,
    commitTimeoutMs: COMMIT_TIMEOUT_MS,
    networkTimeoutMs: NETWORK_TIMEOUT_MS,
  })

const runnerPayloadSchema = z.object({
  agentDir: z.string(),
  pushToOrigin: z.boolean(),
})

type RunnerPayload = z.infer<typeof runnerPayloadSchema>

export default definePlugin({
  configSchema: backupConfigSchema,
  plugin: async (ctx) => {
    const enabled = ctx.config.enabled
    const idleMs = ctx.config.idleMs
    const pushToOrigin = ctx.config.pushToOrigin

    const activeTurns = new Set<string>()
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let pendingFire = false
    let inFlight = false

    const cancelTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    const fireIfQuiet = async (): Promise<void> => {
      if (!enabled) return
      if (inFlight) {
        pendingFire = true
        return
      }
      if (activeTurns.size > 0) return
      inFlight = true
      try {
        await ctx.spawnSubagent(
          SUBAGENT_BACKUP_RUNNER,
          {
            agentDir: ctx.agentDir,
            pushToOrigin,
          } satisfies RunnerPayload,
          // The backup runner is a system-level operation that commits +
          // pushes on the operator's behalf. It runs after every idle
          // window regardless of which session caused activity, so it has
          // no single user session to inherit from. Mark it as TUI-equivalent
          // so it resolves to `owner` and can use git push, etc.
          { spawnedByOrigin: { kind: 'tui', sessionId: 'backup-runner' } },
        )
      } catch (err) {
        ctx.logger.error(`backup runner spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        inFlight = false
        if (pendingFire) {
          pendingFire = false
          if (activeTurns.size === 0) {
            queueMicrotask(() => {
              void fireIfQuiet()
            })
          }
        }
      }
    }

    const isSelfInducedTurn = (origin: { kind: string; subagent?: string } | undefined): boolean => {
      if (origin?.kind !== 'subagent') return false
      const sub = origin.subagent
      return sub !== undefined && SELF_INDUCED_SUBAGENT_NAMES.has(sub)
    }

    const runnerSubagent: Subagent<RunnerPayload> = {
      systemPrompt: '(backup runner — no LLM)',
      payloadSchema: runnerPayloadSchema,
      inFlightKey: (payload) => payload.agentDir,
      handler: async (sctx) => {
        const result = await runBackupOnce(sctx.payload, ctx)
        const summary = describeResult(result)
        ctx.logger.info(`[backup] ${summary}`)
      },
    }

    return {
      subagents: {
        [SUBAGENT_BACKUP_RUNNER]: runnerSubagent,
        [SUBAGENT_COMMIT_MESSAGE]: createCommitMessageSubagent(),
        [SUBAGENT_DIAGNOSE]: createDiagnoseFailureSubagent(),
      },
      hooks: {
        'session.turn.start': (event) => {
          if (isSelfInducedTurn(event.origin)) return
          activeTurns.add(event.sessionId)
          cancelTimer()
        },
        'session.turn.end': (event) => {
          if (isSelfInducedTurn(event.origin)) return
          activeTurns.delete(event.sessionId)
        },
        'session.end': (event) => {
          activeTurns.delete(event.sessionId)
        },
        'session.idle': () => {
          if (!enabled) return
          if (activeTurns.size > 0) return
          cancelTimer()
          idleTimer = setTimeout(() => {
            idleTimer = null
            void fireIfQuiet()
          }, idleMs)
        },
      },
    }
  },
})

async function runBackupOnce(
  payload: RunnerPayload,
  ctx: {
    agentDir: string
    logger: { info: (m: string) => void; warn: (m: string) => void }
    spawnSubagent: PluginContext['spawnSubagent']
  },
): Promise<BackupResult> {
  const messagePath = messageFilePath(payload.agentDir)
  await ensureMessageDir(messagePath)
  await cleanupMessageFile(messagePath)
  // Inherit the backup-runner's owner privileges for the message-picking
  // and diagnose subagents it spawns. Same rationale as the runner itself
  // — these are system-level operations on the operator's behalf.
  const inheritOwner: SpawnSubagentOptions = {
    spawnedByOrigin: { kind: 'tui', sessionId: 'backup-runner' },
  }

  const result = await withGitLock(payload.agentDir, () =>
    runBackup(
      { cwd: payload.agentDir, pushToOrigin: payload.pushToOrigin },
      {
        gitSpawn: makeDefaultGitSpawn(),
        pickCommitMessage: async ({ status, diffstat }) => {
          await cleanupMessageFile(messagePath)
          const messagePayload: CommitMessagePayload = {
            agentDir: payload.agentDir,
            status,
            diffstat,
            outputPath: messagePath,
          }
          try {
            await ctx.spawnSubagent(SUBAGENT_COMMIT_MESSAGE, messagePayload, inheritOwner)
          } catch (err) {
            ctx.logger.warn(
              `${SUBAGENT_COMMIT_MESSAGE} subagent failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          const written = await readMessageFile(messagePath)
          await cleanupMessageFile(messagePath)
          return written ?? 'chore: backup'
        },
        diagnoseFailure: async (input) => {
          const diagPayload: DiagnoseFailurePayload = {
            agentDir: input.cwd,
            stage: input.stage,
            exitCode: input.exitCode,
            stderr: input.stderr,
            stdout: input.stdout,
          }
          try {
            await ctx.spawnSubagent(SUBAGENT_DIAGNOSE, diagPayload, inheritOwner)
          } catch (err) {
            ctx.logger.warn(`${SUBAGENT_DIAGNOSE} subagent failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      },
    ),
  )

  await cleanupMessageFile(messagePath)
  return result
}

function describeResult(r: BackupResult): string {
  if (r.ok) return r.kind
  return `failed (${r.kind}): ${r.reason}`
}
