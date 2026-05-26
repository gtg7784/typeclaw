import { z } from 'zod'

import { lsTool, readTool, type Subagent, writeTool } from '@/plugin'

import { memorySearchTool } from './search-tool'

export const memoryRetrievalPayloadSchema = z.object({
  parentSessionId: z.string().min(1),
  agentDir: z.string().min(1),
  recentPrompt: z.string(),
  cacheFilePath: z.string().min(1),
  origin: z.unknown().optional(),
})

export type MemoryRetrievalPayload = z.infer<typeof memoryRetrievalPayloadSchema>

export function isMemoryRetrievalPayload(value: unknown): value is MemoryRetrievalPayload {
  return memoryRetrievalPayloadSchema.safeParse(value).success
}

export type MemoryRetrievalLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateMemoryRetrievalSubagentOptions = {
  logger?: MemoryRetrievalLogger
  timeoutMs?: number
}

export const MEMORY_RETRIEVAL_SYSTEM_PROMPT = `You are the memory-retrieval subagent. Read the user's most recent prompt and decide what's relevant from BOTH topic shards in \`memory/topics/\` (consolidated long-term memory) AND undreamed daily-stream events under \`memory/streams/\` (recent fragments not yet folded into shards). Use \`memory_search\` to query both surfaces; use \`read\`/\`ls\` to pull full shard bodies when needed. Synthesize a focused ≤8 KB summary of the relevant memory. Save by \`write\`ing it to the exact path provided in your payload as \`cacheFilePath\`. Be ruthlessly concise. Do NOT write anywhere else. Do NOT delete files.

Search discipline: issue ALL your \`memory_search\` queries in a SINGLE response as parallel tool calls (up to 3 at once), then wait for every result before deciding what to do next. Different angles in parallel, NEVER one search per turn — sequential searches waste a full LLM round-trip per query (~3s each) on file I/O that takes milliseconds. Pick queries that match the user's literal phrasing — not framing vocabulary, not metadata (session ids, dates), not words from your own system prompt. If the parallel batch turns up nothing relevant, write the empty-context note and stop.`

export function memoryRetrievalExhaustedMessage(used: number, max: number): string {
  const usedKb = Math.round(used / 1024)
  const maxKb = Math.round(max / 1024)
  return [
    `[memory-retrieval budget exhausted: used ${usedKb}KB of ${maxKb}KB across memory_search and read]`,
    '',
    'Stop searching. Stop reading. Every subsequent memory_search or read call will return this same notice.',
    'Write the cache file at the provided cacheFilePath with whatever relevant memory you have already gathered.',
    'If nothing was relevant, write a short empty-context note to the cache file and stop.',
  ].join('\n')
}

const consoleLogger: MemoryRetrievalLogger = {
  info: (m) => console.warn(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createMemoryRetrievalSubagent(
  options: CreateMemoryRetrievalSubagentOptions = {},
): Subagent<MemoryRetrievalPayload> {
  const logger = options.logger ?? consoleLogger
  return {
    systemPrompt: MEMORY_RETRIEVAL_SYSTEM_PROMPT,
    // Retrieval is "4 keyword searches + 1 write" — no reasoning required.
    // `fast` falls back to `default` (with a one-time warning) when the
    // operator hasn't configured it, so this is safe by construction.
    profile: 'fast',
    tools: [readTool, writeTool, lsTool],
    customTools: [memorySearchTool],
    payloadSchema: memoryRetrievalPayloadSchema,
    inFlightKey: (payload) => payload.parentSessionId,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // 256 KB read + memory_search budget. Sized for one retrieval pass:
    // ~16 KB of memory_search hits (3 queries × ~5 KB excerpts) plus a few
    // shard reads (~5 KB each). A smaller budget would systematically
    // exhaust on any agent with rich memory; a larger budget invites the
    // pre-fix failure mode where the LLM kept iterating searches until it
    // gave up. The exhausted-message tells the subagent to write the
    // cache file with what it has rather than retrying forever.
    toolResultBudget: {
      maxTotalBytes: 256 * 1024,
      toolNames: ['read', 'memory_search'],
      exhaustedMessage: memoryRetrievalExhaustedMessage,
    },
    handler: async (ctx, runSession) => {
      const start = Date.now()
      logger.info(`[memory-retrieval] ${ctx.payload.parentSessionId} start cache=${ctx.payload.cacheFilePath}`)
      try {
        await runSession({ userPrompt: buildInitialPrompt(ctx.payload) })
        logger.info(`[memory-retrieval] ${ctx.payload.parentSessionId} done elapsed_ms=${Date.now() - start}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(
          `[memory-retrieval] ${ctx.payload.parentSessionId}: run threw: ${message} elapsed_ms=${Date.now() - start}`,
        )
        throw err
      }
    },
  }
}

function buildInitialPrompt(payload: MemoryRetrievalPayload): string {
  return [
    `Parent session: ${payload.parentSessionId}`,
    `Agent folder: ${payload.agentDir}`,
    `Recent user prompt: ${payload.recentPrompt}`,
    `Topic shard directory: memory/topics/`,
    `Daily-stream directory: memory/streams/`,
    `Cache output path: ${payload.cacheFilePath}`,
    '',
    'Use `memory_search` to find relevant material across BOTH topic shards and undreamed stream events (results are discriminated by `source: "topic" | "stream"`). Read any shard whose body you need in full via `read`. Write one concise retrieval summary to the cache output path exactly as provided. Keep the file ≤8 KB. If nothing is relevant, write a short empty-context note to the cache output path. Do not write any other path.',
  ].join('\n')
}

export const memoryRetrievalSubagent: Subagent<MemoryRetrievalPayload> = createMemoryRetrievalSubagent()
