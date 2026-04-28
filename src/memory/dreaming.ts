import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createAgentSession,
  DefaultResourceLoader,
  readTool,
  SessionManager,
  writeTool,
} from '@mariozechner/pi-coding-agent'

import { getAuth } from '@/agent/auth'
import { config, resolveModel } from '@/config'
import { formatLocalDate, formatLocalDateTime } from '@/shared'
import type { SubagentSpawner } from '@/subagent'

import {
  DREAMING_STATE_FILE,
  type DreamingState,
  getDreamedLines,
  loadDreamingState,
  saveDreamingState,
  setDreamedLines,
} from './dreaming-state'

const STREAM_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/

export type DreamingPayload = {
  agentDir: string
}

export function isDreamingPayload(value: unknown): value is DreamingPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.agentDir === 'string' && v.agentDir.length > 0
}

export type DreamingSession = {
  prompt: (text: string) => Promise<void>
  dispose: () => void
}

export type DreamingSnapshot = { date: string; lines: number }

export type DreamingLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateDreamingSpawnerOptions = {
  createDreamingSession?: () => Promise<DreamingSession>
  commitMemory?: (cwd: string) => Promise<void>
  logger?: DreamingLogger
}

const consoleLogger: DreamingLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createDreamingSpawner(options: CreateDreamingSpawnerOptions = {}): SubagentSpawner {
  const factory = options.createDreamingSession ?? defaultCreateDreamingSession
  const commit = options.commitMemory ?? commitMemorySnapshot
  const logger = options.logger ?? consoleLogger

  return async (payload) => {
    if (!isDreamingPayload(payload)) {
      throw new Error('dreaming: invalid payload shape')
    }

    const state = await loadDreamingState(payload.agentDir)
    const snapshots = await collectStreamSnapshots(payload.agentDir, state)

    if (snapshots.undreamed.length === 0) {
      logger.info('[dreaming] no undreamed fragments since last run; skipping')
      return
    }

    const session = await factory()
    try {
      await session.prompt(buildInitialPrompt(payload, snapshots.undreamed))
    } finally {
      session.dispose()
    }

    const advanced = advanceWatermarks(state, snapshots.undreamed)
    await saveDreamingState(payload.agentDir, advanced)
    await commit(payload.agentDir)
  }
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

async function defaultCreateDreamingSession(): Promise<DreamingSession> {
  const { authStorage, modelRegistry } = getAuth()
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => DREAMING_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    model: resolveModel(config.model),
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools: [readTool, writeTool],
  })
  return session
}

// Force-add gitignored memory artifacts (memory/*.md, memory/.dreaming-state.json)
// alongside MEMORY.md so the agent folder's git history captures the
// consolidation as a single recoverable snapshot. Skips silently when the
// folder is not a git repo or bun is unavailable, matching commitSystemFile in
// src/container/start.ts. Uses the user's global git config for authorship.
async function commitMemorySnapshot(cwd: string): Promise<void> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return
  if (!existsSync(join(cwd, '.git'))) return

  const add = bun.spawn({
    cmd: ['git', 'add', '-f', '--', 'MEMORY.md', 'memory/'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await add.exited) !== 0) return

  const diff = bun.spawn({
    cmd: ['git', 'diff', '--cached', '--quiet', '--', 'MEMORY.md', 'memory/'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // diff --cached --quiet exits 0 when no staged changes, 1 when there are.
  // We only commit on 1 (something to commit); 0 means a no-op write.
  if ((await diff.exited) === 0) return

  const commit = bun.spawn({
    cmd: ['git', 'commit', '-m', 'Dream', '--only', '--', 'MEMORY.md', 'memory/'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await commit.exited
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
