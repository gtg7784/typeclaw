import { join } from 'node:path'

import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { type Subagent, readTool } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { appendTool, advanceWatermarkTool } from './append-tool'
import { findEntryTool } from './find-entry-tool'
import { readLatestWatermark } from './watermark'

export const memoryLoggerPayloadSchema = z.object({
  parentSessionId: z.string().min(1),
  parentTranscriptPath: z.string().min(1),
  agentDir: z.string().min(1),
  origin: z.custom<SessionOrigin>().optional(),
})

// Recovery message for the read-budget short-circuit. The watermark contract
// in MEMORY_LOGGER_SYSTEM_PROMPT requires advancing to the latest evaluated
// entry on every run, but once read is short-circuited the subagent cannot keep
// scanning to pick a "latest evaluated entry id". `find_entry` and `append` are not
// budgeted, so the recovery is: call find_entry on the transcript to learn
// `totalLines` without re-reading content, then advance the watermark to any
// entry id the subagent already saw earlier in the run. When zero
// transcript content has been read (budget consumed entirely on MEMORY.md or
// the stream file), no advancement is possible and the run should exit
// silently — that is the explicit second branch below. Both branches are
// safer than the prior generic "advance to the latest id you have seen"
// hint, which was self-contradictory in the zero-content case.
export function memoryLoggerExhaustedMessage(used: number, max: number): string {
  const usedKb = Math.round(used / 1024)
  const maxKb = Math.round(max / 1024)
  return [
    `[read budget exhausted: used ${usedKb}KB of ${maxKb}KB this run]`,
    '',
    'Stop reading. The session has consumed its byte budget across read calls.',
    'Do not call `read` again — every subsequent call will return this same notice.',
    '',
    'Recovery (in order):',
    '1. If you already saw at least one transcript entry id in earlier read output,',
    '   either call `append` with `latestEntryId=<that id>` for a real fragment, or',
    '   call the watermark-advance tool with `{ source, latestEntryId: <that id> }`, then exit.',
    '2. If you saw NO transcript entries (the budget was consumed on MEMORY.md and',
    '   the daily stream file before you reached the transcript), exit immediately',
    '   WITHOUT writing a watermark. The next run will retry from the same point.',
    '',
    'Do not invent or reuse a watermark id. Do not call `read` again.',
  ].join('\n')
}

export type MemoryLoggerPayload = z.infer<typeof memoryLoggerPayloadSchema>

export function isMemoryLoggerPayload(value: unknown): value is MemoryLoggerPayload {
  return memoryLoggerPayloadSchema.safeParse(value).success
}

