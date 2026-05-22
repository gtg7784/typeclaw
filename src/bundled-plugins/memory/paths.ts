import { join } from 'node:path'

export { DREAMING_STATE_FILE } from './dreaming-state'

export const MEMORY_DIR = 'memory'
export const TOPICS_SUBDIR = 'topics'
export const STREAMS_SUBDIR = 'streams'
export const SKILLS_SUBDIR = 'skills'
export const PRE_SHARD_BACKUP_FILENAME = 'MEMORY.md.pre-shard.bak'
export const MIGRATING_TMPDIR = 'memory/.migrating'

const STREAM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function topicsDir(agentDir: string): string {
  return join(agentDir, MEMORY_DIR, TOPICS_SUBDIR)
}

export function streamsDir(agentDir: string): string {
  return join(agentDir, MEMORY_DIR, STREAMS_SUBDIR)
}

export function topicShardPath(agentDir: string, slug: string): string {
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\') || slug.startsWith('.')) {
    throw new Error(`invalid topic slug: ${JSON.stringify(slug)}`)
  }
  return join(agentDir, MEMORY_DIR, TOPICS_SUBDIR, `${slug}.md`)
}

export function streamFilePath(agentDir: string, date: string): string {
  if (!STREAM_DATE_RE.test(date)) {
    throw new Error(`invalid stream date: ${JSON.stringify(date)}`)
  }
  return join(agentDir, MEMORY_DIR, STREAMS_SUBDIR, `${date}.jsonl`)
}

export function preShardBackupPath(agentDir: string): string {
  return join(agentDir, MEMORY_DIR, PRE_SHARD_BACKUP_FILENAME)
}

export function migratingTmpDir(agentDir: string): string {
  return join(agentDir, MEMORY_DIR, '.migrating')
}
