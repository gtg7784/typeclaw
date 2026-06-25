import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { defineCommand, type ContainerCommand, type PluginCommand } from '@/plugin'

import { bumpReferenceAccess } from './references/load-references'
import { agentUsesVector } from './vector/config'
import { hybridSearch, type EmbedFn, type HybridSearchResult } from './vector/hybrid'
import { VectorStore } from './vector/store'

const DEFAULT_TOP_K = 10
const MAX_TOP_K = 50

export const memorySearchArgs = z.object({
  query: z.string(),
  topK: z.number().int().min(1).max(MAX_TOP_K).default(DEFAULT_TOP_K),
  json: z.boolean().default(false),
})

export type MemorySearchArgs = z.infer<typeof memorySearchArgs>

// Container-only: hybridSearch needs the in-container embedding model (the host
// has no ONNX runtime / weights). The host `typeclaw memory search` CLI proxies
// here over the /commands websocket and streams this stdout back to the
// operator. Vector-only by design — no keyword `memory_search` fallback: with
// vector disabled there is no index to query, so it exits non-zero rather than
// silently degrade to a different search the operator didn't request.
export function createMemorySearchCommand(embedFn?: EmbedFn): ContainerCommand<MemorySearchArgs> {
  return defineCommand({
    surface: 'container',
    description: 'vector-search the agent long-term memory and print ranked topic/stream/reference hits',
    args: memorySearchArgs,
    async run(ctx, args) {
      if (!agentUsesVector(ctx.agentDir)) {
        await writeLine(
          ctx.stderr,
          'memory.vector.enabled is false — vector search is unavailable. Enable it in typeclaw.json (memory.vector.enabled) and restart the container.',
        )
        return 1
      }

      const dbPath = vectorDbPath(ctx.agentDir)
      if (!existsSync(dbPath)) {
        await writeLine(
          ctx.stderr,
          'vector index not built yet (memory/.vectors/index.db is absent). Restart the container to build it, then retry.',
        )
        return 1
      }

      const store = VectorStore.open(dbPath)
      let results: HybridSearchResult[]
      try {
        results = await hybridSearch(
          args.query,
          store,
          ctx.agentDir,
          args.topK,
          ...(embedFn !== undefined ? ([embedFn] as const) : ([] as const)),
        )
      } finally {
        store.close()
      }

      // Count a surfaced reference as an access so it survives dreaming's
      // time-decay the same way a memory_search / per-turn-retrieval hit does
      // (mirrors src/bundled-plugins/memory/index.ts). Awaited here — unlike the
      // per-turn path this is a one-shot command with no latency budget to protect.
      const referenceSlugs = results.flatMap((r) => (r.source === 'reference' ? [r.key] : []))
      if (referenceSlugs.length > 0) {
        await bumpReferenceAccess(ctx.agentDir, referenceSlugs, { logger: ctx.logger })
      }

      await writeLine(ctx.stdout, args.json ? JSON.stringify(results) : renderResults(args.query, results))
      return 0
    },
  })
}

export const memorySearchCommand = createMemorySearchCommand()

// The registry stores commands as `PluginCommand` (args: unknown) and validates
// each call against the command's own zod `args` schema before invoking `run`
// (see parseArgs in src/server/command-runner.ts). Widening the typed command to
// the registry shape here is the type-level expression of that runtime contract;
// the concrete `ContainerCommand<MemorySearchArgs>` export stays available for
// direct, type-checked test calls.
export const memoryCommands: Record<string, PluginCommand> = {
  'memory-search': memorySearchCommand as ContainerCommand<unknown>,
}

export function vectorDbPath(agentDir: string): string {
  return join(agentDir, 'memory', '.vectors', 'index.db')
}

export function renderResults(query: string, results: HybridSearchResult[]): string {
  if (results.length === 0) {
    return `No memory matched "${query}".`
  }

  const lines: string[] = [`${results.length} result(s) for "${query}":`, '']
  results.forEach((result, index) => {
    lines.push(`${index + 1}. [${result.source}] ${result.heading}`)
    lines.push(`   key: ${result.key}  score: ${result.rrfScore.toFixed(4)}`)
    const provenance = renderProvenance(result)
    if (provenance !== null) lines.push(`   ${provenance}`)
    for (const excerptLine of result.excerpt.split('\n')) {
      lines.push(`   | ${excerptLine}`)
    }
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

function renderProvenance(result: HybridSearchResult): string | null {
  const parts: string[] = []
  if (result.who !== undefined) parts.push(result.who)
  if (result.where?.chatName !== undefined) parts.push(`in ${result.where.chatName}`)
  else if (result.where?.chat !== undefined) parts.push(`in ${result.where.chat}`)
  if (result.when !== undefined) parts.push(`at ${result.when}`)
  return parts.length === 0 ? null : parts.join(' ')
}

async function writeLine(stream: WritableStream<Uint8Array>, line: string): Promise<void> {
  const writer = stream.getWriter()
  try {
    await writer.write(new TextEncoder().encode(`${line}\n`))
  } finally {
    writer.releaseLock()
  }
}
