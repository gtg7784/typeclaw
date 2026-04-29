import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { definePlugin, readTool, writeTool } from './define'

describe('definePlugin', () => {
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
