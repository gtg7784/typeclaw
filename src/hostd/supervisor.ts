import type { Response } from './protocol'

export type SupervisorRestart = (input: {
  containerName: string
  cwd: string
  // When true, the underlying `start()` runs with `forceBuild: true`, which
  // regenerates the Dockerfile from the current CLI template AND rebuilds the
  // image even if it already exists. Default false matches the host-side
  // `typeclaw restart` (no `--build` flag) behavior.
  build?: boolean
}) => Promise<{ ok: true } | { ok: false; reason: string }>

export type SupervisorOptions = {
  restart?: SupervisorRestart
}

export type SupervisorLogEvent =
  | { kind: 'restart-scheduled'; containerName: string; build: boolean }
  | { kind: 'restart-completed'; containerName: string }
  | { kind: 'restart-failed'; containerName: string; reason: string }

export type Supervisor = {
  scheduleRestart: (input: { containerName: string; cwd: string; build?: boolean }) => Response
}

export type SupervisorBuildOptions = {
  restart: SupervisorRestart
  onLog: (event: SupervisorLogEvent) => void
  isStopped: () => boolean
}

// The daemon ACKs the agent immediately so the container can exit cleanly,
// then runs stop+start in the background. If we ran them inline the agent's
// own RPC connection would die when its container stopped — guaranteed to
// race because `docker stop` is the very thing we're about to do. Errors are
// surfaced via the log channel; there is no connected client to receive them.
export function buildSupervisor({ restart, onLog, isStopped }: SupervisorBuildOptions): Supervisor {
  return {
    scheduleRestart: ({ containerName, cwd, build = false }): Response => {
      if (isStopped()) return { ok: false, reason: 'daemon stopping' }
      onLog({ kind: 'restart-scheduled', containerName, build })
      void runRestart()
      return { ok: true }

      async function runRestart(): Promise<void> {
        try {
          const result = await restart({ containerName, cwd, build })
          if (result.ok) onLog({ kind: 'restart-completed', containerName })
          else onLog({ kind: 'restart-failed', containerName, reason: result.reason })
        } catch (error) {
          onLog({
            kind: 'restart-failed',
            containerName,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    },
  }
}
