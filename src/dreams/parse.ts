import {
  type DreamCategory,
  type DreamEmoji,
  DREAM_EMOJI_POOL,
  type DreamEntryDetail,
  type FragmentEventSummary,
  type ShardChangeStatus,
  type SkillCreation,
  type TopicShardChange,
} from './types'

const BODY_PREVIEW_MAX = 80
const EMOJI_SET = new Set<string>(DREAM_EMOJI_POOL)
const STREAM_PATH = /^memory\/(?:streams\/)?(\d{4}-\d{2}-\d{2})\.jsonl$/
const TOPIC_PATH = /^memory\/topics\/(.+)\.md$/
const SKILL_PATH = /^memory\/skills\/([^/]+)\/SKILL\.md$/
const STATE_PATH = 'memory/.dreaming-state.json'

export type DreamSubject = {
  isDreamCommit: boolean
  summary: string | null
  emoji: DreamEmoji | null
  categories: DreamCategory[]
}

export function parseDreamSubject(subject: string): DreamSubject {
  const match = /^dream:\s+(.*)$/.exec(subject)
  if (match === null) {
    return { isDreamCommit: false, summary: null, emoji: null, categories: [] }
  }

  const rest = (match[1] ?? '').trim()
  const { summary, emoji } = splitTrailingEmoji(rest)
  return {
    isDreamCommit: true,
    summary: summary.length > 0 ? summary : null,
    emoji,
    categories: classifySummary(summary),
  }
}

function splitTrailingEmoji(rest: string): { summary: string; emoji: DreamEmoji | null } {
  const chars = [...rest]
  const last = chars.at(-1)
  if (last !== undefined && EMOJI_SET.has(last)) {
    return { summary: chars.slice(0, -1).join('').trim(), emoji: last as DreamEmoji }
  }
  return { summary: rest, emoji: null }
}

function classifySummary(summary: string): DreamCategory[] {
  const categories: DreamCategory[] = []
  if (/\bfragments?\b/.test(summary)) categories.push('fragments')
  if (/\bskills?\b/.test(summary)) categories.push('skills')
  if (/watermarks only/.test(summary)) categories.push('watermarks-only')
  if (/^snapshot$/.test(summary)) categories.push('snapshot')
  if (categories.length === 0) categories.push('other')
  return categories
}

export function parseDreamDetail(nameStatus: string, patch: string): DreamEntryDetail {
  const warnings: string[] = []
  const changedTopics: TopicShardChange[] = []
  const createdSkills: SkillCreation[] = []
  let stateChanged = false

  for (const { status, path, oldPath } of parseNameStatus(nameStatus)) {
    if (path === STATE_PATH || oldPath === STATE_PATH) {
      stateChanged = true
      continue
    }
    const topic = TOPIC_PATH.exec(path)
    if (topic !== null) {
      changedTopics.push({ path, slug: topic[1] ?? path, status, additions: null, deletions: null })
      continue
    }
    if (status === 'added') {
      const skill = SKILL_PATH.exec(path)
      if (skill !== null) createdSkills.push({ name: skill[1] ?? '', path })
    }
  }

  applyTopicLineCounts(changedTopics, patch, warnings)
  const addedFragments = extractAddedFragments(patch, warnings)

  return { addedFragments, changedTopics, createdSkills, stateChanged, parseWarnings: warnings }
}

type NameStatusRow = { status: ShardChangeStatus; path: string; oldPath: string | null }

function parseNameStatus(nameStatus: string): NameStatusRow[] {
  const rows: NameStatusRow[] = []
  for (const line of nameStatus.split('\n')) {
    if (line.trim().length === 0) continue
    const cols = line.split('\t')
    const code = cols[0] ?? ''
    if (code.startsWith('R')) {
      const oldPath = cols[1] ?? ''
      const newPath = cols[2] ?? ''
      if (newPath.length > 0) rows.push({ status: 'renamed', path: newPath, oldPath })
      continue
    }
    const path = cols[1] ?? ''
    if (path.length === 0) continue
    rows.push({ status: mapStatusCode(code), path, oldPath: null })
  }
  return rows
}

function mapStatusCode(code: string): ShardChangeStatus {
  const c = code.charAt(0)
  if (c === 'A') return 'added'
  if (c === 'M') return 'modified'
  if (c === 'D') return 'deleted'
  if (c === 'R') return 'renamed'
  return 'unknown'
}

type ParsedHunk = { path: string; addedLines: string[] }

function* iterateHunks(patch: string): Generator<ParsedHunk> {
  let currentPath: string | null = null
  let added: string[] = []
  const flush = function* (): Generator<ParsedHunk> {
    if (currentPath !== null) yield { path: currentPath, addedLines: added }
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      yield* flush()
      currentPath = null
      added = []
      continue
    }
    if (line.startsWith('+++ ')) {
      currentPath = stripDiffPathPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push(line.slice(1))
    }
  }
  yield* flush()
}

function stripDiffPathPrefix(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '/dev/null') return trimmed
  return trimmed.replace(/^b\//, '')
}

function extractAddedFragments(patch: string, warnings: string[]): FragmentEventSummary[] {
  const out: FragmentEventSummary[] = []
  for (const hunk of iterateHunks(patch)) {
    const streamMatch = STREAM_PATH.exec(hunk.path)
    if (streamMatch === null) continue
    const streamDate = streamMatch[1] ?? null
    for (const line of hunk.addedLines) {
      if (line.trim().length === 0) continue
      const fragment = parseFragmentLine(line, streamDate)
      if (fragment === null) {
        warnings.push(`unparseable stream line in ${hunk.path}`)
        continue
      }
      if (fragment !== 'skip') out.push(fragment)
    }
  }
  return out
}

function parseFragmentLine(line: string, streamDate: string | null): FragmentEventSummary | 'skip' | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (obj.type !== 'fragment') return 'skip'
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null
  return {
    id: obj.id,
    streamDate,
    topic: typeof obj.topic === 'string' ? obj.topic : null,
    bodyPreview: typeof obj.body === 'string' ? preview(obj.body) : null,
  }
}

function applyTopicLineCounts(topics: TopicShardChange[], patch: string, warnings: string[]): void {
  if (topics.length === 0) return
  const counts = new Map<string, { additions: number; deletions: number }>()
  let currentPath: string | null = null

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentPath = stripDiffPathPrefix(line.slice(4))
      if (currentPath !== null && !counts.has(currentPath)) counts.set(currentPath, { additions: 0, deletions: 0 })
      continue
    }
    if (currentPath === null) continue
    const bucket = counts.get(currentPath)
    if (bucket === undefined) continue
    if (line.startsWith('+') && !line.startsWith('+++')) bucket.additions++
    else if (line.startsWith('-') && !line.startsWith('---')) bucket.deletions++
  }

  for (const topic of topics) {
    if (topic.status === 'deleted') continue
    const bucket = counts.get(topic.path)
    if (bucket === undefined) {
      if (topic.status === 'modified') warnings.push(`no diff hunk for modified topic ${topic.path}`)
      continue
    }
    topic.additions = bucket.additions
    topic.deletions = bucket.deletions
  }
}

function preview(body: string): string {
  const oneline = body.replace(/\s+/g, ' ').trim()
  if (oneline.length <= BODY_PREVIEW_MAX) return oneline
  return `${oneline.slice(0, BODY_PREVIEW_MAX)}…`
}
