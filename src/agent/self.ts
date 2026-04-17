import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_FILE_BYTES = 12 * 1024

const SOUL_FRAMING =
  'If SOUL.md has content below, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.'

type FileEntry = {
  name: string
  path: string
  content: string | null
}

export async function loadSelf(agentDir: string): Promise<string> {
  const entries = await Promise.all([readEntry(agentDir, 'IDENTITY.md'), readEntry(agentDir, 'SOUL.md')])
  return renderSection(entries)
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

function renderSection(entries: FileEntry[]): string {
  const lines = ['# Identity', '', SOUL_FRAMING, '']
  for (const entry of entries) {
    lines.push(`## ${entry.name}`, '')
    if (entry.content === null) {
      lines.push(`[MISSING] Expected at: ${entry.path}`)
    } else if (entry.content.trim() === '') {
      lines.push(`[EMPTY] Present at ${entry.path} but has no content yet.`)
    } else {
      lines.push(entry.content.trimEnd())
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
