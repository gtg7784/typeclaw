import { describe, expect, test } from 'bun:test'

import { createLoopGuard, LOOP_HARD_BLOCK, LOOP_SOFT_WARN, WINDOW_HARD_BLOCK, WINDOW_SOFT_WARN } from './loop-guard'

describe('createLoopGuard', () => {
  test('returns ok for the first call with a given signature', () => {
    const guard = createLoopGuard()
    const decision = guard.check('s1', 'bash', { command: 'ls' })
    expect(decision.kind).toBe('ok')
  })

  test('returns ok up to (softWarn - 1) consecutive identical calls', () => {
    const guard = createLoopGuard()
    for (let i = 1; i < LOOP_SOFT_WARN; i++) {
      const decision = guard.check('s1', 'bash', { command: 'ls' })
      expect(decision.kind).toBe('ok')
    }
  })

  test('emits a warn decision exactly at the softWarn count', () => {
    const guard = createLoopGuard()
    for (let i = 1; i < LOOP_SOFT_WARN; i++) {
      guard.check('s1', 'bash', { command: 'ls' })
    }
    const decision = guard.check('s1', 'bash', { command: 'ls' })
    expect(decision.kind).toBe('warn')
    if (decision.kind === 'warn') {
      expect(decision.count).toBe(LOOP_SOFT_WARN)
      expect(decision.message).toContain('bash')
      expect(decision.message).toContain('thought-loop')
    }
  })

  test('soft warning fires only once per streak', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 10 })
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('warn')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('ok')
  })

  test('emits a block decision at the hardBlock count and beyond', () => {
    const guard = createLoopGuard()
    let lastDecision: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
    for (let i = 1; i <= LOOP_HARD_BLOCK; i++) {
      lastDecision = guard.check('s1', 'bash', { command: 'ls' })
    }
    expect(lastDecision.kind).toBe('block')
    if (lastDecision.kind === 'block') {
      expect(lastDecision.count).toBe(LOOP_HARD_BLOCK)
      expect(lastDecision.message).toContain('bash')
    }
    const next = guard.check('s1', 'bash', { command: 'ls' })
    expect(next.kind).toBe('block')
    if (next.kind === 'block') {
      expect(next.count).toBe(LOOP_HARD_BLOCK + 1)
    }
  })

  test('resets the streak when the tool name changes', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.check('s1', 'bash', { command: 'ls' })
    const switched = guard.check('s1', 'read', { path: 'x' })
    expect(switched.kind).toBe('ok')
    expect(guard.check('s1', 'read', { path: 'x' }).kind).toBe('ok')
    expect(guard.check('s1', 'read', { path: 'x' }).kind).toBe('warn')
  })

  test('resets the streak when the args change', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.check('s1', 'bash', { command: 'ls' })
    const switched = guard.check('s1', 'bash', { command: 'pwd' })
    expect(switched.kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'pwd' }).kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'pwd' }).kind).toBe('warn')
  })

  test('treats key insertion order as irrelevant for equality', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    guard.check('s1', 'edit', { path: 'a.ts', content: 'x' })
    guard.check('s1', 'edit', { content: 'x', path: 'a.ts' })
    expect(guard.check('s1', 'edit', { path: 'a.ts', content: 'x' }).kind).toBe('warn')
  })

  test('keeps streaks per session independent', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.check('s1', 'bash', { command: 'ls' })
    expect(guard.check('s2', 'bash', { command: 'ls' }).kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('warn')
  })

  test('forget(sessionId) clears a session-scoped streak', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.forget('s1')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('ok')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('warn')
  })

  test('evicts the oldest session once maxSessions is exceeded', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5, maxSessions: 2 })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.check('s2', 'bash', { command: 'ls' })
    guard.check('s2', 'bash', { command: 'ls' })
    guard.check('s3', 'bash', { command: 'ls' })
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('ok')
  })

  test('handles unstringifiable arguments without throwing', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    expect(() => guard.check('s1', 'bash', cyclic)).not.toThrow()
    guard.check('s1', 'bash', cyclic)
    expect(guard.check('s1', 'bash', cyclic).kind).toBe('warn')
  })

  test('rejects invalid thresholds at construction time', () => {
    expect(() => createLoopGuard({ softWarn: 1, hardBlock: 5 })).toThrow()
    expect(() => createLoopGuard({ softWarn: 5, hardBlock: 5 })).toThrow()
    expect(() => createLoopGuard({ softWarn: 5, hardBlock: 3 })).toThrow()
  })

  test('consecutive-identical block reports reason "consecutive"', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
    for (let i = 0; i < 5; i++) last = guard.check('s1', 'bash', { command: 'ls' })
    expect(last.kind).toBe('block')
    if (last.kind === 'block') expect(last.reason).toBe('consecutive')
  })
})

