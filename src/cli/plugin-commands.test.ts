import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { renderCommandHelp, renderPluginCommandsSection } from './plugin-command-help'
import { discoverCommands, resolveAgentDir } from './plugin-commands'
import { dispatchPluginCommand } from './plugin-commands-dispatch'

const tmpDirs: string[] = []
const REPO_ROOT = resolvePath(import.meta.dir, '..', '..')
const PLUGIN_IMPORT = pathToFileURL(join(import.meta.dir, '..', 'plugin', 'index.ts')).href

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function mkTempAgent(plugin?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tcpc-'))
  tmpDirs.push(dir)
  // Symlink the workspace's node_modules so bare imports inside the test
  // plugin source (e.g. `import { z } from 'zod'`) resolve.
  await symlink(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir')
  const config: { plugins?: string[] } = {}
  if (plugin !== undefined) {
    const pluginPath = join(dir, 'plugin.ts')
    await writeFile(pluginPath, plugin, 'utf8')
    config.plugins = ['./plugin.ts']
  }
  await writeFile(join(dir, 'typeclaw.json'), JSON.stringify(config, null, 2), 'utf8')
  return dir
}

const HOST_ECHO_PLUGIN = `
import { definePlugin, defineCommand } from '${PLUGIN_IMPORT}'
import { z } from 'zod'

export default definePlugin({
  commands: {
    'host-echo': defineCommand({
      surface: 'host',
      description: 'echo a message to stdout',
      args: z.object({ msg: z.string() }),
      run: async (ctx, args) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(\`got: \${args.msg}\\n\`))
        writer.releaseLock()
        return 0
      },
    }),
  },
  plugin: async () => ({}),
})
`

const EITHER_AGENTDIR_PLUGIN = `
import { definePlugin, defineCommand } from '${PLUGIN_IMPORT}'

export default definePlugin({
  commands: {
    'agentdir': defineCommand({
      surface: 'either',
      description: 'print agentDir to stdout',
      run: async (ctx) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(ctx.agentDir + '\\n'))
        writer.releaseLock()
        return 0
      },
    }),
  },
  plugin: async () => ({}),
})
`

const CONTAINER_ONLY_PLUGIN = `
import { definePlugin, defineCommand } from '${PLUGIN_IMPORT}'

export default definePlugin({
  commands: {
    'container-only': defineCommand({
      surface: 'container',
      description: 'needs the agent runtime',
      run: async () => 0,
    }),
  },
  plugin: async () => ({}),
})
`

function collectStream(): { writable: WritableStream<Uint8Array>; getOutput: () => string } {
  const chunks: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  const getOutput = () => new TextDecoder().decode(concat(chunks))
  return { writable, getOutput }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function buildStreams(): {
  stdin: ReadableStream<Uint8Array>
  stdout: WritableStream<Uint8Array>
  stderr: WritableStream<Uint8Array>
  getStdout: () => string
  getStderr: () => string
} {
  const stdin = new ReadableStream<Uint8Array>({ start: (c) => c.close() })
  const out = collectStream()
  const err = collectStream()
  return {
    stdin,
    stdout: out.writable,
    stderr: err.writable,
    getStdout: out.getOutput,
    getStderr: err.getOutput,
  }
}

describe('resolveAgentDir', () => {
  test('returns null when no typeclaw.json exists in cwd or ancestors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tcpc-noagent-'))
    tmpDirs.push(dir)
    expect(resolveAgentDir(dir)).toBeNull()
  })

  test('returns the directory containing typeclaw.json', async () => {
    const dir = await mkTempAgent()
    expect(resolveAgentDir(dir)).toBe(dir)
  })

  test('walks up to find typeclaw.json from a nested cwd', async () => {
    const dir = await mkTempAgent()
    const nested = join(dir, 'sub', 'deep')
    await Bun.write(join(nested, '.placeholder'), '')
    expect(resolveAgentDir(nested)).toBe(dir)
  })
})

describe('discoverCommands', () => {
  test('returns empty when no agent dir resolvable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tcpc-noagent-'))
    tmpDirs.push(dir)
    const result = await discoverCommands({ cwd: dir })
    expect(result.commands).toEqual([])
    expect(result.loadErrors).toEqual([])
  })

  // 60s, not the global 30s: discoverCommands `await import()`s a temp plugin,
  // paying Bun's cold transpile + `@/plugin` graph resolution (~400ms in
  // isolation) that starves past 30s under full 18-worker contention.
  test('lists commands from a local plugin', async () => {
    const dir = await mkTempAgent(HOST_ECHO_PLUGIN)
    const result = await discoverCommands({ cwd: dir })
    expect(result.commands.map((c) => c.commandName)).toEqual(['host-echo'])
    expect(result.commands[0]?.command.surface).toBe('host')
    expect(result.loadErrors).toEqual([])
  }, 60_000)

  test('records load errors and continues', async () => {
    const dir = await mkTempAgent()
    await writeFile(join(dir, 'typeclaw.json'), JSON.stringify({ plugins: ['./does-not-exist.ts'] }, null, 2), 'utf8')
    const result = await discoverCommands({ cwd: dir })
    expect(result.commands).toEqual([])
    expect(result.loadErrors.length).toBeGreaterThan(0)
  })
})

