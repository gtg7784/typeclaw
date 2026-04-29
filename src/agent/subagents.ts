import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { z } from 'zod'

import { type AgentSession, createSession } from './index'

type AgentSessionTools = NonNullable<Parameters<typeof createSession>[0]>['tools']

export type SubagentContext<P = unknown> = {
  userPrompt: string
  agentDir: string
  payload: P
}

export type RunSession = (override?: { userPrompt?: string }) => Promise<void>

export type Subagent<P = unknown> = {
  systemPrompt: string
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
  payloadSchema?: z.ZodType<P>
  handler?: (ctx: SubagentContext<P>, runSession: RunSession) => Promise<void>
}

export type SubagentRegistry = Readonly<Record<string, Subagent<any>>>

// Validate payload against the subagent's schema. Strict: when no schema is
// declared, a non-undefined payload is rejected to prevent silent drops of
// caller intent.
export function validateSubagentPayload(name: string, subagent: Subagent<any>, payload: unknown): unknown {
  if (subagent.payloadSchema) {
    const result = subagent.payloadSchema.safeParse(payload)
    if (!result.success) {
      throw new Error(`subagent ${name}: invalid payload: ${result.error.message}`)
    }
    return result.data
  }
  if (payload !== undefined) {
    throw new Error(`subagent ${name}: does not accept a payload (received ${describePayload(payload)})`)
  }
  return payload
}

function describePayload(payload: unknown): string {
  if (payload === null) return 'null'
  if (Array.isArray(payload)) return 'array'
  return typeof payload
}

export type CreateSessionForSubagent = (subagent: Subagent<any>) => Promise<AgentSession>

export const defaultCreateSessionForSubagent: CreateSessionForSubagent = (subagent) =>
  createSession({
    systemPromptOverride: subagent.systemPrompt,
    ...(subagent.tools ? { tools: subagent.tools } : {}),
    customTools: subagent.customTools ?? [],
  })

export type InvokeSubagentOptions = {
  registry: SubagentRegistry
  createSessionForSubagent?: CreateSessionForSubagent
  agentDir: string
  userPrompt: string
  payload?: unknown
}

export async function invokeSubagent(name: string, options: InvokeSubagentOptions): Promise<void> {
  const subagent = options.registry[name]
  if (!subagent) throw new Error(`unknown subagent: ${name}`)

  const validatedPayload = validateSubagentPayload(name, subagent, options.payload)
  const createSessionForSubagent = options.createSessionForSubagent ?? defaultCreateSessionForSubagent

  const runSession: RunSession = async (override) => {
    const session = await createSessionForSubagent(subagent)
    try {
      await session.prompt(override?.userPrompt ?? options.userPrompt)
    } finally {
      session.dispose()
    }
  }

  if (subagent.handler) {
    const ctx = {
      userPrompt: options.userPrompt,
      agentDir: options.agentDir,
      payload: validatedPayload,
    }
    await subagent.handler(ctx, runSession)
  } else {
    await runSession()
  }
}