describe('createLoopGuard — windowed multi-signature detection', () => {
  // High consecutive thresholds isolate the windowed detector: interleaved
  // calls never repeat back-to-back, so the consecutive tripwire stays dormant.
  const noConsecutive = { softWarn: 1000, hardBlock: 1001 }

  test('blocks an interleaved cycle that never repeats consecutively', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    const seq = ['a', 'b', 'c', 'b', 'c', 'b', 'a', 'b', 'c', 'b', 'a', 'b']
    const decisions = seq.map((cmd) => guard.check('s1', 'bash', { command: cmd }))
    const blocked = decisions.some((d) => d.kind === 'block')
    expect(blocked).toBe(true)
  })

  test('windowed block reports reason "windowed"', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
    const seq = ['b', 'x', 'b', 'x', 'b', 'x', 'b', 'x', 'b', 'x', 'b']
    for (const cmd of seq) last = guard.check('s1', 'bash', { command: cmd })
    expect(last.kind).toBe('block')
    if (last.kind === 'block') {
      expect(last.reason).toBe('windowed')
      expect(last.message).toContain('bash')
    }
  })

  test('emits a windowed warn before the block', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    const decisions: string[] = []
    const seq = ['b', 'x', 'b', 'x', 'b', 'x', 'b']
    for (const cmd of seq) decisions.push(guard.check('s1', 'bash', { command: cmd }).kind)
    expect(decisions).toContain('warn')
    expect(decisions).not.toContain('block')
  })

  // Reproduces the real incident: a subagent re-read one transcript with
  // drifting offsets. Exact-arg signatures saw distinct calls and never tripped;
  // path-coarsened signatures collapse them so the windowed guard catches it.
  test('coarsens path-bearing tools so drifting offsets collapse to one signature', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    const offsets = [49, 50, 51, 50, 51, 50]
    let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
    for (const offset of offsets) {
      last = guard.check('s1', 'read', { path: '/agent/transcript.jsonl', offset, limit: 100 })
    }
    expect(last.kind).toBe('block')
    if (last.kind === 'block') expect(last.reason).toBe('windowed')
  })

  test('does not flag legitimate fan-out reads across distinct paths', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts']
    for (const path of paths) {
      const d = guard.check('s1', 'read', { path, offset: 0, limit: 100 })
      expect(d.kind).toBe('ok')
    }
  })

  test('does not flag productive read/edit alternation on distinct targets', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    const steps: Array<[string, string]> = [
      ['read', 'a.ts'],
      ['edit', 'a.ts'],
      ['read', 'b.ts'],
      ['edit', 'b.ts'],
      ['read', 'c.ts'],
      ['edit', 'c.ts'],
    ]
    for (const [tool, path] of steps) {
      const d = guard.check('s1', tool, { path })
      expect(d.kind).toBe('ok')
    }
  })

  test('only the last windowSize calls count toward a signature', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 4,
      windowSoftWarn: 3,
      windowHardBlock: 4,
    })
    const olderThanWindow = ['b', 'b']
    const fillersFillingWindow = ['p', 'q', 'r']
    for (const cmd of [...olderThanWindow, ...fillersFillingWindow]) {
      guard.check('s1', 'bash', { command: cmd })
    }
    expect(guard.check('s1', 'bash', { command: 'b' }).kind).toBe('ok')
  })

  test('keeps windows per session independent', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    for (let i = 0; i < 5; i++) guard.check('s1', 'bash', { command: 'b' })
    expect(guard.check('s2', 'bash', { command: 'b' }).kind).toBe('ok')
  })

  test('forget(sessionId) clears the windowed history', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    for (let i = 0; i < 5; i++) guard.check('s1', 'bash', { command: 'b' })
    guard.forget('s1')
    expect(guard.check('s1', 'bash', { command: 'b' }).kind).toBe('ok')
  })

  test('exports default windowed thresholds with a usable ordering', () => {
    expect(WINDOW_SOFT_WARN).toBeGreaterThanOrEqual(2)
    expect(WINDOW_HARD_BLOCK).toBeGreaterThan(WINDOW_SOFT_WARN)
  })

  test('rejects invalid windowed thresholds at construction time', () => {
    expect(() => createLoopGuard({ windowSoftWarn: 1, windowHardBlock: 6 })).toThrow()
    expect(() => createLoopGuard({ windowSoftWarn: 6, windowHardBlock: 6 })).toThrow()
    expect(() => createLoopGuard({ windowSoftWarn: 6, windowHardBlock: 4 })).toThrow()
    expect(() => createLoopGuard({ windowSize: 1 })).toThrow()
    expect(() => createLoopGuard({ windowSize: 4, windowHardBlock: 5 })).toThrow()
  })

  // grep/find/ls have an OPTIONAL path that defaults to cwd. Omitting it and
  // varying only non-target args (pattern/limit) still hits the same directory,
  // so those calls must coarsen to a single default-target signature.
  for (const tool of ['grep', 'find', 'ls'] as const) {
    test(`coarsens omitted-path ${tool} calls to the default target so non-target args cannot evade the guard`, () => {
      const guard = createLoopGuard({
        ...noConsecutive,
        windowSize: 16,
        windowSoftWarn: 4,
        windowHardBlock: 6,
      })
      const varyingArgs = [
        { pattern: 'a*' },
        { pattern: 'b*', limit: 10 },
        { pattern: 'c*' },
        { pattern: 'd*', limit: 50 },
        { pattern: 'e*' },
        { pattern: 'f*', limit: 5 },
      ]
      let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
      for (const args of varyingArgs) last = guard.check('s1', tool, args)
      expect(last.kind).toBe('block')
      if (last.kind === 'block') expect(last.reason).toBe('windowed')
    })

    test(`treats an empty-string path for ${tool} the same as an omitted path`, () => {
      const guard = createLoopGuard({
        ...noConsecutive,
        windowSize: 16,
        windowSoftWarn: 4,
        windowHardBlock: 6,
      })
      let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
      for (let i = 0; i < 6; i++) last = guard.check('s1', tool, { path: '', pattern: `p${i}*` })
      expect(last.kind).toBe('block')
    })

    test(`does not flag omitted-path ${tool} calls against genuinely distinct explicit targets`, () => {
      const guard = createLoopGuard({
        ...noConsecutive,
        windowSize: 16,
        windowSoftWarn: 4,
        windowHardBlock: 6,
      })
      const dirs = ['src', 'test', 'docs', 'scripts', 'lib', 'bin']
      for (const path of dirs) {
        expect(guard.check('s1', tool, { path, pattern: 'x*' }).kind).toBe('ok')
      }
    })
  }

  // read/write/edit require an explicit path, so absence is malformed input, not
  // a cwd default — they must NOT be coarsened to a shared default target.
  test('does not coarsen required-path tools (read) to a default target', () => {
    const guard = createLoopGuard({
      ...noConsecutive,
      windowSize: 16,
      windowSoftWarn: 4,
      windowHardBlock: 6,
    })
    for (let i = 0; i < 8; i++) {
      expect(guard.check('s1', 'read', { offset: i, limit: 100 }).kind).toBe('ok')
    }
  })
})

