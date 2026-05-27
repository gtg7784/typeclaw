import { readFile } from 'node:fs/promises'
import { createInterface, type Interface } from 'node:readline'
import { type Readable } from 'node:stream'

import { isCancel, log } from '@clack/prompts'

const BEGIN_MARKER = '-----BEGIN'
const END_MARKER_RE = /^-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/
const END_MARKER_INLINE_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/

export const CANCEL_SYMBOL = Symbol('cancel')

export type ReadLineFn = () => Promise<string | typeof CANCEL_SYMBOL>

export async function promptPrivateKeyPem(message: string): Promise<string | typeof CANCEL_SYMBOL> {
  log.step(message)
  log.message('Paste the PEM (including BEGIN/END lines), a path to a .pem file, or an escaped PEM.')

  const reader = createStdinLineReader()
  try {
    const raw = await readPrivateKeyFromLines(reader.next)
    if (raw === CANCEL_SYMBOL) return CANCEL_SYMBOL
    return await resolvePrivateKeyInput(raw)
  } finally {
    reader.close()
  }
}

/**
 * Read a PEM block (or single-line value) using `readLine`.
 *
 * A line starting with `-----BEGIN` switches into block mode, accumulating
 * until a line matches `-----END ... PRIVATE KEY-----`. Otherwise the first
 * non-empty line is returned verbatim (path or escaped PEM). Leading blank
 * lines are skipped so a stray Enter does not abort the prompt.
 */
export async function readPrivateKeyFromLines(readLine: ReadLineFn): Promise<string | typeof CANCEL_SYMBOL> {
  let first: string
  while (true) {
    const line = await readLine()
    if (line === CANCEL_SYMBOL) return CANCEL_SYMBOL
    if (line.trim().length > 0) {
      first = line
      break
    }
  }

  if (!first.trimStart().startsWith(BEGIN_MARKER)) return first.trim()

  // Escaped-PEM pasted as one line (contains both BEGIN and END markers and
  // no real newlines) bypasses block mode entirely.
  if (END_MARKER_INLINE_RE.test(first)) return first.trim()

  const lines: string[] = [first.trimEnd()]
  while (true) {
    const line = await readLine()
    if (line === CANCEL_SYMBOL) return CANCEL_SYMBOL
    const trimmed = line.trimEnd()
    lines.push(trimmed)
    if (END_MARKER_RE.test(trimmed)) break
  }
  return `${lines.join('\n')}\n`
}

export async function resolvePrivateKeyInput(input: string): Promise<string> {
  const unescaped = input.includes('\\n') && !input.includes('\n') ? input.replace(/\\n/g, '\n') : input
  if (unescaped.includes('-----BEGIN') && unescaped.includes('PRIVATE KEY-----')) return unescaped
  return await readFile(input, 'utf8')
}

type StdinLineReader = {
  next: ReadLineFn
  close: () => void
}

function createStdinLineReader(): StdinLineReader {
  return createReadlineLineReader(process.stdin)
}

export function createReadlineLineReader(input: NodeJS.ReadableStream | Readable): StdinLineReader {
  const rl: Interface = createInterface({ input, terminal: false })
  const queue: string[] = []
  const waiters: ((value: string | typeof CANCEL_SYMBOL) => void)[] = []
  let closed = false

  rl.on('line', (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else queue.push(line)
  })
  rl.on('close', () => {
    closed = true
    for (const w of waiters.splice(0)) w(CANCEL_SYMBOL)
  })

  const next: ReadLineFn = () =>
    new Promise((resolve) => {
      const queued = queue.shift()
      if (queued !== undefined) {
        resolve(queued)
        return
      }
      if (closed) {
        resolve(CANCEL_SYMBOL)
        return
      }
      waiters.push(resolve)
    })

  return {
    next,
    close: () => rl.close(),
  }
}

export { isCancel }
