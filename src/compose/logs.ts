import { buildDockerLogsCmd, containerExists } from '@/container'
import { supportsColor } from '@/container/log-colors'
import { makeLogTimestampReformatter, type TimestampReformatter } from '@/container/log-timestamps'
import { getBun } from '@/container/shared'

import { discoverAgents, type AgentEntry } from './discover'

export type ComposeLogsOptions = {
  rootCwd: string
  follow: boolean
  out?: NodeJS.WritableStream
  err?: NodeJS.WritableStream
  signal?: AbortSignal
}

export type ComposeLogsResult = {
  agents: AgentEntry[]
  attached: AgentEntry[]
  missing: AgentEntry[]
  exitCode: number
}

const COLORS = ['36', '33', '32', '35', '34', '31', '96', '93', '92', '95'] as const

export function colorFor(name: string, palette: readonly string[] = COLORS): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length] ?? '0'
}

// Stateful chunker that buffers partial lines across chunks: only emits
// newline-terminated lines (each prefixed with the agent name + bar), and
// flushes the un-terminated tail on EOF. Without this, interleaved chunks
// from multiple agents would shred lines mid-character.
export function makeLinePrefixer(
  name: string,
  width: number,
  color: string,
  useColor: boolean,
): { write: (chunk: string) => string; flush: () => string } {
  const padded = name.padEnd(width)
  const prefix = useColor ? `\x1b[${color}m${padded}\x1b[0m | ` : `${padded} | `
  let buffer = ''
  return {
    write(chunk: string): string {
      buffer += chunk
      const nl = buffer.lastIndexOf('\n')
      if (nl < 0) return ''
      const complete = buffer.slice(0, nl + 1)
      buffer = buffer.slice(nl + 1)
      return complete
        .split('\n')
        .slice(0, -1)
        .map((l) => `${prefix}${l}\n`)
        .join('')
    },
    flush(): string {
      if (buffer.length === 0) return ''
      const out = `${prefix}${buffer}\n`
      buffer = ''
      return out
    },
  }
}

export async function composeLogs({
  rootCwd,
  follow,
  out = process.stdout,
  err = process.stderr,
  signal,
}: ComposeLogsOptions): Promise<ComposeLogsResult> {
  const agents = discoverAgents(rootCwd)

  const liveness = await Promise.all(
    agents.map(async (a) => ({ agent: a, exists: await containerExists(a.containerName) })),
  )
  const attached = liveness.filter((l) => l.exists).map((l) => l.agent)
  const missing = liveness.filter((l) => !l.exists).map((l) => l.agent)

  for (const a of missing) {
    err.write(`compose: skipping ${a.name} (container not running)\n`)
  }
  if (attached.length === 0) return { agents, attached, missing, exitCode: 0 }

  const bun = getBun()
  if (!bun) {
    err.write('compose: bun runtime not available\n')
    return { agents, attached, missing, exitCode: 1 }
  }

  const width = attached.reduce((w, a) => Math.max(w, a.name.length), 0)
  const useColor = supportsColor(out)

  const procs = attached.map((agent) => {
    const cmd = buildDockerLogsCmd({ containerName: agent.containerName, follow })
    const proc = bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })
    return { agent, proc }
  })

  const onAbort = (): void => {
    for (const { proc } of procs) {
      try {
        proc.kill('SIGTERM')
      } catch {
        // already exited
      }
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const pumps = procs.flatMap(({ agent, proc }) => {
    const color = colorFor(agent.name)
    return [
      pumpStream(
        proc.stdout,
        makeLogTimestampReformatter(undefined, { color: useColor }),
        makeLinePrefixer(agent.name, width, color, useColor),
        out,
      ),
      pumpStream(
        proc.stderr,
        makeLogTimestampReformatter(undefined, { color: useColor }),
        makeLinePrefixer(agent.name, width, color, useColor),
        err,
      ),
    ]
  })

  await Promise.all(pumps)
  const exits = await Promise.all(procs.map((p) => p.proc.exited))
  signal?.removeEventListener('abort', onAbort)

  // 143 = 128 + SIGTERM(15). When we cancel via signal, every child exits 143;
  // that's expected, not failure. Surface only the first non-OK, non-cancelled
  // exit so a real `docker logs` failure (e.g. "no such container") still bubbles.
  const exitCode = exits.find((c) => c !== 0 && c !== 143) ?? 0
  return { agents, attached, missing, exitCode }
}

async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  reformatter: TimestampReformatter,
  prefixer: { write: (s: string) => string; flush: () => string },
  sink: NodeJS.WritableStream,
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  const writeChunk = (chunk: string): void => {
    const reformatted = reformatter.write(chunk)
    if (reformatted.length === 0) return
    const prefixed = prefixer.write(reformatted)
    if (prefixed.length > 0) sink.write(prefixed)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) writeChunk(decoder.decode(value, { stream: true }))
    }
    const tail = decoder.decode()
    if (tail.length > 0) writeChunk(tail)
    const flushedTs = reformatter.flush()
    if (flushedTs.length > 0) {
      const prefixed = prefixer.write(flushedTs)
      if (prefixed.length > 0) sink.write(prefixed)
    }
    const flushedPrefix = prefixer.flush()
    if (flushedPrefix.length > 0) sink.write(flushedPrefix)
  } finally {
    reader.releaseLock()
  }
}