describe('createLoopGuard — forgetTool', () => {
  const noConsecutive = { softWarn: 1000, hardBlock: 1001 }

  function windowGuard() {
    return createLoopGuard({ ...noConsecutive, windowSize: 16, windowSoftWarn: 4, windowHardBlock: 6 })
  }

  // Reproduces the incident: premature subagent_output polling (interleaved
  // with other work, as it was in production — the windowed detector only sees
  // non-consecutive repeats) poisons the window, then a completion reminder
  // clears it so the next fetch is allowed.
  function pollInterleaved(
    guard: ReturnType<typeof windowGuard>,
    times: number,
  ): ReturnType<typeof guard.check> | { kind: 'ok' } {
    const args = { task_id: 'bg_x' }
    let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
    for (let i = 0; i < times; i++) {
      last = guard.check('s1', 'subagent_output', args)
      guard.check('s1', 'bash', { command: `step${i}` })
    }
    return last
  }

  test('clears the windowed residue for the named tool so the next call is allowed', () => {
    const guard = windowGuard()
    pollInterleaved(guard, 5)
    guard.forgetTool('s1', 'subagent_output')
    expect(guard.check('s1', 'subagent_output', { task_id: 'bg_x' }).kind).toBe('ok')
  })

  test('without forgetTool the same polling spree still hard-blocks', () => {
    const guard = windowGuard()
    const last = pollInterleaved(guard, 6)
    expect(last.kind).toBe('block')
    if (last.kind === 'block') expect(last.reason).toBe('windowed')
  })

  // The windowed detector only evaluates on calls that break the consecutive
  // streak (count === 1), so bash and subagent_output are interleaved here to
  // keep each one's window count climbing without a consecutive run.
  test('does not clear another tool\u2019s accumulated window', () => {
    const guard = windowGuard()
    let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
    for (let i = 0; i < 6; i++) {
      guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
      last = guard.check('s1', 'bash', { command: 'ls' })
    }
    // Drop subagent_output's residue; bash's six interleaved entries remain.
    guard.forgetTool('s1', 'subagent_output')
    expect(last.kind).toBe('block')
    if (last.kind === 'block') expect(last.reason).toBe('windowed')
  })

  test('clears a consecutive streak only when it belongs to the named tool', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    guard.forgetTool('s1', 'subagent_output')
    expect(guard.check('s1', 'subagent_output', { task_id: 'bg_x' }).kind).toBe('ok')
    expect(guard.check('s1', 'subagent_output', { task_id: 'bg_x' }).kind).toBe('ok')
    expect(guard.check('s1', 'subagent_output', { task_id: 'bg_x' }).kind).toBe('warn')
  })

  test('leaves a different tool\u2019s consecutive streak intact', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.check('s1', 'bash', { command: 'ls' })
    guard.forgetTool('s1', 'subagent_output')
    expect(guard.check('s1', 'bash', { command: 'ls' }).kind).toBe('warn')
  })

  test('coarsened path-bearing residue is cleared by tool name', () => {
    const guard = windowGuard()
    for (let i = 0; i < 5; i++) guard.check('s1', 'read', { path: '/a.ts', offset: i })
    guard.forgetTool('s1', 'read')
    expect(guard.check('s1', 'read', { path: '/a.ts', offset: 99 }).kind).toBe('ok')
  })

  test('is a no-op for an unknown session', () => {
    const guard = windowGuard()
    expect(() => guard.forgetTool('missing', 'subagent_output')).not.toThrow()
  })
})

