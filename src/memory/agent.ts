import { join } from 'node:path'

import { readTool, SessionManager, writeTool } from '@mariozechner/pi-coding-agent'

import type { Tool } from '@/agent'
import type { SubagentSpawner } from '@/subagent'

import { readWatermark } from './watermark'

export type MemoryLoggerPayload = {
  parentSessionId: string
  parentTranscriptPath: string
  agentDir: string
}

export function isMemoryLoggerPayload(value: unknown): value is MemoryLoggerPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.parentSessionId === 'string' &&
    v.parentSessionId.length > 0 &&
    typeof v.parentTranscriptPath === 'string' &&
    v.parentTranscriptPath.length > 0 &&
    typeof v.agentDir === 'string' &&
    v.agentDir.length > 0
  )
}

export type SubagentSession = {
  prompt: (text: string) => Promise<void>
  dispose: () => void
}

export type SubagentSessionConfig = {
  tools: Tool[]
  systemPrompt: string
  sessionManager: SessionManager
}

export type CreateMemoryLoggerSpawnerOptions = {
  createSubagentSession: (config: SubagentSessionConfig) => Promise<SubagentSession>
}

export function createMemoryLoggerSpawner({
  createSubagentSession,
}: CreateMemoryLoggerSpawnerOptions): SubagentSpawner {
  return async (payload) => {
    if (!isMemoryLoggerPayload(payload)) {
      throw new Error('memory-logger: invalid payload shape')
    }

    const today = new Date().toISOString().slice(0, 10)
    const streamFile = join(payload.agentDir, 'memory', `${today}.md`)
    const watermark = readWatermark(streamFile, payload.parentSessionId)

    const session = await createSubagentSession({
      tools: [readTool, writeTool],
      systemPrompt: MEMORY_LOGGER_SYSTEM_PROMPT,
      sessionManager: SessionManager.inMemory(),
    })

    try {
      await session.prompt(buildInitialPrompt(payload, streamFile, watermark))
    } finally {
      session.dispose()
    }
  }
}

const MEMORY_LOGGER_SYSTEM_PROMPT = `You are the typeclaw memory-logger subagent.

Your job is narrow: read a session transcript, identify content worth remembering, and append fragments to a daily memory stream file. Then exit.

You have only two tools: \`read\` and \`write\`. You cannot run shell commands or edit other files.

# Marker format

Two kinds of HTML-comment markers can appear in the daily stream file:

A **fragment marker** introduces a memory you decided to keep. It is followed by a markdown heading and body:

\`\`\`
<!-- fragment source=<sessionId> entry=<entryId> -->
## <topic>
<body, one or more paragraphs>
\`\`\`

A **watermark marker** is a bare line that records "I evaluated up to this entry id but found nothing worth keeping." It has no heading or body:

\`\`\`
<!-- watermark source=<sessionId> entry=<entryId> -->
\`\`\`

For both markers:
- \`source\` is the parent session id passed in the user message.
- \`entry\` is the stable id of the LATEST transcript entry you considered (whether or not you wrote a fragment for it). The next memory-logger run uses this to know where you left off.
- Separate markers by a blank line.

# Worth-remembering criteria

Write a fragment ONLY if the transcript reveals:
- A stable preference, habit, or constraint of the user.
- A durable fact about the user, the agent, the project, or the environment.
- A decision made or a problem solved that is likely to recur.
- A meaningful learning that should outlive this session.

Do NOT write fragments for:
- Routine task chatter, greetings, acknowledgements.
- Transient context that will not matter tomorrow.
- Information already encoded in IDENTITY.md, SOUL.md, or USER.md.

# Watermark contract — IMPORTANT

The user message will tell you the watermark — the entry id of the last transcript entry processed in a previous run, if any. Skip everything at or before that watermark.

You MUST advance the watermark on every run, regardless of whether you wrote any fragments. There are exactly two valid outcomes:

1. **You wrote one or more fragments.** The last fragment's \`entry=\` value already records the latest entry you considered. Done.
2. **You wrote no fragments** (nothing met the bar). You MUST append a single bare watermark marker recording the latest entry id you evaluated, then stop.

Never exit without either a new fragment or a new watermark. If you skip this, the next run re-evaluates content you already considered.

# Append, never rewrite

Use \`write\` only in append mode. Never rewrite or truncate the daily stream file. If \`write\` is given a path that already has content, your responsibility is to preserve the existing content and add new markers at the end.

When you are done, simply stop. There is no completion message to emit.`

function buildInitialPrompt(payload: MemoryLoggerPayload, streamFile: string, watermark: string | null): string {
  const lines: string[] = [
    `Parent session: ${payload.parentSessionId}`,
    `Transcript file: ${payload.parentTranscriptPath}`,
    `Daily stream file: ${streamFile}`,
  ]
  if (watermark === null) {
    lines.push('Watermark: none (no prior fragments for this session — begin from the start of the transcript)')
  } else {
    lines.push(`Watermark: entry id ${watermark} (skip everything at or before this entry)`)
  }
  lines.push(
    '',
    'Read the transcript. Identify worth-remembering content past the watermark. Append fragments to the daily stream file. If nothing meets the bar, append a single bare watermark marker recording the latest entry id you evaluated. Either way, advance the watermark before you stop.',
  )
  return lines.join('\n')
}
