// Detects when the model is stuck looping on tool calls. Two independent
// detectors run per call; the more severe decision wins.
//
// 1. Consecutive-identical (reason: 'consecutive') — catches the tight loop
//    where the agent repeats `bash("ls")` byte-for-byte waiting for a different
//    answer. Soft-warn at LOOP_SOFT_WARN (3), hard-block at LOOP_HARD_BLOCK (5).
//
// 2. Windowed-frequency (reason: 'windowed') — catches interleaved cycles the
//    consecutive detector cannot see, e.g. read(a)→edit(b)→read(a)→edit(b)…, or
//    re-reading one file with drifting offsets. Over a sliding window of the
//    last WINDOW_SIZE calls, if one signature recurs WINDOW_SOFT_WARN times it
//    warns and WINDOW_HARD_BLOCK times it blocks. Path-bearing tools coarsen
//    their signature to the path alone (offsets/limits/line ranges dropped) so
//    that paging the same file in a cycle collapses to one signature.
//
// Both warn/block decisions carry the byte-identical or coarsened nudge text.
// The wrapping in plugin-tools.ts maps a block to `errorResult` for plugin tools
// and to a thrown Error for system / pi-builtin tools (matching the existing
// `tool.before { block: true }` plumbing).
//
// State is per-session and bounded by MAX_SESSIONS with LRU eviction. The
// detector is intentionally placed INSIDE the tool wrappers (not as a
// `tool.before` plugin) so it covers every tool category — plugin tools,
// TypeClaw system tools, and pi-coding-agent builtins — through one chokepoint.

export const LOOP_SOFT_WARN = 3
export const LOOP_HARD_BLOCK = 5

export const WINDOW_SIZE = 16
export const WINDOW_SOFT_WARN = 4
export const WINDOW_HARD_BLOCK = 6

// Tools whose first path-like argument identifies the target. Their windowed
// signature keys on that path alone so paging one file with drifting
// offset/limit collapses to a single signature. Two classes, because the
// builtins differ in whether the path is required:
//
//   - REQUIRED-path tools (read/write/edit): path is mandatory. Coarsen only
//     when a path key is present; an absent path is malformed input, not a
//     default, so we must NOT collapse such calls to a shared target.
//   - DEFAULT-path tools (grep/find/ls): path is OPTIONAL and defaults to the
//     cwd ("."). Omitting the path and varying only non-target args (pattern,
//     limit) still hits the same directory, so an omitted/empty path coarsens
//     to `${tool}#path:.` — otherwise those calls would evade the detector.
//
// `glob` is intentionally absent: pi-coding-agent has no `glob` builtin (the
// glob-pattern arg lives inside grep/find), so listing it here matched nothing.
const REQUIRED_PATH_TOOLS = new Set(['read', 'write', 'edit'])
const DEFAULT_PATH_TOOLS = new Set(['grep', 'find', 'ls'])
const PATH_ARG_KEYS = ['path', 'file', 'filePath', 'filename']
const DEFAULT_PATH_TARGET = '.'

const MAX_SESSIONS = 256

export type LoopReason = 'consecutive' | 'windowed'

export type LoopGuardDecision =
  | { kind: 'ok' }
  | { kind: 'warn'; count: number; reason: LoopReason; message: string }
  | { kind: 'block'; count: number; reason: LoopReason; message: string }

export type LoopGuard = {
  check: (sessionId: string, tool: string, args: unknown) => LoopGuardDecision
  reset: (sessionId: string) => void
  forget: (sessionId: string) => void
}

type SessionState = {
  // Consecutive-identical streak: the current tail signature, its run length,
  // and whether this streak already emitted its one soft warning.
  signature: string
  count: number
  warned: boolean
  // Windowed history: the last WINDOW_SIZE coarsened signatures, plus the set
  // of signatures that already emitted their one windowed soft warning while
  // still present in the window.
  window: string[]
  windowWarned: Set<string>
}

export type CreateLoopGuardOptions = {
  softWarn?: number
  hardBlock?: number
  maxSessions?: number
  windowSize?: number
  windowSoftWarn?: number
  windowHardBlock?: number
}

