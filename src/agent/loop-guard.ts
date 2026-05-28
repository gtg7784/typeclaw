// Detects when the model calls the same tool with byte-identical arguments in
// a tight streak — the classic "stuck in a thought-loop" failure where the
// agent repeats `bash("ls")` or `read("foo.ts")` indefinitely waiting for a
// different answer. Two-tier escalation:
//
//   - At LOOP_SOFT_WARN consecutive identical calls (default 3), the next call
//     completes normally but the wrapped tool's output is suffixed with a nudge
//     telling the model it's looping. Soft warning fires ONCE per streak so
//     the model isn't drowning in identical reminders.
//   - At LOOP_HARD_BLOCK consecutive identical calls (default 5), the call is
//     refused outright. The wrapping in plugin-tools.ts maps the refusal to
//     `errorResult` for plugin tools (the model sees a tool error and must
//     change strategy) and to a thrown Error for system / pi-builtin tools
//     (matches the existing `tool.before { block: true }` plumbing).
//
// State is per-session and bounded: the guard keeps at most MAX_SESSIONS
// session entries with LRU eviction, and each session holds at most one
// signature + counter (we only care about the current tail streak). When a
// different tool/args combination arrives, the streak resets to 1.
//
// The detector is intentionally placed INSIDE the tool wrappers (not as a
// `tool.before` plugin) so it covers every tool category — plugin tools,
// TypeClaw system tools, and pi-coding-agent builtins — through one chokepoint.

export const LOOP_SOFT_WARN = 3
export const LOOP_HARD_BLOCK = 5

// Caps in-process memory across many sessions. Each entry is small
// (signature string + small counters), so this bound is generous; we just
// don't want unbounded growth if sessionIds churn.
const MAX_SESSIONS = 256

export type LoopGuardDecision =
  | { kind: 'ok' }
  | { kind: 'warn'; count: number; message: string }
  | { kind: 'block'; count: number; message: string }

export type LoopGuard = {
  check: (sessionId: string, tool: string, args: unknown) => LoopGuardDecision
  reset: (sessionId: string) => void
  forget: (sessionId: string) => void
}

type SessionState = {
  signature: string
  count: number
  // Fires the soft warning exactly once per streak instead of every call
  // from the 3rd onwards. Re-arms when the streak breaks.
  warned: boolean
}

export type CreateLoopGuardOptions = {
  softWarn?: number
  hardBlock?: number
  maxSessions?: number
}

export function createLoopGuard(options: CreateLoopGuardOptions = {}): LoopGuard {
  const softWarn = options.softWarn ?? LOOP_SOFT_WARN
  const hardBlock = options.hardBlock ?? LOOP_HARD_BLOCK
  const maxSessions = options.maxSessions ?? MAX_SESSIONS

  if (softWarn < 2) throw new Error(`loop-guard: softWarn must be >= 2 (got ${softWarn})`)
  if (hardBlock <= softWarn) {
    throw new Error(`loop-guard: hardBlock (${hardBlock}) must be greater than softWarn (${softWarn})`)
  }

  // Map preserves insertion order; we rely on that for LRU eviction.
  const sessions = new Map<string, SessionState>()

  function touch(sessionId: string, state: SessionState): void {
    sessions.delete(sessionId)
    sessions.set(sessionId, state)
    if (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
  }

  return {
    check(sessionId, tool, args) {
      const signature = makeCallSignature(tool, args)
      const existing = sessions.get(sessionId)

      if (!existing || existing.signature !== signature) {
        touch(sessionId, { signature, count: 1, warned: false })
        return { kind: 'ok' }
      }

      const nextCount = existing.count + 1
      const nextState: SessionState = {
        signature,
        count: nextCount,
        warned: existing.warned,
      }

      if (nextCount >= hardBlock) {
        touch(sessionId, nextState)
        return {
          kind: 'block',
          count: nextCount,
          message: formatBlockMessage(tool, nextCount),
        }
      }

      if (nextCount >= softWarn && !nextState.warned) {
        nextState.warned = true
        touch(sessionId, nextState)
        return {
          kind: 'warn',
          count: nextCount,
          message: formatWarnMessage(tool, nextCount),
        }
      }

      touch(sessionId, nextState)
      return { kind: 'ok' }
    },
    reset(sessionId) {
      const existing = sessions.get(sessionId)
      if (!existing) return
      // Resetting is what `tool.after` does on a non-identical call too;
      // exposed for callers that observe a strategy change externally.
      sessions.delete(sessionId)
    },
    forget(sessionId) {
      sessions.delete(sessionId)
    },
  }
}

function formatWarnMessage(tool: string, count: number): string {
  return (
    `\n\n[loop-guard] You have called \`${tool}\` ${count} times in a row with identical arguments. ` +
    `This looks like a thought-loop. If you have enough information, produce the final answer now. ` +
    `If something is unclear, ask the user one specific question. Do not repeat this exact call.`
  )
}

function formatBlockMessage(tool: string, count: number): string {
  return (
    `loop-guard: refused \`${tool}\` — identical call repeated ${count} times in a row. ` +
    `Stop. Either (1) produce the final answer with the data you already have, ` +
    `(2) ask the user a clarifying question, or (3) try a meaningfully different approach. ` +
    `Do not retry this exact call.`
  )
}

function makeCallSignature(tool: string, args: unknown): string {
  try {
    return `${tool}:${stableStringify(args)}`
  } catch {
    return `${tool}:<unstringifiable>`
  }
}

// Order-independent JSON serialization so semantically-identical objects
// produce identical signatures regardless of key insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value)
    return s ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
