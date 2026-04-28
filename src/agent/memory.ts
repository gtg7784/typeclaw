import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_FILE_BYTES = 12 * 1024
const STREAM_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/
const MEMORY_FRAMING =
  'Long-term memory below survives across sessions. Daily streams below capture undreamed observations from recent sessions; the newest day is closest to the current task. Read both before answering anything that plausibly connects to past context.'

type FileEntry = {
  name: string
  path: string
  content: string | null
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

  const dated = names.filter((n) => STREAM_FILE_PATTERN.test(n)).sort()
  return Promise.all(
    dated.map(async (name) => {
      const entry = await readEntry(memoryDir, name)
      return { ...entry, name: `memory/${name}` }
    }),
  )
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
