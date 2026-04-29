import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getDreamedLines, loadDreamingState } from './dreaming-state'

const MAX_FILE_BYTES = 12 * 1024
const STREAM_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/
const STREAM_DATE_FROM_FILENAME = /^(\d{4}-\d{2}-\d{2})\.md$/
const WATERMARK_LINE = /^<!--\s*watermark\s+source=\S+\s+entry=\S+(?:\s+\S+=\S+)*\s*-->\s*$/
const MEMORY_FRAMING =
  'Long-term memory below survives across sessions. Daily streams below capture undreamed observations from recent sessions; the newest day is closest to the current task. Read both before answering anything that plausibly connects to past context.'

type FileEntry = {
  name: string
  path: string
  content: string | null
  fullyDreamed?: boolean
}

export async function loadMemory(agentDir: string): Promise<string> {
  const longTerm = await readEntry(agentDir, 'MEMORY.md')
  const streams = await readStreamEntries(agentDir)
  return renderSection(longTerm, streams)
}

async function readEntry(agentDir: string, name: string): Promise<FileEntry> {
  const filePath = join(agentDir, name)
  try {
    const raw = await readFile(filePath, 'utf8')
    const trimmed = raw.length > MAX_FILE_BYTES ? `${raw.slice(0, MAX_FILE_BYTES)}\n\n[truncated]` : raw
    return { name, path: filePath, content: trimmed }
  } catch {
    return { name, path: filePath, content: null }
  }
}

async function readStreamEntries(agentDir: string): Promise<FileEntry[]> {
  const memoryDir = join(agentDir, 'memory')
  let names: string[]
  try {
    names = await readdir(memoryDir)
  } catch {
    return []
  }

  const state = await loadDreamingState(agentDir)
  const dated = names.filter((n) => STREAM_FILE_PATTERN.test(n)).sort()
  const entries = await Promise.all(
    dated.map(async (name) => {
      const date = STREAM_DATE_FROM_FILENAME.exec(name)?.[1] ?? ''
      const dreamedLines = getDreamedLines(state, date)
      const entry = await readEntry(memoryDir, name)
      const tail = sliceUndreamedTail({ ...entry, name: `memory/${name}` }, dreamedLines)
      return stripWatermarks(tail)
    }),
  )
  return entries.filter((e) => !e.fullyDreamed)
}

// Slice off the lines already consolidated into MEMORY.md so the agent never
// sees a fragment twice (once in MEMORY.md and once in the daily stream). When
// the entire file is dreamed, return a sentinel `fullyDreamed: true` so the
// caller can drop it from the prompt entirely. When the file was hand-edited
// to be shorter than the watermark, we treat it as fully dreamed (the lost
// fragments are already consolidated into MEMORY.md).
function sliceUndreamedTail(entry: FileEntry, dreamedLines: number): FileEntry {
  if (dreamedLines <= 0 || entry.content === null) return entry
  const lines = entry.content.split('\n')
  if (dreamedLines >= lines.length) return { ...entry, fullyDreamed: true }
  const tail = lines.slice(dreamedLines).join('\n').trimStart()
  if (tail.trim() === '') return { ...entry, fullyDreamed: true }
  return { ...entry, name: `${entry.name} (undreamed tail)`, content: tail }
}

// Bare `<!-- watermark ... -->` lines are bookkeeping for the memory-logger's
// cursor; they carry no signal for the main agent reading the prompt. Strip
// them and collapse any blank-line runs they leave behind so the injected
// stream stays compact. If nothing but watermarks remained, drop the entry.
function stripWatermarks(entry: FileEntry): FileEntry {
  if (entry.fullyDreamed || entry.content === null) return entry
  const kept = entry.content.split('\n').filter((line) => !WATERMARK_LINE.test(line))
  const collapsed = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (collapsed === '') return { ...entry, fullyDreamed: true }
  return { ...entry, content: collapsed }
}

function renderSection(longTerm: FileEntry, streams: FileEntry[]): string {
  const lines = ['# Memory', '', MEMORY_FRAMING, '', `## ${longTerm.name}`, '']
  lines.push(renderBody(longTerm), '')
  for (const entry of streams) {
    lines.push(`## ${entry.name}`, '', renderBody(entry), '')
  }
  return lines.join('\n').trimEnd()
}

function renderBody(entry: FileEntry): string {
  if (entry.content === null) return `[MISSING] Expected at: ${entry.path}`
  if (entry.content.trim() === '') return `[EMPTY] Present at ${entry.path} but has no content yet.`
  return entry.content.trimEnd()
}
