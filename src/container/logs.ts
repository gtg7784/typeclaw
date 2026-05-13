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
}

export async function logs({
  cwd,
  follow,
  out = process.stdout,
  err = process.stderr,
  signal,
}: LogsOptions): Promise<LogsResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const { containerName } = planLogs(cwd, { follow })

  try {
    if (!(await containerExists(containerName))) {
      return { ok: false, reason: `Container ${containerName} not found. Run \`typeclaw start\` first.` }
    }

    const cmd = ['docker', 'logs', '--timestamps']
    if (follow) cmd.push('-f')
    cmd.push(containerName)

    const proc = bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })

    const onAbort = (): void => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // already exited
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    await Promise.all([pumpWithTimestamps(proc.stdout, out), pumpWithTimestamps(proc.stderr, err)])
    const exitCode = await proc.exited
    signal?.removeEventListener('abort', onAbort)

    return { ok: true, containerName, exitCode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planLogs(cwd: string, { follow }: { follow: boolean }): LogsPlan {
  return { containerName: containerNameFromCwd(cwd), follow }
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
