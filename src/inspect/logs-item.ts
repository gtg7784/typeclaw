import { logs } from '@/container'

export type StreamLogsOptions = {
  cwd: string
  color: boolean
  stdout: (line: string) => void
  stderr: (line: string) => void
  signal?: AbortSignal
  liveHint?: string
}

export type StreamLogsResult = { escToPicker: boolean }

// Interactive container-logs viewer for the session-viewer list. Unlike the raw
// `logs` pump (host-stage, used for `typeclaw logs | grep`), this one runs under
// the loop's tail scope: aborting the signal (esc/q/ctrl-c) kills `docker logs`
// and returns control to the picker. Works with the agent server down — it only
// needs the container to exist.
export async function streamLogs(opts: StreamLogsOptions): Promise<StreamLogsResult> {
  const aborted = (): boolean => opts.signal?.aborted === true
  if (aborted()) return { escToPicker: true }

  opts.stdout(divider(opts.color, '─── container logs ───'))
  if (opts.liveHint !== undefined && opts.liveHint !== '') {
    opts.stdout(divider(opts.color, opts.liveHint))
  }

  const out = lineSink(opts.stdout)
  const err = lineSink(opts.stderr)

  const result = await logs({
    cwd: opts.cwd,
    follow: true,
    out,
    err,
    useColor: opts.color,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })

  if (!result.ok) {
    opts.stderr(result.reason)
    return { escToPicker: aborted() }
  }
  return { escToPicker: aborted() }
}

function divider(color: boolean, text: string): string {
  if (color) return `\u001b[2m${text}\u001b[0m`
  return text
}

// `logs` writes pre-formatted chunks (already newline-terminated) to a
// WritableStream; the loop's sink wants newline-free lines. Buffer partial
// lines and forward complete ones so a chunk split mid-line never emits a
// truncated row.
function lineSink(emit: (line: string) => void): NodeJS.WritableStream {
  let buffer = ''
  const flushLines = (): void => {
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      emit(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
      idx = buffer.indexOf('\n')
    }
  }
  return {
    write(chunk: string | Uint8Array): boolean {
      buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      flushLines()
      return true
    },
    end(): void {
      if (buffer.length > 0) {
        emit(buffer)
        buffer = ''
      }
    },
  } as unknown as NodeJS.WritableStream
}
