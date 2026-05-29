import path from 'node:path'

import type { HiddenPaths } from '@/sandbox'

import type { SecurityBlock } from '../policy'

export const GUARD_PRIVATE_SURFACE_READ = 'privateSurfaceRead'

const PATH_LIKE_KEYS = ['path', 'paths', 'pattern', 'patterns', 'glob', 'globs', 'cwd', 'dir', 'directory']

// The bash sandbox hides the role's private working DIRECTORIES (workspace/,
// memory/, sessions/) via bwrap masks, but the read/grep/find/ls/edit/write
// builtins run in the main process — outside any sandbox. Without this guard a
// guest could read back through them exactly what bash masking denies, making
// the sandbox hollow. Same role-derived deny-list, applied at the tool.before
// boundary so both surfaces enforce one policy.
//
// Scope is hidden.dirs only. The secret FILES (.env, secrets.json) are already
// owned by the secretExfilRead guard, which gates the same tools with the same
// role tier (its medium-severity bypass maps to fs.see.secrets) plus a
// per-call acknowledgement path this guard deliberately does not duplicate.
export function checkPrivateSurfaceReadGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  hidden: HiddenPaths
}): SecurityBlock | undefined {
  const { tool, args, agentDir, hidden } = options
  if (tool !== 'read' && tool !== 'grep' && tool !== 'find' && tool !== 'ls' && tool !== 'edit' && tool !== 'write') {
    return undefined
  }
  const denied = hidden.dirs
  if (denied.length === 0) return undefined

  for (const key of PATH_LIKE_KEYS) {
    for (const candidate of collectStringValues(args[key])) {
      const hit = matchHidden(candidate, agentDir, denied)
      if (hit !== undefined) {
        return {
          block: true,
          reason: [
            `Guard \`${GUARD_PRIVATE_SURFACE_READ}\` blocked ${tool} of ${hit}: this path is hidden from the current role.`,
            'The bash sandbox masks the same path; reading it through a non-bash tool is the same disclosure.',
          ].join(' '),
        }
      }
    }
  }
  return undefined
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

// A candidate matches when, resolved against agentDir, it equals or sits under
// a denied path. Resolving both sides defeats `workspace/../workspace/x`,
// `./workspace`, and absolute restatements of the same path.
function matchHidden(candidate: string, agentDir: string, denied: string[]): string | undefined {
  const resolved = path.resolve(agentDir, candidate)
  for (const deny of denied) {
    if (resolved === deny || resolved.startsWith(`${deny}/`)) return deny
  }
  return undefined
}
