import {
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'

import { REAL_BIN_ENV } from './shim'

const DEFAULT_GLOBAL_BIN_PATH = '/usr/local/bin/agent-browser'
const DEFAULT_LOCAL_BIN_PATH = '/agent/node_modules/.bin/agent-browser'
const STASH_ROOT = '/usr/local/lib/typeclaw-agent-browser'
const SHIM_MARKER = '# typeclaw-agent-browser-shim'

export type InstallShimOptions = {
  binPath?: string
  stashDir?: string
  shimEntry?: string
  fs?: ShimFs
}

export type ShimFs = {
  lstat: (path: string) => { isSymbolicLink: () => boolean } | null
  // statExists follows symlinks: a broken symlink (link entry exists, target
  // does not) returns false. This is the discriminator we need to skip
  // installation when the host bind-mount surfaces dangling node_modules/.bin
  // entries inside the container — see installShim's upstream guard.
  statExists: (path: string) => boolean
  readlink: (path: string) => string
  readFile: (path: string) => string
  rename: (from: string, to: string) => void
  symlink: (target: string, path: string) => void
  writeFile: (path: string, data: string, mode: number) => void
  unlink: (path: string) => void
  mkdirp: (path: string) => void
}

export type InstallShimResult =
  | { kind: 'installed'; realBin: string; binPath: string; stashTarget: string }
  | { kind: 'already-installed'; binPath: string }
  | { kind: 'no-upstream'; binPath: string }

export function installShim(opts: InstallShimOptions = {}): InstallShimResult {
  const binPath = opts.binPath ?? DEFAULT_GLOBAL_BIN_PATH
  const shimEntry = opts.shimEntry ?? defaultShimEntry()
  const fs = opts.fs ?? defaultFs()
  const stashDir = opts.stashDir ?? defaultStashDir(binPath)
  const stashTarget = join(stashDir, 'agent-browser-real')

  const stat = fs.lstat(binPath)
  if (stat === null) return { kind: 'no-upstream', binPath }

  if (isAlreadyShim(binPath, fs)) {
    if (fs.statExists(stashTarget)) return { kind: 'already-installed', binPath }
    // Wrapper survived a container restart but the image-owned stash did not
    // (STASH_ROOT lives outside the bind-mount). The wrapper now points at a
    // non-existent stashTarget, so executing it would ENOENT. Drop it and
    // report no-upstream — there is nothing valid here to preserve, and the
    // global-path shim (if it exists) stands on its own.
    fs.unlink(binPath)
    return { kind: 'no-upstream', binPath }
  }

  // Bind-mounted node_modules/.bin entries can be dangling symlinks inside
  // the container (host ran bun install; the container image did not). lstat
  // alone passes for those. Follow the link with statExists before mutating
  // anything — otherwise we'd stash a broken symlink and write a wrapper
  // pointing at a target that never resolves.
  if (!fs.statExists(binPath)) return { kind: 'no-upstream', binPath }

  const realBin = resolveCurrentTarget(binPath, stat, fs)
  fs.mkdirp(stashDir)
  if (stat.isSymbolicLink()) {
    fs.unlink(binPath)
    if (fs.lstat(stashTarget) !== null) fs.unlink(stashTarget)
    fs.symlink(realBin, stashTarget)
  } else {
    if (fs.lstat(stashTarget) !== null) fs.unlink(stashTarget)
    fs.rename(binPath, stashTarget)
  }

  fs.writeFile(binPath, renderWrapper(shimEntry, stashTarget), 0o755)
  return { kind: 'installed', realBin, binPath, stashTarget }
}

export const KNOWN_BIN_PATHS = {
  global: DEFAULT_GLOBAL_BIN_PATH,
  local: DEFAULT_LOCAL_BIN_PATH,
} as const

function defaultStashDir(binPath: string): string {
  // Per-binPath subdirectory under the image-owned stash root. Lives outside
  // every bind-mounted agent folder so a host-side `bun install` cannot
  // touch it; the wrapper at the bind-mounted location can be clobbered by
  // host-side installs but the stash and image-level real binary stay safe.
  const slug = binPath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return join(STASH_ROOT, slug)
}

function isAlreadyShim(binPath: string, fs: ShimFs): boolean {
  try {
    return fs.readFile(binPath).includes(SHIM_MARKER)
  } catch {
    return false
  }
}

function resolveCurrentTarget(binPath: string, stat: { isSymbolicLink: () => boolean }, fs: ShimFs): string {
  if (!stat.isSymbolicLink()) return binPath
  const target = fs.readlink(binPath)
  return resolvePath(dirname(binPath), target)
}

function renderWrapper(shimEntry: string, stashTarget: string): string {
  return `#!/bin/sh
${SHIM_MARKER}
export ${REAL_BIN_ENV}="\${${REAL_BIN_ENV}:-${stashTarget}}"
exec bun run ${shimEntry} "$@"
`
}

function defaultShimEntry(): string {
  return resolvePath(import.meta.dir, 'shim.ts')
}

function defaultFs(): ShimFs {
  return {
    lstat: (path) => {
      try {
        return lstatSync(path)
      } catch {
        return null
      }
    },
    statExists: (path) => {
      try {
        statSync(path)
        return true
      } catch {
        return false
      }
    },
    readlink: readlinkSync,
    readFile: (path) => readFileSync(path, 'utf-8'),
    rename: renameSync,
    symlink: symlinkSync,
    writeFile: (path, data, mode) => writeFileSync(path, data, { mode }),
    unlink: unlinkSync,
    mkdirp: (path) => {
      Bun.spawnSync(['mkdir', '-p', path])
    },
  }
}
