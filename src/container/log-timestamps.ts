// Docker emits each `--timestamps` line as `<RFC3339Nano> <body>\n`, e.g.
// `2026-05-13T14:23:01.123456789Z hello world\n`. RFC3339Nano is precise but
// painful to read live; humans want a wall-clock prefix. This module parses
// the leading token, reformats it to `YYYY-MM-DD HH:MM:SS` in the host's
// local timezone, and passes everything after the first space through.
//
// Stateful chunker mirroring src/compose/logs.ts#makeLinePrefixer: only emits
// newline-terminated lines and flushes the un-terminated tail on EOF, so
// interleaved reads from `docker logs` can never shred a line mid-character.

// `2026-05-13T14:23:01.123456789Z` or `...+09:00` etc. We accept anything
// from Docker that Date can parse, but anchor on the ISO date+time prefix to
// avoid eating non-timestamped log content.
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})) (.*)$/

export type TimestampReformatter = {
  write: (chunk: string) => string
  flush: () => string
}

export function makeLogTimestampReformatter(now: () => Date = () => new Date()): TimestampReformatter {
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
        .map((line) => `${reformatLine(line, now)}\n`)
        .join('')
    },
    flush(): string {
      if (buffer.length === 0) return ''
      const out = `${reformatLine(buffer, now)}\n`
      buffer = ''
      return out
    },
  }
}

// Exported for tests. Format: `YYYY-MM-DD HH:MM:SS <rest>`. Falls back to the
// raw line if it doesn't look like a Docker `--timestamps` line, and falls
// back to `now()` if Docker's timestamp doesn't parse (defensive — shouldn't
// happen, but losing one timestamp shouldn't hide the log body).
export function reformatLine(line: string, now: () => Date = () => new Date()): string {
  const match = TIMESTAMP_RE.exec(line)
  if (!match) return line
  const [, raw, body] = match
  if (raw === undefined || body === undefined) return line
  const parsed = new Date(raw)
  const stamp = formatLocal(Number.isNaN(parsed.getTime()) ? now() : parsed)
  return `${stamp} ${body}`
}

function formatLocal(d: Date): string {
  const year = d.getFullYear()
  const month = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const hour = pad2(d.getHours())
  const minute = pad2(d.getMinutes())
  const second = pad2(d.getSeconds())
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
