import { readDreamCommitLog, readDreamCommitShow, resolveGitRepo, type SpawnGit } from './git'
import { parseDreamDetail, parseDreamSubject } from './parse'
import { renderDetail, renderListRow, type RenderOptions, toJsonShape } from './render'
import type { DreamEntry } from './types'

export type { SpawnGit } from './git'
export type { DreamEntry } from './types'
export { renderDetail, renderListRow, toJsonShape } from './render'
export { parseDreamDetail, parseDreamSubject } from './parse'

export type SelectDream = (entries: DreamEntry[]) => Promise<DreamEntry | null>

export type RunDreamsOptions = {
  agentDir: string
  json: boolean
  details: boolean
  color: boolean
  limit?: number
  selectDream: SelectDream
  stdout: (line: string) => void
  spawnGit?: SpawnGit
}

export type RunDreamsResult = { ok: true; exitCode: 0 } | { ok: false; exitCode: number; reason: string }

export async function listDreams(
  agentDir: string,
  opts: { limit?: number } = {},
  spawnGit?: SpawnGit,
): Promise<DreamEntry[]> {
  const repo = await resolveGitRepo(agentDir, spawnGit)
  if (!repo.ok) return []
  const commits = await readDreamCommitLog(repo.root, opts.limit !== undefined ? { limit: opts.limit } : {}, spawnGit)
  return commits.map((commit) => {
    const subject = parseDreamSubject(commit.subject)
    return {
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      committedAt: commit.committedAt,
      isDreamCommit: subject.isDreamCommit,
      summary: subject.summary,
      emoji: subject.emoji,
      categories: subject.categories,
    }
  })
}

export async function hydrateDream(agentDir: string, entry: DreamEntry, spawnGit?: SpawnGit): Promise<DreamEntry> {
  const repo = await resolveGitRepo(agentDir, spawnGit)
  if (!repo.ok) return entry
  const show = await readDreamCommitShow(repo.root, entry.sha, spawnGit)
  if (show === null) return entry
  return { ...entry, detail: parseDreamDetail(show.nameStatus, show.patch) }
}

export async function runDreams(opts: RunDreamsOptions): Promise<RunDreamsResult> {
  const repo = await resolveGitRepo(opts.agentDir, opts.spawnGit)
  if (!repo.ok) {
    if (repo.reason === 'not-a-repo') {
      return {
        ok: false,
        exitCode: 1,
        reason:
          "Not a git repository. Dreams live in the agent folder's git history — run this from your agent folder.",
      }
    }
    return { ok: false, exitCode: 1, reason: 'git failed while resolving the repository root.' }
  }

  const entries = await listDreams(opts.agentDir, opts.limit !== undefined ? { limit: opts.limit } : {}, opts.spawnGit)
  const renderOpts: RenderOptions = { color: opts.color }

  if (opts.json) return runJson(opts, repo.root, entries)

  if (entries.length === 0) {
    opts.stdout('No dreams yet. The dreaming subagent commits here after it consolidates memory.')
    return { ok: true, exitCode: 0 }
  }

  if (!isInteractive()) {
    for (const entry of entries) opts.stdout(renderListRow(entry, renderOpts))
    return { ok: true, exitCode: 0 }
  }

  const picked = await opts.selectDream(entries)
  if (picked === null) return { ok: true, exitCode: 0 }
  const hydrated = await hydrateDream(opts.agentDir, picked, opts.spawnGit)
  opts.stdout(renderDetail(hydrated, renderOpts))
  return { ok: true, exitCode: 0 }
}

async function runJson(opts: RunDreamsOptions, root: string, entries: DreamEntry[]): Promise<RunDreamsResult> {
  for (const entry of entries) {
    const final = opts.details ? await hydrateEntryFromRoot(root, entry, opts.spawnGit) : entry
    opts.stdout(JSON.stringify(toJsonShape(final)))
  }
  return { ok: true, exitCode: 0 }
}

async function hydrateEntryFromRoot(root: string, entry: DreamEntry, spawnGit?: SpawnGit): Promise<DreamEntry> {
  const show = await readDreamCommitShow(root, entry.sha, spawnGit)
  if (show === null) return entry
  return { ...entry, detail: parseDreamDetail(show.nameStatus, show.patch) }
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY)
}
