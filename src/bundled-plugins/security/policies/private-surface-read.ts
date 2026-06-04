import { realpathSync } from 'node:fs'
import path from 'node:path'

import type { HiddenPaths } from '@/sandbox'

import type { SecurityBlock } from '../policy'

export const GUARD_PRIVATE_SURFACE_READ = 'privateSurfaceRead'

// bash is excluded: its access to hidden paths is contained by the bwrap
// sandbox (applyBashSandbox), not by blocking the call. Every OTHER tool is
// scanned, so a new file-reading tool — bundled or third-party — is covered
// the day it ships without a whitelist edit. web_search/web_fetch take URLs, not
// local paths, and the path-plausibility filter keeps their args from matching.
const UNSCANNED_TOOLS = new Set(['bash'])

// The bash sandbox hides the role's private surface — the working DIRECTORIES
// (workspace/, memory/, sessions/) and the secret FILES (.env, secrets.json) —
// via bwrap masks, but every non-bash tool runs in the main process, outside
// any sandbox. find_entry, look_at, and the channel attachment tools all read
// files by a caller-supplied path, so without a guard a restricted role could
// read back through them exactly what bash masking denies. This guard mirrors
// the WHOLE deny-list (dirs + files) onto all of them, honouring the PR's
// "two enforcement points, one deny-list" invariant.
//
// It covers the full deny-list rather than delegating secret files to the
// secretExfilRead guard: that guard only inspects read/grep/find/ls (not
// edit/write/look_at/channel_send) and is acknowledgement-bypassable, so
// delegating would leave .env/secrets.json reachable through the uncovered
// tools — exactly the gap the bash masks close. secretExfilRead remains as
// independent defense in depth for the four tools it does cover.
//
// Posture is FAIL-CLOSED for restricted roles: it does not whitelist a known
// set of tools (that fails open the moment a new reader is added). It scans
// every arg of every non-bash tool — recursively, since paths hide in nested
// shapes like look_at's images[].path and channel_send's attachments[].path —
// and blocks any string that resolves to (a secret file) or under (a hidden
// directory) the deny-list.
export function checkPrivateSurfaceReadGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  hidden: HiddenPaths
}): SecurityBlock | undefined {
  const { tool, args, agentDir, hidden } = options
  if (UNSCANNED_TOOLS.has(tool)) return undefined
  const deniedDirs = hidden.dirs
  const deniedFiles = hidden.files
  if (deniedDirs.length === 0 && deniedFiles.length === 0) return undefined

  for (const candidate of collectPathCandidates(args, tool)) {
    const hit = matchHidden(candidate, agentDir, deniedDirs, deniedFiles)
    if (hit !== undefined) {
      return {
        block: true,
        reason: [
          `Guard \`${GUARD_PRIVATE_SURFACE_READ}\` blocked ${tool}: argument \`${candidate}\` resolves to ${hit}, which is hidden from the current role.`,
          'The bash sandbox masks the same path; reaching it through another tool is the same disclosure.',
        ].join(' '),
      }
    }
  }
  return undefined
}

// Field names whose values are ALWAYS free text (prose/queries/ids), NEVER a
// filesystem path, for EVERY tool. Scanning them caused false positives: a
// guest's `channel_reply({ text: "the memory leak" })` or `web_search({ query:
// "workspace setup" })` resolve to a bare hidden-dir name and were wrongly
// blocked. This is a DENYLIST OF KEY NAMES, not a tool whitelist: an unknown
// field on an unknown tool is still scanned (fail-closed for new path-bearing
// readers); we only skip values whose KEY is universally free text. `command`
// is here because bash (its only user) is already exempt via UNSCANNED_TOOLS.
//
// `glob` and `pattern` are deliberately ABSENT — they are tool-dependent (a
// glob/path-filter in grep/find, a regex only in grep) and handled by
// FREE_TEXT_KEYS_BY_TOOL below.
const NON_PATH_KEYS = new Set([
  'text',
  'query',
  'prompt',
  'selector',
  'url',
  'message',
  'body',
  'content',
  'command',
  'reason',
  'subject',
  'description',
  'title',
  'name',
  // edit tool: replacement text is free-form and may quote a hidden path.
  'oldText',
  'newText',
  // memory append tool: fragment topic is free text.
  'topic',
  // channel_send/channel_reply attachments[].filename and
  // channel_fetch_attachment.filename: display-only metadata (defaults to the
  // basename of the real `path`), never the file location the guard cares
  // about — `attachments[].path` carries that and is NOT exempted.
  'filename',
])

