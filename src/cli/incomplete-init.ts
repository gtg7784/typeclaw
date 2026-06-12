import { createLocalWizardCheckpointStore, type WizardCheckpointStore } from '@/init/checkpoint'
import { detectInitProgress, type DetectInitProgressOptions, type InitProgressStatus } from '@/init/progress'

export type IncompleteInitDecision = { kind: 'continue' } | { kind: 'block'; message: string } | { kind: 'prompt' }

const BLOCK_MESSAGE =
  'This agent looks half-initialized — a previous `typeclaw init` did not finish. ' +
  'Run `typeclaw init` in this directory to resume setup, then try again.'

// Pure policy: given the detected init progress and whether we have an
// interactive TTY, decide what start/restart should do. Kept free of I/O so
// the branch matrix is unit-testable without a real checkpoint or a TTY.
//   - none / complete-stale-checkpoint -> continue (the agent is fine; a stale
//     checkpoint is cleaned up by the caller, not a reason to block)
//   - incomplete + interactive          -> prompt the user
//   - incomplete + non-interactive      -> block with actionable guidance
export function resolveIncompleteInitDecision(
  status: InitProgressStatus,
  interactive: boolean,
): IncompleteInitDecision {
  if (status.kind !== 'incomplete') return { kind: 'continue' }
  return interactive ? { kind: 'prompt' } : { kind: 'block', message: BLOCK_MESSAGE }
}

export interface GuardIncompleteInitOptions {
  cwd: string
  interactive: boolean
  // Returns true to proceed with start anyway, false to abort. Only called for
  // the interactive `prompt` decision.
  confirmContinue: () => Promise<boolean>
  checkpointStore?: WizardCheckpointStore
  detectProgress?: (options: DetectInitProgressOptions) => Promise<InitProgressStatus>
}

export type GuardIncompleteInitResult =
  | { action: 'continue' }
  | { action: 'block'; message: string }
  | { action: 'abort' }

export async function guardIncompleteInit(options: GuardIncompleteInitOptions): Promise<GuardIncompleteInitResult> {
  const checkpointStore = options.checkpointStore ?? createLocalWizardCheckpointStore()
  const detect = options.detectProgress ?? detectInitProgress
  const status = await detect({ cwd: options.cwd, checkpointStore })

  // A checkpoint that outlived a hatched agent is stale (clear failed after a
  // successful init). Clean it up opportunistically so it never re-triggers.
  if (status.kind === 'complete-stale-checkpoint') {
    await checkpointStore.clear(options.cwd).catch(() => {})
  }

  const decision = resolveIncompleteInitDecision(status, options.interactive)
  if (decision.kind === 'continue') return { action: 'continue' }
  if (decision.kind === 'block') return { action: 'block', message: decision.message }

  const proceed = await options.confirmContinue()
  return proceed ? { action: 'continue' } : { action: 'abort' }
}
