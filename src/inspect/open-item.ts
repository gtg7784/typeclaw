import { join } from 'node:path'

import type { LiveSourceFactory, RunInspectResult } from './index'
import { createTranscriptView, streamInspectTarget } from './index'
import type { ViewerItem } from './item'
import { streamLogs } from './logs-item'
import type { OpenItemContext, OpenItemResult, TailController } from './loop'
import { resolveSession } from './session-list'
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

// Dispatches a selected list item to its viewer. The tui branch and the
// interactive read-only transcript view each own their own raw-mode pi-tui
// terminal, so they run WITHOUT the loop's tail scope (two raw-stdin owners
// would corrupt input). The line/JSON session path and logs run UNDER the tail
// scope, which owns the raw-mode esc/q/ctrl-c handling.
export function openViewerItem(deps: OpenViewerDeps) {
  return async (rawItem: ViewerItem, ctx: OpenItemContext): Promise<OpenItemResult> => {
    // A live-only row captured `sessionFile: ''` when it was listed. By the time
    // the user opens it the reply may have flushed to disk AND the registry
    // entry may be gone — leaving the live tail broadcast-only and skipping the
    // now-existing transcript. Re-resolve against the sessions dir so a
    // flushed session opens as its real disk summary (replay + live tail).
    const item = await reresolveLiveItem(rawItem, deps.cwd, deps.stderr)

    if (item.kind === 'tui') {
      const result = await runTuiViewer({
        resolveUrl: deps.resolveTuiUrl,
        stderr: deps.stderr,
        ...(deps.expectedVersion !== undefined ? { expectedVersion: deps.expectedVersion } : {}),
        ...(deps.onVersionMismatch !== undefined ? { onVersionMismatch: deps.onVersionMismatch } : {}),
      })
      // Detaching the writable tui viewer ends the live session — the only path
      // that should suppress the writable row on the next list refresh.
      return { result, endedWritableSession: result.ok && result.escToPicker === true }
    }

    // Interactive-TTY read-only session -> rich pi-tui transcript view. Owns its
    // own terminal, so it bypasses the tail scope. JSON/non-TTY falls through to
    // the scriptable line renderer below. Read-only: esc does NOT end a live
    // session, so endedWritableSession stays unset.
    if (item.kind === 'session' && deps.interactive && !deps.json) {
      const view = createTranscriptView({
        summary: item.summary,
        filter: deps.filter,
        sinceMs: deps.sinceMs,
        ...(deps.liveSource !== undefined ? { liveSource: deps.liveSource } : {}),
      })
      const outcome = await view.run()
      const result: RunInspectResult =
        outcome.reason === 'back' ? { ok: true, exitCode: 0, escToPicker: true } : { ok: true, exitCode: 0 }
      return { result }
    }

    const scope = ctx.createTailScope()
    try {
      if (item.kind === 'logs') {
        const logsResult = await streamLogs({
          cwd: deps.cwd,
          color: deps.color,
          stdout: deps.stdout,
          stderr: deps.stderr,
          signal: scope.signal,
          ...(deps.liveHint !== undefined ? { liveHint: deps.liveHint } : {}),
        })
        // Logs esc does NOT touch the live session — no endedWritableSession.
        return { result: toResult(logsResult.escToPicker, scope) }
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
      return { result: toResult(escToPicker, scope) }
    } finally {
      scope.dispose()
    }
  }
}

export async function reresolveLiveItem(
  item: ViewerItem,
  cwd: string,
  onWarn: (line: string) => void,
): Promise<ViewerItem> {
  if (item.kind === 'logs' || item.summary.live !== true) return item
  const resolved = await resolveSession(join(cwd, 'sessions'), item.summary.sessionId, onWarn)
  if (!resolved.ok) return item
  return { kind: 'session', summary: resolved.summary, writable: false }
}

function toResult(escToPicker: boolean, scope: TailController): RunInspectResult {
  if (scope.intent() === 'exit') return { ok: true, exitCode: 0 }
  if (escToPicker) return { ok: true, exitCode: 0, escToPicker: true }
  return { ok: true, exitCode: 0 }
}
