import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse as parsePath } from 'node:path'

// The ACTUALLY-INSTALLED @huggingface/transformers version in the current
// runtime, read from the resolved package's own package.json — NOT from
// typeclaw's dependency spec (which is the intended version, not what is on
// disk). The model-cache sentinel compares this across stages: the host
// stamps the version that produced the download, the container checks the
// version that will consume it. Comparing two intended constants would miss
// exactly the drift this guards — "the installed runtime isn't what the build
// said it should be" (e.g. a lockfile-free `bun add` resolving a newer
// release). Resolution is isolated here so the package-internals access lives
// in one place.
//
// We resolve the package's EXPORTED entry and walk up to its package.json,
// rather than `require('@huggingface/transformers/package.json')`: that subpath
// is not in the package's `exports` map (only `node`/`default`), so a strict
// Node-exports resolver throws ERR_PACKAGE_PATH_NOT_EXPORTED. The main entry IS
// exported, and its package.json is the nearest one above the resolved file.
export function getResolvedTransformersVersion(): string {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@huggingface/transformers')
  const version = readNearestPackageVersion(dirname(entry))
  if (version === null) {
    throw new Error('could not resolve @huggingface/transformers version from its package.json')
  }
  return version
}

function readNearestPackageVersion(startDir: string): string | null {
  const root = parsePath(startDir).root
  let dir = startDir
  for (;;) {
    const version = readPackageNameVersion(join(dir, 'package.json'))
    if (version !== null) return version
    if (dir === root) return null
    dir = dirname(dir)
  }
}

// Only accept the @huggingface/transformers package.json, never a nested
// dependency's: the resolved entry can sit under dist/, and an intermediate
// dir could in theory carry an unrelated package.json. Match on name.
function readPackageNameVersion(pkgPath: string): string | null {
  let parsed: { name?: unknown; version?: unknown }
  try {
    parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
  } catch {
    return null
  }
  if (parsed.name !== '@huggingface/transformers') return null
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) return null
  return parsed.version
}
