import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { wrapPluginTool } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import { createHookBus, defineTool } from '@/plugin'

import { createPermissionService } from './permissions'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

// These tests exercise production wiring rather than pure service logic.
// They guard the bugs the Oracle review flagged: tool.before must receive
// the LIVE origin (not the cold-start snapshot), and permission gating
// must resolve against that live origin per turn for channel sessions.

describe('production-path: tool.before sees live origin per turn', () => {
  test('channel session-style: lastInboundAuthorId update flips author: rule match', async () => {
    const svc = createPermissionService({
      roles: { trusted: { match: [{ kind: 'channel', platform: 'slack', workspace: 'T0', author: 'U_ME' }] } },
      pluginPermissions: ['security.bypass.secretExfilBash'],
    })

    const seenRoles: string[] = []
    const hooks = createHookBus()
    hooks.registerAll('p', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenRoles.push(svc.resolveRole(event.origin))
        return undefined
      },
    })

    const live: { current: SessionOrigin | undefined } = {
      current: {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C',
        thread: null,
      },
    }

    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p',
      toolName: 't',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
      getOrigin: () => live.current,
    })

    // Turn 1: stranger speaks. Origin has no lastInboundAuthorId -> guest.
    await wrapped.execute('c1', {}, undefined, undefined, {} as never)

    // Turn 2: U_ME speaks. Router updates the holder before prompt(); now
    // the same wrapped tool's tool.before stamps the live origin with the
    // trusted author -> resolves to `trusted`.
    live.current = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C',
      thread: null,
      lastInboundAuthorId: 'U_ME',
    }
    await wrapped.execute('c2', {}, undefined, undefined, {} as never)

    // Turn 3: stranger again -> guest.
    live.current = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C',
      thread: null,
      lastInboundAuthorId: 'U_STRANGER',
    }
    await wrapped.execute('c3', {}, undefined, undefined, {} as never)

    expect(seenRoles).toEqual(['guest', 'trusted', 'guest'])
  })
})

describe('production-path: subagent provenance inheritance', () => {
  test('cron-spawned subagent inherits the cron job role', () => {
    // The cron consumer emits stream-target fields that the subagent
    // consumer reads on the other side. Verify the full payload shape
    // the consumer expects.
    const svc = createPermissionService({ pluginPermissions: ['security.bypass.gitExfil'] })

    // Simulating what the cron consumer publishes for a job stamped 'owner':
    const stampedOrigin: SessionOrigin = {
      kind: 'subagent',
      subagent: 'dreaming',
      parentSessionId: 'cron-job-X',
      spawnedByRole: 'owner',
      spawnedByOrigin: { kind: 'cron', jobId: 'X', jobKind: 'prompt', scheduledByRole: 'owner' },
    }
    expect(svc.resolveRole(stampedOrigin)).toBe('owner')
  })

  test('attacker-laundered cron stamped as guest cannot bypass', () => {
    const svc = createPermissionService({ pluginPermissions: ['security.bypass.secretExfilBash'] })
    const laundered: SessionOrigin = {
      kind: 'cron',
      jobId: 'laundered',
      jobKind: 'prompt',
      scheduledByRole: 'guest',
    }
    expect(svc.resolveRole(laundered)).toBe('guest')
    expect(svc.has(laundered, 'security.bypass.secretExfilBash')).toBe(false)
  })
})

describe('production-path: plugin cron default role', () => {
  test('plugin cron jobs run as owner by default (memory dreaming, etc.)', () => {
    const svc = createPermissionService({ pluginPermissions: ['security.bypass.secretExfilBash'] })
    // Mirrors what toCronJob() in src/plugin/registry.ts produces:
    const pluginJobOrigin: SessionOrigin = {
      kind: 'cron',
      jobId: '__plugin_memory_dreaming',
      jobKind: 'prompt',
      scheduledByRole: 'owner',
    }
    expect(svc.resolveRole(pluginJobOrigin)).toBe('owner')
    expect(svc.has(pluginJobOrigin, 'security.bypass.secretExfilBash')).toBe(true)
  })
})
