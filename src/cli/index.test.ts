import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { BUILTIN_COMMAND_NAMES } from './builtins'

const REPO_ROOT = resolvePath(import.meta.dir, '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts')
const tmpDirs: string[] = []

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function mkAgent(pluginText?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tccli-'))
  tmpDirs.push(dir)
  await symlink(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir')
  const config: { plugins?: string[] } = {}
  if (pluginText !== undefined) {
    await writeFile(join(dir, 'plugin.ts'), pluginText, 'utf8')
    config.plugins = ['./plugin.ts']
  }
  await writeFile(join(dir, 'typeclaw.json'), JSON.stringify(config, null, 2), 'utf8')
  return dir
}

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bun', 'run', CLI_ENTRY, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TYPECLAW_TEST: '1' },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { stdout, stderr, code }
}

const ECHO_PLUGIN = `
import { definePlugin, defineCommand } from '${join(REPO_ROOT, 'src', 'plugin')}'
import { z } from 'zod'

export default definePlugin({
  commands: {
    'echo-host': defineCommand({
      surface: 'host',
      description: 'echo a message',
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

describe('BUILTIN_COMMAND_NAMES exposure', () => {
  test('contains every subCommand declared in cli/index.ts', () => {
    // Source of truth: this list must match what citty has wired in
    // src/cli/index.ts subCommands. The dispatch logic depends on it.
    expect(BUILTIN_COMMAND_NAMES).toContain('init')
    expect(BUILTIN_COMMAND_NAMES).toContain('start')
    expect(BUILTIN_COMMAND_NAMES).toContain('stop')
    expect(BUILTIN_COMMAND_NAMES).toContain('run')
    expect(BUILTIN_COMMAND_NAMES).toContain('tui')
    expect(BUILTIN_COMMAND_NAMES).toContain('doctor')
    expect(BUILTIN_COMMAND_NAMES).toContain('cron')
    expect(BUILTIN_COMMAND_NAMES).toContain('_hostd')
  })
})

// Each test spawns `bun run src/cli/index.ts` (~300-400ms cold start). The
// suite is otherwise hermetic — each test mkdtemp's its own agent folder, no
// shared state between tests — so `.concurrent` runs them on the runner's
// worker pool instead of serially. The 6 host-stage subprocess tests below
// drop from ~1.8s sequential to ~0.4s in parallel.
describe('typeclaw <plugin-command> on host stage', () => {
  test.concurrent('QA-5 end-to-end: dispatches a host command via CLI entrypoint', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { stdout, code } = await runCli(['echo-host', '--msg=hello'], dir)
    expect(code).toBe(0)
    expect(stdout).toContain('got: hello')
  })

  test.concurrent('exits 2 with stderr message when required arg is missing', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { stderr, code } = await runCli(['echo-host'], dir)
    expect(code).toBe(2)
    expect(stderr).toMatch(/msg/i)
  })

  test.concurrent('unknown command falls through to citty (no plugin match, no built-in)', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { code } = await runCli(['no-such-command'], dir)
    expect(code).not.toBe(0)
  })
})

describe('typeclaw --help on host stage', () => {
  test.concurrent('QA-16: appends a Plugin commands section listing discovered commands', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { stdout, code } = await runCli(['--help'], dir)
    expect(code).toBe(0)
    expect(stdout).toContain('Plugin commands:')
    expect(stdout).toContain('echo-host')
    expect(stdout).toContain('echo a message')
  })

  test.concurrent('QA-17: outside an agent folder, no Plugin commands section is shown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tccli-bare-'))
    tmpDirs.push(dir)
    const { stdout, code } = await runCli(['--help'], dir)
    expect(code).toBe(0)
    expect(stdout).not.toContain('Plugin commands:')
  })
})

describe('_hostd preservation', () => {
  test.concurrent('_hostd is recognized as a built-in (not routed to plugin dispatcher)', async () => {
    // We can't actually launch _hostd in a test (it would daemonize), but
    // we can verify it appears in `typeclaw --help` (citty subCommand) and
    // is in BUILTIN_COMMAND_NAMES so the intercept skips it.
    expect(BUILTIN_COMMAND_NAMES).toContain('_hostd')
    const dir = await mkAgent()
    const { stdout } = await runCli(['--help'], dir)
    // citty's help is the source; we just need to verify it ran (exit 0
    // with non-empty stdout would mean citty's runMain didn't bail).
    expect(stdout.length).toBeGreaterThan(0)
  })
})
