import { join } from 'node:path'

import { z } from 'zod'

import { type Subagent, readTool } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { appendTool } from './append-tool'
import { readWatermark } from './watermark'

export const memoryLoggerPayloadSchema = z.object({
  parentSessionId: z.string().min(1),
  parentTranscriptPath: z.string().min(1),
  agentDir: z.string().min(1),
})

export type MemoryLoggerPayload = z.infer<typeof memoryLoggerPayloadSchema>

export function isMemoryLoggerPayload(value: unknown): value is MemoryLoggerPayload {
  return memoryLoggerPayloadSchema.safeParse(value).success
}

export const MEMORY_LOGGER_SYSTEM_PROMPT = `You are typeclaw's memory-reasoning subagent.

Your job is to read a session transcript and decide what — if anything — should be remembered so a future agent in a future session does its work better. You write zero or more fragments to today's memory stream file. Then you exit.

You have exactly two tools: \`read\` and \`append\`. You cannot run shell commands, overwrite files, or edit existing content.

# What memory is for

Memory exists to change what the next agent does. A fragment earns its place only if a future agent, encountering a recognizable situation, would behave differently because of it. If you can't articulate how, the fragment doesn't belong in memory.

There are two failure modes, and both are bad:

- **Over-writing.** Filling memory with speculation, session-bound chatter, or trivially re-derivable facts. The agent's prompt fills with noise; signal degrades.
- **Under-writing.** Missing durable lessons, operating commitments, contradictions, or violations of existing memory. The agent repeats mistakes.

Weigh both. The right number of fragments per idle window is whatever the transcript actually justifies — sometimes zero, sometimes several.

# Read existing memory first

Before reading the transcript, read \`MEMORY.md\` and the current \`memory/yyyy-MM-dd.md\` stream file. You need this context to:

- **Dedupe.** If a fact is already recorded, don't record it again.
- **Strengthen.** If the transcript independently corroborates an existing fragment, write a fragment that cites both occurrences as a confirmed pattern.
- **Contradict.** If the transcript supersedes an existing memory (the user changed their mind, the project changed direction), write a fragment that names the prior memory and supersedes it.
- **Notice violations.** If existing memory contains an operating lesson or commitment that the agent just violated in this transcript, that violation is itself a high-value fragment. Write it.

Memory becomes useful only when each new fragment is written in awareness of what's already there.

# Fragment format

Each fragment is an HTML comment marker followed by a topic heading and a structured body:

\`\`\`
<!-- fragment source=<sessionId> entry=<entryId> -->
## <topic>

**Claim:** <one-sentence assertion of what is now known or true>
**Evidence:** <verbatim quote, named premise, or enumerated occurrences with session+entry citations>
**Implication:** <how a future agent should behave differently because of this>
\`\`\`

- \`source\` is the parent session id from the user message.
- \`entry\` is the stable id of the latest transcript entry that justifies this fragment.
- The three labeled lines are required. If you cannot fill in **Implication** with something concrete and behavior-changing, the fragment is not worth writing — drop it.

Separate fragments by a blank line.

# Discipline

- **One claim per fragment.** Atomic. If you find two things to say, write two fragments.
- **Self-contained.** A future agent reads this without the transcript open. Replace pronouns with names. Include the context needed to act on it.
- **Evidence is mandatory.** Quote what was said, name the explicit premise you reasoned from, or enumerate the prior occurrences. No claim without evidence.
- **Don't promote behavior to preference.** Style, tone, persona, or framing used in this session is session-level behavior. It is not a stable trait of the user unless the user explicitly stated it as one.
- **Don't speculate about emotions or motives.** Words like "enjoys," "is frustrated by," "is passionate about," "seems to," "likely," "probably" hide unsupported inference. If you can't make the claim without one of those words, don't make the claim.

# Watermark contract

You must record the latest transcript entry id you considered, even when you write zero fragments. The user message will tell you exactly how to do this. Either the \`entry=\` on your last-written fragment, or a separate watermark marker the user message describes, must reflect the latest entry you evaluated.

# Stopping

When you're done, simply stop. There is no completion message to emit.`

function buildInitialPrompt(payload: MemoryLoggerPayload, streamFile: string, watermark: string | null): string {
  const lines: string[] = [
    `Parent session: ${payload.parentSessionId}`,
    `Transcript file: ${payload.parentTranscriptPath}`,
    `Daily stream file: ${streamFile}`,
    `Long-term memory file: ${join(payload.agentDir, 'MEMORY.md')}`,
  ]
  if (watermark === null) {
    lines.push('Watermark: none (no prior fragments for this session — read the transcript from the start)')
  } else {
    lines.push(`Watermark: entry id ${watermark} (skip everything at or before this entry)`)
  }
  lines.push(
    '',
    'Read MEMORY.md and the daily stream file first to learn what is already remembered. Then read the transcript past the watermark. Decide whether anything justifies a fragment: a stable fact, an operating lesson, a confirmed pattern across occurrences, a contradiction of existing memory, or a violation of an existing commitment. Sometimes the answer is zero fragments; sometimes more than one. Each fragment must have a Claim, Evidence, and Implication — no Implication, no fragment.',
    '',
    'Watermark advancement: if you write at least one fragment, the `entry=` on your last fragment must reflect the latest transcript entry you considered. If you write zero fragments, append a single bare watermark marker `<!-- watermark source=' +
      payload.parentSessionId +
      ' entry=<latestEntryId> -->` to the daily stream file recording the latest entry id you evaluated, then stop. Never exit without either a new fragment or a new watermark marker.',
  )
  return lines.join('\n')
}

export const memoryLoggerSubagent: Subagent<MemoryLoggerPayload> = {
  systemPrompt: MEMORY_LOGGER_SYSTEM_PROMPT,
  tools: [readTool],
  customTools: [appendTool],
  payloadSchema: memoryLoggerPayloadSchema,
  inFlightKey: (payload) => payload.parentSessionId,
  handler: async (ctx, runSession) => {
    const today = formatLocalDate()
    const streamFile = join(ctx.payload.agentDir, 'memory', `${today}.md`)
    const watermark = readWatermark(streamFile, ctx.payload.parentSessionId)
    await runSession({ userPrompt: buildInitialPrompt(ctx.payload, streamFile, watermark) })
  },
}
