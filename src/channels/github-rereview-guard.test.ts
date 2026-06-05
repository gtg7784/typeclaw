import { describe, expect, it } from 'bun:test'

import { evaluateRereviewGuard, type RereviewGuardInput } from './github-rereview-guard'

function input(overrides: Partial<RereviewGuardInput> = {}): RereviewGuardInput {
  return {
    adapter: 'github',
    chat: 'pr:644',
    thread: '12345',
    text: 'Verified — that closes it, thanks!',
    wantsResolve: true,
    workspace: 'acme/widgets',
    getReviewState: async () => ({ ok: true, selfBlocking: true, approve: true }),
    ...overrides,
  }
}

const stateOk =
  (selfBlocking: boolean, approve = true): RereviewGuardInput['getReviewState'] =>
  async () => ({ ok: true, selfBlocking, approve })

describe('re-review stranding guard', () => {
  it('blocks a resolve while the bot holds a live CHANGES_REQUESTED (PR #644 scenario)', async () => {
    const decision = await evaluateRereviewGuard(input({ getReviewState: stateOk(true) }))
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('APPROVE')
  })

  it('allows the resolve once the bot no longer blocks the PR', async () => {
    const decision = await evaluateRereviewGuard(input({ getReviewState: stateOk(false) }))
    expect(decision).toEqual({ block: false })
  })

  it('branches the denial to dismissal when approval is disabled', async () => {
    const decision = await evaluateRereviewGuard(input({ getReviewState: stateOk(true, false) }))
    expect(decision.block).toBe(true)
    if (decision.block) {
      expect(decision.reason).toContain('dismiss')
      expect(decision.reason).not.toContain('event: APPROVE')
    }
  })

  it('fails closed when review state cannot be verified', async () => {
    const decision = await evaluateRereviewGuard(
      input({ getReviewState: async () => ({ ok: false, error: 'GitHub reviews 503', code: 'transient' }) }),
    )
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('Could not verify')
  })

  it('fires on a close-out claim even without the resolve flag', async () => {
    const decision = await evaluateRereviewGuard(
      input({ wantsResolve: false, text: 'Confirmed fixed — that resolves it.', getReviewState: stateOk(true) }),
    )
    expect(decision.block).toBe(true)
  })

  it('does not fire on ordinary discussion replies', async () => {
    let queried = false
    const decision = await evaluateRereviewGuard(
      input({
        wantsResolve: false,
        text: 'Thanks for the context, I think this approach makes sense.',
        getReviewState: async () => {
          queried = true
          return { ok: true, selfBlocking: true, approve: true }
        },
      }),
    )
    expect(decision).toEqual({ block: false })
    expect(queried).toBe(false)
  })

  it('never fires on non-github adapters', async () => {
    const decision = await evaluateRereviewGuard(input({ adapter: 'slack-bot' }))
    expect(decision).toEqual({ block: false })
  })

  it('never fires on a non-PR chat', async () => {
    const decision = await evaluateRereviewGuard(input({ chat: 'issue:5' }))
    expect(decision).toEqual({ block: false })
  })

  it('never fires when there is no thread to resolve', async () => {
    const decision = await evaluateRereviewGuard(input({ thread: null }))
    expect(decision).toEqual({ block: false })
  })
})