describe('createLoopGuard — retract', () => {
  const noConsecutive = { softWarn: 1000, hardBlock: 1001 }

  function windowGuard() {
    return createLoopGuard({ ...noConsecutive, windowSize: 16, windowSoftWarn: 4, windowHardBlock: 6 })
  }

  test('retracting a windowed observation drops it from the window count', () => {
    const guard = windowGuard()
    // given: five interleaved polls of one task_id poison the window
    let receipt!: ReturnType<typeof guard.check>['receipt']
    for (let i = 0; i < 5; i++) {
      const d = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
      receipt = d.receipt
      guard.check('s1', 'bash', { command: `step${i}` })
    }
    // when: the last observation is retracted
    guard.retract(receipt)
    // then: the next identical poll is the 5th in-window, not the 6th — no block
    const next = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    expect(next.kind).not.toBe('block')
  })

  test('retracting every pending poll keeps a fan-out collect-loop unblocked', () => {
    const guard = windowGuard()
    const tasks = ['bg_1', 'bg_2', 'bg_3', 'bg_4', 'bg_5', 'bg_6']
    let blocked = false
    // 20 round-robin waves: every poll is "still running", so every one is retracted
    for (let wave = 0; wave < 20; wave++) {
      const live = tasks.slice(0, Math.max(2, tasks.length - Math.floor(wave / 3)))
      for (const task_id of live) {
        const d = guard.check('s1', 'subagent_output', { task_id })
        if (d.kind === 'block') blocked = true
        guard.retract(d.receipt)
      }
    }
    expect(blocked).toBe(false)
  })

  test('retracting pending polls still lets a repeated TERMINAL-result poll block', () => {
    const guard = windowGuard()
    // pending polls of bg_a are retracted; terminal polls are NOT, so they accumulate
    let last: ReturnType<typeof guard.check> | { kind: 'ok' } = { kind: 'ok' }
    for (let i = 0; i < 7; i++) {
      const d = guard.check('s1', 'subagent_output', { task_id: 'bg_a' })
      last = d
      // simulate: caller does NOT retract because the result was terminal
      guard.check('s1', 'bash', { command: `between${i}` })
    }
    expect(last.kind).toBe('block')
    if (last.kind === 'block') expect(last.reason).toBe('windowed')
  })

  test('retract rewinds a consecutive streak so a pending poll never trips it', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    // back-to-back polls of one task_id; each pending poll is retracted
    for (let i = 0; i < 10; i++) {
      const d = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
      expect(d.kind).not.toBe('block')
      guard.retract(d.receipt)
    }
  })

  test('retracting one task_id leaves another task_id\u2019s accumulated signal intact', () => {
    const guard = windowGuard()
    // bg_keep accumulates 5 interleaved entries that are never retracted
    for (let i = 0; i < 5; i++) {
      guard.check('s1', 'subagent_output', { task_id: 'bg_keep' })
      guard.check('s1', 'bash', { command: `f${i}` })
    }
    // bg_drop polls are all retracted
    for (let i = 0; i < 5; i++) {
      const d = guard.check('s1', 'subagent_output', { task_id: 'bg_drop' })
      guard.retract(d.receipt)
      guard.check('s1', 'bash', { command: `g${i}` })
    }
    // bg_keep's 6th interleaved entry still blocks; retracting bg_drop didn't help it
    const keep = guard.check('s1', 'subagent_output', { task_id: 'bg_keep' })
    expect(keep.kind).toBe('block')
  })

  test('is a no-op for an unknown session', () => {
    const guard = windowGuard()
    const receipt = { sessionId: 'missing', tool: 'subagent_output', signature: 'x', windowSignature: 'y' }
    expect(() => guard.retract(receipt)).not.toThrow()
  })
})

