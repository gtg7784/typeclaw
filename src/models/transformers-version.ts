import { createRequire } from 'node:module'

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
export function getResolvedTransformersVersion(): string {
  const require = createRequire(import.meta.url)
  const pkg = require('@huggingface/transformers/package.json') as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('could not resolve @huggingface/transformers version from its package.json')
  }
  return pkg.version
}
