import { supportsColor } from './log-colors'
import { makeLogTimestampReformatter, type TimestampReformatter } from './log-timestamps'
import { containerExists, containerNameFromCwd, getBun } from './shared'

export type LogsPlan = {
  containerName: string
  follow: boolean
}

export type LogsResult = { ok: true; containerName: string; exitCode: number } | { ok: false; reason: string }

export type LogsOptions = {
  cwd: string
  follow: boolean
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
  out = process.stdout,
  err = process.stderr,
  signal,
  useColor,
}: LogsOptions): Promise<LogsResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const plan = planLogs(cwd, { follow })

  try {
    if (!(await containerExists(plan.containerName))) {
      return { ok: false, reason: `Container ${plan.containerName} not found. Run \`typeclaw start\` first.` }
    }

    const proc = bun.spawn({ cmd: buildDockerLogsCmd(plan), cwd, stdout: 'pipe', stderr: 'pipe' })

    const onAbort = (): void => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // already exited
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const colorOut = useColor ?? supportsColor(out)
    const colorErr = useColor ?? supportsColor(err)
    await Promise.all([
      pumpWithTimestamps(proc.stdout, out, makeLogTimestampReformatter(undefined, { color: colorOut })),
      pumpWithTimestamps(proc.stderr, err, makeLogTimestampReformatter(undefined, { color: colorErr })),
    ])
    const exitCode = await proc.exited
    signal?.removeEventListener('abort', onAbort)

    return { ok: true, containerName: plan.containerName, exitCode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planLogs(cwd: string, { follow }: { follow: boolean }): LogsPlan {
  return { containerName: containerNameFromCwd(cwd), follow }
}

// Exported so `compose/logs.ts` builds the exact same `docker logs` argv shape.
export function buildDockerLogsCmd(plan: LogsPlan): string[] {
  const cmd = ['docker', 'logs', '--timestamps']
  if (plan.follow) cmd.push('-f')
  cmd.push(plan.containerName)
  return cmd
}

// Exported for `compose/logs.ts` so the multi-agent path reuses the same
// reformatter and stays consistent with single-agent output.
export async function pumpWithTimestamps(
  stream: ReadableStream<Uint8Array>,
  sink: NodeJS.WritableStream,
  reformatter: TimestampReformatter = makeLogTimestampReformatter(),
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        const out = reformatter.write(decoder.decode(value, { stream: true }))
        if (out.length > 0) sink.write(out)
      }
    }
    const tail = decoder.decode()
    if (tail.length > 0) {
      const out = reformatter.write(tail)
      if (out.length > 0) sink.write(out)
    }
    const flushed = reformatter.flush()
    if (flushed.length > 0) sink.write(flushed)
  } finally {
    reader.releaseLock()
  }
}
