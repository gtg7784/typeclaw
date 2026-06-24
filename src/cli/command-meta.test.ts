import { describe, expect, test } from 'bun:test'

import { BUILTIN_COMMANDS, type BuiltinCommandName, getBuiltinCommandDescription } from './command-meta'

type MetaCarrier = { meta?: unknown }

// Each subcommand module's own `meta.description` (what citty prints for
// `typeclaw <cmd> --help`) must equal the table `src/cli/help.ts` renders the
// top-level usage from. They are separate sources only because importing the
// modules to build the top-level help is the cost this perf fix removes; this
// guard fails CI the moment a command's description drifts from the table.
const COMMAND_LOADERS: Record<BuiltinCommandName, () => Promise<MetaCarrier>> = {
  init: () => import('./init').then((m) => m.init),
  run: () => import('./run').then((m) => m.run),
  tui: () => import('./tui').then((m) => m.tui),
  start: () => import('./start').then((m) => m.startCommand),
  stop: () => import('./stop').then((m) => m.stopCommand),
  restart: () => import('./restart').then((m) => m.restartCommand),
  status: () => import('./status').then((m) => m.statusCommand),
  reload: () => import('./reload').then((m) => m.reload),
  logs: () => import('./logs').then((m) => m.logsCommand),
  inspect: () => import('./inspect').then((m) => m.inspectCommand),
  dreams: () => import('./dreams').then((m) => m.dreamsCommand),
  shell: () => import('./shell').then((m) => m.shellCommand),
  compose: () => import('./compose').then((m) => m.composeCommand),
  channel: () => import('./channel').then((m) => m.channelCommand),
  cron: () => import('./cron').then((m) => m.cronCommand),
  tunnel: () => import('./tunnel').then((m) => m.tunnelCommand),
  role: () => import('./role').then((m) => m.roleCommand),
  provider: () => import('./provider').then((m) => m.providerCommand),
  model: () => import('./model').then((m) => m.modelCommand),
  mount: () => import('./mount').then((m) => m.mountCommand),
  doctor: () => import('./doctor').then((m) => m.doctorCommand),
  usage: () => import('./usage').then((m) => m.usageCommand),
  update: () => import('./update').then((m) => m.updateCommand),
  _hostd: () => import('./hostd').then((m) => m.hostdCommand),
  '_update-check': () => import('./update-check').then((m) => m.updateCheckCommand),
}

async function metaDescription(name: BuiltinCommandName): Promise<string | undefined> {
  const cmd = await COMMAND_LOADERS[name]()
  const resolved = typeof cmd.meta === 'function' ? await (cmd.meta as () => unknown)() : await cmd.meta
  return (resolved as { description?: string } | undefined)?.description
}

describe('command-meta table', () => {
  test('every wired subcommand has a loader and vice versa', () => {
    const tableNames = new Set<string>(BUILTIN_COMMANDS.map((c) => c.name))
    const loaderNames = new Set<string>(Object.keys(COMMAND_LOADERS))
    expect([...tableNames].sort()).toEqual([...loaderNames].sort())
  })

  test('getBuiltinCommandDescription throws for an unknown name', () => {
    // @ts-expect-error intentionally off the union to exercise the guard
    expect(() => getBuiltinCommandDescription('nope')).toThrow()
  })

  test.each(BUILTIN_COMMANDS.map((c) => [c.name, c.description] as const))(
    '%s description matches its command module meta',
    async (name, description) => {
      expect(await metaDescription(name)).toBe(description)
    },
  )
})
