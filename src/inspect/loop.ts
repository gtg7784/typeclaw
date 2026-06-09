import { resolveInspectTarget, type RunInspectOptions, type RunInspectResult, streamInspectTarget } from './index'

export type TailController = {
  signal: AbortSignal
  intent: () => 'back' | 'exit' | null
  dispose: () => void
}

export type OpenItemContext = {
  createTailScope: () => TailController
}

// `refresh` (the `r` key) re-lists and re-renders the picker without opening
// anything; `highlightKey` is the row highlighted when `r` was pressed, so the
// selection survives the refresh.
export type SelectOutcome<TItem> =
  | { kind: 'picked'; item: TItem }
  | { kind: 'cancelled' }
  | { kind: 'refresh'; highlightKey?: string }

export type SelectItem<TItem> = (items: TItem[], opts: { initialKey?: string }) => Promise<SelectOutcome<TItem>>

export type OpenItemResult = {
  result: RunInspectResult
  // True only when the viewer that just closed ended a writable (live TUI)
  // session — i.e. a tui detach. Logs and read-only transcripts return
  // escToPicker WITHOUT this, so they must not suppress the writable row.
  endedWritableSession?: boolean
}

export type OpenItem<TItem> = (item: TItem, ctx: OpenItemContext) => Promise<OpenItemResult>

export type ListItemsContext = {
  // False once the user has returned to the picker from any viewer: the prior
  // viewer interaction ended, so there is no proof of a still-live writable
  // session — a detached tui session must not be re-promoted as writable.
  allowWritable: boolean
}

export type RunViewerLoopOptions<TItem> = {
  listItems: (ctx: ListItemsContext) => Promise<TItem[]>
  keyOf: (item: TItem) => string
  preselectKey?: string
  selectItem: SelectItem<TItem>
  openItem: OpenItem<TItem>
  createTailScope: () => TailController
  onEmpty: () => RunInspectResult
}

// The session-viewer state machine: pick an item → open it → on back, re-open
// the picker; on exit, return. `openItem` owns the per-branch lifecycle and
// decides whether to request a tail scope (session/logs do; tui does not, since
// it owns its own raw-mode terminal). When used, the tail scope is created
// inside `openItem` AFTER the picker resolves and disposed before the picker
// re-opens, so clack always owns a clean cooked-mode stdin.
export async function runViewerLoop<TItem>(opts: RunViewerLoopOptions<TItem>): Promise<RunInspectResult> {
  // `preselectKey` auto-opens a row once (the `inspect <id>` arg). `highlightKey`
  // only seeds the picker's initial highlight (esc-return + `r` refresh) and
  // never bypasses the picker — keeping the two apart is what lets refresh
  // re-render the list instead of re-opening the last viewer.
  let preselectKey = opts.preselectKey
  let highlightKey: string | undefined
  // Writable is only safe on the very first list. Returning to the picker means
  // a viewer was just opened and left — any writable session it might represent
  // is gone (detach ends the live session), so subsequent refreshes are
  // read-only.
  let allowWritable = true

  while (true) {
    const items = await opts.listItems({ allowWritable })
    if (items.length === 0) return opts.onEmpty()

    let chosen: TItem
    if (preselectKey !== undefined) {
      const match = items.find((i) => opts.keyOf(i) === preselectKey) ?? null
      preselectKey = undefined
      if (match === null) return opts.onEmpty()
      chosen = match
    } else {
      const outcome = await opts.selectItem(items, highlightKey !== undefined ? { initialKey: highlightKey } : {})
      if (outcome.kind === 'cancelled') return { ok: false, exitCode: 130, reason: 'cancelled' }
      if (outcome.kind === 'refresh') {
        if (outcome.highlightKey !== undefined) highlightKey = outcome.highlightKey
        continue
      }
      chosen = outcome.item
      highlightKey = opts.keyOf(chosen)
    }

    const opened = await opts.openItem(chosen, { createTailScope: opts.createTailScope })
    const result = opened.result
    if (!result.ok) return result
    if (result.escToPicker !== true) return result
    // Only a writable (tui) detach ends the live session; leaving logs or a
    // read-only transcript leaves it untouched, so the writable row stays.
    if (opened.endedWritableSession === true) allowWritable = false
  }
}

export type RunInspectLoopOptions = Omit<RunInspectOptions, 'signal'> & {
  // Builds a fresh interaction scope for ONE live-tail attempt: a new
  // AbortController plus a temporary raw-mode listener. The loop creates it
  // only AFTER the picker has resolved a session and disposes it before the
  // picker re-opens, so clack always owns a clean, non-raw stdin — this is what
  // replaces the old pause/resume-same-controller model.
  createTailScope: () => TailController
}

export async function runInspectLoop(opts: RunInspectLoopOptions): Promise<RunInspectResult> {
  let sessionArg = opts.sessionIdOrPrefix
  let lastPickedId: string | undefined
  const wrappedSelectSession: typeof opts.selectSession = async (sessions, selectOpts) => {
    const hint = selectOpts?.initialSessionId ?? lastPickedId
    const picked = await opts.selectSession(sessions, hint !== undefined ? { initialSessionId: hint } : {})
    if (picked !== null) lastPickedId = picked.sessionId
    return picked
  }

  while (true) {
    const resolveOpts: Omit<RunInspectOptions, 'signal'> = { ...opts, selectSession: wrappedSelectSession }
    if (sessionArg !== undefined) resolveOpts.sessionIdOrPrefix = sessionArg
    else delete (resolveOpts as { sessionIdOrPrefix?: string }).sessionIdOrPrefix

    const resolved = await resolveInspectTarget(resolveOpts)
    if (!resolved.ok) return resolved

    const scope = opts.createTailScope()
    let result: RunInspectResult
    try {
      result = await streamInspectTarget({ ...opts, target: resolved.target, signal: scope.signal })
    } finally {
      scope.dispose()
    }

    if (!result.ok) return result
    if (scope.intent() === 'exit') return result
    if (result.escToPicker !== true) return result
    sessionArg = undefined
  }
}