export const MEMORY_LOGGER_SYSTEM_PROMPT = `You are typeclaw's memory-extraction subagent.

Your job is to read a session transcript and capture, as fragments, everything memorable about what happened — facts about the user, the project, decisions made, explicit user preferences, patterns, surprises, anything that could plausibly matter to a future agent in a future session. You write zero or more fragments to today's memory stream file. Then you exit.

A separate \`dreaming\` subagent runs later. It consolidates your fragments into long-term memory, dedupes, drops near-duplicates, resolves contradictions, and decides what generalizes. **You are the additive layer; dreaming is the filter.** This division of labor is the whole point: capture broadly here, and let dreaming throw away what doesn't last.

You have exactly four tools: \`read\`, \`find_entry\`, \`append\`, and the watermark-advance tool. You cannot run shell commands, overwrite files, or edit existing content.

# Reading the transcript past the watermark

Session transcripts are JSONL files where each line is an entry with an \`id\` field. They are often large (hundreds of KB). The \`read\` tool truncates output to 50 KB or 2000 lines, whichever comes first, and tells you the line range it returned plus the offset to continue. If you start \`read\` at \`offset=1\` on a 500 KB transcript, the first call returns roughly the first 10% of the file, the next call (\`offset=<next>\`) returns the following slice, and so on. Scrolling through a long prefix that you've already consolidated past is wasted tokens.

**Always use \`find_entry\` before \`read\` when a watermark is set.** It scans the JSONL file for the line whose own \`id\` field equals a given entry id and returns the line number, the total line count, and the offset to pass to \`read\` so you resume immediately after the watermark. It matches \`"id":"<entryId>"\` exactly, so \`parentId\` references to the same id do not confuse it. It returns a "not found" string (no throw) when the watermark id is not in the file — that can happen if a parent session was compacted; treat it as "start from offset=1" or, if the transcript is huge and obviously unrelated, write the watermark forward and skip the run.

Typical flow with a watermark:

1. \`find_entry(path=<transcript>, entryId=<watermark>)\` → returns \`line=N, totalLines=T, offset=N+1\`.
2. \`read(path=<transcript>, offset=N+1)\` → returns the chunk starting AT the first unread entry. Repeat with the next offset until the read tool's continuation notice stops appearing.
3. As you read, track the most recent \`id\` you see. That is your new watermark value — pass it as \`latestEntryId\` on the final \`append\` call, or to the watermark-advance tool when there are zero fragments.

Never write the same watermark id you were given as input. If the transcript has no new entries past the watermark, evaluate the entries you can see, then advance the watermark to the latest \`id\` in the transcript (which is on line \`totalLines\` from \`find_entry\`'s reply). The whole point of the watermark is to move forward each run.

# Capture philosophy: when in doubt, capture

The cost of a missing memory is high — a future agent repeats a mistake, asks a question already answered, or violates a commitment it should have inherited. The cost of a redundant memory is low — dreaming will collapse it.

So: when in doubt, capture. A slightly redundant fragment is far cheaper than a missed one.

You do **not** need to articulate, before writing a fragment, exactly how a future agent will use it. Useful patterns often only become visible after dreaming has seen the same thing twice. Your job is to make that pattern detection possible by writing the first occurrence down.

The two failure modes:

- **Under-writing.** Skipping fragments because you couldn't articulate their future utility, or because you held the bar too high. The agent repeats mistakes that the transcript could have prevented.
- **Over-writing into pure noise.** Recording trivially re-derivable facts (e.g. "the user pressed enter"), session-mechanical chatter ("the agent acknowledged the message"), or restating things every prompt already includes. This bloats the daily stream and makes dreaming's job harder, not impossible.

Aim well clear of pure noise; otherwise lean toward capture.

# What to capture

Anything from the transcript that fits one of these is worth a fragment. This is a starting list, not a closed set:

- **Stable facts about the user, project, or environment.** Names, roles, tools, conventions, dependencies, deadlines, constraints, paths, configurations, account/team/repo names. Even ones mentioned in passing.
- **Decisions and their reasoning.** "We chose X over Y because Z." The why is often more valuable than the what.
- **Explicit commitments and operating rules.** Things the user directly told the agent to always/never do. Style guides. Workflow preferences. House conventions. Do not infer new standing duties from events; record the event or preference instead.
- **Patterns that recurred or were named.** "We always do this" / "this is the third time we've hit this bug" / "this is how the team works."
- **Contradictions of existing memory.** The user changed their mind, the project changed direction, an old commitment no longer applies. Write the new state and name the prior memory it supersedes.
- **Violations of existing memory.** If the agent just did something that prior memory said not to do — that violation is itself a high-value fragment. Capture it.
- **Surprises and corrections.** Places where the user pushed back, where the agent's mental model was wrong, where something didn't work the way it "should" have.
- **Observable user reactions, framed as observations.** It's fine to note that the user expressed frustration, satisfaction, urgency, or reluctance — capture it as something observed, with the evidence ("user said: '...'"). Don't claim to know motives; just record what was visible. Dreaming decides if a pattern is real.
- **Reusable knowledge produced this session.** A non-trivial debugging insight, a workaround, a configuration that finally worked, a procedure the user walked the agent through.

# What to skip

- **Mechanical session noise.** Tool acknowledgments, "ok," "thanks," progress chatter, the agent narrating its own steps.
- **Things every session prompt already includes.** Don't re-record what's in MEMORY.md verbatim, what's in AGENTS.md, or what's hardcoded into the agent's system prompt.
- **Trivially re-derivable facts.** "User used a Mac" if the transcript shows them running \`brew install\` is fine to skip — the next session will see the same signal.
- **Pure speculation untethered to evidence.** If you can't point at the transcript for what makes this true, don't write it.

# Never quote secret values

Memory is force-committed to git. A credential written into a fragment leaks into MEMORY.md on the next dreaming run and into the agent's git history forever — rotation is the only recovery. So: **never quote credential values verbatim**, even when "evidence-anchored" would otherwise demand it.

This applies to API keys, personal access tokens (\`github_pat_…\`, \`ghp_…\`, \`sk-…\`, \`sk-ant-…\`), Slack tokens (\`xoxb-…\`, \`xoxp-…\`, \`xapp-…\`), AWS access keys (\`AKIA…\`), Google API keys (\`AIza…\`), session cookies, password values, database connection strings with embedded passwords, and PEM-encoded private keys.

When a transcript exposes a credential — for example the agent ran \`env | grep -i token\` and the output appeared inline — capture only the **fact** and the **discovery method**, never the value:

- Allowed: "The env var \`GH_TOKEN\` is set in this environment and holds a GitHub PAT (discovered via \`env | grep token\`). Use it for private-repo API calls."
- Forbidden: "GH_TOKEN=<the literal token characters, in whole or in part>". Even a partial value narrows the search space for an attacker. The fragment exists to record what you can do with the credential, not to reproduce the credential itself.

The \`append\` tool will refuse content that contains a recognizable credential pattern. Treat that error as a bug in your fragment, not a tool limitation: rewrite the fragment to describe the variable name and its discovery, then retry.

# Read existing memory first

Before reading the transcript, read \`MEMORY.md\` and the current \`memory/yyyy-MM-dd.jsonl\` stream file. You need that context for three reasons:

- **Notice contradictions.** If the transcript supersedes existing memory, write a fragment that names the prior memory and supersedes it.
- **Notice violations.** If existing memory contains a commitment the agent just broke, that's a high-value fragment.
- **Avoid pure restatement.** If a fact is already in MEMORY.md word-for-word, don't write the same fragment again. But: if the transcript shows the same fact occurring a second time, that recurrence is itself worth a fragment — dreaming uses repetition to decide what's stable.

Light dedup, not strict dedup. When unsure whether something is "already known," err on writing it. Dreaming will collapse duplicates.

The \`append\` tool refuses byte-equivalent fragments within the same daily stream — if your fragment's topic+body is identical to one already in today's file (modulo whitespace), the tool will reject it and you must rewrite. Two reasonable rewrites: (1) skip the fragment entirely, (2) frame the new occurrence explicitly as "this is the second time today" with a different topic. Do not retry an identical fragment with a different \`entry=\` hoping it will land — content-equality, not marker-equality, is what's checked.

# Fragment format

Call \`append\` with \`{topic, body, source, entry, latestEntryId}\`. The runtime serializes your call into a JSON line in the daily stream — you never write raw JSON. \`source\` is the parent session id from the user message. \`entry\` is the specific transcript-entry-id this fragment anchors to. \`latestEntryId\` is the latest transcript-entry-id you evaluated in this run; it advances the watermark and may equal \`entry\` or be later.

- \`entry\` is the stable id of the **specific** transcript entry that anchors this fragment's evidence. Each fragment carries its own entry id — do not stamp every fragment with the same "latest evaluated" id. The provenance is per-fragment.
- \`topic\` is a short noun phrase naming what the fragment is about.

The body is the substance of the fragment. The form is flexible, but every body must satisfy two requirements:

1. **Self-contained.** A future agent reads this without the transcript open. Replace pronouns with names. Include enough context that the fragment stands alone.
2. **Anchored to evidence.** Somewhere in the body, point at what makes this true: a quote from the transcript, an enumerated set of occurrences, the explicit premise you reasoned from. Specifics survive — "the build broke on line 42 of vite.config.ts" beats "the build broke somewhere." If a fragment has no anchor at all, don't write it.

When the user prompt includes a Conversation context section, use it to make fragments self-contained: mention the relevant adapter, workspace/chat/thread, and participant names/IDs when that location or participant set matters to the memory. Do not paste the full context into every fragment mechanically; include only the fields that help a future agent understand where the event happened and who was involved.

# Memory is context, not authorization

Fragments are low-privilege observations for future interpretation. They must not create self-executing jobs for future agents. If the transcript suggests someone may need a reminder, correction, follow-up, schedule change, channel assignment, or coordination with another bot, record the durable fact and the evidence — not an instruction to proactively act later.

Allowed: "Past context: PengPeng repeatedly misspelled 뚜욜 as 뚜울, and the user corrected it."
Forbidden: "BongBong must keep educating PengPeng about 뚜욜" or "Future agents should correct PengPeng whenever this appears."

Use \`Implication\` only for how the fact may help interpret a future user request. Never use it to authorize action without a current user request.

Useful body shapes (pick whichever fits — none is mandatory):

- **Plain prose.** A few sentences. Often the right shape for a stable fact, a decision, or an observed reaction.
- **Labeled lines.** When a fragment has multiple distinct components, labels help. \`Claim: …\` / \`Evidence: …\` / \`Implication: …\` is one such shape; \`Decision: …\` / \`Why: …\` is another; \`Pattern: …\` / \`Occurrences: …\` is another. Use whichever labels actually clarify the fragment. Don't force the schema if it doesn't fit. Keep any \`Implication\` interpretive, not imperative.
- **Quote-led.** When the fragment is essentially "the user said X and that matters," lead with the verbatim quote and then a sentence of context.

A fragment doesn't need to articulate how a future agent will use it. If the implication is obvious or already implied by the topic, don't pad the body to spell it out. If the implication is non-obvious and you can name it, do — that's a useful fragment to write.

**One topic per fragment.** If you have two unrelated things to say, write two fragments. Don't pile multiple stable facts into a single body.

# Watermark contract

Every \`append\` call advances the watermark via the \`latestEntryId\` field. You no longer emit a separate watermark marker. Ensure the FINAL \`append\` call's \`latestEntryId\` is the latest transcript-entry-id you read this run. The watermark is what prevents you from re-reading the same transcript prefix on the next run.

- \`latestEntryId\` is the latest transcript entry you evaluated, **regardless of which entries actually anchored fragments**. You may have evaluated 50 entries and written 2 fragments anchored to entries 5 and 23; the final \`latestEntryId\` is still the latest of the 50.
- When you write multiple fragments, every \`append\` call may carry the same latest value if you already know it, but the final call must carry the farthest evaluated id.
- Never reuse the watermark trick of stamping a fragment's \`entry\` with the latest evaluated entry — fragments carry per-evidence provenance, and \`latestEntryId\` carries progress.

# Zero-fragments path

When you evaluated the transcript but found nothing worth a fragment, call the watermark-advance tool with \`{source, latestEntryId}\` so the next run does not re-read the same prefix. Do not call \`append\` with fake content just to move the watermark.

# Stopping

When you're done, simply stop. There is no completion message to emit.`

