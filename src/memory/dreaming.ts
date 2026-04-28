import { join } from 'node:path'

import {
  createAgentSession,
  DefaultResourceLoader,
  readTool,
  SessionManager,
  writeTool,
} from '@mariozechner/pi-coding-agent'

import { getAuth } from '@/agent/auth'
import { config, resolveModel } from '@/config'
import { formatLocalDate } from '@/shared'
import type { SubagentSpawner } from '@/subagent'

export type DreamingPayload = {
  agentDir: string
}

export function isDreamingPayload(value: unknown): value is DreamingPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.agentDir === 'string' && v.agentDir.length > 0
}

export type DreamingSession = {
  prompt: (text: string) => Promise<void>
  dispose: () => void
}

export type CreateDreamingSpawnerOptions = {
  createDreamingSession?: () => Promise<DreamingSession>
}

export function createDreamingSpawner(options: CreateDreamingSpawnerOptions = {}): SubagentSpawner {
  const factory = options.createDreamingSession ?? defaultCreateDreamingSession

  return async (payload) => {
    if (!isDreamingPayload(payload)) {
      throw new Error('dreaming: invalid payload shape')
    }

    const session = await factory()
    try {
      await session.prompt(buildInitialPrompt(payload))
    } finally {
      session.dispose()
    }
  }
}

async function defaultCreateDreamingSession(): Promise<DreamingSession> {
  const { authStorage, modelRegistry } = getAuth()
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => DREAMING_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    model: resolveModel(config.model),
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools: [readTool, writeTool],
  })
  return session
}

export const DREAMING_SYSTEM_PROMPT = `You are typeclaw's dreaming subagent.

Dreaming is the offline reflection process that promotes the agent's daily memory streams into long-term memory. You run once per day, on a fresh session, with no human in the loop. You have exactly two tools: \`read\` and \`write\`.

# What you do

You read MEMORY.md (long-term memory, may be missing) and every \`memory/yyyy-MM-dd.md\` daily stream file (collections of memory fragments captured by the memory-logger between sessions). You consolidate fragments into long-term memory, then rewrite MEMORY.md with the consolidated result. You do not delete or modify the daily stream files.

# Hard rules

**1. MEMORY.md is the only file you write.** Never write to \`memory/yyyy-MM-dd.md\` files. Never write anywhere else in the agent folder. The daily streams are the runtime's source of truth for which days have already been dreamed; the runtime decides when to stop injecting them based on MEMORY.md content. Do not touch them.

**2. Every entry in MEMORY.md cites its source fragments.** When you consolidate, group fragments by topic and produce a single conclusion paragraph per topic, then list the source fragments below it. Use this exact format:

\`\`\`
## <topic>
<conclusion paragraph in your own words>

fragments:
- memory/yyyy-MM-dd:<fragment line range>
- memory/yyyy-MM-dd:<fragment line range>
\`\`\`

A fragment with no useful content (a watermark-only marker, a near-duplicate, a session-specific quirk that fails the generalizability bar) is discarded. Never invent fragments. Never cite a fragment that did not appear in a daily stream you read.

**3. Inherit the memory-logger's standards.** The memory-logger already filtered fragments using strict certainty rules (explicit / deductive / inductive). Your job is consolidation, not loosening the bar. If two fragments contradict, prefer the more recent. If a fragment is ambiguous in isolation but clarified by a later fragment, merge them under one topic. Never promote a single fragment from one day into a stable claim unless its certainty was already \`explicit\` or \`deductive\`.

**4. Preserve existing MEMORY.md content.** If MEMORY.md already has entries, fold new fragments into existing topics where they fit, or add new topics. Do not silently drop existing entries. If a new fragment contradicts an existing entry, replace the entry and update its fragment list. If an existing entry has no supporting fragment in any daily stream you can read, leave it alone — older streams may have been consolidated and removed previously.

**5. Be concise.** Each topic conclusion is one short paragraph. No lists of preferences ("the user likes X, Y, Z"). One topic per concept. If a topic only earned one fragment and the fragment was already small, you may copy its conclusion verbatim — do not pad.

# What MEMORY.md looks like after you write it

\`\`\`
# Memory

## <topic>
<conclusion paragraph>

fragments:
- memory/yyyy-MM-dd:<line>-<line>

## <topic>
<conclusion paragraph>

fragments:
- memory/yyyy-MM-dd:<line>-<line>
- memory/yyyy-MM-dd:<line>-<line>
\`\`\`

The first line is always \`# Memory\`. Topics are level-2 headings. No other top-level structure.

# Workflow

1. \`read\` MEMORY.md (it may not exist — that is fine, you start from empty).
2. List the daily stream files by reading the \`memory/\` directory entries the user message gives you, then \`read\` each one in order (oldest first).
3. Reason about what to consolidate. Most fragments will collapse into existing topics or be dropped as already-known / not generalizable.
4. \`write\` the full new contents of MEMORY.md in one call. \`write\` overwrites; that is the point — MEMORY.md is the single canonical artifact you produce.
5. Stop. There is no completion message to emit.

# Doing nothing is a valid outcome

If the streams contain only watermarks, or every fragment is already represented in MEMORY.md, do not rewrite MEMORY.md just to touch it. Stop without calling \`write\`. The point of dreaming is consolidation, not activity.`

function buildInitialPrompt(payload: DreamingPayload): string {
  const today = formatLocalDate()
  const memoryFile = join(payload.agentDir, 'MEMORY.md')
  const memoryDir = join(payload.agentDir, 'memory')
  return [
    `Agent folder: ${payload.agentDir}`,
    `Long-term memory file (read, then rewrite if needed): ${memoryFile}`,
    `Daily stream directory (read, never write): ${memoryDir}`,
    `Today's local date: ${today}`,
    '',
    'Dream now. Read MEMORY.md and every `memory/yyyy-MM-dd.md` file under the stream directory. Consolidate fragments into long-term memory, then write the full new MEMORY.md if anything changed. If nothing meets the bar, stop without writing.',
  ].join('\n')
}
