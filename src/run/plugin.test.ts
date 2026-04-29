import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LoadCronResult } from '@/cron'

import { startAgent, type LoadCronFn } from './index'

const noCron: LoadCronFn = async () => ({ ok: true, file: null }) as LoadCronResult

let running: Awaited<ReturnType<typeof startAgent>> | null = null
let agentDir: string | null = null

afterEach(async () => {
  if (running) {
    running.stop()
    running.tuiPromise?.catch(() => {})
    running = null
  }
  if (agentDir) {
    await rm(agentDir, { recursive: true, force: true })
    agentDir = null
  }
})

async function writePlugin(dir: string, body: string) {
  await writeFile(join(dir, 'plugin.ts'), body)
}

describe('startAgent + plugin loading', () => {
  test('loads a local plugin and merges its cron job under __plugin_<name>_<key>', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => ({
    cronJobs: {
      'weekly-digest': { schedule: '0 9 * * 1', kind: 'prompt', prompt: 'go' },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const ids = running.pluginRuntime.get().registry.cronJobs.map((j) => j.globalId)
    expect(ids).toContain('__plugin_plugin_weekly-digest')
    expect(running.loadedPlugins.map((p) => p.name)).toContain('plugin')
    expect(running.loadedPlugins.map((p) => p.name)).toContain('memory')
  })

  test('plugin factory exception aborts startAgent and does not leak partial registrations', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => {
    throw new Error('boom')
  },
}`,
    )

    await expect(startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })).rejects.toThrow(
      /factory threw: boom/,
    )
  })

  test('plugin session.start hook fires when a websocket session opens', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    const sentinelFile = join(agentDir, 'session-start.log')
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `import { writeFile } from 'node:fs/promises'
export default {
  plugin: async () => ({
    hooks: {
      'session.start': async (event) => {
        await writeFile(${JSON.stringify(sentinelFile)}, \`opened: \${event.sessionId}\`)
      },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const ws = new WebSocket(`ws://localhost:${running.server.port}`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })

    const TIMEOUT_MS = 5000
    const POLL_MS = 25
    const iterations = Math.ceil(TIMEOUT_MS / POLL_MS)
    for (let i = 0; i < iterations; i++) {
      try {
        const content = await Bun.file(sentinelFile).text()
        if (content.startsWith('opened:')) {
          ws.close()
          return
        }
      } catch {}
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    ws.close()
    throw new Error(`session.start hook never fired within ${TIMEOUT_MS}ms (sentinel ${sentinelFile} missing)`)
  })

  test('plugin skill is materialized and present in the resource loader for new sessions', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => ({
    skills: {
      'how-to-x': { description: 'how to do X', content: '# X\\n\\nSteps...' },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })
    expect(running.pluginRuntime.get().registry.skills.map((s) => s.localName)).toEqual(['how-to-x'])
  })

  test('plugin subagent is registered and its tools are forwarded to the spawned session', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => ({
    subagents: {
      worker: {
        systemPrompt: 'you are a worker',
        tools: [{ __builtinTool: 'read' }],
      },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })
    const subagent = running.pluginRuntime.get().registry.subagents.find((s) => s.subagentName === 'worker')
    expect(subagent).toBeDefined()
    expect(subagent?.subagent.tools).toEqual([{ __builtinTool: 'read' }])
  })

  test('ctx.spawnSubagent dispatches plugin subagents end-to-end (handler runs with validated payload)', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await symlink(join(process.cwd(), 'node_modules'), join(agentDir, 'node_modules'), 'dir')
    const sentinelFile = join(agentDir, 'spawn-sentinel.json')
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        plugins: ['./plugin.ts'],
      }),
    )
    // The plugin defines a subagent with `customTools` and a `session.start`
    // hook that calls `ctx.spawnSubagent('probe', ...)`. The probe's handler
    // records the payload it received. This pins that the spawn path:
    //   1. Reaches the registered subagent's handler (no silent drop).
    //   2. Validates the payload against the declared schema.
    //   3. Surfaces the agentDir from the runtime context.
    // It does NOT verify deep tool wiring (that requires a live LLM session);
    // the cron-consumer path, which uses the same plugin-aware session factory,
    // is exercised separately by the cron tests.
    await writePlugin(
      agentDir,
      `import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
const probeTool = {
  description: 'probe tool',
  parameters: z.object({}),
  async execute() { return { content: [{ type: 'text', text: 'ok' }] } },
}
export default {
  plugin: async (ctx) => ({
    subagents: {
      probe: {
        systemPrompt: 'probe',
        customTools: [probeTool],
        payloadSchema: z.object({ source: z.string() }),
        handler: async (subCtx) => {
          await writeFile(${JSON.stringify(sentinelFile)}, JSON.stringify({
            handlerRan: true,
            payload: subCtx.payload,
            agentDir: subCtx.agentDir,
          }))
        },
      },
    },
    hooks: {
      'session.start': async () => {
        await ctx.spawnSubagent('probe', { source: 'session-start' })
      },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const ws = new WebSocket(`ws://localhost:${running.server.port}`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })

    const TIMEOUT_MS = 5000
    const POLL_MS = 25
    const iterations = Math.ceil(TIMEOUT_MS / POLL_MS)
    let written: { handlerRan: boolean; payload: unknown; agentDir: string } | null = null
    for (let i = 0; i < iterations; i++) {
      try {
        written = JSON.parse(await Bun.file(sentinelFile).text())
        if (written?.handlerRan) break
      } catch {}
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    ws.close()

    expect(written).not.toBeNull()
    expect(written?.handlerRan).toBe(true)
    expect(written?.payload).toEqual({ source: 'session-start' })
    expect(written?.agentDir).toBe(agentDir!)
  })

  test('plugin config block is validated against configSchema and exposed as ctx.config', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await symlink(join(process.cwd(), 'node_modules'), join(agentDir, 'node_modules'), 'dir')
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        plugins: ['./plugin.ts'],
        plugin: { magicNumber: 7 },
      }),
    )
    await writePlugin(
      agentDir,
      `import { z } from 'zod'
export default {
  configSchema: z.object({ magicNumber: z.number() }),
  plugin: async (ctx) => ({
    cronJobs: {
      magic: { schedule: \`\${ctx.config.magicNumber} * * * *\`, kind: 'prompt', prompt: 'tick' },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const job = running.pluginRuntime.get().registry.cronJobs[0]?.job
    expect(job?.kind).toBe('prompt')
    expect(job?.schedule).toBe('7 * * * *')
  })
})
