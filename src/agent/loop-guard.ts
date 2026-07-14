import { posix } from 'node:path'

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
//    their signature to the path alone. Read calls additionally recognize one
//    assistant tool batch and successfully-observed forward pagination so
//    productive inspection does not look like a reactive cycle.
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

// The one tool with result-sensitive loop semantics: a poll returning 'running'
// is a legitimate wait, so its block is deferred until status is known (see
// `noteResult` / `deferable`). Kept as a local literal rather than importing the
// tool module to keep this primitive dependency-free; it must match
// SUBAGENT_OUTPUT_TOOL_NAME in tools/subagent-output.ts.
const SUBAGENT_OUTPUT_TOOL = 'subagent_output'

export type LoopReason = 'consecutive' | 'windowed'

// Identifies the single observation a `check` recorded so a caller can retract
// exactly that one after learning post-execution it was not a loop (e.g. a
// `subagent_output` poll that returned `status: 'running'`). Narrower than
// `forgetTool`, which drops the whole tool window: retract undoes one call, so
// unrelated task_ids and terminal-result polls keep their accumulated signal.
export type LoopGuardReceipt = {
  sessionId: string
  tool: string
  signature: string
  windowSignature: string
  recorded: boolean
  readPage?: ReadPage
}

export type LoopGuardCheckContext = {
  turnId?: number
  cwd?: string
}

// Post-execution classification of a `subagent_output` poll, fed back via
// `noteResult`. 'running' is a still-pending wait; 'terminal' is completed/failed
// — a repeated terminal poll is a real loop.
export type LoopObservedResult = 'running' | 'terminal'
export type ReadObservedResult = { nonEmpty: boolean; outputLines?: number; textual?: boolean }

export type LoopGuardDecision =
  | { kind: 'ok'; receipt: LoopGuardReceipt }
  | { kind: 'warn'; count: number; reason: LoopReason; message: string; receipt: LoopGuardReceipt }
  | { kind: 'block'; count: number; reason: LoopReason; message: string; receipt: LoopGuardReceipt; deferable: boolean }

// A decision before its receipt is attached. The detector helpers produce these;
// `check` stamps the receipt on at its single return site.
type Verdict =
  | { kind: 'ok' }
  | { kind: 'warn'; count: number; reason: LoopReason; message: string }
  | { kind: 'block'; count: number; reason: LoopReason; message: string }

export type LoopGuard = {
  check: (sessionId: string, tool: string, args: unknown, context?: LoopGuardCheckContext) => LoopGuardDecision
  reset: (sessionId: string) => void
  forget: (sessionId: string) => void
  // Clears only the residue a single tool left behind in a session: its entries
  // in the windowed history and, if the current consecutive streak belongs to
  // that tool, the streak itself. Used when a state-change boundary makes a
  // tool's prior calls irrelevant — e.g. a backgrounded subagent finishing
  // makes the next `subagent_output` fetch legitimate even though earlier
  // premature polls poisoned the window. Narrower than `forget`, so an
  // unrelated tool's accumulating loop on the same session is preserved.
  forgetTool: (sessionId: string, tool: string) => void
  // Undoes the one observation a prior `check` recorded, identified by its
  // receipt. Pops that signature from the windowed history and, when the
  // current consecutive streak is the call this receipt named, rewinds the
  // streak by one. Suppressed same-batch read receipts are explicit no-ops so
  // parallel sibling completion cannot retract the recorded observation. Used
  // post-execution for a
  // `subagent_output` poll that returned `status: 'running'` — a still-pending
  // wait, not a loop — so it never accumulates toward either detector.
  retract: (receipt: LoopGuardReceipt) => void
  // Records the post-execution class of a `subagent_output` poll. Once a
  // signature is seen 'terminal', `check` stops marking its blocks `deferable`,
  // so further identical polls hard-block PRE-execute instead of running again
  // just to re-confirm a completed task. 'running' clears any prior terminal
  // mark for that signature (a task can only move running→terminal, but a
  // signature can be reused across episodes).
  noteResult: (receipt: LoopGuardReceipt, result: LoopObservedResult) => void
  noteReadResult: (receipt: LoopGuardReceipt, result: ReadObservedResult) => void
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
  // Exact signatures whose `subagent_output` poll has been observed terminal.
  // A block on such a signature is enforced pre-execute (not deferred), so a
  // completed task is not re-polled forever just to re-learn it is done.
  termKnown: Set<string>
  // A model turn may emit several tool calls in one assistant message. Those
  // calls cannot react to one another's results, so same-path reads in that
  // batch count as one loop observation rather than a reactive cycle.
  readTurnId: number | undefined
  readPathsThisTurn: Set<string>
  // Observed contiguous line progress per recently-read canonical path.
  // Suppressed siblings may wait here for earlier siblings to complete, but
  // only exact adjacency advances the frontier.
  readFrontiers: Map<string, ReadProgress>
}