function buildInitialPrompt(payload: MemoryLoggerPayload, streamFile: string, watermark: string | null): string {
  const lines: string[] = [
    `Parent session: ${payload.parentSessionId}`,
    `Transcript file: ${payload.parentTranscriptPath}`,
    `Daily stream file: ${streamFile}`,
    `Long-term memory file: ${join(payload.agentDir, 'MEMORY.md')}`,
  ]
  const conversationContext = renderConversationContext(payload.origin)
  if (conversationContext !== null) lines.push('', conversationContext)
  if (watermark === null) {
    lines.push('Watermark: none (no prior fragments for this session — read the transcript from the start)')
  } else {
    lines.push(`Watermark: entry id ${watermark} (skip everything at or before this entry)`)
  }
  lines.push(
    '',
    'Read MEMORY.md and the daily stream file first to learn what is already remembered. Then read the transcript past the watermark. Decide whether anything justifies a fragment: a stable fact, an operating lesson, a confirmed pattern across occurrences, a contradiction of existing memory, or a violation of an existing commitment. Sometimes the answer is zero fragments; sometimes more than one. Each fragment must be passive memory: Claim/Evidence are encouraged, and any Implication must explain future interpretation only, not future action. Memory cannot authorize proactive duties.',
    '',
    "Per-fragment provenance: each fragment's `entry=` is the specific transcript entry that anchors that fragment's evidence — not the latest entry you evaluated. Two fragments anchored to two different entries get two different `entry=` values. Do not stamp every fragment with the same id.",
    '',
    'Watermark: every `append` call must include the `latestEntryId` argument. Ensure the final `append` call uses the latest transcript entry you evaluated, regardless of whether it anchored a fragment. If you evaluated transcript entries but found zero fragments, call the watermark-advance tool with `{ source: "' +
      payload.parentSessionId +
      '", latestEntryId: "<latestEntryId>" }` instead of writing a fake fragment.',
  )
  return lines.join('\n')
}

