import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { checkCitationSupersetAcrossShards, summarizeMissingCitations } from './citation-superset'
import { normalizeCitation, parseCitations } from './citations'
import { clearDreamedIds, loadDreamingState, saveDreamingState } from './dreaming-state'
import { renderShard, type ShardFrontmatter } from './frontmatter'
import {
  migratingTmpDir,
  PRE_SHARD_BACKUP_FILENAME,
  preShardBackupPath,
  streamFilePath,
  streamsDir,
  topicsDir,
} from './paths'
import { headingToSlug } from './slug'
import { newEventId, type StreamEvent, streamEventSchema, timestampFromId } from './stream-events'
import { writeEventsAtomic as defaultWriteEventsAtomic } from './stream-io'
import { parseTopicsWithBodies } from './topics'

export type MigrationResult = {
  migrated: string[]
  skipped: string[]
  legacyProseCount: number
  fragmentCount: number
  watermarkCount: number
}

export type MigrationLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export type MigrationGit = {
  spawn?: (args: string[], options: { cwd: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export type RunMigrationOptions = {
  agentDir: string
  logger: MigrationLogger
  git?: MigrationGit
  writeEventsAtomic?: (path: string, events: readonly StreamEvent[]) => Promise<void>
}

export type ShardingMigrationResult = {
  migrated: boolean
  topicCount: number
  streamCount: number
  legacy: MigrationResult
  error?: string
}

export type RunShardingMigrationOptions = RunMigrationOptions & {
  hooks?: {
    onAfterStageTopics?: () => Promise<void> | void
    onAfterStageStreams?: () => Promise<void> | void
    onAfterStageBackup?: () => Promise<void> | void
  }
}

const DAILY_MD_NAME = /^(\d{4}-\d{2}-\d{2})\.md$/
const DAILY_JSONL_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const LEGACY_FRAGMENT_RE =
  /<!-- fragment source=(\S+) entry=(\S+) -->\n## (.+)\n([\s\S]*?)(?=<!-- fragment |<!-- watermark |$)/g
const LEGACY_WATERMARK_RE = /<!-- watermark source=(\S+) entry=(\S+) -->/g

export async function runShardingMigration(options: RunShardingMigrationOptions): Promise<ShardingMigrationResult> {
  await recoverShardingMigration(options.agentDir, options.logger)
  const legacy = await runMigration(options)
  const empty = (extra?: Partial<ShardingMigrationResult>): ShardingMigrationResult => ({
    migrated: false,
    topicCount: 0,
    streamCount: 0,
    legacy,
    ...extra,
  })

  await recoverShardingOrphans(options.agentDir, options.logger, options.git)

  if (existsSync(topicsDir(options.agentDir)) || !existsSync(rootMemoryPath(options.agentDir))) {
    return empty()
  }

  const memoryDir = join(options.agentDir, 'memory')
  const tmpDir = migratingTmpDir(options.agentDir)
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(join(tmpDir, 'topics'), { recursive: true })
  await mkdir(join(tmpDir, 'streams'), { recursive: true })

  const rootContent = await readFile(rootMemoryPath(options.agentDir), 'utf8')
  const topics = parseTopicsWithBodies(rootContent)
  if (topics.length === 0) {
    await rm(tmpDir, { recursive: true, force: true })
    options.logger.warn('[memory:migration] MEMORY.md has no topics; skipping sharding migration')
    return empty()
  }

  const existingSlugs = new Set<string>()
  const orderedSlugs: string[] = []
  for (const topic of topics) {
    const slug = headingToSlug(topic.heading, existingSlugs)
    existingSlugs.add(slug)
    orderedSlugs.push(slug)
    const body = normalizeCitation(topic.body)
    const frontmatter = frontmatterForTopic(topic.heading, body)
    await writeFile(join(tmpDir, 'topics', `${slug}.md`), renderShard(frontmatter, body), 'utf8')
  }
  await options.hooks?.onAfterStageTopics?.()

  const streamDates = await collectFlatJsonlDates(memoryDir)
  for (const date of streamDates) {
    await cp(join(memoryDir, `${date}.jsonl`), join(tmpDir, 'streams', `${date}.jsonl`))
  }
  await options.hooks?.onAfterStageStreams?.()

  await cp(rootMemoryPath(options.agentDir), join(tmpDir, 'MEMORY.md.pre-shard.bak'))
  await options.hooks?.onAfterStageBackup?.()

  const newShardTexts = await readShardTexts(join(tmpDir, 'topics'))
  const verdict = checkCitationSupersetAcrossShards(new Map([['MEMORY.md', rootContent]]), newShardTexts)
  if (!verdict.ok) {
    const error = `citation superset violation: ${summarizeMissingCitations(verdict.missing)}`
    options.logger.error(`[memory:migration] ${error}`)
    return empty({ error })
  }

  const finalized = await finalizeShardingMigration(options.agentDir, streamDates, options.logger)
  if (!finalized.ok) return empty({ error: finalized.error })

  await commitShardingMigration(
    options.agentDir,
    { slugs: orderedSlugs, streamDates, hadRootMemory: true },
    options.logger,
    options.git,
  )

  options.logger.info(
    `[memory:migration] sharded MEMORY.md into ${topics.length} topic shard(s) and ${streamDates.length} stream file(s)`,
  )
  return { migrated: true, topicCount: topics.length, streamCount: streamDates.length, legacy }
}

export async function runMigration(options: RunMigrationOptions): Promise<MigrationResult> {
  const memoryDir = join(options.agentDir, 'memory')
  const result: MigrationResult = {
    migrated: [],
    skipped: [],
    legacyProseCount: 0,
    fragmentCount: 0,
    watermarkCount: 0,
  }

  let entries: string[]
  try {
    entries = await readdir(memoryDir)
  } catch {
    return result
  }

  const dates = collectDailyDates(entries)
  for (const date of dates) {
    const mdPath = join(memoryDir, `${date}.md`)
    const jsonlPath = join(memoryDir, `${date}.jsonl`)
    const hasMd = existsSync(mdPath)
    const hasJsonl = existsSync(jsonlPath)

    if (hasJsonl && !hasMd) {
      result.skipped.push(date)
      continue
    }

    if (hasJsonl && hasMd) {
      options.logger.warn(`[memory:migration] ${date}: skipped because both .md and .jsonl exist`)
      result.skipped.push(date)
      continue
    }

    if (!hasMd) continue

    const content = await readFile(mdPath, 'utf8')
    const events = parseLegacyMarkdown(content)
    const invalid = findInvalidEvent(events)
    if (invalid !== null) {
      options.logger.error(
        `[memory:migration] ${date}.md: event ${invalid.index + 1} failed validation: ${invalid.reason}`,
      )
      result.skipped.push(date)
      continue
    }

    const counts = countEvents(events)
    try {
      await (options.writeEventsAtomic ?? defaultWriteEventsAtomic)(jsonlPath, events)
    } catch (err) {
      options.logger.error(`[memory:migration] ${date}.md: failed to write JSONL: ${describeError(err)}`)
      result.skipped.push(date)
      continue
    }
    await unlink(mdPath)

    result.fragmentCount += counts.fragmentCount
    result.watermarkCount += counts.watermarkCount
    result.legacyProseCount += counts.legacyProseCount
    result.migrated.push(date)
    options.logger.info(
      `[memory:migration] ${date}: ${counts.fragmentCount} fragments, ${counts.watermarkCount} watermarks, ${counts.legacyProseCount} legacy_prose regions`,
    )
  }

  if (result.migrated.length > 0) {
    await resetDreamingWatermarks(options.agentDir, result.migrated)
    await commitMigration(options.agentDir, result.migrated, options.logger, options.git)
  }

  return result
}

function collectDailyDates(entries: readonly string[]): string[] {
  const dates = new Set<string>()
  for (const entry of entries) {
    const md = DAILY_MD_NAME.exec(entry)
    if (md?.[1] !== undefined) dates.add(md[1])
    const jsonl = DAILY_JSONL_NAME.exec(entry)
    if (jsonl?.[1] !== undefined) dates.add(jsonl[1])
  }
  return Array.from(dates).sort()
}

async function recoverShardingMigration(agentDir: string, logger: MigrationLogger): Promise<void> {
  const tmpDir = migratingTmpDir(agentDir)
  if (!existsSync(tmpDir)) return

  const hasTopics = existsSync(topicsDir(agentDir))
  await rm(tmpDir, { recursive: true, force: true })
  logger.info(
    hasTopics
      ? '[memory:migration] removed leftover sharding tmpdir after completed migration'
      : '[memory:migration] removed stale sharding tmpdir; retrying migration from originals',
  )
}

async function recoverShardingOrphans(
  agentDir: string,
  logger: MigrationLogger,
  git: MigrationGit | undefined,
): Promise<void> {
  if (existsSync(topicsDir(agentDir))) {
    let cleaned = false
    const memoryPath = rootMemoryPath(agentDir)
    if (existsSync(memoryPath)) {
      await unlink(memoryPath)
      cleaned = true
    }

    const memoryDir = join(agentDir, 'memory')
    const dates = await collectFlatJsonlDates(memoryDir)
    for (const date of dates) {
      if (!existsSync(streamFilePath(agentDir, date))) continue
      await unlink(join(memoryDir, `${date}.jsonl`))
      cleaned = true
    }

    if (cleaned) logger.info('[memory:migration] cleaned orphaned pre-shard memory files')
  }

  // Always called, even when nothing was cleaned this boot AND even when the
  // sharded layout never landed on this agent: pre-#315 migrations and
  // earlier runs of this function unlinked without committing, leaving
  // staged deletions that survive across reboots until cleared explicitly.
  // The earlier guard (`return` when topicsDir is absent) stranded any agent
  // whose pre-shard files were deleted but whose sharding never completed —
  // their staged deletions sat in the index forever.
  await commitPendingLegacyDeletions(agentDir, logger, git)
}

async function collectFlatJsonlDates(memoryDir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(memoryDir)
  } catch {
    return []
  }
  return entries
    .map((entry) => DAILY_JSONL_NAME.exec(entry)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort()
}

function frontmatterForTopic(heading: string, body: string): ShardFrontmatter {
  const citations = parseCitations(body)
  const dates = [...citations.keys()].sort()
  let cites = 0
  for (const ids of citations.values()) cites += ids.size

  return {
    heading,
    cites,
    days: dates.length,
    lastReinforced: dates.at(-1) ?? todayDate(),
  }
}

async function readShardTexts(dir: string): Promise<Map<string, string>> {
  const entries = (await readdir(dir)).filter((entry) => entry.endsWith('.md')).sort()
  const out = new Map<string, string>()
  for (const entry of entries) {
    out.set(entry, await readFile(join(dir, entry), 'utf8'))
  }
  return out
}

async function finalizeShardingMigration(
  agentDir: string,
  streamDates: readonly string[],
  logger: MigrationLogger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tmpDir = migratingTmpDir(agentDir)
  const renames: Array<[string, string]> = [
    [join(tmpDir, 'topics'), topicsDir(agentDir)],
    [join(tmpDir, 'streams'), streamsDir(agentDir)],
    [join(tmpDir, 'MEMORY.md.pre-shard.bak'), preShardBackupPath(agentDir)],
  ]

  for (const [from, to] of renames) {
    try {
      await rename(from, to)
    } catch (err) {
      const error = `failed to finalize sharding migration: ${describeError(err)}`
      logger.error(`[memory:migration] ${error}`)
      return { ok: false, error }
    }
  }

  for (const date of streamDates) {
    try {
      await unlink(join(agentDir, 'memory', `${date}.jsonl`))
    } catch (err) {
      logger.warn(`[memory:migration] failed to remove flat stream ${date}.jsonl: ${describeError(err)}`)
    }
  }

  try {
    await unlink(rootMemoryPath(agentDir))
  } catch (err) {
    logger.warn(`[memory:migration] failed to remove root MEMORY.md: ${describeError(err)}`)
  }

  try {
    await rmdir(tmpDir)
  } catch (err) {
    logger.warn(`[memory:migration] failed to remove sharding tmpdir: ${describeError(err)}`)
  }

  return { ok: true }
}

function rootMemoryPath(agentDir: string): string {
  return join(agentDir, 'MEMORY.md')
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseLegacyMarkdown(content: string): StreamEvent[] {
  const events: StreamEvent[] = []
  let cursor = 0

  while (cursor < content.length) {
    const fragment = nextMatch(LEGACY_FRAGMENT_RE, content, cursor)
    const watermark = nextMatch(LEGACY_WATERMARK_RE, content, cursor)
    const next = earliest(fragment, watermark)
    if (next === null) break

    addLegacyProse(events, content.slice(cursor, next.match.index))
    if (next.kind === 'fragment') {
      const id = newEventId()
      events.push({
        type: 'fragment',
        id,
        ts: timestampFromId(id),
        source: next.match[1]!,
        entry: next.match[2]!,
        topic: next.match[3]!,
        body: next.match[4]!,
      })
    } else {
      const id = newEventId()
      events.push({
        type: 'watermark',
        id,
        ts: timestampFromId(id),
        source: next.match[1]!,
        entry: next.match[2]!,
      })
    }
    cursor = next.match.index + next.match[0].length
  }

  addLegacyProse(events, content.slice(cursor))
  return events
}

function addLegacyProse(events: StreamEvent[], text: string): void {
  if (text.trim() === '') return
  events.push({ type: 'legacy_prose', ts: new Date().toISOString(), text, origin: 'migration' })
}

function nextMatch(regex: RegExp, content: string, cursor: number): RegExpExecArray | null {
  regex.lastIndex = cursor
  return regex.exec(content)
}

function earliest(
  fragment: RegExpExecArray | null,
  watermark: RegExpExecArray | null,
): { kind: 'fragment' | 'watermark'; match: RegExpExecArray } | null {
  if (fragment === null && watermark === null) return null
  if (fragment === null) return { kind: 'watermark', match: watermark! }
  if (watermark === null) return { kind: 'fragment', match: fragment }
  return fragment.index <= watermark.index
    ? { kind: 'fragment', match: fragment }
    : { kind: 'watermark', match: watermark }
}

function findInvalidEvent(events: readonly StreamEvent[]): { index: number; reason: string } | null {
  for (let i = 0; i < events.length; i++) {
    const parsed = streamEventSchema.safeParse(events[i])
    if (!parsed.success) {
      return { index: i, reason: parsed.error.issues.map((issue) => issue.message).join('; ') }
    }
  }
  return null
}

function countEvents(
  events: readonly StreamEvent[],
): Pick<MigrationResult, 'fragmentCount' | 'watermarkCount' | 'legacyProseCount'> {
  let fragmentCount = 0
  let watermarkCount = 0
  let legacyProseCount = 0
  for (const event of events) {
    if (event.type === 'fragment') fragmentCount++
    if (event.type === 'watermark') watermarkCount++
    if (event.type === 'legacy_prose') legacyProseCount++
  }
  return { fragmentCount, watermarkCount, legacyProseCount }
}

async function resetDreamingWatermarks(agentDir: string, dates: readonly string[]): Promise<void> {
  let state = await loadDreamingState(agentDir)
  const ts = new Date().toISOString()
  for (const date of dates) {
    state = clearDreamedIds(state, date, ts)
  }
  await saveDreamingState(agentDir, state)
}

async function commitMigration(
  agentDir: string,
  dates: readonly string[],
  logger: MigrationLogger,
  git: MigrationGit | undefined,
): Promise<void> {
  const spawn = git?.spawn ?? spawnGit
  const inside = await spawn(['rev-parse', '--is-inside-work-tree'], { cwd: agentDir })
  if (inside.exitCode !== 0) {
    logger.info('[memory:migration] not in a git repo; skipping git commit')
    return
  }

  const jsonlPaths = dates.map((date) => `memory/${date}.jsonl`)
  const addJsonl = await spawn(['add', '--', ...jsonlPaths], { cwd: agentDir })
  if (addJsonl.exitCode !== 0) {
    logger.warn(`[memory:migration] git add failed: ${addJsonl.stderr || addJsonl.stdout}`.trim())
    return
  }

  for (const date of dates) {
    const mdPath = `memory/${date}.md`
    const tracked = await spawn(['ls-files', '--error-unmatch', '--', mdPath], { cwd: agentDir })
    if (tracked.exitCode !== 0) continue
    const addDeletedMd = await spawn(['add', '-u', '--', mdPath], { cwd: agentDir })
    if (addDeletedMd.exitCode !== 0) {
      logger.warn(`[memory:migration] git add failed: ${addDeletedMd.stderr || addDeletedMd.stdout}`.trim())
      return
    }
  }

  const commit = await spawn(
    ['commit', '-m', `memory: migrate ${dates.length} daily stream(s) to JSONL`, '--no-edit'],
    {
      cwd: agentDir,
    },
  )
  if (commit.exitCode !== 0) {
    logger.warn(`[memory:migration] git commit failed: ${commit.stderr || commit.stdout}`.trim())
  }
}

async function commitShardingMigration(
  agentDir: string,
  details: { slugs: readonly string[]; streamDates: readonly string[]; hadRootMemory: boolean },
  logger: MigrationLogger,
  git: MigrationGit | undefined,
): Promise<void> {
  const spawn = git?.spawn ?? spawnGit
  const inside = await spawn(['rev-parse', '--is-inside-work-tree'], { cwd: agentDir })
  if (inside.exitCode !== 0) {
    logger.info('[memory:migration] not in a git repo; skipping git commit')
    return
  }

  const newPaths = [
    ...details.slugs.map((slug) => `memory/topics/${slug}.md`),
    ...details.streamDates.map((date) => `memory/streams/${date}.jsonl`),
    `memory/${PRE_SHARD_BACKUP_FILENAME}`,
  ]
  const addNew = await spawn(['add', '--', ...newPaths], { cwd: agentDir })
  if (addNew.exitCode !== 0) {
    logger.warn(`[memory:migration] git add failed: ${addNew.stderr || addNew.stdout}`.trim())
    return
  }

  const candidateDeletions = [...details.streamDates.map((date) => `memory/${date}.jsonl`)]
  if (details.hadRootMemory) candidateDeletions.push('MEMORY.md')
  const trackedDeletions: string[] = []
  for (const path of candidateDeletions) {
    const tracked = await spawn(['ls-files', '--error-unmatch', '--', path], { cwd: agentDir })
    if (tracked.exitCode === 0) trackedDeletions.push(path)
  }
  if (trackedDeletions.length > 0) {
    const addDeletions = await spawn(['add', '-u', '--', ...trackedDeletions], { cwd: agentDir })
    if (addDeletions.exitCode !== 0) {
      logger.warn(`[memory:migration] git add failed: ${addDeletions.stderr || addDeletions.stdout}`.trim())
      return
    }
  }

  const commitSharding = await spawn(
    [
      'commit',
      '-m',
      `memory: shard MEMORY.md into ${details.slugs.length} topic(s) and ${details.streamDates.length} daily stream(s)`,
      '--no-edit',
    ],
    { cwd: agentDir },
  )
  if (commitSharding.exitCode !== 0) {
    logger.warn(`[memory:migration] git commit failed: ${commitSharding.stderr || commitSharding.stdout}`.trim())
  }
}

async function commitPendingLegacyDeletions(
  agentDir: string,
  logger: MigrationLogger,
  git: MigrationGit | undefined,
): Promise<void> {
  const spawn = git?.spawn ?? spawnGit
  const inside = await spawn(['rev-parse', '--is-inside-work-tree'], { cwd: agentDir })
  if (inside.exitCode !== 0) return

  const pending = await collectLegacyDeletions(agentDir, spawn)
  if (pending.all.length === 0) return

  // `git add -u` errors with "pathspec did not match" on paths whose deletion
  // is already in the index, so stage only the working-tree-only deletions.
  // The already-staged set is picked up by the commit directly.
  if (pending.workingTreeOnly.length > 0) {
    const addDeletions = await spawn(['add', '-u', '--', ...pending.workingTreeOnly], { cwd: agentDir })
    if (addDeletions.exitCode !== 0) {
      logger.warn(`[memory:migration] git add failed: ${addDeletions.stderr || addDeletions.stdout}`.trim())
      return
    }
  }

  const commit = await spawn(
    [
      'commit',
      '-m',
      `memory: clean up ${pending.all.length} pre-shard file(s) orphaned by earlier migration`,
      '--no-edit',
    ],
    { cwd: agentDir },
  )
  if (commit.exitCode !== 0) {
    logger.warn(`[memory:migration] git commit failed: ${commit.stderr || commit.stdout}`.trim())
  }
}

async function collectLegacyDeletions(
  agentDir: string,
  spawn: NonNullable<MigrationGit['spawn']>,
): Promise<{ all: string[]; workingTreeOnly: string[] }> {
  const isLegacy = (line: string): boolean => line === 'MEMORY.md' || /^memory\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(line)
  const parse = (out: string): string[] =>
    out
      .split('\n')
      .map((line) => line.trim())
      .filter(isLegacy)

  const allDiff = await spawn(['diff', 'HEAD', '--name-only', '--diff-filter=D', '--', 'memory/', 'MEMORY.md'], {
    cwd: agentDir,
  })
  if (allDiff.exitCode !== 0) return { all: [], workingTreeOnly: [] }
  const all = parse(allDiff.stdout)
  if (all.length === 0) return { all: [], workingTreeOnly: [] }

  const wtDiff = await spawn(['diff', '--name-only', '--diff-filter=D', '--', 'memory/', 'MEMORY.md'], {
    cwd: agentDir,
  })
  const workingTreeOnly = wtDiff.exitCode === 0 ? parse(wtDiff.stdout) : []
  return { all, workingTreeOnly }
}

async function spawnGit(
  args: string[],
  options: { cwd: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
