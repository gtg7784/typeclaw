import { describe, expect, test } from 'bun:test'

import type { PortForward } from '@/config'
import { CONTAINER_PORT } from '@/container'

import { brokerEnabled, shouldForward } from './policy'

describe('shouldForward', () => {
  test('allow:* forwards arbitrary ports', () => {
    expect(shouldForward({ policy: { allow: '*' }, port: 5173 })).toBe(true)
    expect(shouldForward({ policy: { allow: '*' }, port: 65535 })).toBe(true)
    expect(shouldForward({ policy: { allow: '*' }, port: 1 })).toBe(true)
  })

  test('allow:* + deny excludes listed ports', () => {
    const policy: PortForward = { allow: '*', deny: [9229, 9999] }
    expect(shouldForward({ policy, port: 5173 })).toBe(true)
    expect(shouldForward({ policy, port: 9229 })).toBe(false)
    expect(shouldForward({ policy, port: 9999 })).toBe(false)
  })

  test('allow as array forwards only listed ports', () => {
    const policy: PortForward = { allow: [3000, 5173] }
    expect(shouldForward({ policy, port: 3000 })).toBe(true)
    expect(shouldForward({ policy, port: 5173 })).toBe(true)
    expect(shouldForward({ policy, port: 8080 })).toBe(false)
  })

  test('allow:[] forwards nothing', () => {
    const policy: PortForward = { allow: [] }
    expect(shouldForward({ policy, port: 5173 })).toBe(false)
    expect(shouldForward({ policy, port: 1234 })).toBe(false)
  })

  test('CONTAINER_PORT is always excluded, even when allow:* and not in deny', () => {
    expect(shouldForward({ policy: { allow: '*' }, port: CONTAINER_PORT })).toBe(false)
  })

  test('CONTAINER_PORT is excluded even if explicitly listed in allow array (defense against config typos)', () => {
    expect(shouldForward({ policy: { allow: [CONTAINER_PORT] }, port: CONTAINER_PORT })).toBe(false)
  })

  test('containerPort override exercises the implicit exclusion at a different port (test seam)', () => {
    expect(shouldForward({ policy: { allow: '*' }, port: 7777, containerPort: 7777 })).toBe(false)
    expect(shouldForward({ policy: { allow: '*' }, port: 7778, containerPort: 7777 })).toBe(true)
  })
})

describe('brokerEnabled', () => {
  test('allow:* enables the broker', () => {
    expect(brokerEnabled({ allow: '*' })).toBe(true)
  })

  test('allow with at least one port enables the broker', () => {
    expect(brokerEnabled({ allow: [3000] })).toBe(true)
  })

  test('allow:[] disables the broker (off-switch)', () => {
    expect(brokerEnabled({ allow: [] })).toBe(false)
  })
})
