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
    let lastDecision: ReturnType<typeof guard.check> = { kind: 'ok' }
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
    let last: ReturnType<typeof guard.check> = { kind: 'ok' }
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
    let last: ReturnType<typeof guard.check> = { kind: 'ok' }
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
    let last: ReturnType<typeof guard.check> = { kind: 'ok' }
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
})
