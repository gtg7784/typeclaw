import { describe, expect, test } from 'bun:test'

import { defineTool as definePiTool } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { z } from 'zod'

import { createHookBus, defineTool } from '@/plugin'

import { wrapPluginTool, wrapSystemAgentTool, wrapSystemTool, zodToToolParameters } from './plugin-tools'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

function textOfFirstContent(result: { content: { type: string; text?: string }[] }): string | undefined {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : undefined
}

describe('zodToToolParameters', () => {
  test('produces a JSON-schema-shaped object from a Zod schema', () => {
    const schema = z.object({ name: z.string(), age: z.number().optional() })
    const json = zodToToolParameters(schema) as { type?: string; properties?: Record<string, unknown> }
    expect(json.type).toBe('object')
    expect(json.properties).toBeDefined()
    expect(json.properties).toHaveProperty('name')
    expect(json.properties).toHaveProperty('age')
  })
})

describe('wrapPluginTool', () => {
  test('passes parsed args to plugin execute and exposes ToolContext', async () => {
    const seen: { args: unknown; ctx: { sessionId: string; agentDir: string } }[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args, ctx) {
        seen.push({ args, ctx: { sessionId: ctx.sessionId, agentDir: ctx.agentDir } })
        return { content: [{ type: 'text', text: `q=${args.q}` }] }
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'sess-1',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const result = (await wrapped.execute('call-1', { q: 'hello' }, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0]?.text).toBe('q=hello')
    expect(seen[0]?.args).toEqual({ q: 'hello' })
    expect(seen[0]?.ctx.sessionId).toBe('sess-1')
    expect(seen[0]?.ctx.agentDir).toBe('/agent')
  })

  test('tool.before mutations to args propagate to the plugin tool execute', async () => {
    const seen: unknown[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        seen.push(args)
        return { content: [{ type: 'text', text: '' }] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.q = 'mutated'
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    await wrapped.execute('c', { q: 'original' }, undefined, undefined, {} as never)
    expect(seen[0]).toEqual({ q: 'mutated' })
  })

  test('tool.before { block: true } refuses execution and never invokes plugin tool', async () => {
    const calls: number[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        calls.push(1)
        return { content: [] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no thanks' }),
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    const result = (await wrapped.execute('c', {}, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
      isError?: boolean
    }
    expect(calls).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no thanks')
  })

  test('tool.after observes the plugin tool result', async () => {
    const observed: unknown[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'done' }] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.after': (event) => {
        observed.push(event.result.content[0])
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    await wrapped.execute('c', {}, undefined, undefined, {} as never)
    expect(observed[0]).toEqual({ type: 'text', text: 'done' })
  })

  test('returns error result when args fail Zod validation', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        return { content: [] }
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    const result = (await wrapped.execute('c', { q: 42 }, undefined, undefined, {} as never)) as {
      isError?: boolean
    }
    expect(result.isError).toBe(true)
  })

  test('returns error result when plugin tool throws', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        throw new Error('kaboom')
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    const result = (await wrapped.execute('c', {}, undefined, undefined, {} as never)) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('kaboom')
  })

  test('forwards the AbortSignal from the engine through to the plugin tool', async () => {
    const captured: { signal: AbortSignal | undefined } = { signal: undefined }
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute(_args, ctx) {
        captured.signal = ctx.signal
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const controller = new AbortController()
    await wrapped.execute('c', {}, controller.signal, undefined, {} as never)
    expect(captured.signal).toBe(controller.signal)
  })
})

describe('wrapSystemTool', () => {
  test('tool.before mutations propagate to TypeClaw system tool execution and tool.after can rewrite the result', async () => {
    const seen: unknown[] = []
    const observed: unknown[] = []
    const tool = definePiTool({
      name: 'reload',
      label: 'reload',
      description: '',
      parameters: Type.Object({ q: Type.String() }),
      async execute(_callId, params) {
        seen.push(params)
        return { content: [{ type: 'text', text: `q=${params.q}` }], details: { q: params.q } }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.q = 'mutated'
      },
      'tool.after': (event) => {
        observed.push(event.result.details)
        event.result.content = [{ type: 'text', text: 'rewritten' }]
        event.result.details = { rewritten: true }
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const result = await wrapped.execute('c', { q: 'original' }, undefined, undefined, {} as never)
    expect(textOfFirstContent(result)).toBe('rewritten')
    expect(result.details).toEqual({ rewritten: true })
    expect(seen[0]).toEqual({ q: 'mutated' })
    expect(observed[0]).toEqual({ q: 'mutated' })
  })

  test('tool.before { block: true } rejects TypeClaw system tool execution through the engine error path', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'restart',
      label: 'restart',
      description: '',
      parameters: Type.Object({}),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no restart' }),
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(wrapped.execute('c', {}, undefined, undefined, {} as never)).rejects.toThrow('blocked: no restart')
    expect(calls).toEqual([])
  })

  test('write system tool exposes and strips guard acknowledgements before execution', async () => {
    const seen: unknown[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object(
        {
          path: Type.String(),
          content: Type.String(),
        },
        { additionalProperties: false },
      ),
      async execute(_callId, params) {
        seen.push(params)
        return { content: [{ type: 'text', text: 'wrote' }], details: params }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        expect(event.args.acknowledgeGuards).toEqual({ nonWorkspaceWrite: true })
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const parameters = wrapped.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toHaveProperty('acknowledgeGuards')
    await wrapped.execute(
      'c',
      { path: 'typeclaw.json', content: '{}', acknowledgeGuards: { nonWorkspaceWrite: true } },
      undefined,
      undefined,
      {} as never,
    )

    expect(seen[0]).toEqual({ path: 'typeclaw.json', content: '{}' })
  })

  test('write system tool runs a final guard after hook mutations', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.path = 'notes.md'
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(
      wrapped.execute('c', { path: 'workspace/file.txt', content: 'x' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Guard `nonWorkspaceWrite` blocked write outside the workspace')
    expect(calls).toEqual([])
  })
})

describe('wrapSystemAgentTool', () => {
  test('tool.before and tool.after fire for built-in pi-style agent tools and can rewrite the result', async () => {
    const seen: unknown[] = []
    const observed: unknown[] = []
    const tool = {
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_callId: string, params: { path: string }) {
        seen.push(params)
        return { content: [{ type: 'text' as const, text: params.path }], details: { path: params.path } }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.path = '/mutated'
      },
      'tool.after': (event) => {
        observed.push(event.result.details)
        event.result.content = [{ type: 'text', text: 'rewritten read' }]
        event.result.details = { rewritten: true }
      },
    })

    const wrapped = wrapSystemAgentTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const result = await wrapped.execute('c', { path: '/original' })
    expect(textOfFirstContent(result)).toBe('rewritten read')
    expect(result.details as Record<string, unknown>).toEqual({ rewritten: true })
    expect(seen[0]).toEqual({ path: '/mutated' })
    expect(observed[0]).toEqual({ path: '/mutated' })
  })

  test('tool.before { block: true } rejects built-in pi-style agent tool execution through the engine error path', async () => {
    const calls: number[] = []
    const tool = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_callId: string, _params: { command: string }) {
        calls.push(1)
        return { content: [], details: undefined }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no bash' }),
    })

    const wrapped = wrapSystemAgentTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(wrapped.execute('c', { command: 'pwd' })).rejects.toThrow('blocked: no bash')
    expect(calls).toEqual([])
  })

  test('edit built-in agent tool exposes and strips guard acknowledgements before execution', async () => {
    const seen: unknown[] = []
    const tool = {
      name: 'edit',
      label: 'edit',
      description: '',
      parameters: Type.Object(
        {
          path: Type.String(),
          edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
        },
        { additionalProperties: false },
      ),
      async execute(
        _callId: string,
        params: {
          path: string
          edits: { oldText: string; newText: string }[]
          acknowledgeGuards?: { nonWorkspaceWrite?: boolean }
        },
      ) {
        seen.push(params)
        return { content: [{ type: 'text' as const, text: 'edited' }], details: params }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        expect(event.args.acknowledgeGuards).toEqual({ nonWorkspaceWrite: true })
      },
    })

    const wrapped = wrapSystemAgentTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const parameters = wrapped.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toHaveProperty('acknowledgeGuards')
    const params = {
      path: 'typeclaw.json',
      edits: [{ oldText: 'x', newText: 'y' }],
      acknowledgeGuards: { nonWorkspaceWrite: true },
    } as unknown as Parameters<typeof wrapped.execute>[1]
    await wrapped.execute('c', params)

    expect(seen[0]).toEqual({ path: 'typeclaw.json', edits: [{ oldText: 'x', newText: 'y' }] })
  })
})
