import { realpath } from 'node:fs/promises'
import path from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'

import { ACKNOWLEDGE_GUARDS, type GuardBlock, isGuardAcknowledged } from '../policy'
import { isMemoryRetrievalCacheWriteAllowed } from './memory-retrieval-cache-write'
import { isMemoryTopicsWriteAllowed } from './memory-topics-write'
import { isSkillAuthoringAllowed } from './skill-authoring'

export const GUARD_NON_WORKSPACE_WRITE = 'nonWorkspaceWrite'

const AGENT_ROOT_WRITE_ALLOWLIST = new Set([
  'AGENTS.md',
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'cron.json',
  'package.json',
  'typeclaw.json',
])

// All scaffolded write zones outside `workspace/` (see
// src/init/index.ts#DIRECTORIES) that the agent may write into without
// acknowledging the guard. `packages/` holds reusable systems and custom
// typeclaw plugins as standalone packages; `public/` is the guest-visible
// zone for anything intended to be shared out. Both are deliberate write
// targets, same as `workspace/`, so an unacknowledged write is expected, not
// suspicious.
const AGENT_ROOT_DIRECTORY_ALLOWLIST = new Set(['mounts', 'packages', 'public'])

export async function checkNonWorkspaceWriteGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  origin?: SessionOrigin
}): Promise<GuardBlock | undefined> {
  const { tool, args, agentDir, origin } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = path.resolve(agentDir, rawPath)
  const workspacePath = path.resolve(agentDir, 'workspace')
  const [realTargetPath, realWorkspacePath] = await Promise.all([
    resolveRealIntendedPath(targetPath),
    resolveRealIntendedPath(workspacePath),
  ])
  if (await isSkillAuthoringAllowed({ tool, args, agentDir })) return undefined
  if (await isMemoryRetrievalCacheWriteAllowed({ tool, args, agentDir, origin })) return undefined
  if (await isMemoryTopicsWriteAllowed({ tool, args, agentDir, origin })) return undefined
  if (await isAllowedAgentRootWrite(agentDir, targetPath, realTargetPath)) return undefined
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

async function isAllowedAgentRootWrite(agentDir: string, targetPath: string, realTargetPath: string): Promise<boolean> {
  const resolvedAgentDir = path.resolve(agentDir)
  if (path.dirname(targetPath) === resolvedAgentDir && AGENT_ROOT_WRITE_ALLOWLIST.has(path.basename(targetPath))) {
    return true
  }

  for (const dir of AGENT_ROOT_DIRECTORY_ALLOWLIST) {
    const rootDir = path.join(resolvedAgentDir, dir)
    if (isInside(await resolveRealIntendedPath(rootDir), realTargetPath)) return true
  }
  return false
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
