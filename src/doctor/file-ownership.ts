import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { DoctorCheck } from './types'

const MANAGED_PATHS = ['typeclaw.json', 'sessions', 'memory', '.typeclaw'] as const

export type FileOwnershipDeps = {
  readonly platform?: NodeJS.Platform
  readonly currentUid?: () => number
}

export function agentFileOwnership(deps: FileOwnershipDeps = {}): DoctorCheck {
  const platform = deps.platform ?? process.platform
  const currentUid = deps.currentUid ?? process.getuid

  return {
    name: 'agent-folder.file-ownership',
    category: 'agent-folder',
    description: 'agent-managed files are owned by the current host user',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      if (platform === 'win32' || currentUid === undefined) {
        return { status: 'ok', message: 'POSIX ownership does not apply on this host' }
      }

      const uid = currentUid()
      const foreignPaths: string[] = []
      for (const managedPath of MANAGED_PATHS) {
        collectForeignPaths(join(ctx.cwd, managedPath), ctx.cwd, uid, foreignPaths)
      }
      if (foreignPaths.length === 0) return { status: 'ok', message: 'agent-managed files match the host user' }

      return {
        status: 'error',
        message: `agent-managed files have a different owner: ${foreignPaths.join(', ')}`,
        details: [
          'This usually means an older TypeClaw container wrote bind-mounted files as root.',
          `Repair ownership from the agent folder: sudo chown -R "$(id -u):$(id -g)" ${MANAGED_PATHS.join(' ')}`,
        ],
      }
    },
  }
}

function collectForeignPaths(path: string, cwd: string, uid: number, foreignPaths: string[]): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.uid !== uid) foreignPaths.push(relative(cwd, path))
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path)) collectForeignPaths(join(path, entry), cwd, uid, foreignPaths)
}
