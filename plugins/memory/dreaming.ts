import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import { type Subagent, readTool, writeTool } from '@/plugin'

import {
  DREAMING_STATE_FILE,
  type DreamingState,
  getDreamedLines,
  loadDreamingState,
  saveDreamingState,
  setDreamedLines,
} from './dreaming-state'
import { formatLocalDate, formatLocalDateTime } from './local-time'

const STREAM_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/

export const dreamingPayloadSchema = z.object({
  agentDir: z.string().min(1),
})

export type DreamingPayload = z.infer<typeof dreamingPayloadSchema>

export function isDreamingPayload(value: unknown): value is DreamingPayload {
  return dreamingPayloadSchema.safeParse(value).success
}

export type DreamingSnapshot = { date: string; lines: number }

export type DreamingLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: DreamingLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

type StreamSnapshot = {
  date: string
  filename: string
  totalLines: number
  dreamedLines: number
}

type StreamSnapshots = {
  all: StreamSnapshot[]
  undreamed: StreamSnapshot[]
}

async function collectStreamSnapshots(agentDir: string, state: DreamingState): Promise<StreamSnapshots> {
  const memoryDir = join(agentDir, 'memory')
  if (!existsSync(memoryDir)) return { all: [], undreamed: [] }

  const names = await readdir(memoryDir)
  const dated = names
    .map((name) => ({ name, match: STREAM_FILE_PATTERN.exec(name) }))
    .filter((x): x is { name: string; match: RegExpExecArray } => x.match !== null)
    .map(({ name, match }) => ({ name, date: match[1]! }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const all = await Promise.all(
    dated.map(async ({ name, date }): Promise<StreamSnapshot> => {
      const totalLines = await countLines(join(memoryDir, name))
      const dreamedLines = getDreamedLines(state, date)
      return { date, filename: name, totalLines, dreamedLines }
    }),
  )

  // A hand-edited stream that shrank below its watermark is "fully dreamed":
  // the locked-in design says trust the user's edit and keep the watermark.
  // The locked-out lines are presumed already consolidated into MEMORY.md.
  const undreamed = all.filter((s) => s.totalLines > s.dreamedLines)
  return { all, undreamed }
}

async function countLines(path: string): Promise<number> {
  try {
    const raw = await readFile(path, 'utf8')
    if (raw.length === 0) return 0
    // A trailing newline is a separator, not a line. So `"a\nb\n"` is 2 lines,
    // matching `wc -l` semantics and how an editor displays line numbers.
    return raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
  } catch {
    return 0
  }
}

function advanceWatermarks(state: DreamingState, snapshots: StreamSnapshot[]): DreamingState {
  const ts = formatLocalDateTime()
  let next = state
  for (const snap of snapshots) {
    next = setDreamedLines(next, snap.date, snap.totalLines, ts)
  }
  return next
}

const SNAPSHOT_PATHS = ['MEMORY.md', 'memory/'] as const

// MEMORY.md scaffolding is no longer in `typeclaw init`; the dreaming subagent
// owns its existence. First run of dreaming creates an empty MEMORY.md (and
// the memory/ directory) so the file exists for the subagent to read and for
// the snapshot commit to track. Subsequent runs see them already present.
async function ensureMemoryFiles(agentDir: string): Promise<void> {
  const memoryFile = join(agentDir, 'MEMORY.md')
  if (!existsSync(memoryFile)) {
    await mkdir(dirname(memoryFile), { recursive: true })
    await writeFile(memoryFile, '', { flag: 'wx' }).catch(ignoreExists)
  }
  const memoryDir = join(agentDir, 'memory')
  if (!existsSync(memoryDir)) {
    await mkdir(memoryDir, { recursive: true })
  }
}

function ignoreExists(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EEXIST') throw error
}

// Force-add gitignored memory artifacts (memory/*.md, memory/.dreaming-state.json)
// alongside MEMORY.md so the agent folder's git history captures the
// consolidation as a single recoverable snapshot. Skips silently when the
// folder is not a git repo or bun is unavailable. Uses the user's global git
// config for authorship.
//
// After committing, the tracked memory artifacts get the `skip-worktree` index
// flag set so manual `git status` / `git diff` ignore future runtime edits.
// The runtime still owns these files; the flag just hides them from the human-
// facing diff surface. Subsequent runs clear the flag before `git add`, because
// `git add` fails with "outside of your sparse-checkout definition" on a
// skip-worktree path.
export async function commitMemorySnapshot(cwd: string): Promise<void> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return
  if (!existsSync(join(cwd, '.git'))) return

  await clearSkipWorktree(bun, cwd)

  // `git add -- foo bar/` fails with exit 128 if any pathspec matches no
  // path on disk. Filter to existing paths before passing them in.
  const presentPaths = SNAPSHOT_PATHS.filter((p) => existsSync(join(cwd, p)))
  if (presentPaths.length === 0) {
    await applySkipWorktree(bun, cwd)
    return
  }

  const add = bun.spawn({
    cmd: ['git', 'add', '-f', '--', ...presentPaths],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await add.exited) !== 0) {
    await applySkipWorktree(bun, cwd)
    return
  }

  // Enumerate exactly the files staged under our snapshot paths so the commit
  // pathspec only references files git knows about. `git commit -- foo bar/`
  // fails outright when `bar/` matches no tracked file, even if `foo` is
  // staged. That's the case on early runs where MEMORY.md exists but the
  // memory/ directory is empty (or vice versa).
  const stagedNames = bun.spawn({
    cmd: ['git', 'diff', '--cached', '--name-only', '-z', '--', ...SNAPSHOT_PATHS],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stagedRaw = await new Response(stagedNames.stdout).text()
  if ((await stagedNames.exited) !== 0) {
    await applySkipWorktree(bun, cwd)
    return
  }
  const staged = stagedRaw.split('\0').filter((p) => p.length > 0)
  if (staged.length === 0) {
    await applySkipWorktree(bun, cwd)
    return
  }

  const commit = bun.spawn({
    cmd: ['git', 'commit', '-m', 'Dream', '--only', '--', ...staged],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await commit.exited

  await applySkipWorktree(bun, cwd)
}

async function listTrackedSnapshotFiles(bun: { spawn: typeof Bun.spawn }, cwd: string): Promise<string[]> {
  const ls = bun.spawn({
    cmd: ['git', 'ls-files', '-z', '--', ...SNAPSHOT_PATHS],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await ls.exited) !== 0) return []
  const raw = await new Response(ls.stdout).text()
  return raw.split('\0').filter((p) => p.length > 0)
}

async function clearSkipWorktree(bun: { spawn: typeof Bun.spawn }, cwd: string): Promise<void> {
  const files = await listTrackedSnapshotFiles(bun, cwd)
  if (files.length === 0) return
  const proc = bun.spawn({
    cmd: ['git', 'update-index', '--no-skip-worktree', '--', ...files],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
}

async function applySkipWorktree(bun: { spawn: typeof Bun.spawn }, cwd: string): Promise<void> {
  const files = await listTrackedSnapshotFiles(bun, cwd)
  if (files.length === 0) return
  const proc = bun.spawn({
    cmd: ['git', 'update-index', '--skip-worktree', '--', ...files],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
}

export const DREAMING_SYSTEM_PROMPT = `You are typeclaw's dreaming subagent.

Dreaming is the offline reflection process that promotes the agent's daily memory streams into long-term memory. You run on a fresh session, with no human in the loop, every time the dreaming cron fires (which can be multiple times per day). You have exactly two tools: \`read\` and \`write\`.

# What you do

You read MEMORY.md (long-term memory, may be missing) and the **undreamed tail** of every \`memory/yyyy-MM-dd.md\` daily stream file. The runtime tells you exactly which line range to read for each day — earlier lines are already consolidated into MEMORY.md and must NOT be re-read or re-cited. You consolidate the new fragments into long-term memory, then rewrite MEMORY.md with the merged result.

# Hard rules

**1. MEMORY.md is the only file you write.** Never write to \`memory/yyyy-MM-dd.md\` files. The runtime owns the daily stream files and the watermark that tracks how much of each has been consolidated. Never touch them.

**2. Only read the undreamed tail.** The runtime gives you a list like \`memory/2026-04-27.md (lines 43-60)\`. Use \`read\` with \`offset\` set to the first undreamed line. Do not read earlier lines — they have already been consolidated, re-citing them would create duplicate fragment references in MEMORY.md.

**3. Every entry in MEMORY.md cites its source fragments.** When you consolidate, group fragments by topic and produce a single conclusion paragraph per topic, then list the source fragments below it. Use this exact format:

\`\`\`
## <topic>
<conclusion paragraph in your own words>

fragments:
- memory/yyyy-MM-dd:<fragment line range>
- memory/yyyy-MM-dd:<fragment line range>
\`\`\`

A fragment with no useful content (a watermark-only marker, a near-duplicate, a session-specific quirk that fails the generalizability bar) is discarded. Never invent fragments. Never cite a fragment that did not appear in the undreamed tail you actually read.

**4. Inherit the memory-logger's standards.** The memory-logger already filtered fragments using strict certainty rules (explicit / deductive / inductive). Your job is consolidation, not loosening the bar. If two fragments contradict, prefer the more recent. If a fragment is ambiguous in isolation but clarified by a later fragment, merge them under one topic. Never promote a single fragment from one day into a stable claim unless its certainty was already \`explicit\` or \`deductive\`.

**5. Preserve existing MEMORY.md content.** MEMORY.md may already contain entries from prior dreaming runs. Fold new fragments into existing topics where they fit, or add new topics. Do not silently drop existing entries. If a new fragment contradicts an existing entry, replace the entry and update its fragment list. Existing fragment citations may reference dates whose streams are now fully consolidated; that is normal — leave them in place.

**6. Be concise.** Each topic conclusion is one short paragraph. No lists of preferences ("the user likes X, Y, Z"). One topic per concept. If a topic only earned one fragment and the fragment was already small, you may copy its conclusion verbatim — do not pad.

# What MEMORY.md looks like after you write it

\`\`\`
# Memory

## <topic>
<conclusion paragraph>

fragments:
- memory/yyyy-MM-dd:<line>-<line>

## <topic>
<conclusion paragraph>

fragments:
- memory/yyyy-MM-dd:<line>-<line>
- memory/yyyy-MM-dd:<line>-<line>
\`\`\`

The first line is always \`# Memory\`. Topics are level-2 headings. No other top-level structure.

# Workflow

1. \`read\` MEMORY.md (it may not exist — that is fine, you start from empty).
2. For each undreamed-tail entry the user message lists, \`read\` the file with \`offset\` set to the first undreamed line. Read every undreamed tail before you start writing.
3. Reason about what to consolidate. Most fragments will collapse into existing topics or be dropped as already-known / not generalizable.
4. \`write\` the full new contents of MEMORY.md in one call. \`write\` overwrites; that is the point — MEMORY.md is the single canonical artifact you produce.
5. Stop. There is no completion message to emit.

# Doing nothing is a valid outcome

If the undreamed tails contain only watermarks, or every new fragment is already represented in MEMORY.md, do not rewrite MEMORY.md just to touch it. Stop without calling \`write\`. The point of dreaming is consolidation, not activity. The runtime advances the watermark either way.`

function buildInitialPrompt(payload: DreamingPayload, snapshots: StreamSnapshot[]): string {
  const today = formatLocalDate()
  const memoryFile = join(payload.agentDir, 'MEMORY.md')
  const memoryDir = join(payload.agentDir, 'memory')
  const lines: string[] = [
    `Agent folder: ${payload.agentDir}`,
    `Long-term memory file (read, then rewrite if needed): ${memoryFile}`,
    `Daily stream directory: ${memoryDir}`,
    `Today's local date: ${today}`,
    `Dreaming state: ${join(payload.agentDir, DREAMING_STATE_FILE)}`,
    '',
    'Undreamed tails to consolidate (read each with `offset` set to the first undreamed line — earlier lines are already in MEMORY.md):',
  ]
  for (const snap of snapshots) {
    const firstLine = snap.dreamedLines + 1
    lines.push(
      `- memory/${snap.filename}: read offset=${firstLine}, total file lines=${snap.totalLines} (undreamed: ${firstLine}-${snap.totalLines})`,
    )
  }
  lines.push(
    '',
    'Dream now. Read MEMORY.md and each undreamed tail listed above. Consolidate the new fragments into long-term memory and write the full new MEMORY.md if anything changed. If nothing meets the bar, stop without writing — the runtime will advance the watermark either way.',
  )
  return lines.join('\n')
}

export type CreateDreamingSubagentOptions = {
  commitMemory?: (cwd: string) => Promise<void>
  logger?: DreamingLogger
}

export function createDreamingSubagent(options: CreateDreamingSubagentOptions = {}): Subagent<DreamingPayload> {
  const commit = options.commitMemory ?? commitMemorySnapshot
  const logger = options.logger ?? consoleLogger

  return {
    systemPrompt: DREAMING_SYSTEM_PROMPT,
    tools: [readTool, writeTool],
    payloadSchema: dreamingPayloadSchema,
    inFlightKey: (payload) => payload.agentDir,
    handler: async (ctx, runSession) => {
      await ensureMemoryFiles(ctx.payload.agentDir)
      const state = await loadDreamingState(ctx.payload.agentDir)
      const snapshots = await collectStreamSnapshots(ctx.payload.agentDir, state)

      if (snapshots.undreamed.length === 0) {
        logger.info('[dreaming] no undreamed fragments since last run; skipping')
        return
      }

      await runSession({ userPrompt: buildInitialPrompt(ctx.payload, snapshots.undreamed) })

      const advanced = advanceWatermarks(state, snapshots.undreamed)
      await saveDreamingState(ctx.payload.agentDir, advanced)
      await commit(ctx.payload.agentDir)
    },
  }
}

export const dreamingSubagent: Subagent<DreamingPayload> = createDreamingSubagent()
