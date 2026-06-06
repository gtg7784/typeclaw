import { afterEach, describe, expect, test } from 'bun:test'

import { createApproveIdempotencyGuard, type EffectiveApprovalResolver } from './approve-idempotency'

const WS = 'acme/widgets'

function resolver(map: Record<string, 'APPROVED' | 'CHANGES_REQUESTED' | 'NONE' | 'error'>): EffectiveApprovalResolver {
  return async ({ workspace, prNumber }) => {
    const state = map[`${workspace}#${prNumber}`] ?? 'NONE'
    if (state === 'error') return { ok: false }
    return { ok: true, alreadyApproved: state === 'APPROVED' }
  }
}

describe('approve idempotency guard', () => {
  let guards: Array<ReturnType<typeof createApproveIdempotencyGuard>> = []
  afterEach(() => {
    guards = []
  })
  function makeGuard(map: Record<string, 'APPROVED' | 'CHANGES_REQUESTED' | 'NONE' | 'error'>) {
    const g = createApproveIdempotencyGuard({ resolveEffectiveApproval: resolver(map) })
    guards.push(g)
    return g
  }

  test('allows the first APPROVE when the bot has no prior approval', async () => {
    const g = makeGuard({})
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 5, verdict: 'APPROVE' })
    expect(decision).toBeNull()
  })

  test('blocks a second APPROVE while the first is still pending (concurrent sessions, same container)', async () => {
    const g = makeGuard({})
    // given: a first APPROVE that reserved the PR but has not completed (tool.after not called yet)
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    expect(first).toBeNull()
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    expect(second).not.toBeNull()
    expect(second?.block).toBe(true)
  })

  test('two APPROVE calls racing through guard() before either awaits the remote check yield exactly one allow', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => {
        await gate
        return { ok: true, alreadyApproved: false }
      },
    })
    const both = Promise.all([
      g.guard({ callId: 'a1', workspace: WS, prNumber: 21, verdict: 'APPROVE' }),
      g.guard({ callId: 'a2', workspace: WS, prNumber: 21, verdict: 'APPROVE' }),
    ])
    release()
    const [r1, r2] = await both
    const allowed = [r1, r2].filter((r) => r === null)
    const blocked = [r1, r2].filter((r) => r !== null)
    expect(allowed).toHaveLength(1)
    expect(blocked).toHaveLength(1)
  })

  test('blocks an APPROVE when the bot already effectively approved the PR on GitHub', async () => {
    const g = makeGuard({ [`${WS}#9`]: 'APPROVED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 9, verdict: 'APPROVE' })
    expect(decision).not.toBeNull()
    expect(decision?.block).toBe(true)
  })

  test('allows APPROVE when the bot previously requested changes (a real re-review)', async () => {
    const g = makeGuard({ [`${WS}#11`]: 'CHANGES_REQUESTED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 11, verdict: 'APPROVE' })
    expect(decision).toBeNull()
  })

  test('releasing a failed APPROVE lets a later genuine APPROVE through', async () => {
    const g = makeGuard({})
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 13, verdict: 'APPROVE' })
    g.release({ callId: 'a1', succeeded: false })
    const retry = await g.guard({ callId: 'a2', workspace: WS, prNumber: 13, verdict: 'APPROVE' })
    expect(retry).toBeNull()
  })

  test('after a succeeded APPROVE the next attempt defers to the resolver, which blocks once GitHub reports APPROVED', async () => {
    const g = makeGuard({ [`${WS}#15`]: 'APPROVED' })
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 15, verdict: 'APPROVE' })
    g.release({ callId: 'a1', succeeded: true })
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 15, verdict: 'APPROVE' })
    expect(dup).not.toBeNull()
    expect(dup?.block).toBe(true)
  })

  test('a superseded approval no longer strands the bot: after a succeeded APPROVE is later demoted to CHANGES_REQUESTED, a re-APPROVE is allowed', async () => {
    // given: the first APPROVE landed and the in-flight lock was released
    const g = makeGuard({})
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 16, verdict: 'APPROVE' })
    g.release({ callId: 'a1', succeeded: true })
    // when: GitHub's effective state has since moved to CHANGES_REQUESTED (resolver defaults to NONE)
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 16, verdict: 'APPROVE' })
    // then: no stale local lock blocks the genuine re-approval
    expect(reapprove).toBeNull()
  })

  test('a remote-already-approved block releases the in-flight lock so a later supersession can re-approve', async () => {
    let approved = true
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, alreadyApproved: approved }),
    })
    guards.push(g)
    const blocked = await g.guard({ callId: 'a1', workspace: WS, prNumber: 18, verdict: 'APPROVE' })
    expect(blocked?.block).toBe(true)
    // when: the standing approval is later superseded upstream
    approved = false
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 18, verdict: 'APPROVE' })
    // then: the earlier block did not leave a stale lock behind
    expect(reapprove).toBeNull()
  })

  test('ignores non-APPROVE verdicts (REQUEST_CHANGES is allowed to repeat)', async () => {
    const g = makeGuard({ [`${WS}#17`]: 'APPROVED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 17, verdict: 'REQUEST_CHANGES' })
    expect(decision).toBeNull()
  })

  test('fails open on a resolver error so a genuine approval is never permanently blocked', async () => {
    const g = makeGuard({ [`${WS}#19`]: 'error' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 19, verdict: 'APPROVE' })
    // A transient GitHub read failure must not strand the bot from ever approving;
    // the in-process pending set still guards the concurrent-duplicate case.
    expect(decision).toBeNull()
  })
})
