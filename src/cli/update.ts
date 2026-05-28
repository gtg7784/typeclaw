import { defineCommand } from 'citty'

import { formatCommand, planSelfUpdate, type UpdateManagerSelection } from '@/update'

import { c, errorLine, successLine } from './ui'

const MANAGERS = ['auto', 'bun', 'npm', 'pnpm', 'yarn'] as const

export const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description: 'update the globally installed typeclaw CLI',
  },
  args: {
    manager: {
      type: 'string',
      description: 'package manager to use: auto, bun, npm, pnpm, or yarn',
      default: 'auto',
    },
    'dry-run': {
      type: 'boolean',
      description: 'print the update command without running it',
      default: false,
    },
  },
  async run({ args }) {
    const manager = parseManager(args.manager)
    if (manager === null) {
      console.error(errorLine(`Invalid --manager=${args.manager}. Expected auto, bun, npm, pnpm, or yarn.`))
      process.exit(2)
    }

    const plan = planSelfUpdate({ manager })
    if (!plan.ok) {
      console.error(errorLine(plan.reason))
      process.exit(1)
    }

    const rendered = formatCommand(plan.command)
    if (args['dry-run']) {
      process.stdout.write(`${rendered}\n`)
      return
    }

    process.stdout.write(`${c.cyan('Updating TypeClaw with:')} ${rendered}\n`)
    const exitCode = await runUpdateCommand(plan.command)
    if (exitCode !== 0) {
      console.error(errorLine(`Update command exited with code ${exitCode}.`))
      process.exit(exitCode)
    }
    process.stdout.write(`${successLine('TypeClaw update command completed.')}\n`)
    process.stdout.write(`${c.dim('Restart running agent containers to pick up the new CLI runtime.')}\n`)
  },
})

function parseManager(value: string | undefined): UpdateManagerSelection | null {
  if (value === undefined) return 'auto'
  return (MANAGERS as readonly string[]).includes(value) ? (value as UpdateManagerSelection) : null
}

async function runUpdateCommand(command: string[]): Promise<number> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) {
    console.error(errorLine('bun runtime not available'))
    return 1
  }
  try {
    const proc = bun.spawn({
      cmd: command,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return await proc.exited
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      console.error(errorLine(`${command[0]} not found in $PATH.`))
      return 127
    }
    throw error
  }
}