type ReadProgress = { frontier?: number; pending: Map<number, number> }

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

  function evaluateConsecutive(state: SessionState, tool: string): Verdict {
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

  function evaluateWindowed(state: SessionState, tool: string, windowSig: string): Verdict {
    const count = state.window.reduce((n, sig) => (sig === windowSig ? n + 1 : n), 0)
    if (count >= windowHardBlock) {
      return { kind: 'block', count, reason: 'windowed', message: formatWindowedBlockMessage(tool, count) }
    }
    if (count >= windowSoftWarn && !state.windowWarned.has(windowSig)) {
      state.windowWarned.add(windowSig)
      return { kind: 'warn', count, reason: 'windowed', message: formatWindowedWarnMessage(tool, count) }
    }
    return { kind: 'ok' }
  }

  function resolveVerdict(state: SessionState, tool: string, windowSig: string): Verdict {
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
  }

  return {
    check(sessionId, tool, args, context) {
      const signature = makeCallSignature(tool, args)
      const existing = sessions.get(sessionId)

      const state: SessionState = existing ?? {
        signature,
        count: 0,
        warned: false,
        window: [],
        windowWarned: new Set(),
        termKnown: new Set(),
        readTurnId: undefined,
        readPathsThisTurn: new Set(),
        readFrontiers: new Map(),
      }

      const readTarget = parseReadTarget(tool, args, context?.cwd)
      const readPage = parseReadPage(tool, args, context?.cwd)
      if (readTarget !== undefined && context?.turnId !== undefined) {
        if (readPathSeenThisTurn(state, readTarget.path, context.turnId, windowSize)) {
          const receipt: LoopGuardReceipt = {
            sessionId,
            tool,
            signature,
            windowSignature: readPathSignature(readTarget.path),
            recorded: false,
            ...(readPage !== undefined ? { readPage } : {}),
          }
          touch(sessionId, state)
          return { kind: 'ok', receipt }
        }
      }

      const windowSig = makeWindowSignature(tool, args, state, context?.cwd)
      const receipt: LoopGuardReceipt = {
        sessionId,
        tool,
        signature,
        windowSignature: windowSig,
        recorded: true,
        ...(readPage !== undefined ? { readPage } : {}),
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

      const verdict = resolveVerdict(state, tool, windowSig)
      if (verdict.kind === 'block') {
        // A `subagent_output` block is deferable (let the boundary call execute
        // to learn its status) only until this signature has proven terminal.
        const deferable = tool === SUBAGENT_OUTPUT_TOOL && !state.termKnown.has(signature)
        return { ...verdict, receipt, deferable }
      }
      return { ...verdict, receipt }
    },
    reset(sessionId) {
      sessions.delete(sessionId)
    },
    forget(sessionId) {
      sessions.delete(sessionId)
    },
    forgetTool(sessionId, tool) {
      const state = sessions.get(sessionId)
      if (state === undefined) return
      const retained: string[] = []
      for (const sig of state.window) {
        if (signatureBelongsToTool(sig, tool)) {
          state.windowWarned.delete(sig)
        } else {
          retained.push(sig)
        }
      }
      state.window = retained
      if (signatureBelongsToTool(state.signature, tool)) {
        state.signature = ''
        state.count = 0
        state.warned = false
      }
      for (const sig of state.termKnown) {
        if (signatureBelongsToTool(sig, tool)) state.termKnown.delete(sig)
      }
      if (tool === 'read') {
        state.readTurnId = undefined
        state.readPathsThisTurn.clear()
        state.readFrontiers.clear()
      }
    },
    retract(receipt) {
      if (!receipt.recorded) return
      const state = sessions.get(receipt.sessionId)
      if (state === undefined) return

      // Pop the receipt's windowed observation. It is the most recent push for
      // this signature (retraction runs immediately after the call's execute,
      // before any other tool runs on the session), so remove the last match.
      const lastIdx = state.window.lastIndexOf(receipt.windowSignature)
      if (lastIdx !== -1) {
        state.window.splice(lastIdx, 1)
        if (!state.window.includes(receipt.windowSignature)) {
          state.windowWarned.delete(receipt.windowSignature)
        }
      }

      // Rewind the consecutive streak by one only if it is still the call this
      // receipt named. A retracted soft-warned streak re-arms its warning so the
      // next genuine repeat warns as if this call never happened.
      if (state.signature === receipt.signature && state.count > 0) {
        state.count -= 1
        if (state.count < softWarn) state.warned = false
        if (state.count === 0) state.signature = ''
      }
    },
    noteResult(receipt, result) {
      if (!receipt.recorded) return
      const state = sessions.get(receipt.sessionId)
      if (state === undefined) return
      if (result === 'terminal') state.termKnown.add(receipt.signature)
      else state.termKnown.delete(receipt.signature)
    },
    noteReadResult(receipt, result) {
      const page = receipt.readPage
      if (page === undefined || !result.nonEmpty || result.textual === false) return
      const state = sessions.get(receipt.sessionId)
      if (state === undefined) return
      const span = result.outputLines
      if (span === undefined || !Number.isFinite(span) || span <= 0) return
      updateReadFrontier(state, page.path, page.offset, page.offset + span, receipt.recorded, windowSize)
    },
  }
}

// Both signature builders prefix the tool name: exact signatures as `tool:...`
// and path-coarsened ones as `tool#path:...`. A tool's residue is therefore any
// signature starting with `tool:` or `tool#`, never a different tool whose name
// merely shares this one as a prefix (the delimiter rules that out).
function signatureBelongsToTool(signature: string, tool: string): boolean {
  return signature.startsWith(`${tool}:`) || signature.startsWith(`${tool}#`)
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
function makeWindowSignature(tool: string, args: unknown, state: SessionState, cwd: string | undefined): string {
  const readPage = parseReadPage(tool, args, cwd)
  if (readPage !== undefined) {
    const coarse = readPathSignature(readPage.path)
    const previousFrontier = state.readFrontiers.get(readPage.path)?.frontier
    return previousFrontier !== undefined && readPage.offset === previousFrontier
      ? `${coarse}#frontier:${readPage.offset}`
      : coarse
  }

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

type ReadTarget = { path: string }
type ReadPage = ReadTarget & { offset: number; limit?: number }

function parseReadTarget(tool: string, args: unknown, cwd?: string): ReadTarget | undefined {
  if (tool !== 'read' || args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const path = PATH_ARG_KEYS.map((key) => record[key]).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  return path === undefined ? undefined : { path: canonicalizeReadPath(path, cwd) }
}

function parseReadPage(tool: string, args: unknown, cwd?: string): ReadPage | undefined {
  const target = parseReadTarget(tool, args, cwd)
  if (target === undefined || args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const { offset, limit } = record
  if (
    (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 1)) ||
    (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0))
  ) {
    return undefined
  }
  return {
    path: target.path,
    offset: typeof offset === 'number' ? offset : 1,
    ...(typeof limit === 'number' ? { limit } : {}),
  }
}

function readPathSignature(path: string): string {
  return `read#path:${path}`
}

function readPathSeenThisTurn(state: SessionState, path: string, turnId: number, maxReadPaths: number): boolean {
  if (state.readTurnId !== turnId) {
    state.readTurnId = turnId
    state.readPathsThisTurn.clear()
  }
  const seen = state.readPathsThisTurn.has(path)
  if (seen) state.readPathsThisTurn.delete(path)
  state.readPathsThisTurn.add(path)
  while (state.readPathsThisTurn.size > maxReadPaths) {
    const oldest = state.readPathsThisTurn.values().next().value
    if (oldest === undefined) break
    state.readPathsThisTurn.delete(oldest)
  }
  return seen
}

function updateReadFrontier(
  state: SessionState,
  path: string,
  observedStart: number,
  observedEnd: number,
  recorded: boolean,
  maxReadFrontiers: number,
): void {
  let progress = state.readFrontiers.get(path)
  if (progress === undefined) {
    progress = { pending: new Map() }
  }
  state.readFrontiers.delete(path)
  state.readFrontiers.set(path, progress)

  if (progress.frontier === undefined) {
    if (recorded) {
      progress.frontier = observedEnd
      drainContiguousReadIntervals(progress)
    } else {
      rememberReadInterval(progress, observedStart, observedEnd, maxReadFrontiers)
    }
  } else if (observedStart === progress.frontier) {
    progress.frontier = observedEnd
    drainContiguousReadIntervals(progress)
  } else if (!recorded && observedStart > progress.frontier) {
    rememberReadInterval(progress, observedStart, observedEnd, maxReadFrontiers)
  }

  while (state.readFrontiers.size > maxReadFrontiers) {
    const oldest = state.readFrontiers.keys().next().value
    if (oldest === undefined) break
    state.readFrontiers.delete(oldest)
  }
}

function rememberReadInterval(progress: ReadProgress, start: number, end: number, maxIntervals: number): void {
  const previousEnd = progress.pending.get(start)
  progress.pending.delete(start)
  progress.pending.set(start, previousEnd === undefined ? end : Math.max(previousEnd, end))
  while (progress.pending.size > maxIntervals) {
    const oldest = progress.pending.keys().next().value
    if (oldest === undefined) break
    progress.pending.delete(oldest)
  }
}

function drainContiguousReadIntervals(progress: ReadProgress): void {
  let frontier = progress.frontier
  if (frontier === undefined) return
  for (const start of progress.pending.keys()) {
    if (start < frontier) progress.pending.delete(start)
  }
  let nextEnd = progress.pending.get(frontier)
  while (nextEnd !== undefined) {
    progress.pending.delete(frontier)
    frontier = nextEnd
    progress.frontier = frontier
    nextEnd = progress.pending.get(frontier)
  }
}

function canonicalizeReadPath(path: string, cwd?: string): string {
  const normalizedPath = path.replaceAll('\\', '/')
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath)) {
    return posix.normalize(normalizedPath)
  }
  if (cwd === undefined) return posix.normalize(normalizedPath)
  return posix.normalize(`${cwd.replaceAll('\\', '/')}/${normalizedPath}`)
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
