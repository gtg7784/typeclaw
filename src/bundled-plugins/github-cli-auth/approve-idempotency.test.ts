import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetReviewVerdictGuardForTest,
  createApproveIdempotencyGuard,
  type EffectiveApprovalResolver,
  type EffectiveVerdict,
} from './approve-idempotency'

const WS = 'acme/widgets'

function resolver(map: Record<string, EffectiveVerdict | 'error'>): EffectiveApprovalResolver {
  return async ({ workspace, prNumber }) => {
    const state = map[`${workspace}#${prNumber}`] ?? 'NONE'
    if (state === 'error') return { ok: false }
    return { ok: true, effective: state }
  }
}

describe('review verdict idempotency guard', () => {
  afterEach(() => {
    __resetReviewVerdictGuardForTest()
  })
  function makeGuard(map: Record<string, EffectiveVerdict | 'error'> = {}, now?: () => number) {
    return createApproveIdempotencyGuard({ resolveEffectiveApproval: resolver(map), now })
  }

  test('allows the first APPROVE when the bot has no prior verdict', async () => {
    const g = makeGuard()
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 5, verdict: 'APPROVE' })
    expect(decision).toBeNull()
  })

  test('blocks a second verdict while the first is still in flight (concurrent sessions, same container)', async () => {
    const g = makeGuard()
    // given: a first APPROVE that reserved the PR but has not completed (tool.after not called yet)
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    expect(first).toBeNull()
    // when: a second session attempts any formal verdict for the same PR
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    // then: it is blocked while the first is mid-flight
    expect(second?.block).toBe(true)
  })

  test('separate plugin instances share the in-flight lease (process-wide singleton)', async () => {
    // given: two guards as two different plugin instances would create them
    const instanceA = makeGuard()
    const instanceB = makeGuard()
    // when: instance A reserves an APPROVE and never calls tool.after
    const a = await instanceA.guard({ callId: 'a1', workspace: WS, prNumber: 8, verdict: 'APPROVE' })
    expect(a).toBeNull()
    // then: instance B sees the in-flight lease and blocks — the regression that
    // let three concurrent sessions each land an APPROVE on the same PR
    const b = await instanceB.guard({ callId: 'b1', workspace: WS, prNumber: 8, verdict: 'APPROVE' })
    expect(b?.block).toBe(true)
  })

  test('two verdict calls racing through guard() before either awaits the remote check yield exactly one allow', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => {
        await gate
        return { ok: true, effective: 'NONE' }
      },
    })
    const both = Promise.all([
      g.guard({ callId: 'a1', workspace: WS, prNumber: 21, verdict: 'APPROVE' }),
      g.guard({ callId: 'a2', workspace: WS, prNumber: 21, verdict: 'APPROVE' }),
    ])
    release()
    const [r1, r2] = await both
    expect([r1, r2].filter((r) => r === null)).toHaveLength(1)
    expect([r1, r2].filter((r) => r !== null)).toHaveLength(1)
  })

  test('blocks an APPROVE when the bot already effectively approved the PR on GitHub', async () => {
    const g = makeGuard({ [`${WS}#9`]: 'APPROVED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 9, verdict: 'APPROVE' })
    expect(decision?.block).toBe(true)
  })

  test('allows APPROVE when the bot previously requested changes (a real re-review)', async () => {
    const g = makeGuard({ [`${WS}#11`]: 'CHANGES_REQUESTED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 11, verdict: 'APPROVE' })
    expect(decision).toBeNull()
  })

  test('blocks a REQUEST_CHANGES when the bot already holds a standing CHANGES_REQUESTED', async () => {
    const g = makeGuard({ [`${WS}#23`]: 'CHANGES_REQUESTED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 23, verdict: 'REQUEST_CHANGES' })
    expect(decision?.block).toBe(true)
  })

  test('allows REQUEST_CHANGES when the bot previously approved (a real demotion)', async () => {
    const g = makeGuard({ [`${WS}#24`]: 'APPROVED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 24, verdict: 'REQUEST_CHANGES' })
    expect(decision).toBeNull()
  })

  test('blocks a concurrent REQUEST_CHANGES while the first is in flight (symmetry with APPROVE)', async () => {
    const g = makeGuard()
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 25, verdict: 'REQUEST_CHANGES' })
    expect(first).toBeNull()
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 25, verdict: 'REQUEST_CHANGES' })
    expect(second?.block).toBe(true)
  })

  test('releasing a failed verdict lets a later genuine verdict through', async () => {
    const g = makeGuard()
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
    expect(dup?.block).toBe(true)
  })

  test('a superseded approval no longer strands the bot: after a succeeded APPROVE is later demoted to CHANGES_REQUESTED, a re-APPROVE is allowed', async () => {
    // given: the first APPROVE landed and the in-flight lease was released
    const g = makeGuard()
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 16, verdict: 'APPROVE' })
    g.release({ callId: 'a1', succeeded: true })
    // when: GitHub's effective state has since moved off APPROVED (resolver defaults to NONE)
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 16, verdict: 'APPROVE' })
    // then: no stale local lease blocks the genuine re-approval
    expect(reapprove).toBeNull()
  })

  test('a remote-already-approved block releases the in-flight lease so a later supersession can re-approve', async () => {
    let effective: EffectiveVerdict = 'APPROVED'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
    })
    const blocked = await g.guard({ callId: 'a1', workspace: WS, prNumber: 18, verdict: 'APPROVE' })
    expect(blocked?.block).toBe(true)
    // when: the standing approval is later superseded upstream
    effective = 'NONE'
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 18, verdict: 'APPROVE' })
    // then: the earlier block did not leave a stale lease behind
    expect(reapprove).toBeNull()
  })

  test('an expired lease is reclaimable so a crashed tool.after never strands the PR forever', async () => {
    let clock = 1_000
    const g = makeGuard({}, () => clock)
    // given: a verdict reserved the PR but tool.after never fired (crash)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 26, verdict: 'APPROVE' })
    // when: more than the lease TTL elapses
    clock += 5 * 60_000 + 1
    // then: a fresh verdict can reclaim the abandoned lease
    const reclaimed = await g.guard({ callId: 'a2', workspace: WS, prNumber: 26, verdict: 'APPROVE' })
    expect(reclaimed).toBeNull()
  })

  test('a fresh lease is not reclaimable before the TTL elapses', async () => {
    let clock = 1_000
    const g = makeGuard({}, () => clock)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 27, verdict: 'APPROVE' })
    clock += 5 * 60_000 - 1
    const blocked = await g.guard({ callId: 'a2', workspace: WS, prNumber: 27, verdict: 'APPROVE' })
    expect(blocked?.block).toBe(true)
  })

  test('a stale tool.after for a reclaimed reservation does not drop the live session lease', async () => {
    let clock = 1_000
    const g = makeGuard({}, () => clock)
    // given: session 1 reserves, then its lease is reclaimed after TTL by session 2
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 28, verdict: 'APPROVE' })
    clock += 5 * 60_000 + 1
    await g.guard({ callId: 'a2', workspace: WS, prNumber: 28, verdict: 'APPROVE' })
    // when: session 1's tool.after finally fires (stale)
    g.release({ callId: 'a1', succeeded: false })
    // then: session 2 still holds the lease, so a third attempt is blocked
    const third = await g.guard({ callId: 'a3', workspace: WS, prNumber: 28, verdict: 'APPROVE' })
    expect(third?.block).toBe(true)
  })

  test('ignores COMMENT-only / non-verdict review events', async () => {
    const g = makeGuard({ [`${WS}#17`]: 'APPROVED' })
    // The guard's caller only passes APPROVE / REQUEST_CHANGES; a non-verdict
    // value must never be treated as a duplicate. Cast simulates a future verdict
    // type slipping through.
    const decision = await g.guard({
      callId: 'a1',
      workspace: WS,
      prNumber: 17,
      verdict: 'COMMENT' as 'APPROVE',
    })
    expect(decision).toBeNull()
  })

  test('fails open on a resolver error so a genuine verdict is never permanently blocked', async () => {
    const g = makeGuard({ [`${WS}#19`]: 'error' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 19, verdict: 'APPROVE' })
    // A transient GitHub read failure must not strand the bot; the in-flight
    // lease still guards the concurrent-duplicate case.
    expect(decision).toBeNull()
  })

  test('a concurrent verdict still blocks even when the remote read fails open', async () => {
    const g = makeGuard({ [`${WS}#29`]: 'error' })
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 29, verdict: 'APPROVE' })
    expect(first).toBeNull()
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 29, verdict: 'APPROVE' })
    expect(second?.block).toBe(true)
  })
})