describe('createLoopGuard — noteResult / deferable', () => {
  test('a subagent_output block is deferable until its signature is noted terminal', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    // five back-to-back polls of one task_id reach the consecutive hard block
    let blocked!: ReturnType<typeof guard.check>
    for (let i = 0; i < 5; i++) blocked = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    expect(blocked.kind).toBe('block')
    if (blocked.kind === 'block') expect(blocked.deferable).toBe(true)

    // once the signature is known terminal, the next identical block is NOT deferable
    guard.noteResult(blocked.receipt, 'terminal')
    const next = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    expect(next.kind).toBe('block')
    if (next.kind === 'block') expect(next.deferable).toBe(false)
  })

  test('noteResult(running) clears a prior terminal mark so the block is deferable again', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    let d!: ReturnType<typeof guard.check>
    for (let i = 0; i < 5; i++) d = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    guard.noteResult(d.receipt, 'terminal')
    guard.noteResult(d.receipt, 'running')
    const next = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    if (next.kind === 'block') expect(next.deferable).toBe(true)
  })

  test('terminal-known is per-signature: a different task_id stays deferable', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    let a!: ReturnType<typeof guard.check>
    for (let i = 0; i < 5; i++) a = guard.check('s1', 'subagent_output', { task_id: 'bg_a' })
    guard.noteResult(a.receipt, 'terminal')
    // bg_b reaches its own consecutive block and is still deferable
    let b!: ReturnType<typeof guard.check>
    for (let i = 0; i < 5; i++) b = guard.check('s1', 'subagent_output', { task_id: 'bg_b' })
    expect(b.kind).toBe('block')
    if (b.kind === 'block') expect(b.deferable).toBe(true)
  })

  test('forgetTool clears terminal-known so a later episode defers again', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    let d!: ReturnType<typeof guard.check>
    for (let i = 0; i < 5; i++) d = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    guard.noteResult(d.receipt, 'terminal')
    guard.forgetTool('s1', 'subagent_output')
    let again!: ReturnType<typeof guard.check>
    for (let i = 0; i < 5; i++) again = guard.check('s1', 'subagent_output', { task_id: 'bg_x' })
    if (again.kind === 'block') expect(again.deferable).toBe(true)
  })

  test('non-subagent_output blocks are never deferable', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    let d!: ReturnType<typeof guard.check>
    for (let i = 0; i < 5; i++) d = guard.check('s1', 'bash', { command: 'ls' })
    expect(d.kind).toBe('block')
    if (d.kind === 'block') expect(d.deferable).toBe(false)
  })

  test('noteResult is a no-op for an unknown session', () => {
    const guard = createLoopGuard({ softWarn: 3, hardBlock: 5 })
    const receipt = { sessionId: 'missing', tool: 'subagent_output', signature: 'x', windowSignature: 'y' }
    expect(() => guard.noteResult(receipt, 'terminal')).not.toThrow()
  })
})
