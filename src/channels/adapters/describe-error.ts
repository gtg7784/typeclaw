// A WebSocket 'error' fires with an `ErrorEvent`, NOT an `Error`, so
// `String(err)` yields the useless `[object ErrorEvent]`. Dig the real reason
// out of `.message`/nested `.error` (same trap as `describeWsErrorEvent` in
// `src/cli/tunnel.ts`), unwrapping `AggregateError` and `.cause` chains.

const MAX_DEPTH = 4

export function describeError(err: unknown): string {
  const message = extract(err, 0)
  return message ?? String(err)
}

function extract(err: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return null

  if (err instanceof Error) {
    if (err instanceof AggregateError && err.errors.length > 0) {
      const inner = err.errors.map((e) => extract(e, depth + 1) ?? String(e)).join('; ')
      if (err.message !== '') return `${err.message}: ${inner}`
      return inner
    }
    if (err.message !== '') return err.message
    if (err.cause !== undefined) return extract(err.cause, depth + 1)
    return err.name
  }

  if (typeof err === 'string') return err === '' ? null : err

  if (typeof err === 'object' && err !== null) {
    const { message, error } = err as { message?: unknown; error?: unknown }
    if (typeof message === 'string' && message !== '') return message
    if (error !== undefined && error !== err) {
      const nested = extract(error, depth + 1)
      if (nested !== null) return nested
    }
    return null
  }

  return null
}
