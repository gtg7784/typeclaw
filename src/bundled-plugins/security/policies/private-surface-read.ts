import path from 'node:path'

import type { HiddenPaths } from '@/sandbox'

import type { SecurityBlock } from '../policy'

export const GUARD_PRIVATE_SURFACE_READ = 'privateSurfaceRead'

// bash is excluded: its access to hidden paths is contained by the bwrap
// sandbox (applyBashSandbox), not by blocking the call. Every OTHER tool is
// scanned, so a new file-reading tool — bundled or third-party — is covered
// the day it ships without a whitelist edit. websearch/webfetch take URLs, not
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

  for (const candidate of collectPathCandidates(args)) {
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

// Recursively collects every string in args. Matching is left to matchHidden,
// which resolves each string against agentDir and only fires on one that lands
// inside a hidden directory — so the decision is "does this resolve under a
// secret dir", not a guess about whether the string was "meant" as a path.
// Fail-closed by design: a bare arg value equal to a hidden dir name (e.g.
// "memory") is treated as that directory and blocked, because the alternative
// — letting `grep <pat> workspace` through — is exactly the bypass this guard
// exists to stop. Multi-word prose ("about memory and workspace") resolves to a
// path that is NOT a hidden dir, so it passes.
function collectPathCandidates(value: unknown): string[] {
  const out: string[] = []
  walk(value, out)
  return out
}

function walk(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) walk(item, out)
  }
}

// Resolving both sides against agentDir defeats traversal (workspace/../workspace/x),
// relative forms (./workspace), and absolute restatements. Secret files match on
// exact equality; hidden directories match the dir itself or anything under it,
// using a trailing slash so `workspace` does not also match a sibling
// `workspace-notes`.
function matchHidden(
  candidate: string,
  agentDir: string,
  deniedDirs: string[],
  deniedFiles: string[],
): string | undefined {
  const resolved = path.resolve(agentDir, candidate)
  for (const file of deniedFiles) {
    if (resolved === file) return file
  }
  for (const dir of deniedDirs) {
    if (resolved === dir || resolved.startsWith(`${dir}/`)) return dir
  }
  return undefined
}