// Keys that are free text in SPECIFIC tools but path-bearing in others, so a
// global denylist would either over-block or open a bypass. Scoped per tool:
//   - grep.pattern  : a regex/search string (e.g. "sessions"), NOT a path.
// Notably NOT listed (and therefore SCANNED):
//   - grep.glob / find.pattern : both are glob path-filters resolved RELATIVE
//     to the search root, so `grep({ path: '.', glob: 'workspace/**' })` and
//     `find({ path: '.', pattern: 'workspace/**' })` reach a hidden subtree.
//     Exempting them let the only hidden-identifying arg through (the bypass a
//     review caught). They have no false-positive risk: path.resolve treats
//     glob metacharacters as literal, so `*.ts` -> `/agent/*.ts` (passes) while
//     `workspace/**` -> `/agent/workspace/**` (correctly blocked).
// Fail-closed: only the listed tool's listed key is exempted; an unknown tool
// (or grep gaining a new key) scans everything.
const FREE_TEXT_KEYS_BY_TOOL: Record<string, ReadonlySet<string>> = {
  grep: new Set(['pattern']),
}

// Recursively collects strings that could be paths, skipping values under a
// universally-free-text key or a tool-scoped free-text key. matchHidden then
// realpath-resolves each candidate and fires only on one landing inside a
// hidden directory. Fail-closed by design: a bare path-bearing value equal to a
// hidden dir name (e.g. `path: "memory"`) is still blocked. `underExempt`
// propagates so nested values under an exempt key (e.g. a structured pattern)
// stay exempt; top-level strings and array elements carry no key and are always
// scanned (so attachments[].path is collected).
function collectPathCandidates(value: unknown, tool: string): string[] {
  const out: string[] = []
  walk(value, out, tool, false)
  return out
}

function walk(value: unknown, out: string[], tool: string, underExempt: boolean): void {
  if (typeof value === 'string') {
    if (underExempt) return
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, tool, underExempt)
    return
  }
  if (value !== null && typeof value === 'object') {
    const toolFreeText = FREE_TEXT_KEYS_BY_TOOL[tool]
    for (const [key, item] of Object.entries(value)) {
      const keyIsExempt = NON_PATH_KEYS.has(key) || (toolFreeText?.has(key) ?? false)
      walk(item, out, tool, underExempt || keyIsExempt)
    }
  }
}

// Resolving both sides against agentDir defeats traversal (workspace/../workspace/x),
// relative forms (./workspace), and absolute restatements. Secret files match on
// exact equality; hidden directories match the dir itself or anything under it,
// using a trailing slash so `workspace` does not also match a sibling
// `workspace-notes`.
//
// Symlink defense: lexical path.resolve is NOT enough. A restricted role can
// plant `public/leak -> ../.env` (or `-> ../memory`) via sandboxed bash, then
// read it back through a non-bash tool whose path lexically lands in the
// guest-visible `public/`. So we resolve the candidate's REAL path
// (realpathRealIntendedPath follows symlinks on every existing path component)
// before matching. Both sides are realpath'd because agentDir itself may sit
// under a symlink (e.g. /tmp -> /private/tmp on macOS); comparing a real
// candidate against a lexical deny-list would never match.
function matchHidden(
  candidate: string,
  agentDir: string,
  deniedDirs: string[],
  deniedFiles: string[],
): string | undefined {
  const resolved = realpathRealIntendedPath(path.resolve(agentDir, candidate))
  for (const file of deniedFiles) {
    if (resolved === realpathRealIntendedPath(file)) return file
  }
  for (const dir of deniedDirs) {
    const realDir = realpathRealIntendedPath(dir)
    if (resolved === realDir || resolved.startsWith(`${realDir}/`)) return dir
  }
  return undefined
}

// Resolves symlinks on the longest existing prefix of an absolute path, then
// re-appends the non-existent tail. A bare realpathSync throws on a path that
// does not exist yet (a write target, or a read of a not-yet-created file), so
// we walk up to the nearest existing ancestor, realpath THAT (collapsing any
// symlinked component including a planted symlink), and rejoin the remainder.
// This catches `public/leak/x` where `public/leak` is a symlink into a hidden
// dir even though `public/leak/x` itself does not exist. Sync (realpathSync)
// keeps the guard synchronous so the security tool.before check array stays
// non-async; the cost is one syscall per existing component, negligible at the
// tool-call boundary. Sync mirror of resolveRealIntendedPath in the guard
// plugin's non-workspace-write policy.
function realpathRealIntendedPath(absolutePath: string): string {
  const pending: string[] = []
  let current = absolutePath
  while (true) {
    try {
      return path.join(realpathSync.native(current), ...pending.reverse())
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }
    const parent = path.dirname(current)
    if (parent === current) return absolutePath
    pending.push(path.basename(current))
    current = parent
  }
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}
