import { appendFile, mkdir, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

const NEWLINE_BYTE = 0x0a

export const appendTool = defineTool({
  name: 'append',
  label: 'Append',
  description:
    'Append content to a file. Creates the file (and any missing parent directories) if needed. Never truncates or overwrites existing content. If the file is non-empty and does not already end in a newline, a single newline is inserted before the appended content so consecutive appends do not run together.',
  parameters: Type.Object({
    path: Type.String({ description: 'Path to the file to append to (relative or absolute).' }),
    content: Type.String({ description: 'Content to append, exactly as given.' }),
  }),
  async execute(_toolCallId, { path, content }) {
    await mkdir(dirname(path), { recursive: true })
    const prefix = (await needsLeadingNewline(path)) ? '\n' : ''
    await appendFile(path, prefix + content, 'utf-8')
    const bytesAppended = prefix.length + content.length
    return {
      content: [{ type: 'text' as const, text: `Appended ${bytesAppended} bytes to ${path}` }],
      details: { path, bytesAppended, leadingNewlineInserted: prefix.length > 0 },
    }
  },
})

async function needsLeadingNewline(path: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  if (info.size === 0) return false
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, info.size - 1)
    return buf[0] !== NEWLINE_BYTE
  } finally {
    await fh.close()
  }
}
