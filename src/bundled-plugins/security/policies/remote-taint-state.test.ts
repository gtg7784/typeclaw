import { beforeEach, describe, expect, test } from 'bun:test'

import {
  __resetRemoteTaintStateForTests,
  clearSessionTaints,
  getRemoteTaint,
  recordRemoteTaint,
} from './remote-taint-state'

describe('remote-taint-state', () => {
  beforeEach(() => {
    __resetRemoteTaintStateForTests()
  })

  test('records and retrieves a taint by session and remote name', () => {
    recordRemoteTaint('ses1', { remoteName: 'origin', url: 'https://attacker.example/repo.git', now: 1000 })
    const taint = getRemoteTaint('ses1', 'origin')
    expect(taint?.remoteName).toBe('origin')
    expect(taint?.url).toBe('https://attacker.example/repo.git')
    expect(taint?.recordedAt).toBe(1000)
  })

  test('returns undefined for an unknown session', () => {
    recordRemoteTaint('ses1', { remoteName: 'origin', url: 'https://x/r.git' })
    expect(getRemoteTaint('ses-other', 'origin')).toBeUndefined()
  })

  test('returns undefined for a known session but unknown remote', () => {
    recordRemoteTaint('ses1', { remoteName: 'origin', url: 'https://x/r.git' })
    expect(getRemoteTaint('ses1', 'upstream')).toBeUndefined()
  })

  test('overwrites a prior taint for the same (session, remoteName) pair', () => {
    recordRemoteTaint('ses1', { remoteName: 'origin', url: 'https://first.example/r.git', now: 1000 })
    recordRemoteTaint('ses1', { remoteName: 'origin', url: 'https://second.example/r.git', now: 2000 })
    const taint = getRemoteTaint('ses1', 'origin')
    expect(taint?.url).toBe('https://second.example/r.git')
    expect(taint?.recordedAt).toBe(2000)
  })

  test('taints are isolated per session', () => {
    recordRemoteTaint('ses1', { remoteName: 'origin', url: 'https://a/r.git' })
    recordRemoteTaint('ses2', { remoteName: 'origin', url: 'https://b/r.git' })
    expect(getRemoteTaint('ses1', 'origin')?.url).toBe('https://a/r.git')
    expect(getRemoteTaint('ses2', 'origin')?.url).toBe('https://b/r.git')
  })

  test('clearSessionTaints removes all taints for one session and leaves others intact', () => {
    recordRemoteTaint('ses1', { remoteName: 'origin', url: 'https://a/r.git' })
    recordRemoteTaint('ses1', { remoteName: 'upstream', url: 'https://c/r.git' })
    recordRemoteTaint('ses2', { remoteName: 'origin', url: 'https://b/r.git' })

    clearSessionTaints('ses1')

    expect(getRemoteTaint('ses1', 'origin')).toBeUndefined()
    expect(getRemoteTaint('ses1', 'upstream')).toBeUndefined()
    expect(getRemoteTaint('ses2', 'origin')?.url).toBe('https://b/r.git')
  })

  test('clearSessionTaints is a no-op for an unknown session', () => {
    expect(() => clearSessionTaints('ses-never-seen')).not.toThrow()
  })
})
