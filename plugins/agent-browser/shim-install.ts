import { lstatSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'

import { REAL_BIN_ENV } from './shim'

const DEFAULT_BIN_PATH = '/usr/local/bin/agent-browser'
const STASH_DIR = '/usr/local/lib/typeclaw-agent-browser'
const STASH_TARGET = join(STASH_DIR, 'agent-browser-real')
const SHIM_MARKER = '# typeclaw-agent-browser-shim'

export type InstallShimOptions = {
  binPath?: string
  shimEntry?: string
  fs?: ShimFs
}

export type ShimFs = {
  lstat: (path: string) => { isSymbolicLink: () => boolean } | null
  readlink: (path: string) => string
  readFile: (path: string) => string
  rename: (from: string, to: string) => void
  symlink: (target: string, path: string) => void
  writeFile: (path: string, data: string, mode: number) => void
  unlink: (path: string) => void
  mkdirp: (path: string) => void
}

export type InstallShimResult =
  | { kind: 'installed'; realBin: string; binPath: string }
  | { kind: 'already-installed'; binPath: string }
  | { kind: 'no-upstream'; binPath: string }

export function installShim(opts: InstallShimOptions = {}): InstallShimResult {
  const binPath = opts.binPath ?? DEFAULT_BIN_PATH
  const shimEntry = opts.shimEntry ?? defaultShimEntry()
  const fs = opts.fs ?? defaultFs()

  const stat = fs.lstat(binPath)
  if (stat === null) return { kind: 'no-upstream', binPath }

  if (isAlreadyShim(binPath, fs)) return { kind: 'already-installed', binPath }

  const realBin = resolveCurrentTarget(binPath, stat, fs)
  fs.mkdirp(STASH_DIR)
  if (stat.isSymbolicLink()) {
    fs.unlink(binPath)
    fs.symlink(realBin, STASH_TARGET)
  } else {
    fs.rename(binPath, STASH_TARGET)
  }

  fs.writeFile(binPath, renderWrapper(shimEntry), 0o755)
  return { kind: 'installed', realBin, binPath }
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

function renderWrapper(shimEntry: string): string {
  return `#!/bin/sh
${SHIM_MARKER}
export ${REAL_BIN_ENV}="\${${REAL_BIN_ENV}:-${STASH_TARGET}}"
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
