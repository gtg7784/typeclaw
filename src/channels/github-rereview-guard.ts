import { classifyReviewClaim } from './github-review-claim'
import type { ReviewStateResult } from './types'

// The re-review stranding guard. A bot that resolves a review thread (or posts a
// close-out ack) while it still holds its own sticky CHANGES_REQUESTED leaves the
// PR blocked forever — the resolve/ack carries no review state, so GitHub's
// reviewDecision never clears (PR #644). This guard blocks that close-out and
// tells the model to land a formal APPROVE / dismissal first.
//
// It is the same enforcement seam as the false-receipt guard and the
// resolve-thread author check: BLOCK and instruct, never act on the model's
// behalf — the runtime cannot prove a semantic approval from "one thread closed".

export type RereviewGuardInput = {
  adapter: string
  chat: string
  thread: string | null
  text: string | undefined
  wantsResolve: boolean
  getReviewState: (req: { adapter: 'github'; workspace: string; chat: string }) => Promise<ReviewStateResult>
  workspace: string
}

export type RereviewGuardDecision = { block: false } | { block: true; reason: string }

const ALLOW: RereviewGuardDecision = { block: false }

export async function evaluateRereviewGuard(input: RereviewGuardInput): Promise<RereviewGuardDecision> {
  if (input.adapter !== 'github') return ALLOW
  if (!/^pr:\d+$/.test(input.chat)) return ALLOW
  if (input.thread === null) return ALLOW
  if (!isCloseoutAttempt(input.wantsResolve, input.text)) return ALLOW

  const state = await input.getReviewState({ adapter: 'github', workspace: input.workspace, chat: input.chat })

  // Fail closed: an unverifiable review state is treated as a live block, so the
  // bot never strands a re-review on a transient API failure.
  if (!state.ok) return { block: true, reason: unverifiableReason(state.error) }
  if (!state.selfBlocking) return ALLOW

  return { block: true, reason: state.approve ? STICKY_BLOCK_APPROVE_ENABLED : STICKY_BLOCK_APPROVE_DISABLED }
}

// Trigger when the model asks to resolve the thread, OR when its reply reads as a
// close-out/verdict claim even without the flag — both strand the block if the
// bot still owes a verdict. Plain discussion replies (ignore/warn) do not fire.
function isCloseoutAttempt(wantsResolve: boolean, text: string | undefined): boolean {
  if (wantsResolve) return true
  const claim = classifyReviewClaim(text ?? '')
  return claim === 'block-resolve' || claim === 'block-approve'
}

function unverifiableReason(error: string): string {
  return (
    'Could not verify whether your prior CHANGES_REQUESTED on this PR is still live ' +
    `(${error}). Refusing to close out the thread while the block state is unknown — ` +
    'retry once the GitHub API is reachable, or land a formal review verdict first.'
  )
}

const STICKY_BLOCK_APPROVE_ENABLED =
  'You still hold a CHANGES_REQUESTED on this PR. Resolving the thread (or posting a close-out ack) ' +
  'does NOT clear it — only a fresh formal review does. Submit `APPROVE` via ' +
  '`gh api -X POST /repos/<owner>/<repo>/pulls/<N>/reviews` (event: APPROVE) if the blockers are fixed, ' +
  'or `REQUEST_CHANGES` if not, THEN resolve the thread / reply.'

const STICKY_BLOCK_APPROVE_DISABLED =
  'You still hold a CHANGES_REQUESTED on this PR and resolving the thread does NOT clear it. ' +
  'Approval is disabled for this agent (channels.github.review.approve: false), so you cannot APPROVE — ' +
  'dismiss your prior review via ' +
  '`gh api -X PUT /repos/<owner>/<repo>/pulls/<N>/reviews/<review_id>/dismissals -f message="..." -f event=DISMISS` ' +
  'if the blockers are fixed (or submit REQUEST_CHANGES if not), THEN resolve the thread / reply.'
