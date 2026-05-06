import { realpath } from 'node:fs/promises'
import path from 'node:path'

import { ACKNOWLEDGE_GUARDS, type GuardBlock, isGuardAcknowledged } from '../policy'

export const GUARD_NON_WORKSPACE_WRITE = 'nonWorkspaceWrite'

const AGENT_ROOT_WRITE_ALLOWLIST = new Set([
  'AGENTS.md',
  'IDENTITY.md',
  'MEMORY.md',
  'SOUL.md',
  'USER.md',
  'cron.json',
  'typeclaw.json',
])

export async function checkNonWorkspaceWriteGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<GuardBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = path.resolve(agentDir, rawPath)
  const workspacePath = path.resolve(agentDir, 'workspace')
  if (isAllowedAgentRootWrite(agentDir, targetPath)) return undefined

  const [realTargetPath, realWorkspacePath] = await Promise.all([
    resolveRealIntendedPath(targetPath),
    resolveRealIntendedPath(workspacePath),
  ])
  if (isInside(realWorkspacePath, realTargetPath)) return undefined
  if (isGuardAcknowledged(args, GUARD_NON_WORKSPACE_WRITE)) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_NON_WORKSPACE_WRITE}\` blocked ${tool} outside the workspace: ${targetPath}.`,
      `The free-write zone is ${workspacePath}.`,
      `Retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_NON_WORKSPACE_WRITE}: true\` only if this write is intentional.`,
    ].join(' '),
  }
}

function isAllowedAgentRootWrite(agentDir: string, targetPath: string): boolean {
  return (
    path.dirname(targetPath) === path.resolve(agentDir) && AGENT_ROOT_WRITE_ALLOWLIST.has(path.basename(targetPath))
  )
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveRealIntendedPath(absolutePath: string): Promise<string> {
  const pending: string[] = []
  let current = absolutePath

  while (true) {
    try {
      const realCurrent = await realpath(current)
      return path.join(realCurrent, ...pending.reverse())
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }

    const parent = path.dirname(current)
    if (parent === current) throw new Error(`could not resolve existing parent for ${absolutePath}`)
    pending.push(path.basename(current))
    current = parent
  }
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}
