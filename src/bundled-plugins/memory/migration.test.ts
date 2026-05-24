import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addDreamedIds, loadDreamingState, saveDreamingState } from './dreaming-state'
import { parseShard } from './frontmatter'
import { runMigration, runShardingMigration, type MigrationLogger } from './migration'
import { readEvents } from './stream-io'

describe('runMigration', () => {
  let agentDir: string
  let memoryDir: string
  let messages: { info: string[]; warn: string[]; error: string[] }
  let logger: MigrationLogger

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-memory-migration-'))
    memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    messages = { info: [], warn: [], error: [] }
    logger = {
      info: (message) => messages.info.push(message),
      warn: (message) => messages.warn.push(message),
      error: (message) => messages.error.push(message),
    }
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('migrates a clean markdown stream to ordered JSONL events', async () => {
    await writeDailyMd(
      '2026-05-16',
      '<!-- fragment source=ses_a entry=entry_1 -->\n## First Topic\nFirst body\n' +
        '<!-- watermark source=ses_a entry=entry_2 -->\n' +
        '<!-- fragment source=ses_b entry=entry_3 -->\n## Second Topic\nSecond body',
    )

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual(['2026-05-16'])
    expect(result.fragmentCount).toBe(2)
    expect(result.watermarkCount).toBe(1)
    expect(result.legacyProseCount).toBe(0)
    expect(existsSync(join(memoryDir, '2026-05-16.md'))).toBe(false)
    expect(existsSync(join(memoryDir, '2026-05-16.jsonl'))).toBe(true)

    const events = await readEvents(join(memoryDir, '2026-05-16.jsonl'))
    expect(events.map((event) => event.type)).toEqual(['fragment', 'watermark', 'fragment'])
    expect(events[0]).toMatchObject({ source: 'ses_a', entry: 'entry_1', topic: 'First Topic', body: 'First body\n' })
    expect(events[1]).toMatchObject({ source: 'ses_a', entry: 'entry_2' })
    expect(events[2]).toMatchObject({ source: 'ses_b', entry: 'entry_3', topic: 'Second Topic', body: 'Second body' })
  })

  test('preserves interleaved prose as legacy_prose events', async () => {
    await writeDailyMd(
      '2026-05-16',
      'intro prose\n' +
        '<!-- fragment source=ses_a entry=entry_1 -->\n## Topic\nBody\n' +
        'middle prose\n' +
        '<!-- watermark source=ses_a entry=entry_2 -->\n' +
        'tail prose\n',
    )

    const result = await runMigration({ agentDir, logger })

    expect(result.legacyProseCount).toBe(2)
    const events = await readEvents(join(memoryDir, '2026-05-16.jsonl'))
    expect(events.map((event) => event.type)).toEqual(['legacy_prose', 'fragment', 'watermark', 'legacy_prose'])
    expect(events[0]).toMatchObject({ text: 'intro prose\n', origin: 'migration' })
    expect(events[3]).toMatchObject({ text: '\ntail prose\n', origin: 'migration' })
  })

  test('skips a date that only has an already-migrated JSONL file', async () => {
    await writeFile(join(memoryDir, '2026-05-16.jsonl'), '', 'utf8')

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual([])
    expect(result.skipped).toEqual(['2026-05-16'])
  })

  test('skips a conflict when markdown and JSONL both exist', async () => {
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')
    await writeFile(join(memoryDir, '2026-05-16.jsonl'), 'existing\n', 'utf8')

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual([])
    expect(result.skipped).toEqual(['2026-05-16'])
    expect(await readFile(join(memoryDir, '2026-05-16.md'), 'utf8')).toContain('watermark')
    expect(await readFile(join(memoryDir, '2026-05-16.jsonl'), 'utf8')).toBe('existing\n')
    expect(messages.warn.some((message) => message.includes('both .md and .jsonl exist'))).toBe(true)
  })

  test('keeps markdown and leaves JSONL absent when the atomic write fails', async () => {
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    const result = await runMigration({
      agentDir,
      logger,
      writeEventsAtomic: async () => {
        throw new Error('disk full')
      },
    })

    expect(result.migrated).toEqual([])
    expect(result.skipped).toEqual(['2026-05-16'])
    expect(existsSync(join(memoryDir, '2026-05-16.md'))).toBe(true)
    expect(existsSync(join(memoryDir, '2026-05-16.jsonl'))).toBe(false)
    expect(messages.error.some((message) => message.includes('disk full'))).toBe(true)
  })

  test('commits migrated streams when the agent directory is a git repo', async () => {
    await initGitRepo(agentDir)
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    await runMigration({ agentDir, logger })

    const latest = await git(agentDir, ['log', '--oneline', '-1'])
    expect(latest.stdout).toContain('memory: migrate 1 daily stream(s) to JSONL')
  })

  test('does not throw outside a git repo', async () => {
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual(['2026-05-16'])
    expect(messages.info.some((message) => message.includes('not in a git repo'))).toBe(true)
  })

  test('clears the dreamed-id set for migrated dates so dreaming re-reads the newly-written JSONL', async () => {
    let state = addDreamedIds(await loadDreamingState(agentDir), '2026-05-16', ['stale-id-1', 'stale-id-2'], 'old')
    await saveDreamingState(agentDir, state)
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    await runMigration({ agentDir, logger })

    state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-05-16']?.dreamedIds).toEqual([])
  })

  test('leaves dreamed-id sets unchanged for unmigrated dates', async () => {
    let state = addDreamedIds(await loadDreamingState(agentDir), '2026-05-15', ['kept-id'], 'old')
    state = addDreamedIds(state, '2026-05-16', ['will-be-cleared'], 'old')
    await saveDreamingState(agentDir, state)
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    await runMigration({ agentDir, logger })
    state = await loadDreamingState(agentDir)

    expect(state.dreamedThrough['2026-05-15']?.dreamedIds).toEqual(['kept-id'])
    expect(state.dreamedThrough['2026-05-16']?.dreamedIds).toEqual([])
  })

  test('migrates an empty markdown stream to an empty JSONL file', async () => {
    await writeDailyMd('2026-05-16', '')

    const result = await runMigration({ agentDir, logger })

    const jsonl = await readFile(join(memoryDir, '2026-05-16.jsonl'), 'utf8')

    expect(result.migrated).toEqual(['2026-05-16'])
    expect(result.fragmentCount).toBe(0)
    expect(result.watermarkCount).toBe(0)
    expect(result.legacyProseCount).toBe(0)
    expect(jsonl).toBe('')
  })

  test('treats malformed fragment markers as legacy prose instead of fixing them', async () => {
    await writeDailyMd(
      '2026-05-16',
      '<!-- fragment source=ses_a entry=entry_1 -->\n# Wrong heading\nBody\n' +
        '<!-- watermark source=ses_a entry=entry_2 -->',
    )

    const result = await runMigration({ agentDir, logger })
    const events = await readEvents(join(memoryDir, '2026-05-16.jsonl'))

    expect(result.legacyProseCount).toBe(1)
    expect(result.watermarkCount).toBe(1)
    expect(events.map((event) => event.type)).toEqual(['legacy_prose', 'watermark'])
  })

  async function writeDailyMd(date: string, content: string): Promise<void> {
    await writeFile(join(memoryDir, `${date}.md`), content, 'utf8')
  }
})

