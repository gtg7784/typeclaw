import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { GuardBlock } from '../policy'

export const GUARD_SKILL_AUTHORING = 'skillAuthoring'

export type SkillAuthoringDecision = GuardBlock | { allow: true } | undefined

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

type SkillRoot = {
  path: string
}

export async function checkSkillAuthoringGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<GuardBlock | undefined> {
  const decision = await checkSkillAuthoringDecision(options)
  return decision && 'block' in decision ? decision : undefined
}

export async function checkSkillAuthoringDecision(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<SkillAuthoringDecision> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = path.resolve(agentDir, rawPath)
  const target = await resolveSkillTarget(agentDir, targetPath)
  if (!target) return undefined

  if (target.rest.length !== 2 || target.rest[1] !== 'SKILL.md') {
    return block(tool, targetPath, 'skill writes must target exactly <skill-name>/SKILL.md')
  }

  const skillName = target.rest[0]
  if (!skillName || !SKILL_NAME_PATTERN.test(skillName)) {
    return block(tool, targetPath, `skill name must match ${SKILL_NAME_PATTERN}`)
  }
  if (skillName.startsWith('typeclaw-')) {
    return block(tool, targetPath, 'the typeclaw- skill namespace is reserved for bundled skills')
  }

  const contentResult = await intendedContent(tool, args, targetPath)
  if ('block' in contentResult) return contentResult

  const frontmatter = parseFrontmatter(contentResult.content)
  if (!frontmatter) {
    return block(tool, targetPath, 'SKILL.md must start with YAML frontmatter')
  }
  if (frontmatter.name !== skillName) {
    return block(tool, targetPath, `frontmatter name must match path segment ${skillName}`)
  }
  if (!frontmatter.description || frontmatter.description.trim().length === 0) {
    return block(tool, targetPath, 'frontmatter description is required')
  }

  return { allow: true }
}

export async function isSkillAuthoringAllowed(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<boolean> {
  const decision = await checkSkillAuthoringDecision(options)
  return decision !== undefined && 'allow' in decision
}

async function resolveSkillTarget(agentDir: string, targetPath: string): Promise<{ rest: string[] } | undefined> {
  const roots: SkillRoot[] = [
    { path: path.join(agentDir, 'memory', 'skills') },
    { path: path.join(agentDir, '.agents', 'skills') },
  ]
  const realTargetPath = await resolveRealIntendedPath(targetPath)

  for (const root of roots) {
    const realRootPath = await resolveRealIntendedPath(root.path)
    if (!isInside(realRootPath, realTargetPath)) continue
    return { rest: path.relative(realRootPath, realTargetPath).split(path.sep).filter(Boolean) }
  }
  return undefined
}

async function intendedContent(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
): Promise<{ content: string } | GuardBlock> {
  if (tool === 'write') {
    const content = args.content
    if (typeof content !== 'string') return block(tool, targetPath, 'write content must be a string')
    return { content }
  }

  const edits = args.edits
  if (!Array.isArray(edits)) return block(tool, targetPath, 'edit calls must include an edits array')

  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return block(tool, targetPath, `could not read existing skill before edit: ${message}`)
  }

  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return block(tool, targetPath, 'each edit must be an object')
    const { oldText, newText } = edit as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return block(tool, targetPath, 'each edit must include string oldText and newText')
    }
    if (oldText.length === 0) return block(tool, targetPath, 'edit oldText must not be empty')
    if (!content.includes(oldText)) return block(tool, targetPath, 'edit oldText was not found in existing skill')
    content = content.replace(oldText, newText)
  }
  return { content }
}

function parseFrontmatter(content: string): { name?: string; description?: string } | undefined {
  const normalized = content.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const close = normalized.indexOf('\n---', 4)
  if (close === -1) return undefined

  const values: { name?: string; description?: string } = {}
  for (const line of normalized.slice(4, close).split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    if (key !== 'name' && key !== 'description') continue
    values[key] = parseScalar(line.slice(separator + 1).trim())
  }
  return values
}

function parseScalar(value: string): string {
  if (value.length === 0) return ''
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1)
  return value
}

function block(tool: string, targetPath: string, reason: string): GuardBlock {
  return {
    block: true,
    reason: `Guard \`${GUARD_SKILL_AUTHORING}\` blocked ${tool} for ${targetPath}: ${reason}.`,
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveRealIntendedPath(absolutePath: string): Promise<string> {
  const pending: string[] = []
  let current = absolutePath

  while (true) {
    try {
      const realCurrent = await realpath(current)
      return path.join(realCurrent, ...pending.reverse())
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }

    const parent = path.dirname(current)
    if (parent === current) throw new Error(`could not resolve existing parent for ${absolutePath}`)
    pending.push(path.basename(current))
    current = parent
  }
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}