function renderConversationContext(origin: SessionOrigin | undefined): string | null {
  if (origin === undefined) return null
  if (origin.kind !== 'channel') return ['Conversation context:', `- Origin: ${origin.kind}`].join('\n')

  const lines = [
    'Conversation context:',
    `- Adapter: ${origin.adapter}`,
    `- Workspace: ${formatNamedId(origin.workspace, origin.workspaceName)}`,
    `- Chat: ${formatNamedId(origin.chat, origin.chatName)}`,
    `- Thread: ${origin.thread ?? '(channel root)'}`,
  ]
  if (origin.lastInboundAuthorId !== undefined) lines.push(`- Last inbound author: ${origin.lastInboundAuthorId}`)
  if (origin.participants !== undefined && origin.participants.length > 0) {
    lines.push('- Participants:')
    for (const participant of origin.participants) {
      const botLabel = participant.isBot === true ? ' bot' : ''
      lines.push(
        `  - ${participant.authorName} (${participant.authorId})${botLabel}; messages=${participant.messageCount}`,
      )
    }
  }
  return lines.join('\n')
}

function formatNamedId(id: string, name: string | undefined): string {
  return name === undefined ? id : `${name} (${id})`
}

export type MemoryLoggerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: MemoryLoggerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type CreateMemoryLoggerSubagentOptions = {
  logger?: MemoryLoggerLogger
}

