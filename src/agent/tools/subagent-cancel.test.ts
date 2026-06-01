import { describe, expect, test } from 'bun:test'

import { createPermissionService, rolesConfigSchema } from '@/permissions'

import { LiveSubagentRegistry, type LiveSubagent } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import { createSubagentCancelTool } from './subagent-cancel'

const ctx = {} as Parameters<ReturnType<typeof createSubagentCancelTool>['execute']>[4]

const guestOrigin: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C_GEN',
  thread: null,
}
const memberOrigin: SessionOrigin = { ...guestOrigin, lastInboundAuthorId: 'U_MEMBER' }

function capPermissions() {
  const roles = rolesConfigSchema.parse({
    guest: { match: [], permissions: ['subagent.cancel'] },
    member: { match: ['slack:T0123 author:U_MEMBER'], permissions: ['subagent.cancel'] },
  })
  return createPermissionService({ roles })
}

function makeLive(overrides: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    taskId: 'bg_c1',
    sessionId: 'ses_s1',
    subagentName: 'explorer',
    parentSessionId: 'ses_parent',
    startedAt: 1_000,
    status: 'running',
    abort: async () => {},
    ...overrides,
  }
}

describe('createSubagentCancelTool', () => {
  test('unknown task_id → ok=false', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    const tool = createSubagentCancelTool({
      liveRegistry,
      getOrigin: () => undefined,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_missing' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('Unknown task_id')
  })

  test('cancels running subagent and invokes abort() once', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    let abortCount = 0
    liveRegistry.register(
      makeLive({
        abort: async () => {
          abortCount += 1
        },
      }),
    )
    const tool = createSubagentCancelTool({
      liveRegistry,
      getOrigin: () => undefined,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_c1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; alreadyDone?: boolean }
    expect(details.ok).toBe(true)
    expect(details.alreadyDone).toBe(false)
    expect(abortCount).toBe(1)
  })

  test('already-completed task → ok=true with alreadyDone=true, no abort call', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    let abortCount = 0
    liveRegistry.register(
      makeLive({
        abort: async () => {
          abortCount += 1
        },
      }),
    )
    liveRegistry.recordCompletion('bg_c1', { ok: true, durationMs: 100 })

    const tool = createSubagentCancelTool({
      liveRegistry,
      getOrigin: () => undefined,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_c1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; alreadyDone?: boolean }
    expect(details.ok).toBe(true)
    expect(details.alreadyDone).toBe(true)
    expect(abortCount).toBe(0)
  })

  test('abort failure surfaces as ok=false error', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(
      makeLive({
        abort: async () => {
          throw new Error('upstream cancel rejected')
        },
      }),
    )
    const tool = createSubagentCancelTool({
      liveRegistry,
      getOrigin: () => undefined,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_c1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('upstream cancel rejected')
  })

  test('denied when origin lacks subagent.cancel', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    const tool = createSubagentCancelTool({
      liveRegistry,
      getOrigin: () => ({ kind: 'channel', adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null }),
      permissions: {
        has: () => false,
        resolveRole: () => 'guest',
        compareRoleSeverity: () => undefined,
        describe: () => ({ role: 'guest', permissions: [] }),
        replaceRoles: () => {},
      },
    })
    const result = await tool.execute('call_1', { task_id: 'bg_c1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('denied')
  })
})

describe('createSubagentCancelTool — provenance cap', () => {
  function makeTool(registry: LiveSubagentRegistry, origin: SessionOrigin) {
    return createSubagentCancelTool({ liveRegistry: registry, getOrigin: () => origin, permissions: capPermissions() })
  }

  test('guest cannot cancel a member-spawned subagent even when granted subagent.cancel', async () => {
    const registry = new LiveSubagentRegistry()
    let aborted = 0
    registry.register(makeLive({ spawnedByRole: 'member', abort: async () => void (aborted += 1) }))
    const result = await makeTool(registry, guestOrigin).execute('c', { task_id: 'bg_c1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('higher role')
    expect(aborted).toBe(0)
  })

  test('member can cancel a member-spawned subagent', async () => {
    const registry = new LiveSubagentRegistry()
    let aborted = 0
    registry.register(makeLive({ spawnedByRole: 'member', abort: async () => void (aborted += 1) }))
    const result = await makeTool(registry, memberOrigin).execute('c', { task_id: 'bg_c1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
    expect(aborted).toBe(1)
  })

  test('missing spawn role fails closed', async () => {
    const registry = new LiveSubagentRegistry()
    registry.register(makeLive())
    const result = await makeTool(registry, memberOrigin).execute('c', { task_id: 'bg_c1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('spawn role unavailable')
  })
})
