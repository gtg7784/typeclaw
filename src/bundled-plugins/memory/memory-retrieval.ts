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
}

export const MEMORY_RETRIEVAL_SYSTEM_PROMPT = `You are the memory-retrieval subagent. Read the user's most recent prompt and decide what's relevant from BOTH topic shards in \`memory/topics/\` (consolidated long-term memory) AND undreamed daily-stream events under \`memory/streams/\` (recent fragments not yet folded into shards). Use \`memory_search\` to query both surfaces; use \`read\`/\`ls\` to pull full shard bodies when needed. Synthesize a focused ≤8 KB summary of the relevant memory. Save by \`write\`ing it to the exact path provided in your payload as \`cacheFilePath\`. Be ruthlessly concise. Do NOT write anywhere else. Do NOT delete files.`

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
    tools: [readTool, writeTool, lsTool],
    customTools: [memorySearchTool],
    payloadSchema: memoryRetrievalPayloadSchema,
    inFlightKey: (payload) => payload.parentSessionId,
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