describe('dispatchPluginCommand', () => {
  test('QA-5: invokes a host command end-to-end', async () => {
    const dir = await mkTempAgent(HOST_ECHO_PLUGIN)
    const { stdin, stdout, stderr, getStdout } = buildStreams()
    const outcome = await dispatchPluginCommand({
      name: 'host-echo',
      rawArgs: ['--msg=hello'],
      cwd: dir,
      stdin,
      stdout,
      stderr,
    })
    expect(outcome.kind).toBe('dispatched')
    if (outcome.kind === 'dispatched') {
      expect(outcome.exitCode).toBe(0)
    }
    expect(getStdout()).toContain('got: hello')
  })

  test('QA-12: zod args validation rejection with exit 2', async () => {
    const dir = await mkTempAgent(HOST_ECHO_PLUGIN)
    const { stdin, stdout, stderr } = buildStreams()
    const outcome = await dispatchPluginCommand({
      name: 'host-echo',
      rawArgs: [],
      cwd: dir,
      stdin,
      stdout,
      stderr,
    })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.exitCode).toBe(2)
      expect(outcome.message).toMatch(/msg/)
    }
  })

  test('returns not-found when command name is unknown', async () => {
    const dir = await mkTempAgent(HOST_ECHO_PLUGIN)
    const { stdin, stdout, stderr } = buildStreams()
    const outcome = await dispatchPluginCommand({
      name: 'no-such-command',
      rawArgs: [],
      cwd: dir,
      stdin,
      stdout,
      stderr,
    })
    expect(outcome.kind).toBe('not-found')
  })

  test('QA-6: host command does not require a running container', async () => {
    const dir = await mkTempAgent(HOST_ECHO_PLUGIN)
    const { stdin, stdout, stderr, getStdout } = buildStreams()
    const outcome = await dispatchPluginCommand({
      name: 'host-echo',
      rawArgs: ['--msg=isolated'],
      cwd: dir,
      stdin,
      stdout,
      stderr,
    })
    expect(outcome.kind).toBe('dispatched')
    expect(getStdout()).toContain('got: isolated')
  })

  test('QA-11 partial: either command works on host stage', async () => {
    const dir = await mkTempAgent(EITHER_AGENTDIR_PLUGIN)
    const { stdin, stdout, stderr, getStdout } = buildStreams()
    const outcome = await dispatchPluginCommand({
      name: 'agentdir',
      rawArgs: [],
      cwd: dir,
      stdin,
      stdout,
      stderr,
    })
    expect(outcome.kind).toBe('dispatched')
    expect(getStdout().trim()).toBe(dir)
  })

  test('container command without a running container errors with start-it hint', async () => {
    const dir = await mkTempAgent(CONTAINER_ONLY_PLUGIN)
    const { stdin, stdout, stderr } = buildStreams()
    const outcome = await dispatchPluginCommand({
      name: 'container-only',
      rawArgs: [],
      cwd: dir,
      stdin,
      stdout,
      stderr,
    })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/typeclaw start/)
    }
  })

  test('QA-16: renderPluginCommandsSection includes every discovered command', async () => {
    const dir = await mkTempAgent(HOST_ECHO_PLUGIN)
    const discovery = await discoverCommands({ cwd: dir })
    const section = renderPluginCommandsSection(discovery.commands)
    expect(section).not.toBeNull()
    expect(section).toContain('Plugin commands:')
    expect(section).toContain('host-echo')
    expect(section).toContain('echo a message to stdout')
  })

  test('QA-17: renderPluginCommandsSection returns null when no commands discovered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tcpc-noagent-'))
    tmpDirs.push(dir)
    const discovery = await discoverCommands({ cwd: dir })
    expect(renderPluginCommandsSection(discovery.commands)).toBeNull()
  })

  test('QA-18: --help renders the command schema', async () => {
    const dir = await mkTempAgent(HOST_ECHO_PLUGIN)
    const { stdin, stdout, stderr, getStdout } = buildStreams()
    const outcome = await dispatchPluginCommand({
      name: 'host-echo',
      rawArgs: ['--help'],
      cwd: dir,
      stdin,
      stdout,
      stderr,
    })
    expect(outcome.kind).toBe('dispatched')
    const help = getStdout()
    expect(help).toContain('typeclaw host-echo')
    expect(help).toContain('--msg=<string>')
  })
})

describe('renderCommandHelp', () => {
  test('renders default values and required flags', async () => {
    const dir = await mkTempAgent(`
import { definePlugin, defineCommand } from '${PLUGIN_IMPORT}'
import { z } from 'zod'

export default definePlugin({
  commands: {
    'with-defaults': defineCommand({
      surface: 'host',
      description: 'demo defaults',
      args: z.object({
        name: z.string(),
        loud: z.boolean().default(false),
        count: z.number().default(3),
      }),
      run: async () => 0,
    }),
  },
  plugin: async () => ({}),
})
`)
    const discovery = await discoverCommands({ cwd: dir })
    const cmd = discovery.commands[0]
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const help = renderCommandHelp(cmd)
    expect(help).toContain('--name=<string>')
    expect(help).toContain('(required)')
    expect(help).toContain('--loud=<boolean>')
    expect(help).toContain('(default: false)')
    expect(help).toContain('--count=<number>')
    expect(help).toContain('(default: 3)')
  })

  test('renders "(no options)" for commands without args', async () => {
    const dir = await mkTempAgent(`
import { definePlugin, defineCommand } from '${PLUGIN_IMPORT}'

export default definePlugin({
  commands: {
    'noargs': defineCommand({
      surface: 'host',
      description: 'no args',
      run: async () => 0,
    }),
  },
  plugin: async () => ({}),
})
`)
    const discovery = await discoverCommands({ cwd: dir })
    const cmd = discovery.commands[0]
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    expect(renderCommandHelp(cmd)).toContain('(no options)')
  })
})
