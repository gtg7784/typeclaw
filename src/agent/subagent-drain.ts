import type { Stream, Unsubscribe } from '@/stream'

import type { LiveSubagentRegistry } from './live-subagents'
import { parseSubagentCompletedPayload, renderSubagentCompletionReminder } from './subagent-completion-reminder'

// Presence of this capability is the single signal that background spawning is
// permitted from a subagent (see the spawn_subagent guard); absence keeps the
// subagent a one-shot leaf. It carries everything the drain needs: the shared
// Stream to listen on, the subagent's own sessionId to filter completions by,
// and the registry that is the source of truth for child state.
export type SubagentBackgroundDrain = {
  stream: Stream
  sessionId: string
  liveRegistry: LiveSubagentRegistry
}

export type DrainPrompt = (text: string) => Promise<void>

export type RunSubagentDrainOptions = {
  drain: SubagentBackgroundDrain
  prompt: DrainPrompt
  // Cooperative cancellation: when this returns true the loop stops re-prompting
  // and returns, letting the caller's timeout/abort path dispose the session.
  cancelled?: () => boolean
}

// Re-prompts a subagent with its children's completion reminders until a fixed
// point, called after the subagent's initial prompt resolves. The registry is
// the source of truth; stream broadcasts are only wakeups, so a duplicated or
// missed broadcast cannot corrupt termination (every iteration re-derives state
// from the registry). Each child's reminder is delivered at most once (tracked
// by taskId). Terminates only when no children are running AND none are
// completed-but-undelivered; a child spawned during a reminder turn reappears as
// `running` in the next snapshot and keeps the loop alive, so no separate
// "spawned nothing" flag is needed. The watch MUST have been started before the
// initial prompt (see `beginSubagentDrainWatch`) to close the lost-wakeup race.
export async function runSubagentDrain(watch: SubagentDrainWatch, options: RunSubagentDrainOptions): Promise<void> {
  const { drain, prompt, cancelled } = options
  const delivered = new Set<string>()
  try {
    while (cancelled === undefined || !cancelled()) {
      const pending = collectPendingReminders(drain, delivered)
      if (pending.length === 0) {
        if (!hasRunningChildren(drain)) return
        // Children still running but none newly completed: wait for the next
        // wakeup, then re-derive from the registry.
        const woke = await watch.waitForWakeup()
        if (!woke) return
        continue
      }
      for (const reminder of pending) {
        if (cancelled !== undefined && cancelled()) return
        delivered.add(reminder.taskId)
        await prompt(reminder.text)
      }
    }
  } finally {
    watch.stop()
  }
}

type PendingReminder = { taskId: string; text: string }

function collectPendingReminders(drain: SubagentBackgroundDrain, delivered: Set<string>): PendingReminder[] {
  const children = drain.liveRegistry.list({ parentSessionId: drain.sessionId })
  const pending: PendingReminder[] = []
  for (const child of children) {
    if (child.status === 'running') continue
    if (delivered.has(child.taskId)) continue
    const completion = child.completion
    const text = renderSubagentCompletionReminder({
      subagent: child.subagentName,
      taskId: child.taskId,
      ok: child.status === 'completed',
      durationMs: completion?.durationMs ?? 0,
      ...(completion?.error !== undefined ? { error: completion.error } : {}),
    })
    pending.push({ taskId: child.taskId, text })
  }
  return pending
}

function hasRunningChildren(drain: SubagentBackgroundDrain): boolean {
  return drain.liveRegistry.list({ parentSessionId: drain.sessionId }).some((c) => c.status === 'running')
}

export type SubagentDrainWatch = {
  // Resolves true on a child-completion wakeup, false once stopped. A wakeup
  // that arrives before anyone waits is latched (pendingWake), so a completion
  // during the subagent's prompt is not lost.
  waitForWakeup: () => Promise<boolean>
  stop: () => void
}

export function beginSubagentDrainWatch(drain: SubagentBackgroundDrain): SubagentDrainWatch {
  let stopped = false
  let pendingWake = false
  let resolveWaiter: ((woke: boolean) => void) | null = null

  const wake = (): void => {
    if (resolveWaiter !== null) {
      const r = resolveWaiter
      resolveWaiter = null
      r(true)
      return
    }
    pendingWake = true
  }

  const unsubscribe: Unsubscribe = drain.stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const parsed = parseSubagentCompletedPayload(msg.payload)
    if (parsed === null) return
    if (parsed.parentSessionId !== drain.sessionId) return
    wake()
  })

  return {
    waitForWakeup: () =>
      new Promise<boolean>((resolve) => {
        if (stopped) {
          resolve(false)
          return
        }
        if (pendingWake) {
          pendingWake = false
          resolve(true)
          return
        }
        resolveWaiter = resolve
      }),
    stop: () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      if (resolveWaiter !== null) {
        const r = resolveWaiter
        resolveWaiter = null
        r(false)
      }
    },
  }
}
