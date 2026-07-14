import { hooklessGitArgs } from '@/git/hookless'
import { resolveAgentGit } from '@/git/resolve-agent-git'

const MAX_LISTED_PATHS = 10

// `sessions/` is auto-snapshotted and `memory/` is force-committed by the
// dreaming subagent — both are runtime-owned, never agent-owned. Nudging the
// agent to commit them would mislead it into staging files outside its remit.
const RUNTIME_OWNED_PREFIXES = ['sessions/', 'memory/']

export type GitNudgeDeps = {
  readStatus: (agentDir: string, gitArgs: readonly string[]) => Promise<readonly string[] | null>
}

// Returns "" (not a placeholder string) when there is nothing to nudge about.
// The empty case must add zero bytes to the system prompt so cache prefixes
// stay identical to a clean-worktree agent folder.
export async function renderGitNudge(agentDir: string, deps: GitNudgeDeps = defaultDeps): Promise<string> {
  const repo = resolveAgentGit(agentDir)
  if (!repo) return ''
  const status = await deps.readStatus(agentDir, repo.gitArgs)
  if (status === null) return ''
  const dirty = filterAgentOwned(status)
  if (dirty.length === 0) return ''
  return formatNudge(dirty)
}

export function formatNudge(dirtyPaths: readonly string[]): string {
  const total = dirtyPaths.length
  const shown = dirtyPaths.slice(0, MAX_LISTED_PATHS)
  const remaining = total - shown.length

  const lines = [
    '## Uncommitted changes at session start',
    '',
    `git reports ${total} uncommitted file${total === 1 ? '' : 's'} in your agent folder right now:`,
    '',
    ...shown.map((p) => `- ${p}`),
  ]
  if (remaining > 0) {
    lines.push(`- … and ${remaining} more`)
  }
  lines.push(
    '',
    "These are real, current modifications — not advice. Before declaring this session's task done, commit any of these you're responsible for, with `git add <paths>` and `git commit -m \"…\"` per the version-control rules above. If a listed path is from earlier work you didn't touch, leave it alone.",
  )
  return lines.join('\n')
}

// Porcelain v1 line shape: "XY <path>" or, for renames, "XY <orig> -> <dest>".
// We drop the status code and, on rename, return the destination because that
// is the live file the agent would `git add`.
export function parsePorcelain(stdout: string): string[] {
  const out: string[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.length < 4) continue
    const rest = raw.slice(3)
    const arrowIdx = rest.indexOf(' -> ')
    out.push(arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4))
  }
  return out
}

function filterAgentOwned(paths: readonly string[]): string[] {
  return paths.filter((p) => !RUNTIME_OWNED_PREFIXES.some((prefix) => p.startsWith(prefix)))
}

// Mirrors the spawn pattern in `src/container/start.ts` `commitSystemFile`.
const defaultDeps: GitNudgeDeps = {
  async readStatus(agentDir, gitArgs) {
    const bun = getBun()
    if (!bun) return null
    try {
      const proc = bun.spawn({
        cmd: ['git', ...hooklessGitArgs([...gitArgs, 'status', '--porcelain=v1'])],
        cwd: agentDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exit = await proc.exited
      if (exit !== 0) return null
      const text = await new Response(proc.stdout).text()
      return parsePorcelain(text)
    } catch {
      return null
    }
  },
}

// Pieces of `@/agent` are exercised under Node in some tests where
// `globalThis.Bun` is undefined; this fallback matches the helper in
// `src/container/start.ts`.
function getBun(): typeof Bun | null {
  const g = globalThis as { Bun?: typeof Bun }
  return g.Bun ?? null
}
