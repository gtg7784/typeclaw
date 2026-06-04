import { supportsColor } from './log-colors'
import { makeLogTimestampReformatter, type TimestampReformatter } from './log-timestamps'
import { containerExists, containerNameFromCwd, getBun } from './shared'

export type LogsPlan = {
  containerName: string
  follow: boolean
  tail?: string
}

export type LogsResult = { ok: true; containerName: string; exitCode: number } | { ok: false; reason: string }

export type LogsOptions = {
  cwd: string
  follow: boolean
  // Forwarded to `docker logs --tail <value>`. Accepts a non-negative
  // integer string or the sentinel `"all"`. When undefined, no `--tail`
  // arg is added and docker's default ("all") applies.
  tail?: string
  out?: NodeJS.WritableStream
  err?: NodeJS.WritableStream
  signal?: AbortSignal
  // When undefined, defaults to TTY+NO_COLOR detection on `out`/`err`.
  // Tests pass `false` for deterministic plain output.
  useColor?: boolean
}

export async function logs({
  cwd,
  follow,
  tail,
  out = process.stdout,
  err = process.stderr,
  signal,
  useColor,
}: LogsOptions): Promise<LogsResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const plan = planLogs(cwd, { follow, tail })

  try {
    if (!(await containerExists(plan.containerName))) {
      return { ok: false, reason: `Container ${plan.containerName} not found. Run \`typeclaw start\` first.` }
    }

    // stdin:'ignore' — `docker logs` never reads stdin, and letting the child
    // hold the TTY breaks the viewer's raw-mode keypress listener (esc/q/ctrl-c
    // stop reaching it, freezing the logs view with no way out).
    const proc = bun.spawn({ cmd: buildDockerLogsCmd(plan), cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

    // `docker logs -f` never exits on its own; aborting the signal must kill it
    // so the pumps' stream readers end. Escalate to SIGKILL if SIGTERM is
    // ignored, otherwise Promise.all(pumps) could hang until the pipes close.
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      try {
        proc.kill('SIGTERM')
        killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            // already exited
          }
        }, 2_000)
      } catch {
        // already exited
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // The signal may already be aborted before we attached the listener (esc
    // pressed during container existence check); addEventListener would then
    // never fire, leaving docker logs -f running forever.
    if (signal?.aborted === true) onAbort()

    try {
      const colorOut = useColor ?? supportsColor(out)
      const colorErr = useColor ?? supportsColor(err)
      await Promise.all([
        pumpWithTimestamps(proc.stdout, out, makeLogTimestampReformatter(undefined, { color: colorOut }), signal),
        pumpWithTimestamps(proc.stderr, err, makeLogTimestampReformatter(undefined, { color: colorErr }), signal),
      ])
      const exitCode = await proc.exited
      return { ok: true, containerName: plan.containerName, exitCode }
    } finally {
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planLogs(cwd: string, { follow, tail }: { follow: boolean; tail?: string }): LogsPlan {
  return { containerName: containerNameFromCwd(cwd), follow, ...(tail !== undefined ? { tail } : {}) }
}

// Validate user-supplied `--tail` value. Mirrors `docker logs --tail`'s
// accepted shape: either the sentinel `"all"` (case-insensitive) or a
// non-negative integer.
export function parseTailValue(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: '--tail requires a value (a non-negative integer or "all")' }
  if (trimmed.toLowerCase() === 'all') return { ok: true, value: 'all' }
  // Reject leading +, leading zeros (other than "0"), signs, decimals, and
  // scientific notation up front so the user gets a clear error instead of
  // docker's terse "invalid value" later.
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    return { ok: false, reason: `--tail expects a non-negative integer or "all", got ${JSON.stringify(raw)}` }
  }
  return { ok: true, value: trimmed }
}

// Exported so `compose/logs.ts` builds the exact same `docker logs` argv shape.
export function buildDockerLogsCmd(plan: LogsPlan): string[] {
  const cmd = ['docker', 'logs', '--timestamps']
  if (plan.tail !== undefined) cmd.push('--tail', plan.tail)
  if (plan.follow) cmd.push('-f')
  cmd.push(plan.containerName)
  return cmd
}

// Exported for `compose/logs.ts` so the multi-agent path reuses the same
// reformatter and stays consistent with single-agent output.
//
// Abort handling is load-bearing for the interactive logs viewer: killing
// `docker logs -f` does NOT reliably make Bun's pending `reader.read()` resolve
// (the killed child may not promptly EOF its piped stdout — see the OrbStack
// /proc quirk). Without cancelling the reader on abort, esc would hang forever.
// So on abort we cancel the reader, which unblocks the pending read; the caller
// still kills the process for OS-side cleanup.
export async function pumpWithTimestamps(
  stream: ReadableStream<Uint8Array>,
  sink: NodeJS.WritableStream,
  reformatter: TimestampReformatter = makeLogTimestampReformatter(),
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let aborted = signal?.aborted === true
  const onAbort = (): void => {
    aborted = true
    void reader.cancel().catch(() => {})
  }
  if (aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (aborted) break
      const chunk = await reader.read().catch((error: unknown) => {
        if (aborted || signal?.aborted === true) return null
        throw error
      })
      if (chunk === null || chunk.done || aborted) break
      if (chunk.value && chunk.value.byteLength > 0) {
        const out = reformatter.write(decoder.decode(chunk.value, { stream: true }))
        if (out.length > 0) sink.write(out)
      }
    }
    if (!aborted) {
      const tail = decoder.decode()
      if (tail.length > 0) {
        const out = reformatter.write(tail)
        if (out.length > 0) sink.write(out)
      }
      const flushed = reformatter.flush()
      if (flushed.length > 0) sink.write(flushed)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // harmless if cancel/abort raced with stream teardown
    }
  }
}
