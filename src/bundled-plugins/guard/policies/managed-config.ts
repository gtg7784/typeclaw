import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { parseConfigJson } from '@/config'
import { parseCronJson } from '@/cron'

import type { GuardBlock } from '../policy'

export const GUARD_MANAGED_CONFIG = 'managedConfig'

type ManagedFile = 'typeclaw.json' | 'cron.json'

const MANAGED_FILES = new Set<ManagedFile>(['typeclaw.json', 'cron.json'])

export async function checkManagedConfigGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<GuardBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const resolvedAgentDir = path.resolve(agentDir)
  const targetPath = path.resolve(agentDir, rawPath)
  if (path.dirname(targetPath) !== resolvedAgentDir) return undefined

  const basename = path.basename(targetPath)
  if (!isManagedFile(basename)) return undefined

  const contentResult = await intendedContent(tool, args, targetPath)
  if ('block' in contentResult) return contentResult

  const validation = validateManagedContent(basename, contentResult.content)
  if (validation.ok) return undefined

  return {
    block: true,
    reason: `Guard \`${GUARD_MANAGED_CONFIG}\` blocked ${tool} for ${targetPath}: ${validation.reason}.`,
  }
}

function isManagedFile(basename: string): basename is ManagedFile {
  return MANAGED_FILES.has(basename as ManagedFile)
}

function validateManagedContent(file: ManagedFile, content: string): { ok: true } | { ok: false; reason: string } {
  if (file === 'typeclaw.json') {
    const result = parseConfigJson(content)
    return result.ok ? { ok: true } : { ok: false, reason: result.reason }
  }
  const result = parseCronJson(content)
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

async function intendedContent(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
): Promise<{ content: string } | GuardBlock> {
  if (tool === 'write') {
    const content = args.content
    if (typeof content !== 'string') {
      return blockReason(tool, targetPath, 'write content must be a string')
    }
    return { content }
  }

  const edits = args.edits
  if (!Array.isArray(edits)) {
    return blockReason(tool, targetPath, 'edit calls must include an edits array')
  }

  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return blockReason(tool, targetPath, `could not read existing file before edit: ${message}`)
  }

  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') {
      return blockReason(tool, targetPath, 'each edit must be an object')
    }
    const { oldText, newText } = edit as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return blockReason(tool, targetPath, 'each edit must include string oldText and newText')
    }
    if (oldText.length === 0) {
      return blockReason(tool, targetPath, 'edit oldText must not be empty')
    }
    if (!content.includes(oldText)) {
      return blockReason(tool, targetPath, 'edit oldText was not found in existing file')
    }
    content = content.replace(oldText, newText)
  }
  return { content }
}

function blockReason(tool: string, targetPath: string, reason: string): GuardBlock {
  return {
    block: true,
    reason: `Guard \`${GUARD_MANAGED_CONFIG}\` blocked ${tool} for ${targetPath}: ${reason}.`,
  }
}
