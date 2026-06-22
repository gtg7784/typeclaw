import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type AgentGit = { kind: 'dotgit'; gitArgs: readonly [] } | { kind: 'gitstore'; gitArgs: readonly string[] }

export function resolveAgentGit(cwd: string): AgentGit | null {
  if (existsSync(join(cwd, '.git'))) return { kind: 'dotgit', gitArgs: [] }
  if (existsSync(join(cwd, '.gitstore'))) {
    return { kind: 'gitstore', gitArgs: ['--git-dir', join(cwd, '.gitstore'), '--work-tree', cwd] }
  }
  return null
}
