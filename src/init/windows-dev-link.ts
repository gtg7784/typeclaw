import { existsSync } from 'node:fs'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { isWindows } from '@/shared/platform'

const PACKAGE_FILE = 'package.json'
const NODE_MODULES = 'node_modules'
const TYPECLAW_DEP = 'typeclaw'

export type SymlinkImpl = (target: string, path: string, type: 'junction') => Promise<void>

export type PrepareWindowsDevJunctionOptions = {
  platform?: NodeJS.Platform
  symlinkImpl?: SymlinkImpl
}

export type WindowsDevJunctionResult = { created: boolean; target: string }

// Resolve the on-disk checkout path a local `file:` typeclaw dep points at, or
// null when the dep is a registry spec (`^X.Y.Z`) or anything else. Mirrors the
// `file:` parsing in `detectDevSource` (src/container/start.ts) so init and
// start agree on what counts as a local dev source.
export async function resolveLocalFileDepTarget(agentRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(join(agentRoot, PACKAGE_FILE), 'utf8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const spec = pkg.dependencies?.[TYPECLAW_DEP]
    if (typeof spec !== 'string' || !spec.startsWith('file:')) return null
    const target = spec.slice('file:'.length)
    return isAbsolute(target) ? resolve(target) : resolve(agentRoot, target)
  } catch {
    return null
  }
}

// Native-Windows dev-mode only: materialize <agent>/node_modules/typeclaw as a
// directory JUNCTION to the local checkout instead of letting `bun install`
// copy the whole source tree (incl `.git/`) into node_modules — that copy
// EPERMs on git/Defender-locked `.git` files (the deferred #899 path). A
// junction needs no admin privilege on Windows (unlike a symlink) and never
// copies. No-op on POSIX (registry users and dev contributors there are
// unaffected) and when typeclaw is a registry spec rather than a local file:.
export async function prepareWindowsDevJunction(
  agentRoot: string,
  options: PrepareWindowsDevJunctionOptions = {},
): Promise<WindowsDevJunctionResult | null> {
  const platform = options.platform ?? process.platform
  if (!isWindows(platform)) return null

  const target = await resolveLocalFileDepTarget(agentRoot)
  if (target === null) return null

  const junctionPath = join(agentRoot, NODE_MODULES, TYPECLAW_DEP)
  if (existsSync(junctionPath)) return { created: false, target }

  await mkdir(join(agentRoot, NODE_MODULES), { recursive: true })
  const makeLink = options.symlinkImpl ?? ((t, p, type) => symlink(t, p, type))
  await makeLink(target, junctionPath, 'junction')
  return { created: true, target }
}
