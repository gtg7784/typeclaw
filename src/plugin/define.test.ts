import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { noopPermissionService } from '@/permissions'

import { defineCommand, definePlugin, readTool, writeTool } from './define'
import type { ContainerCommand, EitherCommand, HostCommand } from './types'

describe('definePlugin', () => {
  test('accepts a top-level commands field alongside the factory', () => {
    const spec = definePlugin({
      commands: {
        ping: defineCommand({
          surface: 'host',
          description: 'ping',
          run: async () => 0,
        }),
      },
      plugin: async () => ({}),
    })
    expect(spec.commands).toBeDefined()
    expect(Object.keys(spec.commands ?? {})).toEqual(['ping'])
  })

  test('infers config type from configSchema and feeds validated values into the factory ctx', async () => {
    const captured: { value: unknown } = { value: undefined }
    const spec = definePlugin({
      configSchema: z.object({ count: z.number().default(7) }),
      plugin: async (ctx) => {
        captured.value = ctx.config.count
        return {}
      },
    })
    await spec.plugin({
      name: 't',
      version: undefined,
      agentDir: '/tmp',
      config: { count: 42 },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      permissions: noopPermissionService,
      github: {
        resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'test' }),
        hasAppTokenResolver: () => false,
      },
      spawnSubagent: async () => {},
    })
    expect(captured.value).toBe(42)
  })
})

describe('built-in tool refs', () => {
  test('each ref is a distinct opaque token carrying the engine tool name', () => {
    expect(readTool).not.toBe(writeTool)
    expect(readTool.__builtinTool).toBe('read')
    expect(writeTool.__builtinTool).toBe('write')
  })
})

describe('defineCommand', () => {
  test('returns the spec unchanged (identity pass-through)', () => {
    const spec: HostCommand = {
      surface: 'host',
      description: 'echo',
      run: async () => 0,
    }
    expect(defineCommand(spec)).toBe(spec)
  })

  test('container surface preserves prompt/subagent/exec on ctx (type inference)', async () => {
    let promptCalled = false
    const cmd = defineCommand({
      surface: 'container',
      description: 'test',
      args: z.object({ msg: z.string() }),
      run: async (ctx, args) => {
        const result = await ctx.prompt(`echo ${args.msg}`)
        expect(result).toBe('echoed: hi')
        promptCalled = true
        return 0
      },
    })
    expect(cmd.surface).toBe('container')

    const fakeStreams = {
      stdin: new ReadableStream<Uint8Array>(),
      stdout: new WritableStream<Uint8Array>(),
      stderr: new WritableStream<Uint8Array>(),
    }
    const code = await cmd.run(
      {
        ...fakeStreams,
        name: 'test-plugin',
        version: '0.0.1',
        agentDir: '/agent',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        permissions: noopPermissionService,
        origin: { kind: 'tui', sessionId: 'test' },
        signal: new AbortController().signal,
        prompt: async (text) => `echoed: ${text.replace('echo ', '')}`,
        subagent: async () => {},
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      },
      { msg: 'hi' },
    )
    expect(code).toBe(0)
    expect(promptCalled).toBe(true)
  })

  test('host surface ctx has no prompt/subagent/exec (type-level)', async () => {
    const cmd = defineCommand({
      surface: 'host',
      description: 'host-only',
      args: z.object({ verbose: z.boolean().default(false) }),
      run: async (ctx, args) => {
        // @ts-expect-error host ctx has no prompt capability
        ctx.prompt
        // @ts-expect-error host ctx has no subagent capability
        ctx.subagent
        // @ts-expect-error host ctx has no exec capability
        ctx.exec
        // @ts-expect-error host ctx has no permissions capability
        ctx.permissions
        return args.verbose ? 1 : 0
      },
    })
    expect(cmd.surface).toBe('host')

    const fakeStreams = {
      stdin: new ReadableStream<Uint8Array>(),
      stdout: new WritableStream<Uint8Array>(),
      stderr: new WritableStream<Uint8Array>(),
    }
    const code = await cmd.run(
      {
        ...fakeStreams,
        name: 'p',
        version: undefined,
        agentDir: '/Users/me/agent',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        signal: new AbortController().signal,
      },
      { verbose: true },
    )
    expect(code).toBe(1)
  })

  test('either surface ctx is the intersection of host and container', async () => {
    const cmd = defineCommand({
      surface: 'either',
      description: 'works anywhere',
      run: async (ctx) => {
        // @ts-expect-error either ctx has no prompt
        ctx.prompt
        // @ts-expect-error either ctx has no permissions
        ctx.permissions
        expect(typeof ctx.agentDir).toBe('string')
        return 0
      },
    })
    expect(cmd.surface).toBe('either')

    const fakeStreams = {
      stdin: new ReadableStream<Uint8Array>(),
      stdout: new WritableStream<Uint8Array>(),
      stderr: new WritableStream<Uint8Array>(),
    }
    await cmd.run(
      {
        ...fakeStreams,
        name: 'p',
        version: undefined,
        agentDir: '/agent',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        signal: new AbortController().signal,
      },
      undefined,
    )
  })

  test('args type is inferred from the Zod schema', () => {
    const cmd: ContainerCommand<{ count: number; label: string }> = defineCommand({
      surface: 'container',
      description: 'typed',
      args: z.object({ count: z.number(), label: z.string() }),
      run: async (_ctx, args) => args.count,
    })
    expect(cmd.description).toBe('typed')
  })

  test('without args, the args parameter is unknown', () => {
    const cmd: EitherCommand<unknown> = defineCommand({
      surface: 'either',
      description: 'no args',
      run: async () => 0,
    })
    expect(cmd.surface).toBe('either')
  })
})
