import { createTui, type TuiRunResult } from '@/tui'

import type { RunInspectResult } from './index'

export type TuiRunner = (opts: {
  url: string
  initialPrompt?: string
  expectedVersion?: string
  onVersionMismatch?: (info: { expected: string; actual: string }) => void
}) => Promise<TuiRunResult>

export type RunTuiViewerOptions = {
  resolveUrl: () => Promise<string>
  initialPrompt?: string
  expectedVersion?: string
  onVersionMismatch?: (info: { expected: string; actual: string }) => void
  stderr: (line: string) => void
  runTui?: TuiRunner
  reconnectMaxAttempts?: number
  reconnectBackoffMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_RECONNECT_MAX_ATTEMPTS = 30
const DEFAULT_RECONNECT_BACKOFF_MS = 1_000

// The interactive read+write viewer branch. Unlike session/logs, this does NOT
// run under the loop's tail scope: createTui owns its own raw-mode pi-tui
// terminal and esc/ctrl-c handling, so a second raw-stdin owner would corrupt
// input. The branch maps createTui's outcome into the loop's result contract:
// detach → back to the list (escToPicker), exit → terminate, lostConnection →
// reconnect (the self-restart case), connectFailed → error result.
export async function runTuiViewer(opts: RunTuiViewerOptions): Promise<RunInspectResult> {
  const runTui = opts.runTui ?? defaultRunTui
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const maxAttempts = opts.reconnectMaxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS
  const backoffMs = opts.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS

  let initialPrompt = opts.initialPrompt
  let attempt = 0

  while (true) {
    let url: string
    try {
      url = await opts.resolveUrl()
    } catch (err) {
      return { ok: false, exitCode: 1, reason: errorMessage(err) }
    }

    let result: TuiRunResult
    try {
      result = await runTui({
        url,
        ...(initialPrompt !== undefined ? { initialPrompt } : {}),
        ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        ...(opts.onVersionMismatch !== undefined ? { onVersionMismatch: opts.onVersionMismatch } : {}),
      })
    } catch (err) {
      return { ok: false, exitCode: 1, reason: errorMessage(err) }
    }

    if (result.reason === 'detach') return { ok: true, exitCode: 0, escToPicker: true }
    if (result.reason === 'exit') return { ok: true, exitCode: result.exitCode }
    if (result.reason === 'connectFailed') return { ok: false, exitCode: 1, reason: 'connection failed' }

    // lostConnection: the WS dropped post-handshake (self-restart, network
    // blip). Re-resolve the URL because the host port can change across
    // container lifecycles, then reconnect. Clear the initial prompt so a
    // reconnect resuming the same session does not re-send it to the LLM.
    initialPrompt = undefined
    attempt += 1
    if (attempt > maxAttempts) {
      return { ok: false, exitCode: 1, reason: `disconnected; gave up after ${maxAttempts} reconnect attempts` }
    }
    opts.stderr(`reconnecting (attempt ${attempt}/${maxAttempts})...`)
    await sleep(backoffMs)
  }
}

function defaultRunTui(opts: {
  url: string
  initialPrompt?: string
  expectedVersion?: string
  onVersionMismatch?: (info: { expected: string; actual: string }) => void
}): Promise<TuiRunResult> {
  return createTui({
    url: opts.url,
    exit: () => {},
    ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}),
    ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
    ...(opts.onVersionMismatch !== undefined ? { onVersionMismatch: opts.onVersionMismatch } : {}),
  }).run()
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
