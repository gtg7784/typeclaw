import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// A GIT_ASKPASS helper git invokes for username/password prompts. The token
// rides in TYPECLAW_GIT_TOKEN (env, via the bash env overlay), NEVER in argv or
// git config — so it cannot leak through process listings, logs, or .git/config.
// The script contents are constant and secret-free; only the env value is secret.
//
// Host-scoped: git's prompt is `Username for 'https://github.com': ` etc. We
// answer ONLY when the prompt names github.com; for any other host (e.g. one an
// `insteadOf`/`pushurl` rewrite redirected to) we exit non-zero WITHOUT printing
// the token, so a redirect can never exfiltrate it. The analyzer already blocks
// the known redirect vectors; this is defense-in-depth at the credential edge.
// The host match is on \`//github.com/\` and \`//github.com'\` (git wraps the URL
// in quotes: \`Password for 'https://github.com': \`) so it cannot be fooled by
// \`evil-github.com\` or \`github.com.evil/\`.
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *//github.com/*|*//github.com\\'*) : ;;
  *) exit 1 ;;
esac
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$TYPECLAW_GIT_TOKEN" ;;
esac
`

// /usr is --ro-bind mounted into the per-tool bwrap sandbox (src/sandbox/build.ts),
// so a helper here is readable by sandboxed bash; the per-session /tmp bind is not
// a stable path. TYPECLAW_GIT_ASKPASS_PATH overrides it for tests/CI, which
// cannot write under /usr.
const DEFAULT_ASKPASS_PATH = '/usr/local/bin/typeclaw-git-askpass'

function defaultPath(): string {
  const override = process.env.TYPECLAW_GIT_ASKPASS_PATH
  return override !== undefined && override !== '' ? override : DEFAULT_ASKPASS_PATH
}

let ensurePromise: Promise<string> | null = null

export function resetGitAskPassHelperForTests(): void {
  ensurePromise = null
}

// Writes the helper once per process (idempotent, race-safe via the shared
// promise) and returns its absolute path. The temp name is unpredictable and
// opened with `wx` (exclusive create, fails on an existing file/symlink) so a
// planted symlink cannot redirect the write; then atomically renamed so a
// concurrent reader never sees a partial file.
export function ensureGitAskPassHelper(path: string = defaultPath()): Promise<string> {
  if (ensurePromise !== null) return ensurePromise
  ensurePromise = (async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.typeclaw-git-askpass.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(tmp, ASKPASS_SCRIPT, { mode: 0o755, flag: 'wx' })
    await chmod(tmp, 0o755)
    await rename(tmp, path)
    return path
  })().catch((err) => {
    ensurePromise = null
    throw err
  })
  return ensurePromise
}
