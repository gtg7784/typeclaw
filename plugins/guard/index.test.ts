import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { HookContext, PluginContext, ToolBeforeEvent } from '@/plugin'

import guardPlugin from './index'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('guard plugin', () => {
  test('blocks write calls outside workspace until nonWorkspaceWrite is acknowledged', async () => {
    const hook = await toolBeforeHook()

    const blocked = await hook(toolEvent('write', { path: 'notes.md', content: '{}' }), hookContext('/agent'))
    const acknowledged = await hook(
      toolEvent('write', {
        path: 'notes.md',
        content: '{}',
        acknowledgeGuards: { nonWorkspaceWrite: true },
      }),
      hookContext('/agent'),
    )

    expect(blocked).toEqual({
      block: true,
      reason:
        'Guard `nonWorkspaceWrite` blocked write outside the workspace: /agent/notes.md. The free-write zone is /agent/workspace. Retry with `acknowledgeGuards.nonWorkspaceWrite: true` only if this write is intentional.',
    })
    expect(acknowledged).toBeUndefined()
  })

  test('allows write and edit calls inside workspace', async () => {
    const hook = await toolBeforeHook()

    const writeResult = await hook(
      toolEvent('write', { path: 'workspace/file.txt', content: 'x' }),
      hookContext('/agent'),
    )
    const editResult = await hook(
      toolEvent('edit', { path: '/agent/workspace/file.txt', edits: [{ oldText: 'x', newText: 'y' }] }),
      hookContext('/agent'),
    )

    expect(writeResult).toBeUndefined()
    expect(editResult).toBeUndefined()
  })

  test('blocks lexical workspace escapes and workspace-like sibling paths', async () => {
    const hook = await toolBeforeHook()

    const dotDotResult = await hook(
      toolEvent('write', { path: 'workspace/../notes.md', content: '{}' }),
      hookContext('/agent'),
    )
    const siblingResult = await hook(
      toolEvent('write', { path: 'workspace2/file.txt', content: 'x' }),
      hookContext('/agent'),
    )
    const absoluteResult = await hook(
      toolEvent('write', { path: '/tmp/outside.txt', content: 'x' }),
      hookContext('/agent'),
    )

    expect(dotDotResult?.block).toBe(true)
    expect(siblingResult?.block).toBe(true)
    expect(absoluteResult?.block).toBe(true)
  })

  test('allows known writable files at the agent root', async () => {
    const hook = await toolBeforeHook()

    for (const file of [
      'AGENTS.md',
      'IDENTITY.md',
      'MEMORY.md',
      'SOUL.md',
      'USER.md',
      'cron.json',
      'package.json',
      'typeclaw.json',
    ]) {
      const result = await hook(toolEvent('write', { path: file, content: 'x' }), hookContext('/agent'))
      expect(result).toBeUndefined()
    }
  })

  test('allows writes under the agent root mounts directory', async () => {
    const hook = await toolBeforeHook()

    const relativeResult = await hook(
      toolEvent('write', { path: 'mounts/data/file.txt', content: 'x' }),
      hookContext('/agent'),
    )
    const absoluteResult = await hook(
      toolEvent('edit', { path: '/agent/mounts/config.json', edits: [{ oldText: 'x', newText: 'y' }] }),
      hookContext('/agent'),
    )

    expect(relativeResult).toBeUndefined()
    expect(absoluteResult).toBeUndefined()
  })

  test('allows writes under the agent root packages directory (bun workspace root)', async () => {
    const hook = await toolBeforeHook()

    const newPackageFile = await hook(
      toolEvent('write', { path: 'packages/my-plugin/index.ts', content: 'export {}' }),
      hookContext('/agent'),
    )
    const newPackageJson = await hook(
      toolEvent('write', { path: 'packages/my-plugin/package.json', content: '{}' }),
      hookContext('/agent'),
    )
    const editAbsolute = await hook(
      toolEvent('edit', {
        path: '/agent/packages/my-plugin/index.ts',
        edits: [{ oldText: 'export {}', newText: 'export const x = 1' }],
      }),
      hookContext('/agent'),
    )

    expect(newPackageFile).toBeUndefined()
    expect(newPackageJson).toBeUndefined()
    expect(editAbsolute).toBeUndefined()
  })

  test('still blocks unknown files and nested paths under allowed root names', async () => {
    const hook = await toolBeforeHook()

    const unknownRoot = await hook(toolEvent('write', { path: 'notes.md', content: 'x' }), hookContext('/agent'))
    const nestedUnderAllowedName = await hook(
      toolEvent('write', { path: 'AGENTS.md/nested.txt', content: 'x' }),
      hookContext('/agent'),
    )

    expect(unknownRoot?.block).toBe(true)
    expect(nestedUnderAllowedName?.block).toBe(true)
  })

  test('blocks workspace symlinks that escape the real workspace directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-'))
    const agentDir = path.join(root, 'agent')
    const workspaceDir = path.join(agentDir, 'workspace')
    const outsideDir = path.join(root, 'outside')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDir)
    await symlink(outsideDir, path.join(workspaceDir, 'outside-link'))
    const hook = await toolBeforeHook()

    const result = await hook(
      toolEvent('write', { path: 'workspace/outside-link/file.txt', content: 'x' }),
      hookContext(agentDir),
    )

    expect(result?.block).toBe(true)
  })

  test('ignores non-mutating tools and invalid paths', async () => {
    const hook = await toolBeforeHook()

    const readResult = await hook(toolEvent('read', { path: 'typeclaw.json' }), hookContext('/agent'))
    const invalidPathResult = await hook(toolEvent('write', { path: 42, content: 'x' }), hookContext('/agent'))

    expect(readResult).toBeUndefined()
    expect(invalidPathResult).toBeUndefined()
  })
})

async function toolBeforeHook(): Promise<
  NonNullable<NonNullable<Awaited<ReturnType<typeof guardPlugin.plugin>>['hooks']>['tool.before']>
> {
  const exports = await guardPlugin.plugin(pluginContext('/agent'))
  const hook = exports.hooks?.['tool.before']
  if (!hook) throw new Error('guard plugin did not register tool.before')
  return hook
}

function toolEvent(tool: string, args: Record<string, unknown>): ToolBeforeEvent {
  return { tool, sessionId: 's', callId: 'c', args }
}

function hookContext(agentDir: string): HookContext {
  return { agentDir, pluginName: 'guard', logger: noopLogger }
}

function pluginContext(agentDir: string): PluginContext<undefined> {
  return {
    name: 'guard',
    version: undefined,
    agentDir,
    config: undefined,
    logger: noopLogger,
    spawnSubagent: async () => {},
  }
}
