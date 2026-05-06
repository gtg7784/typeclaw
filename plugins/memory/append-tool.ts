import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import { defineTool } from '@/plugin'

import { fragmentContentHash, parseFragments } from './fragment-parser'
import { detectSecrets } from './secret-detector'

const NEWLINE_BYTE = 0x0a

export const appendTool = defineTool({
  description:
    'Append content to a file. Creates the file (and any missing parent directories) if needed. Never truncates or overwrites existing content. If the file is non-empty and does not already end in a newline, a single newline is inserted before the appended content so consecutive appends do not run together. Refuses to write content that contains recognizable credential patterns (API keys, tokens, private keys); record the variable name and how it was discovered, never the value. Refuses to append a fragment whose topic+body already exists in the file (case-by-case; topics legitimately repeat across days, but byte-equivalent fragments within the same daily stream are duplicates by design).',
  parameters: z.object({
    path: z.string().describe('Path to the file to append to (relative or absolute).'),
    content: z.string().describe('Content to append, exactly as given.'),
  }),
  async execute({ path, content }) {
    const secrets = detectSecrets(content)
    if (secrets.length > 0) {
      const ruleNames = [...new Set(secrets.map((s) => s.rule))].join(', ')
      throw new Error(
        `Refusing to append: content contains a recognized credential pattern (${ruleNames}). ` +
          `Memory fragments must never quote secret values verbatim. Record the env var name and how it ` +
          `was discovered, not the value itself.`,
      )
    }
    const incomingFragments = parseFragments(content)
    if (incomingFragments.length > 0) {
      const existingHashes = await readExistingFragmentHashes(path)
      const duplicates = incomingFragments.filter((f) => existingHashes.has(fragmentContentHash(f)))
      if (duplicates.length > 0) {
        const topics = duplicates.map((d) => `"${d.topic}"`).join(', ')
        throw new Error(
          `Refusing to append: ${duplicates.length} fragment${duplicates.length === 1 ? '' : 's'} (${topics}) ` +
            `already exist in ${path} with byte-equivalent content. The dreaming subagent will see the existing ` +
            `fragment; do not write it again. If the new occurrence is genuinely informative (e.g. a recurrence ` +
            `that establishes a pattern), write a fragment that says so explicitly rather than restating the ` +
            `original.`,
        )
      }
    }
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

async function readExistingFragmentHashes(path: string): Promise<Set<string>> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
  return new Set(parseFragments(content).map((f) => fragmentContentHash(f)))
}

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
