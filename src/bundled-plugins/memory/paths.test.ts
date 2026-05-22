import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  DREAMING_STATE_FILE,
  MEMORY_DIR,
  MIGRATING_TMPDIR,
  PRE_SHARD_BACKUP_FILENAME,
  SKILLS_SUBDIR,
  STREAMS_SUBDIR,
  TOPICS_SUBDIR,
  migratingTmpDir,
  preShardBackupPath,
  streamFilePath,
  streamsDir,
  topicShardPath,
  topicsDir,
} from './paths'

const AGENT_DIR = '/tmp/typeclaw-paths-test/agent'

describe('path constants', () => {
  test('relative path constants are correct', () => {
    expect(MEMORY_DIR).toBe('memory')
    expect(TOPICS_SUBDIR).toBe('topics')
    expect(STREAMS_SUBDIR).toBe('streams')
    expect(SKILLS_SUBDIR).toBe('skills')
    expect(DREAMING_STATE_FILE).toBe('memory/.dreaming-state.json')
    expect(PRE_SHARD_BACKUP_FILENAME).toBe('MEMORY.md.pre-shard.bak')
    expect(MIGRATING_TMPDIR).toBe('memory/.migrating')
  })
})

describe('topicShardPath', () => {
  test('returns correct absolute path for valid slug', () => {
    expect(topicShardPath(AGENT_DIR, 'foo-bar')).toBe(join(AGENT_DIR, 'memory', 'topics', 'foo-bar.md'))
  })

  test('rejects slug containing ..', () => {
    expect(() => topicShardPath(AGENT_DIR, '../etc/passwd')).toThrow(/invalid topic slug/)
  })

  test('rejects absolute path slug', () => {
    expect(() => topicShardPath(AGENT_DIR, '/abs/path')).toThrow(/invalid topic slug/)
  })

  test('rejects slug containing /', () => {
    expect(() => topicShardPath(AGENT_DIR, 'foo/bar')).toThrow(/invalid topic slug/)
  })

  test('rejects slug with backslash', () => {
    expect(() => topicShardPath(AGENT_DIR, 'foo\\bar')).toThrow(/invalid topic slug/)
  })

  test('rejects slug starting with .', () => {
    expect(() => topicShardPath(AGENT_DIR, '.dreaming-state')).toThrow(/invalid topic slug/)
  })
})

describe('streamFilePath', () => {
  test('returns correct absolute path for valid date', () => {
    expect(streamFilePath(AGENT_DIR, '2026-05-20')).toBe(join(AGENT_DIR, 'memory', 'streams', '2026-05-20.jsonl'))
  })

  test('rejects malformed date', () => {
    expect(() => streamFilePath(AGENT_DIR, 'not-a-date')).toThrow(/invalid stream date/)
    expect(() => streamFilePath(AGENT_DIR, '2026-5-20')).toThrow(/invalid stream date/)
    expect(() => streamFilePath(AGENT_DIR, '2026/05/20')).toThrow(/invalid stream date/)
  })
})

describe('directory helpers', () => {
  test('topicsDir returns correct path', () => {
    expect(topicsDir(AGENT_DIR)).toBe(join(AGENT_DIR, 'memory', 'topics'))
  })

  test('streamsDir returns correct path', () => {
    expect(streamsDir(AGENT_DIR)).toBe(join(AGENT_DIR, 'memory', 'streams'))
  })
})

describe('file helpers', () => {
  test('preShardBackupPath returns correct path', () => {
    expect(preShardBackupPath(AGENT_DIR)).toBe(join(AGENT_DIR, 'memory', 'MEMORY.md.pre-shard.bak'))
  })

  test('migratingTmpDir returns correct path', () => {
    expect(migratingTmpDir(AGENT_DIR)).toBe(join(AGENT_DIR, 'memory', '.migrating'))
  })
})
