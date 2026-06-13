import { readdir, readFile, stat } from 'node:fs/promises'

import { referenceFilePath, referencesDir } from '../paths'
import { parseReference, type ReferenceFrontmatter } from './frontmatter'

export type Reference = {
  path: string
  slug: string
  frontmatter: ReferenceFrontmatter
  body: string
}

type Logger = { warn(message: string): void }

type ReferenceCacheEntry = {
  mtimeMs: number
  ctimeMs: number
  size: number
  reference: Reference | null
}

type AgentReferenceCache = {
  entries: Map<string, ReferenceCacheEntry>
  lastSlugs: string[] | null
  lastReferences: Reference[] | null
}

const referenceCache = new Map<string, AgentReferenceCache>()

export async function loadAllReferences(agentDir: string, options: { logger?: Logger } = {}): Promise<Reference[]> {
  const slugs = await listReferenceSlugs(agentDir)
  const cache = getOrCreateCache(agentDir)
  const outcomes = await Promise.all(slugs.map((slug) => resolveReference(agentDir, slug, cache.entries, options)))

  const references: Reference[] = []
  const seen = new Set<string>()
  let changed = !sameSlugs(slugs, cache.lastSlugs)

  for (const outcome of outcomes) {
    seen.add(outcome.slug)
    if (outcome.kind === 'missing') {
      changed = true
      cache.entries.delete(outcome.slug)
      continue
    }
    if (outcome.kind === 'read') {
      changed = true
      cache.entries.set(outcome.slug, outcome.entry)
    }
    if (outcome.reference !== null) references.push(outcome.reference)
  }

  for (const slug of cache.entries.keys()) {
    if (!seen.has(slug)) {
      changed = true
      cache.entries.delete(slug)
    }
  }

  if (!changed && cache.lastReferences !== null) return cache.lastReferences

  cache.lastSlugs = slugs
  cache.lastReferences = references
  return references
}

export async function loadReference(
  agentDir: string,
  slug: string,
  options: { logger?: Logger } = {},
): Promise<Reference | null> {
  return readAndParseReference(referenceFilePath(agentDir, slug), slug, options)
}

export function __resetReferenceCacheForTests(): void {
  referenceCache.clear()
}

type ReferenceOutcome =
  | { kind: 'missing'; slug: string }
  | { kind: 'cached'; slug: string; reference: Reference | null }
  | { kind: 'read'; slug: string; reference: Reference | null; entry: ReferenceCacheEntry }

async function resolveReference(
  agentDir: string,
  slug: string,
  cache: Map<string, ReferenceCacheEntry>,
  options: { logger?: Logger },
): Promise<ReferenceOutcome> {
  const path = referenceFilePath(agentDir, slug)
  const fileStat = await statReference(path)
  if (fileStat === null) return { kind: 'missing', slug }

  const cached = cache.get(slug)
  if (
    cached !== undefined &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.ctimeMs === fileStat.ctimeMs &&
    cached.size === fileStat.size
  ) {
    return { kind: 'cached', slug, reference: cached.reference }
  }

  const reference = await readAndParseReference(path, slug, options)
  const entry: ReferenceCacheEntry = {
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    size: fileStat.size,
    reference,
  }
  return { kind: 'read', slug, reference, entry }
}

export async function listReferenceSlugs(agentDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(referencesDir(agentDir))
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }

  return names
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort()
}

async function readAndParseReference(
  path: string,
  slug: string,
  options: { logger?: Logger },
): Promise<Reference | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }

  try {
    const { frontmatter, body } = parseReference(text)
    return { path, slug, frontmatter, body }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const logger = options.logger ?? console
    logger.warn(`[memory] skipping malformed reference ${slug}: ${message}`)
    return null
  }
}

async function statReference(path: string): Promise<{ mtimeMs: number; ctimeMs: number; size: number } | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size }
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

function getOrCreateCache(agentDir: string): AgentReferenceCache {
  let cache = referenceCache.get(agentDir)
  if (cache === undefined) {
    cache = { entries: new Map(), lastSlugs: null, lastReferences: null }
    referenceCache.set(agentDir, cache)
  }
  return cache
}

function sameSlugs(slugs: string[], previous: string[] | null): boolean {
  return previous !== null && slugs.length === previous.length && slugs.every((slug, index) => slug === previous[index])
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
