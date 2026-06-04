import type { LiveSourceFactory, RunInspectResult } from './index'
import { streamInspectTarget } from './index'
import type { ViewerItem } from './item'
import { streamLogs } from './logs-item'
import type { OpenItemContext, TailController } from './loop'
import { runTuiViewer } from './tui-item'
import type { InspectFilter } from './types'

export type OpenViewerDeps = {
  cwd: string
  filter: InspectFilter
  sinceMs: number | undefined
  json: boolean
  color: boolean
  interactive: boolean
  stdout: (line: string) => void
  stderr: (line: string) => void
  liveSource?: LiveSourceFactory
  liveHint?: string
  resolveTuiUrl: () => Promise<string>
  expectedVersion?: string
  onVersionMismatch?: (info: { expected: string; actual: string }) => void
}

// Dispatches a selected list item to its viewer. session/logs run under the
// loop's tail scope (raw-mode esc/q/ctrl-c handling owned by the loop); tui
// runs WITHOUT a tail scope because createTui owns its own raw-mode terminal —
// two raw-stdin owners would corrupt input.
export function openViewerItem(deps: OpenViewerDeps) {
  return async (item: ViewerItem, ctx: OpenItemContext): Promise<RunInspectResult> => {
    if (item.kind === 'tui') {
      return runTuiViewer({
        resolveUrl: deps.resolveTuiUrl,
        stderr: deps.stderr,
        ...(deps.expectedVersion !== undefined ? { expectedVersion: deps.expectedVersion } : {}),
        ...(deps.onVersionMismatch !== undefined ? { onVersionMismatch: deps.onVersionMismatch } : {}),
      })
    }

    const scope = ctx.createTailScope()
    try {
      if (item.kind === 'logs') {
        const result = await streamLogs({
          cwd: deps.cwd,
          color: deps.color,
          stdout: deps.stdout,
          stderr: deps.stderr,
          signal: scope.signal,
          ...(deps.liveHint !== undefined ? { liveHint: deps.liveHint } : {}),
        })
        return toResult(result.escToPicker, scope)
      }

      const sessionResult = await streamInspectTarget({
        agentDir: deps.cwd,
        target: { summary: item.summary, filter: deps.filter, sinceMs: deps.sinceMs },
        json: deps.json,
        color: deps.color,
        stdout: deps.stdout,
        stderr: deps.stderr,
        signal: scope.signal,
        ...(deps.liveSource !== undefined ? { liveSource: deps.liveSource } : {}),
        ...(deps.liveHint !== undefined ? { liveHint: deps.liveHint } : {}),
        ...(deps.interactive ? { interactive: true } : {}),
      })
      const escToPicker = sessionResult.ok && sessionResult.escToPicker === true
      return toResult(escToPicker, scope)
    } finally {
      scope.dispose()
    }
  }
}

function toResult(escToPicker: boolean, scope: TailController): RunInspectResult {
  if (scope.intent() === 'exit') return { ok: true, exitCode: 0 }
  if (escToPicker) return { ok: true, exitCode: 0, escToPicker: true }
  return { ok: true, exitCode: 0 }
}