describe('runShardingMigration', () => {
  let agentDir: string
  let memoryDir: string
  let messages: { info: string[]; warn: string[]; error: string[] }
  let logger: MigrationLogger

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-memory-sharding-'))
    memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    messages = { info: [], warn: [], error: [] }
    logger = {
      info: (message) => messages.info.push(message),
      warn: (message) => messages.warn.push(message),
      error: (message) => messages.error.push(message),
    }
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('migrates a representative pre-shard fixture end-to-end', async () => {
    const untouched = await writeRepresentativeFixture()

    const result = await runShardingMigration({ agentDir, logger })

    expect(result).toMatchObject({ migrated: true, topicCount: 12, streamCount: 2 })
    expect(await listDir(join(memoryDir, 'topics'))).toHaveLength(12)
    expect(await listDir(join(memoryDir, 'streams'))).toEqual(['2026-05-18.jsonl', '2026-05-19.jsonl'])
    expect(existsSync(join(memoryDir, 'MEMORY.md.pre-shard.bak'))).toBe(true)
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
    expect(existsSync(join(memoryDir, '.migrating'))).toBe(false)
    await expectUntouchedFiles(untouched)
  })

  test('second call is a no-op and leaves shard mtimes unchanged', async () => {
    await writeRepresentativeFixture()
    await runShardingMigration({ agentDir, logger })
    const shard = join(memoryDir, 'topics', 'topic-1.md')
    const before = statSync(shard).mtimeMs

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(statSync(shard).mtimeMs).toBe(before)
  })

  test('MEMORY.md with no h2 topics is a no-op with warning', async () => {
    await writeRootMemory('# Memory\n\nNo topics yet.\n')
    await writeFlatStream('2026-05-18', 'stream\n')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(messages.warn.some((message) => message.includes('no topics'))).toBe(true)
    expect(await readFile(join(agentDir, 'MEMORY.md'), 'utf8')).toBe('# Memory\n\nNo topics yet.\n')
    expect(await readFile(join(memoryDir, '2026-05-18.jsonl'), 'utf8')).toBe('stream\n')
    expect(existsSync(join(memoryDir, 'topics'))).toBe(false)
  })

  test('empty MEMORY.md is a no-op', async () => {
    await writeRootMemory('')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(memoryDir, 'topics'))).toBe(false)
  })

  test('MEMORY.md with only preamble is a no-op', async () => {
    await writeRootMemory('# Memory\n\nPreamble only with streams/2026-05-18#pre.\n')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(await readFile(join(agentDir, 'MEMORY.md'), 'utf8')).toContain('Preamble only')
    expect(existsSync(join(memoryDir, 'topics'))).toBe(false)
  })

  test('duplicate headings receive unique slugs', async () => {
    await writeRootMemory(memoryWithTopics(['Foo', 'Foo']))

    await runShardingMigration({ agentDir, logger })

    expect(await listDir(join(memoryDir, 'topics'))).toEqual(['foo-2.md', 'foo.md'])
  })

  test('non-ASCII headings produce valid shard filenames', async () => {
    await writeRootMemory(memoryWithTopics(['café', '한글 메모']))

    await runShardingMigration({ agentDir, logger })

    const shards = await listDir(join(memoryDir, 'topics'))

    expect(shards).toContain('cafe.md')
    expect(shards.some((name) => /^untitled-[a-f0-9]{6}\.md$/.test(name))).toBe(true)
  })

  test('rewrites legacy citation prefixes in every topic shard', async () => {
    await writeRootMemory(memoryWithTopics(['Legacy Prefix']))

    await runShardingMigration({ agentDir, logger })
    const shardText = await readAllTopicShards()

    expect(shardText).not.toContain('memory/2026-05-18#')
    expect(shardText).toContain('streams/2026-05-18#id-1')
  })

  test('crash recovery branch A removes stale tmpdir and retries migration', async () => {
    await writeRepresentativeFixture()
    await mkdir(join(memoryDir, '.migrating', 'topics'), { recursive: true })
    await writeFile(join(memoryDir, '.migrating', 'topics', 'partial.md'), 'partial', 'utf8')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(true)
    expect(existsSync(join(memoryDir, '.migrating'))).toBe(false)
    expect(existsSync(join(memoryDir, 'topics'))).toBe(true)
  })

  test('crash recovery branch B removes tmpdir alongside completed topics', async () => {
    await writePreMigratedTree()
    await mkdir(join(memoryDir, '.migrating', 'topics'), { recursive: true })
    const shardPath = join(memoryDir, 'topics', 'existing.md')
    const before = await readFile(shardPath, 'utf8')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(existsSync(join(memoryDir, '.migrating'))).toBe(false)
    expect(await readFile(shardPath, 'utf8')).toBe(before)
  })

  test('crash recovery branch C deletes root and flat stream orphans', async () => {
    await writePreMigratedTree()
    await writeRootMemory('# Memory\n\n## Orphan\nold\n')
    await writeFlatStream('2026-05-18', 'orphan\n')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
    expect(existsSync(join(memoryDir, '2026-05-18.jsonl'))).toBe(false)
    expect(await readFile(join(memoryDir, 'streams', '2026-05-18.jsonl'), 'utf8')).toBe('stream\n')
  })

  test('stage-by-copy leaves originals present before verification', async () => {
    await writeRootMemory(memoryWithTopics(['Copy Invariant']))
    await writeFlatStream('2026-05-18', 'stream\n')
    const observations: boolean[] = []

    await runShardingMigration({
      agentDir,
      logger,
      hooks: {
        onAfterStageBackup: async () => {
          observations.push(existsSync(join(agentDir, 'MEMORY.md')))
          observations.push(existsSync(join(memoryDir, '2026-05-18.jsonl')))
          observations.push(existsSync(join(memoryDir, '.migrating', 'streams', '2026-05-18.jsonl')))
        },
      },
    })

    expect(observations).toEqual([true, true, true])
  })

  test('staging verification failure preserves originals and tmpdir', async () => {
    await writeRootMemory(memoryWithTopics(['Broken Stage']))
    await writeFlatStream('2026-05-18', 'stream\n')

    const result = await runShardingMigration({
      agentDir,
      logger,
      hooks: {
        onAfterStageBackup: async () => {
          await writeFile(join(memoryDir, '.migrating', 'topics', 'broken-stage.md'), 'no citations here\n', 'utf8')
        },
      },
    })

    expect(result.migrated).toBe(false)
    expect(result.error).toContain('citation superset violation')
    expect(existsSync(join(memoryDir, '.migrating'))).toBe(true)
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(memoryDir, '2026-05-18.jsonl'))).toBe(true)
    expect(existsSync(join(memoryDir, 'topics'))).toBe(false)
  })

  test('success result reports migrated flag and counts', async () => {
    await writeRootMemory(memoryWithTopics(['One', 'Two']))
    await writeFlatStream('2026-05-18', 'stream\n')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(true)
    expect(result.topicCount).toBe(2)
    expect(result.streamCount).toBe(1)
  })

  test('no-op result reports migrated false', async () => {
    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(result.topicCount).toBe(0)
    expect(result.streamCount).toBe(0)
  })

  test('migrates 50 topics in less than five seconds', async () => {
    await writeRootMemory(memoryWithTopics(Array.from({ length: 50 }, (_, index) => `Topic ${index + 1}`)))
    const started = performance.now()

    const result = await runShardingMigration({ agentDir, logger })
    const elapsed = performance.now() - started

    expect(result.topicCount).toBe(50)
    expect(elapsed).toBeLessThan(5000)
  })

  test('already-migrated tree is a no-op with no mutations', async () => {
    await writePreMigratedTree()
    const shardPath = join(memoryDir, 'topics', 'existing.md')
    const streamPath = join(memoryDir, 'streams', '2026-05-18.jsonl')
    const before = { shard: statSync(shardPath).mtimeMs, stream: statSync(streamPath).mtimeMs }

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(statSync(shardPath).mtimeMs).toBe(before.shard)
    expect(statSync(streamPath).mtimeMs).toBe(before.stream)
  })

  test('mixed legacy and new citations remain accepted and become canonical', async () => {
    await writeRootMemory('# Memory\n\n## Mixed\nLegacy memory/2026-05-18#old-id and new streams/2026-05-19#new-id.\n')

    await runShardingMigration({ agentDir, logger })
    const shardText = await readAllTopicShards()

    expect(shardText).toContain('streams/2026-05-18#old-id')
    expect(shardText).toContain('streams/2026-05-19#new-id')
    expect(shardText).not.toContain('memory/2026-05-18#old-id')
  })

  test('flat JSONL streams are copied during staging before final deletion', async () => {
    await writeRootMemory(memoryWithTopics(['Copy Streams']))
    await writeFlatStream('2026-05-18', 'stream\n')
    const observations: string[] = []

    await runShardingMigration({
      agentDir,
      logger,
      hooks: {
        onAfterStageStreams: async () => {
          observations.push(await readFile(join(memoryDir, '2026-05-18.jsonl'), 'utf8'))
          observations.push(await readFile(join(memoryDir, '.migrating', 'streams', '2026-05-18.jsonl'), 'utf8'))
        },
      },
    })

    expect(observations).toEqual(['stream\n', 'stream\n'])
    expect(existsSync(join(memoryDir, '2026-05-18.jsonl'))).toBe(false)
  })

  test('.dreaming-state.json and memory/skills are byte-identical after migration', async () => {
    const untouched = await writeRepresentativeFixture()

    await runShardingMigration({ agentDir, logger })

    await expectUntouchedFiles(untouched)
  })

  test('legacy markdown stream migration runs before stream staging', async () => {
    await writeRootMemory(memoryWithTopics(['Legacy Stream']))
    await writeFile(join(memoryDir, '2026-05-20.md'), '<!-- watermark source=ses_a entry=entry_1 -->', 'utf8')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.legacy.migrated).toEqual(['2026-05-20'])
    expect(result.streamCount).toBe(1)
    expect(existsSync(join(memoryDir, 'streams', '2026-05-20.jsonl'))).toBe(true)
    expect(existsSync(join(memoryDir, '2026-05-20.md'))).toBe(false)
  })

  test('frontmatter is computed from citations', async () => {
    await writeRootMemory(
      '# Memory\n\n## Strength\nA memory/2026-05-18#a and streams/2026-05-19#b and streams/2026-05-19#c.\n',
    )

    await runShardingMigration({ agentDir, logger })
    const parsed = parseShard(await readFile(join(memoryDir, 'topics', 'strength.md'), 'utf8'))

    expect(parsed.frontmatter).toMatchObject({ heading: 'Strength', cites: 3, days: 2, lastReinforced: '2026-05-19' })
  })

  test('commits sharded layout when the agent directory is a git repo', async () => {
    await initGitRepo(agentDir)
    await writeRootMemory(memoryWithTopics(['Alpha', 'Beta']))
    await writeFlatStream('2026-05-18', '{"type":"fragment","id":"id-1"}\n')
    await git(agentDir, ['add', '--', 'MEMORY.md', 'memory/2026-05-18.jsonl'])
    await git(agentDir, ['commit', '-m', 'pre-shard state'])

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(true)
    const latest = await git(agentDir, ['log', '--oneline', '-1'])
    expect(latest.stdout).toContain('memory: shard MEMORY.md into 2 topic(s) and 1 daily stream(s)')

    const porcelain = await git(agentDir, ['status', '--porcelain'])
    expect(porcelain.stdout).toBe('')

    const tracked = await git(agentDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    const files = new Set(tracked.stdout.split('\n').filter((line) => line !== ''))
    expect(files.has('memory/topics/alpha.md')).toBe(true)
    expect(files.has('memory/topics/beta.md')).toBe(true)
    expect(files.has('memory/streams/2026-05-18.jsonl')).toBe(true)
    expect(files.has('memory/MEMORY.md.pre-shard.bak')).toBe(true)
    expect(files.has('MEMORY.md')).toBe(false)
    expect(files.has('memory/2026-05-18.jsonl')).toBe(false)
  })

  test('sharding migration does not throw outside a git repo', async () => {
    await writeRootMemory(memoryWithTopics(['Alpha']))
    await writeFlatStream('2026-05-18', '{"type":"fragment","id":"id-1"}\n')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(true)
    expect(messages.info.some((message) => message.includes('not in a git repo'))).toBe(true)
  })

  test('sharding migration commits new files even when MEMORY.md and flat streams were never tracked', async () => {
    await initGitRepo(agentDir)
    await writeRootMemory(memoryWithTopics(['Alpha']))
    await writeFlatStream('2026-05-18', '{"type":"fragment","id":"id-1"}\n')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(true)
    const latest = await git(agentDir, ['log', '--oneline', '-1'])
    expect(latest.stdout).toContain('memory: shard MEMORY.md into 1 topic(s) and 1 daily stream(s)')

    const porcelain = await git(agentDir, ['status', '--porcelain'])
    expect(porcelain.stdout).toBe('')

    const tracked = await git(agentDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    const files = new Set(tracked.stdout.split('\n').filter((line) => line !== ''))
    expect(files.has('memory/topics/alpha.md')).toBe(true)
    expect(files.has('memory/streams/2026-05-18.jsonl')).toBe(true)
    expect(files.has('memory/MEMORY.md.pre-shard.bak')).toBe(true)
  })

  test('orphan cleanup commits the deletions it performs (issue #315 path 2)', async () => {
    await initGitRepo(agentDir)
    await writePreMigratedTree()
    await writeRootMemory('# Memory\n\n## Orphan\nold\n')
    await writeFlatStream('2026-05-18', 'orphan\n')
    await git(agentDir, [
      'add',
      '--',
      'MEMORY.md',
      'memory/2026-05-18.jsonl',
      'memory/topics/existing.md',
      'memory/streams/2026-05-18.jsonl',
      'memory/MEMORY.md.pre-shard.bak',
    ])
    await git(agentDir, ['commit', '-m', 'pre-shard state with orphans'])

    await runShardingMigration({ agentDir, logger })

    const porcelain = await git(agentDir, ['status', '--porcelain', '--untracked-files=no'])
    expect(porcelain.stdout).toBe('')
    const latest = await git(agentDir, ['log', '--oneline', '-1'])
    expect(latest.stdout).toContain('memory: clean up 2 pre-shard file(s) orphaned by earlier migration')
    const tracked = await git(agentDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    const files = new Set(tracked.stdout.split('\n').filter((line) => line !== ''))
    expect(files.has('MEMORY.md')).toBe(false)
    expect(files.has('memory/2026-05-18.jsonl')).toBe(false)
    expect(files.has('memory/topics/existing.md')).toBe(true)
    expect(files.has('memory/streams/2026-05-18.jsonl')).toBe(true)
  })

  test('recovers already-affected agents by committing pre-existing staged deletions', async () => {
    await initGitRepo(agentDir)
    await writePreMigratedTree()
    await writeRootMemory('# Memory\n\n## Stale\nold\n')
    await writeFlatStream('2026-05-19', 'stale\n')
    await git(agentDir, [
      'add',
      '--',
      'MEMORY.md',
      'memory/2026-05-19.jsonl',
      'memory/topics/existing.md',
      'memory/streams/2026-05-18.jsonl',
      'memory/MEMORY.md.pre-shard.bak',
    ])
    await git(agentDir, ['commit', '-m', 'pre-shard state'])
    await rm(join(agentDir, 'MEMORY.md'))
    await rm(join(memoryDir, '2026-05-19.jsonl'))
    await git(agentDir, ['add', '-u', '--', 'MEMORY.md', 'memory/2026-05-19.jsonl'])
    const beforePorcelain = await git(agentDir, ['status', '--porcelain', '--untracked-files=no'])
    expect(beforePorcelain.stdout).toContain('D  MEMORY.md')
    expect(beforePorcelain.stdout).toContain('D  memory/2026-05-19.jsonl')

    await runShardingMigration({ agentDir, logger })

    expect(messages.warn).toEqual([])
    expect(messages.error).toEqual([])
    const porcelain = await git(agentDir, ['status', '--porcelain', '--untracked-files=no'])
    expect(porcelain.stdout).toBe('')
    const latest = await git(agentDir, ['log', '--oneline', '-1'])
    expect(latest.stdout).toContain('memory: clean up 2 pre-shard file(s) orphaned by earlier migration')
  })

  test('recovers already-affected agents whose deletions were never staged', async () => {
    await initGitRepo(agentDir)
    await writePreMigratedTree()
    await writeRootMemory('# Memory\n\n## Stale\nold\n')
    await writeFlatStream('2026-05-19', 'stale\n')
    await git(agentDir, [
      'add',
      '--',
      'MEMORY.md',
      'memory/2026-05-19.jsonl',
      'memory/topics/existing.md',
      'memory/streams/2026-05-18.jsonl',
      'memory/MEMORY.md.pre-shard.bak',
    ])
    await git(agentDir, ['commit', '-m', 'pre-shard state'])
    await rm(join(agentDir, 'MEMORY.md'))
    await rm(join(memoryDir, '2026-05-19.jsonl'))

    await runShardingMigration({ agentDir, logger })

    const porcelain = await git(agentDir, ['status', '--porcelain', '--untracked-files=no'])
    expect(porcelain.stdout).toBe('')
    const latest = await git(agentDir, ['log', '--oneline', '-1'])
    expect(latest.stdout).toContain('memory: clean up 2 pre-shard file(s) orphaned by earlier migration')
  })

  test('no-op when post-shard tree is clean and no pending deletions exist', async () => {
    await initGitRepo(agentDir)
    await writePreMigratedTree()
    await git(agentDir, [
      'add',
      '--',
      'memory/topics/existing.md',
      'memory/streams/2026-05-18.jsonl',
      'memory/MEMORY.md.pre-shard.bak',
    ])
    await git(agentDir, ['commit', '-m', 'post-shard state'])
    const headBefore = await git(agentDir, ['rev-parse', 'HEAD'])

    await runShardingMigration({ agentDir, logger })

    const headAfter = await git(agentDir, ['rev-parse', 'HEAD'])
    expect(headAfter.stdout).toBe(headBefore.stdout)
    const porcelain = await git(agentDir, ['status', '--porcelain', '--untracked-files=no'])
    expect(porcelain.stdout).toBe('')
  })

  test('recovery is silent and harmless outside a git repo', async () => {
    await writePreMigratedTree()
    await writeRootMemory('# Memory\n\n## Orphan\nold\n')
    await writeFlatStream('2026-05-18', 'orphan\n')

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
    expect(existsSync(join(memoryDir, '2026-05-18.jsonl'))).toBe(false)
  })

  async function writeRepresentativeFixture(): Promise<{ dreaming: string; skill: string }> {
    await writeRootMemory(representativeMemory())
    await writeFlatStream('2026-05-18', '{"type":"fragment","id":"id-1"}\n')
    await writeFlatStream('2026-05-19', '{"type":"fragment","id":"id-2"}\n')
    const dreaming = '{"version":2,"dreamedThrough":{}}\n'
    const skill = '---\nname: foo\ndescription: Test skill\n---\n\nBody\n'
    await writeFile(join(memoryDir, '.dreaming-state.json'), dreaming, 'utf8')
    await mkdir(join(memoryDir, 'skills', 'foo'), { recursive: true })
    await writeFile(join(memoryDir, 'skills', 'foo', 'SKILL.md'), skill, 'utf8')
    return { dreaming, skill }
  }

  async function writePreMigratedTree(): Promise<void> {
    await mkdir(join(memoryDir, 'topics'), { recursive: true })
    await mkdir(join(memoryDir, 'streams'), { recursive: true })
    await writeFile(
      join(memoryDir, 'topics', 'existing.md'),
      '---\nheading: Existing\ncites: 1\ndays: 1\nlastReinforced: 2026-05-18\n---\nExisting streams/2026-05-18#id-1.\n',
      'utf8',
    )
    await writeFile(join(memoryDir, 'streams', '2026-05-18.jsonl'), 'stream\n', 'utf8')
    await writeFile(join(memoryDir, 'MEMORY.md.pre-shard.bak'), '# Memory\n\n## Existing\nold\n', 'utf8')
    await writeFile(join(memoryDir, '.dreaming-state.json'), '{}\n', 'utf8')
  }

  async function expectUntouchedFiles(expected: { dreaming: string; skill: string }): Promise<void> {
    expect(await readFile(join(memoryDir, '.dreaming-state.json'), 'utf8')).toBe(expected.dreaming)
    expect(await readFile(join(memoryDir, 'skills', 'foo', 'SKILL.md'), 'utf8')).toBe(expected.skill)
  }

  async function readAllTopicShards(): Promise<string> {
    const shards = await listDir(join(memoryDir, 'topics'))
    const texts = await Promise.all(shards.map((entry) => readFile(join(memoryDir, 'topics', entry), 'utf8')))
    return texts.join('\n')
  }

  async function writeRootMemory(content: string): Promise<void> {
    await writeFile(join(agentDir, 'MEMORY.md'), content, 'utf8')
  }

  async function writeFlatStream(date: string, content: string): Promise<void> {
    await writeFile(join(memoryDir, `${date}.jsonl`), content, 'utf8')
  }
})

function representativeMemory(): string {
  const topics = Array.from({ length: 9 }, (_, index) => {
    const n = index + 1
    const prefix = n % 2 === 0 ? 'streams' : 'memory'
    return `## Topic ${n}\nThis is a remembered topic with enough prose to resemble a real shard. ${prefix}/2026-05-${n % 2 === 0 ? '19' : '18'}#id-${n}\nfragments:\n- ${prefix}/2026-05-${n % 2 === 0 ? '19' : '18'}#id-${n}\n`
  })
  return `# Memory\n\n${topics.join('\n')}\n## Historical observations\n- 2026-05-18: Historical one — memory/2026-05-18#hist-1\n- 2026-05-19: Historical two — streams/2026-05-19#hist-2\n- 2026-05-19: Historical three — memory/2026-05-19#hist-3\n`
}

function memoryWithTopics(headings: readonly string[]): string {
  return `# Memory\n\n${headings
    .map((heading, index) => `## ${heading}\nBody for ${heading}. memory/2026-05-18#id-${index + 1}\n`)
    .join('\n')}`
}

async function listDir(path: string): Promise<string[]> {
  return (await readdir(path)).sort()
}

async function initGitRepo(cwd: string): Promise<void> {
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'user@example.com'])
  await git(cwd, ['config', 'user.name', 'Test User'])
  await git(cwd, ['commit', '--allow-empty', '-m', 'initial'])
}

async function git(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  return { exitCode, stdout, stderr }
}
