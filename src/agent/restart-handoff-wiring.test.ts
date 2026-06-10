import { describe, expect, test } from 'bun:test'

import type { SessionManager } from '@mariozechner/pi-coding-agent'

import { buildRestartHandoffWiring } from './index'
import type { SessionOrigin } from './session-origin'

function fakeSessionManager(sessionFile: string | undefined): SessionManager {
  return { getSessionFile: () => sessionFile } as unknown as SessionManager
}

const tuiOrigin: SessionOrigin = { kind: 'tui', sessionId: 'ses-1' }
const channelOrigin: SessionOrigin = {
  kind: 'channel',
  adapter: 'discord-bot',
  workspace: 'g1',
  chat: 'c1',
  thread: 't1',
}

describe('buildRestartHandoffWiring', () => {
  test('emits a tui handoff for a persisted TUI session', () => {
    const result = buildRestartHandoffWiring(
      { origin: tuiOrigin, plugins: { agentDir: '/agent' } },
      fakeSessionManager('/agent/sessions/ses-1.jsonl'),
    )
    expect(result).toEqual({
      agentDir: '/agent',
      originatingSessionFile: '/agent/sessions/ses-1.jsonl',
      handoffOrigin: { kind: 'tui' },
    })
  })

  test('emits a channel handoff carrying the channel key for a persisted channel session', () => {
    const result = buildRestartHandoffWiring(
      { origin: channelOrigin, plugins: { agentDir: '/agent' } },
      fakeSessionManager('/agent/sessions/ses-2.jsonl'),
    )
    expect(result).toEqual({
      agentDir: '/agent',
      originatingSessionFile: '/agent/sessions/ses-2.jsonl',
      handoffOrigin: { kind: 'channel', key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't1' } },
    })
  })

  test('carries the channel author into the handoff so a self-restart re-seeds the requester', () => {
    const result = buildRestartHandoffWiring(
      { origin: { ...channelOrigin, lastInboundAuthorId: 'U_OWNER' }, plugins: { agentDir: '/agent' } },
      fakeSessionManager('/agent/sessions/ses-3.jsonl'),
    )
    expect(result.triggeringAuthorId).toBe('U_OWNER')
  })

  test('emits nothing for cron / subagent / system origins', () => {
    const cron: SessionOrigin = { kind: 'cron', jobId: 'j1', jobKind: 'prompt' }
    const subagent: SessionOrigin = { kind: 'subagent', subagent: 'explorer', parentSessionId: 'p1' }
    const system: SessionOrigin = { kind: 'system', component: 'backup' }
    for (const origin of [cron, subagent, system]) {
      expect(
        buildRestartHandoffWiring({ origin, plugins: { agentDir: '/agent' } }, fakeSessionManager('/f.jsonl')),
      ).toEqual({})
    }
  })

  test('emits nothing when the session is not persisted (no file on disk)', () => {
    expect(
      buildRestartHandoffWiring({ origin: tuiOrigin, plugins: { agentDir: '/agent' } }, fakeSessionManager(undefined)),
    ).toEqual({})
  })

  test('emits nothing when agentDir is absent', () => {
    expect(buildRestartHandoffWiring({ origin: tuiOrigin }, fakeSessionManager('/agent/sessions/ses-1.jsonl'))).toEqual(
      {},
    )
  })

  test('emits nothing when origin is undefined', () => {
    expect(
      buildRestartHandoffWiring({ plugins: { agentDir: '/agent' } }, fakeSessionManager('/agent/sessions/ses-1.jsonl')),
    ).toEqual({})
  })
})
