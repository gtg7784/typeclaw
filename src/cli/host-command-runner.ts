import { z } from 'zod'

import {
  type EitherCommand,
  type EitherCommandContext,
  type HostCommand,
  type HostCommandContext,
  type PluginCommand,
} from '@/plugin'
import { coerceFlag } from '@/plugin/zod-introspect'

export type HostRunOptions = {
  agentDir: string
  pluginName: string
  pluginVersion: string | undefined
  command: HostCommand | EitherCommand
  rawArgs: readonly string[]
  signal: AbortSignal
  stdin: ReadableStream<Uint8Array>
  stdout: WritableStream<Uint8Array>
  stderr: WritableStream<Uint8Array>
}

export type HostRunResult = { ok: true; exitCode: number } | { ok: false; exitCode: number; message: string }

export async function runHostCommand(opts: HostRunOptions): Promise<HostRunResult> {
  const argsParse = parseArgs(opts.command, opts.rawArgs)
  if (!argsParse.ok) {
    return { ok: false, exitCode: 2, message: argsParse.message }
  }

  const logger = makeCommandLogger(opts.pluginName, opts.stderr)
  const ctxBase = {
    name: opts.pluginName,
    version: opts.pluginVersion,
    agentDir: opts.agentDir,
    logger,
    signal: opts.signal,
    stdin: opts.stdin,
    stdout: opts.stdout,
    stderr: opts.stderr,
  }

  try {
    if (opts.command.surface === 'host') {
      const ctx: HostCommandContext = ctxBase
      const code = await opts.command.run(ctx, argsParse.value)
      return { ok: true, exitCode: code }
    }
    const ctx: EitherCommandContext = ctxBase
    const code = await opts.command.run(ctx, argsParse.value)
    return { ok: true, exitCode: code }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, exitCode: 1, message: detail }
  }
}

type ArgsParseResult = { ok: true; value: unknown } | { ok: false; message: string }

export function parseArgs(command: PluginCommand, rawArgs: readonly string[]): ArgsParseResult {
  if (command.args === undefined) {
    if (rawArgs.length > 0) {
      return { ok: false, message: `command accepts no arguments but received: ${rawArgs.join(' ')}` }
    }
    return { ok: true, value: undefined }
  }

  const tokenized = tokenizeFlags(rawArgs)
  if (!tokenized.ok) return tokenized

  const coerced = coerceAgainstSchema(command.args, tokenized.flags)
  if (!coerced.ok) return coerced

  const parsed = command.args.safeParse(coerced.value)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('; ')
    return { ok: false, message }
  }
  return { ok: true, value: parsed.data }
}

type TokenizeResult = { ok: true; flags: Record<string, string | true> } | { ok: false; message: string }

// Parses `--key=value` / `--key value` / `--key` (boolean) into a flat map.
// Positional args are not supported in v1 (constrained by the z.object args
// shape). Unknown flags surface as Zod errors downstream.
function tokenizeFlags(rawArgs: readonly string[]): TokenizeResult {
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) {
      return { ok: false, message: `unexpected positional argument: ${arg}` }
    }
    const stripped = arg.slice(2)
    const eq = stripped.indexOf('=')
    if (eq >= 0) {
      const key = stripped.slice(0, eq)
      const value = stripped.slice(eq + 1)
      flags[key] = value
      continue
    }
    const key = stripped
    const next = rawArgs[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { ok: true, flags }
}

function coerceAgainstSchema(
  schema: z.ZodObject<z.ZodRawShape>,
  flags: Record<string, string | true>,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const shape = schema.shape as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(flags)) {
    const leaf = shape[key]
    if (leaf === undefined) {
      return { ok: false, message: `unknown flag: --${key}` }
    }
    try {
      out[key] = coerceFlag(leaf, raw, key)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, message: detail }
    }
  }
  return { ok: true, value: out }
}

function makeCommandLogger(pluginName: string, stderr: WritableStream<Uint8Array>) {
  const writer = stderr.getWriter()
  const encoder = new TextEncoder()
  const write = (level: string, msg: string) => {
    void writer.write(encoder.encode(`[command:${pluginName}] ${level}: ${msg}\n`))
  }
  return {
    info: (msg: string) => write('info', msg),
    warn: (msg: string) => write('warn', msg),
    error: (msg: string) => write('error', msg),
  }
}