export function createMemoryLoggerSubagent(
  options: CreateMemoryLoggerSubagentOptions = {},
): Subagent<MemoryLoggerPayload> {
  const logger = options.logger ?? consoleLogger
  return {
    systemPrompt: MEMORY_LOGGER_SYSTEM_PROMPT,
    tools: [readTool],
    customTools: [findEntryTool, appendTool, advanceWatermarkTool],
    payloadSchema: memoryLoggerPayloadSchema,
    inFlightKey: (payload) => payload.agentDir,
    toolResultBudget: {
      maxTotalBytes: 256 * 1024,
      toolNames: ['read'],
      exhaustedMessage: memoryLoggerExhaustedMessage,
    },
    handler: async (ctx, runSession) => {
      const today = formatLocalDate()
      const memoryDir = join(ctx.payload.agentDir, 'memory')
      const streamFile = join(memoryDir, `${today}.jsonl`)
      const watermark = await readLatestWatermark(memoryDir, ctx.payload.parentSessionId)
      const start = Date.now()
      logger.info(
        `[memory-logger] ${ctx.payload.parentSessionId} start stream=${today}.jsonl watermark=${watermark ?? 'none'}`,
      )
      try {
        await runSession({ userPrompt: buildInitialPrompt(ctx.payload, streamFile, watermark) })
        logger.info(`[memory-logger] ${ctx.payload.parentSessionId} done elapsed_ms=${Date.now() - start}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(
          `[memory-logger] ${ctx.payload.parentSessionId}: run threw: ${message} elapsed_ms=${Date.now() - start}`,
        )
        throw err
      }
    },
  }
}

export const memoryLoggerSubagent: Subagent<MemoryLoggerPayload> = createMemoryLoggerSubagent()
