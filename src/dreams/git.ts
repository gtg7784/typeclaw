export type GitResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnGit = (args: string[], cwd: string) => Promise<GitResult>

export type RawCommit = {
  sha: string
  shortSha: string
  committedAt: string
  subject: string
}

export type ResolveRepoResult = { ok: true; root: string } | { ok: false; reason: 'not-a-repo' | 'git-failed' }

const FIELD_SEP = '\x1f'
const RECORD_SEP = '\x1e'

export async function resolveGitRepo(cwd: string, spawnGit: SpawnGit = defaultSpawnGit): Promise<ResolveRepoResult> {
  const res = await spawnGit(['rev-parse', '--show-toplevel'], cwd)
  if (res.exitCode === 0) {
    const root = res.stdout.trim()
    if (root.length > 0) return { ok: true, root }
    return { ok: false, reason: 'git-failed' }
  }
  if (/not a git repository/i.test(res.stderr)) return { ok: false, reason: 'not-a-repo' }
  return { ok: false, reason: 'git-failed' }
}

export async function readDreamCommitLog(
  root: string,
  opts: { limit?: number } = {},
  spawnGit: SpawnGit = defaultSpawnGit,
): Promise<RawCommit[]> {
  const args = ['log', '--grep=^dream: ', `--format=%H${FIELD_SEP}%h${FIELD_SEP}%cI${FIELD_SEP}%s${RECORD_SEP}`]
  if (opts.limit !== undefined && opts.limit > 0) args.push(`--max-count=${opts.limit}`)

  const res = await spawnGit(args, root)
  if (res.exitCode !== 0) return []
  return parseLogOutput(res.stdout)
}

export function parseLogOutput(stdout: string): RawCommit[] {
  const commits: RawCommit[] = []
  for (const record of stdout.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n+/, '')
    if (trimmed.length === 0) continue
    const [sha, shortSha, committedAt, subject] = trimmed.split(FIELD_SEP)
    if (sha === undefined || shortSha === undefined || committedAt === undefined || subject === undefined) continue
    commits.push({ sha, shortSha, committedAt, subject })
  }
  return commits
}

export async function readDreamCommitShow(
  root: string,
  sha: string,
  spawnGit: SpawnGit = defaultSpawnGit,
): Promise<{ nameStatus: string; patch: string } | null> {
  const nameStatus = await spawnGit(['show', '--no-color', '--find-renames', '--format=', '--name-status', sha], root)
  if (nameStatus.exitCode !== 0) return null
  const patch = await spawnGit(['show', '--no-color', '--format=', '--unified=0', sha], root)
  if (patch.exitCode !== 0) return null
  return { nameStatus: nameStatus.stdout, patch: patch.stdout }
}

const defaultSpawnGit: SpawnGit = async (args, cwd) => {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { exitCode: -1, stdout: '', stderr: 'bun runtime not available' }
  try {
    const proc = bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stdout, stderr }
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}
