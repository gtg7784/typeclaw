import { defineCommand } from 'citty'

import { addMount, listMounts, removeMount, type MountListEntry } from '@/config/mounts-mutation'
import { findAgentDir, isInitialized } from '@/init'

import { c, errorLine, successLine } from './ui'

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'list host directories mounted into the agent container',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'emit mounts as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const mounts = listMounts(cwd)
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ mounts }, null, 2)}\n`)
      return
    }
    process.stdout.write(`${formatMountList(mounts)}\n`)
  },
})

const addSub = defineCommand({
  meta: {
    name: 'add',
    description: 'add a host directory mount to typeclaw.json',
  },
  args: {
    name: {
      type: 'positional',
      description: 'mount name; appears inside the container at /agent/mounts/<name>',
      required: true,
    },
    path: {
      type: 'positional',
      description: 'host directory path to expose inside the container',
      required: true,
    },
    'read-only': {
      type: 'boolean',
      description: 'mount read-only inside the container',
      default: false,
    },
    description: {
      type: 'string',
      description: 'optional human-readable note stored in typeclaw.json',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const result = addMount(cwd, args.name, args.path, {
      readOnly: args['read-only'] === true,
      ...(args.description !== undefined ? { description: args.description } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    process.stdout.write(`${successLine(`Added mount "${result.entry.name}".`)}\n`)
    process.stdout.write(`${formatMountEntry(result.entry)}\n`)
    process.stdout.write(`${c.dim('Apply change:')} ${c.cyan('typeclaw restart')}\n`)
  },
})

const removeSub = defineCommand({
  meta: {
    name: 'remove',
    description: 'remove a host directory mount from typeclaw.json',
  },
  args: {
    name: {
      type: 'positional',
      description: 'mount name to remove',
      required: true,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const result = removeMount(cwd, args.name)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    process.stdout.write(`${successLine(`Removed mount "${result.removed.name}".`)}\n`)
    process.stdout.write(`${c.dim('Apply change:')} ${c.cyan('typeclaw restart')}\n`)
  },
})

export const mountCommand = defineCommand({
  meta: {
    name: 'mount',
    description: 'manage host directories mounted into the agent container',
  },
  subCommands: {
    list: listSub,
    add: addSub,
    remove: removeSub,
  },
})

export function formatMountList(mounts: readonly MountListEntry[]): string {
  if (mounts.length === 0) return c.dim('No mounts configured.')

  const nameWidth = Math.max(4, ...mounts.map((m) => m.name.length))
  const modeWidth = 'MODE'.length
  const statusWidth = Math.max(6, ...mounts.map((m) => m.status.length))
  const lines: string[] = []
  lines.push(
    c.dim(
      `${'NAME'.padEnd(nameWidth)}  ${'MODE'.padEnd(modeWidth)}  ${'STATUS'.padEnd(statusWidth)}  HOST PATH -> CONTAINER PATH`,
    ),
  )
  for (const mount of mounts) {
    const mode = mount.readOnly ? 'ro' : 'rw'
    const statusText = mount.status.padEnd(statusWidth)
    const status = mount.status === 'ok' ? c.green(statusText) : c.red(statusText)
    lines.push(
      `${mount.name.padEnd(nameWidth)}  ${mode.padEnd(modeWidth)}  ${status}  ${mount.resolvedPath} -> ${mount.targetPath}`,
    )
    if (mount.description !== undefined) {
      lines.push(`${' '.repeat(nameWidth + modeWidth + statusWidth + 6)}${c.dim(mount.description)}`)
    }
    if (mount.statusReason !== undefined) {
      lines.push(`${' '.repeat(nameWidth + modeWidth + statusWidth + 6)}${c.yellow(mount.statusReason)}`)
    }
  }
  return lines.join('\n')
}

function formatMountEntry(mount: MountListEntry): string {
  const mode = mount.readOnly ? 'read-only' : 'read-write'
  const details = [
    `${c.dim('host:')} ${mount.resolvedPath}`,
    `${c.dim('container:')} ${mount.targetPath}`,
    `${c.dim('mode:')} ${mode}`,
  ]
  if (mount.description !== undefined) details.push(`${c.dim('description:')} ${mount.description}`)
  return details.join('\n')
}

function ensureAgentDir(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  if (!isInitialized(cwd)) {
    console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
    process.exit(1)
  }
  return cwd
}
