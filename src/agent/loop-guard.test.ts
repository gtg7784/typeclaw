import { describe, expect, test } from 'bun:test'

import { createLoopGuard, LOOP_HARD_BLOCK, LOOP_SOFT_WARN } from './loop-guard'

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
})
