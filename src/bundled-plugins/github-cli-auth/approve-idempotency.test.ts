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
    // First APPROVE reserves the PR but has not completed (tool.after not called yet).
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    expect(first).toBeNull()
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    expect(second).not.toBeNull()
    expect(second?.block).toBe(true)
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

  test('a succeeded APPROVE keeps the PR locked against duplicates', async () => {
    const g = makeGuard({})
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 15, verdict: 'APPROVE' })
    g.release({ callId: 'a1', succeeded: true })
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 15, verdict: 'APPROVE' })
    expect(dup).not.toBeNull()
    expect(dup?.block).toBe(true)
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