export function createLoopGuard(options: CreateLoopGuardOptions = {}): LoopGuard {
  const softWarn = options.softWarn ?? LOOP_SOFT_WARN
  const hardBlock = options.hardBlock ?? LOOP_HARD_BLOCK
  const maxSessions = options.maxSessions ?? MAX_SESSIONS
  const windowSize = options.windowSize ?? WINDOW_SIZE
  const windowSoftWarn = options.windowSoftWarn ?? WINDOW_SOFT_WARN
  const windowHardBlock = options.windowHardBlock ?? WINDOW_HARD_BLOCK

  if (softWarn < 2) throw new Error(`loop-guard: softWarn must be >= 2 (got ${softWarn})`)
  if (hardBlock <= softWarn) {
    throw new Error(`loop-guard: hardBlock (${hardBlock}) must be greater than softWarn (${softWarn})`)
  }
  if (windowSoftWarn < 2) {
    throw new Error(`loop-guard: windowSoftWarn must be >= 2 (got ${windowSoftWarn})`)
  }
  if (windowHardBlock <= windowSoftWarn) {
    throw new Error(
      `loop-guard: windowHardBlock (${windowHardBlock}) must be greater than windowSoftWarn (${windowSoftWarn})`,
    )
  }
  if (windowSize < 2) throw new Error(`loop-guard: windowSize must be >= 2 (got ${windowSize})`)
  if (windowSize < windowHardBlock) {
    throw new Error(
      `loop-guard: windowSize (${windowSize}) must be >= windowHardBlock (${windowHardBlock}) for the block to be reachable`,
    )
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

  function evaluateConsecutive(state: SessionState, tool: string): LoopGuardDecision {
    if (state.count >= hardBlock) {
      return {
        kind: 'block',
        count: state.count,
        reason: 'consecutive',
        message: formatBlockMessage(tool, state.count),
      }
    }
    if (state.count >= softWarn && !state.warned) {
      state.warned = true
      return { kind: 'warn', count: state.count, reason: 'consecutive', message: formatWarnMessage(tool, state.count) }
    }
    return { kind: 'ok' }
  }

  function evaluateWindowed(state: SessionState, tool: string, windowSig: string): LoopGuardDecision {
    const count = state.window.reduce((n, sig) => (sig === windowSig ? n + 1 : n), 0)
    if (count >= windowHardBlock) {
      return {
        kind: 'block',
        count,
        reason: 'windowed',
        message: formatWindowedBlockMessage(tool, count),
      }
    }
    if (count >= windowSoftWarn && !state.windowWarned.has(windowSig)) {
      state.windowWarned.add(windowSig)
      return {
        kind: 'warn',
        count,
        reason: 'windowed',
        message: formatWindowedWarnMessage(tool, count),
      }
    }
    return { kind: 'ok' }
  }

  return {
    check(sessionId, tool, args) {
      const signature = makeCallSignature(tool, args)
      const windowSig = makeWindowSignature(tool, args)
      const existing = sessions.get(sessionId)

      const state: SessionState = existing ?? {
        signature,
        count: 0,
        warned: false,
        window: [],
        windowWarned: new Set(),
      }

      if (state.signature !== signature) {
        state.signature = signature
        state.count = 1
        state.warned = false
      } else {
        state.count += 1
      }

      state.window.push(windowSig)
      if (state.window.length > windowSize) {
        const evicted = state.window.shift()
        if (evicted !== undefined && !state.window.includes(evicted)) {
          state.windowWarned.delete(evicted)
        }
      }

      touch(sessionId, state)

      const consecutive = evaluateConsecutive(state, tool)
      if (consecutive.kind === 'block') return consecutive

      // Back-to-back identical calls are the consecutive detector's domain; let
      // it own them so a tight streak doesn't also trip the windowed detector.
      // The windowed detector exists for INTERLEAVED cycles, so it only acts
      // when this call breaks the immediate streak (count === 1).
      const windowed = state.count === 1 ? evaluateWindowed(state, tool, windowSig) : { kind: 'ok' as const }
      if (windowed.kind === 'block') return windowed
      if (consecutive.kind === 'warn') return consecutive
      if (windowed.kind === 'warn') return windowed
      return { kind: 'ok' }
    },
    reset(sessionId) {
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

function formatWindowedWarnMessage(tool: string, count: number): string {
  return (
    `\n\n[loop-guard] You have called \`${tool}\` on the same target ${count} times in a short span. ` +
    `This looks like a cycle — revisiting the same work without making progress. ` +
    `If you have enough information, produce the final answer now. ` +
    `Otherwise change approach instead of repeating this call.`
  )
}

function formatWindowedBlockMessage(tool: string, count: number): string {
  return (
    `loop-guard: refused \`${tool}\` — called on the same target ${count} times in a short span. ` +
    `You are cycling on the same work. Stop. Either (1) produce the final answer with the data you already have, ` +
    `(2) ask the user a clarifying question, or (3) try a meaningfully different approach. ` +
    `Do not keep re-running this on the same target.`
  )
}

function makeCallSignature(tool: string, args: unknown): string {
  try {
    return `${tool}:${stableStringify(args)}`
  } catch {
    return `${tool}:<unstringifiable>`
  }
}

// Coarsened signature for windowed detection: path-bearing tools key on their
// target path alone so re-reading one target with drifting non-path args
// collapses to a single signature. All other tools fall back to the exact
// signature.
function makeWindowSignature(tool: string, args: unknown): string {
  const isRequiredPath = REQUIRED_PATH_TOOLS.has(tool)
  const isDefaultPath = DEFAULT_PATH_TOOLS.has(tool)
  if ((isRequiredPath || isDefaultPath) && args !== null && typeof args === 'object') {
    const record = args as Record<string, unknown>
    for (const key of PATH_ARG_KEYS) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return `${tool}#path:${value}`
    }
    // No explicit path. For default-path tools the effective target is the cwd,
    // so coarsen to it; for required-path tools we leave the call uncoarsened.
    if (isDefaultPath) return `${tool}#path:${DEFAULT_PATH_TARGET}`
  }
  return makeCallSignature(tool, args)
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
