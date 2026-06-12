import type { WizardAnswerCheckpointV1, WizardCheckpointStore } from './checkpoint'
import { isHatched } from './index'

export type InitProgressStatus =
  | { kind: 'none' }
  | { kind: 'incomplete'; checkpoint: WizardAnswerCheckpointV1 }
  | { kind: 'complete-stale-checkpoint'; checkpoint: WizardAnswerCheckpointV1 }

export interface DetectInitProgressOptions {
  cwd: string
  checkpointStore: WizardCheckpointStore
  isHatched?: (dir: string) => Promise<boolean>
}

// Single shared predicate for "is this init incomplete?", consumed by both the
// init resume-prompt and the start/restart launchers so the two never drift.
//
// `isHatched` is the completion authority — NOT the presence of node_modules,
// Dockerfile, or typeclaw.json, which are intermediate artifacts that start can
// regenerate. A checkpoint that outlives a hatched agent (clear failed after a
// successful run) is reported as `complete-stale-checkpoint` so callers can
// opportunistically clean it up instead of falsely blocking a working agent.
export async function detectInitProgress(options: DetectInitProgressOptions): Promise<InitProgressStatus> {
  const hatchedCheck = options.isHatched ?? isHatched
  const checkpoint = await options.checkpointStore.load(options.cwd)
  if (checkpoint === undefined) return { kind: 'none' }
  if (await hatchedCheck(options.cwd)) return { kind: 'complete-stale-checkpoint', checkpoint }
  return { kind: 'incomplete', checkpoint }
}
