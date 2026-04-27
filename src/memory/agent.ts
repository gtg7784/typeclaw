import { join } from 'node:path'

import { createAgentSession, DefaultResourceLoader, readTool, SessionManager } from '@mariozechner/pi-coding-agent'

import { getAuth } from '@/agent/auth'
import { config, resolveModel } from '@/config'
import type { SubagentSpawner } from '@/subagent'

import { appendTool } from './append-tool'
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

export type MemoryLoggerSession = {
  prompt: (text: string) => Promise<void>
  dispose: () => void
}

export type CreateMemoryLoggerSpawnerOptions = {
  createMemoryLoggerSession?: () => Promise<MemoryLoggerSession>
}

export function createMemoryLoggerSpawner(options: CreateMemoryLoggerSpawnerOptions = {}): SubagentSpawner {
  const factory = options.createMemoryLoggerSession ?? defaultCreateMemoryLoggerSession

  return async (payload) => {
    if (!isMemoryLoggerPayload(payload)) {
      throw new Error('memory-logger: invalid payload shape')
    }

    const today = new Date().toISOString().slice(0, 10)
    const streamFile = join(payload.agentDir, 'memory', `${today}.md`)
    const watermark = readWatermark(streamFile, payload.parentSessionId)

    const session = await factory()

    try {
      await session.prompt(buildInitialPrompt(payload, streamFile, watermark))
    } finally {
      session.dispose()
    }
  }
}

async function defaultCreateMemoryLoggerSession(): Promise<MemoryLoggerSession> {
  const { authStorage, modelRegistry } = getAuth()
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => MEMORY_LOGGER_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    model: resolveModel(config.model),
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools: [readTool],
    customTools: [appendTool],
  })
  return session
}

const MEMORY_LOGGER_SYSTEM_PROMPT = `You are the typeclaw memory-logger subagent.

Your job is narrow: read a session transcript, identify content worth remembering, and append fragments to a daily memory stream file. Then exit.

You have only two tools: \`read\` and \`append\`. You cannot run shell commands, overwrite files, or edit existing content.

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

# Using the append tool

Call \`append\` with the daily stream file path and the marker text. The tool always appends — it cannot truncate or overwrite. It also auto-inserts a separating newline if the existing file does not end in one, so consecutive markers do not run together.

End each marker's content with a trailing newline (\`\\n\`). For separation between markers, end the body with a blank line (i.e., \`\\n\\n\`).

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
    'Read the transcript. Identify worth-remembering content past the watermark. Append fragments to the daily stream file using the `append` tool. If nothing meets the bar, append a single bare watermark marker recording the latest entry id you evaluated. Either way, advance the watermark before you stop.',
  )
  return lines.join('\n')
}
