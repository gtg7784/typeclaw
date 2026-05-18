import { createSessionWithDispose, type SessionOrigin } from '@/agent'
import type { PermissionService } from '@/permissions'
import type {
  CommandExecResult,
  ContainerCommand,
  ContainerCommandContext,
  EitherCommand,
  EitherCommandContext,
  PluginLogger,
  RegisteredCommand,
  SpawnSubagentOptions,
} from '@/plugin'
import type { PluginRuntime } from '@/run/plugin-runtime'

export type CommandSpawnSubagent = (name: string, payload?: unknown, options?: SpawnSubagentOptions) => Promise<void>

export type CommandOutbound = {
  stdout: (callId: string, chunk: Uint8Array) => void
  stderr: (callId: string, chunk: Uint8Array) => void
  exit: (callId: string, code: number) => void
  error: (callId: string, message: string) => void
}

export type CommandRunnerOptions = {
  pluginRuntime: PluginRuntime
  permissions: PermissionService
  spawnSubagent: CommandSpawnSubagent
  agentDir: string
  runtimeVersion: string | undefined
  containerName: string | undefined
  outbound: CommandOutbound
}

type CommandHandle = {
  callId: string
  abortController: AbortController
  stdinQueue: StdinQueue
  ownerKey: WsOwnerKey
  done: Promise<void>
}

export type WsOwnerKey = object | null

export type CommandRunner = {
  start: (msg: { callId: string; name: string; args: unknown; isolated?: boolean }, ownerKey: WsOwnerKey) => void
  feedStdin: (callId: string, chunkBase64: string) => void
  endStdin: (callId: string) => void
  abort: (callId: string, reason: string) => void
  abortForOwner: (ownerKey: WsOwnerKey) => void
  inFlightCount: () => number
}

export function createCommandRunner(opts: CommandRunnerOptions): CommandRunner {
  const inFlight = new Map<string, CommandHandle>()

  function lookup(name: string): RegisteredCommand | undefined {
    const snapshot = opts.pluginRuntime.get()
    return snapshot.registry.commands.find((c) => c.commandName === name)
  }

  function start(msg: { callId: string; name: string; args: unknown; isolated?: boolean }, ownerKey: WsOwnerKey): void {
    const { callId, name, args } = msg
    if (inFlight.has(callId)) {
      opts.outbound.error(callId, `callId "${callId}" is already in flight`)
      return
    }

    const registered = lookup(name)
    if (registered === undefined) {
      opts.outbound.error(callId, `command "${name}" is not registered`)
      opts.outbound.exit(callId, 1)
      return
    }

    const command = registered.command
    if (command.surface === 'host') {
      opts.outbound.error(callId, `command "${name}" is host-only; cannot run inside the container`)
      opts.outbound.exit(callId, 1)
      return
    }

    const argsParse = parseArgs(command, args)
    if (!argsParse.ok) {
      opts.outbound.error(callId, argsParse.message)
      opts.outbound.exit(callId, 2)
      return
    }

    const abortController = new AbortController()
    const stdinQueue = createStdinQueue(abortController.signal)

    // Subagent-shaped (NOT TUI) so the prompt session this command may spawn
    // via ctx.prompt resolves to the `slim` system prompt mode, saving ~2000
    // tokens per LLM call. The caller's audit trail is preserved via
    // spawnedByOrigin; permission resolution chases through it to the
    // synthetic TUI origin (which matches the built-in owner role).
    const parentTuiOrigin: SessionOrigin = { kind: 'tui', sessionId: `command:${name}:${callId}` }
    const origin: SessionOrigin = {
      kind: 'subagent',
      subagent: `plugin-command:${name}`,
      parentSessionId: parentTuiOrigin.sessionId,
      spawnedByOrigin: parentTuiOrigin,
    }

    const stdoutSink = makeWritable((chunk) => opts.outbound.stdout(callId, chunk))
    const stderrSink = makeWritable((chunk) => opts.outbound.stderr(callId, chunk))

    const logger: PluginLogger = {
      info: (m) => writeLine(stderrSink, `[command:${registered.pluginName}] info: ${m}`),
      warn: (m) => writeLine(stderrSink, `[command:${registered.pluginName}] warn: ${m}`),
      error: (m) => writeLine(stderrSink, `[command:${registered.pluginName}] error: ${m}`),
    }

    // Emit the isolated-fallback warning through the per-command stderr
    // stream so the invoking CLI sees it. The plugin's boot-time logger
    // (registered.logger) writes to container logs which the caller never
    // reads.
    if (msg.isolated === true) {
      logger.warn(
        `command "${name}" requested isolated=true; this build does not yet implement subprocess isolation, falling back to in-process`,
      )
    }

    const sharedCtx = {
      name: registered.pluginName,
      version: registered.command.surface === 'container' ? undefined : undefined,
      agentDir: opts.agentDir,
      logger,
      signal: abortController.signal,
      stdin: stdinQueue.readable,
      stdout: stdoutSink,
      stderr: stderrSink,
    }

    const ctxPromise = (async (): Promise<number> => {
      if (command.surface === 'container') {
        const ctx: ContainerCommandContext = {
          ...sharedCtx,
          permissions: opts.permissions,
          origin,
          prompt: (text) =>
            runPromptForCommand({
              text,
              origin,
              runtime: opts.pluginRuntime,
              agentDir: opts.agentDir,
              runtimeVersion: opts.runtimeVersion,
              containerName: opts.containerName,
              permissions: opts.permissions,
              signal: abortController.signal,
            }),
          subagent: (subName, payload) =>
            opts.spawnSubagent(subName, payload, {
              spawnedByOrigin: origin,
              parentSessionId: parentTuiOrigin.sessionId,
            }),
          exec: (strings, ...values) =>
            runExecForCommand(strings, values, { cwd: opts.agentDir, signal: abortController.signal }),
        }
        return (command as ContainerCommand<unknown>).run(ctx, argsParse.value)
      }
      const ctx: EitherCommandContext = sharedCtx
      return (command as EitherCommand<unknown>).run(ctx, argsParse.value)
    })()

    const done = ctxPromise
      .then((code) => {
        if (typeof code !== 'number' || !Number.isFinite(code)) {
          opts.outbound.error(callId, `command "${name}" returned a non-numeric exit code`)
          opts.outbound.exit(callId, 1)
          return
        }
        opts.outbound.exit(callId, code)
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        opts.outbound.error(callId, detail)
        opts.outbound.exit(callId, 1)
      })
      .finally(() => {
        inFlight.delete(callId)
      })

    inFlight.set(callId, { callId, abortController, stdinQueue, ownerKey, done })
  }

  function feedStdin(callId: string, chunkBase64: string): void {
    const handle = inFlight.get(callId)
    if (handle === undefined) return
    try {
      const bytes = Uint8Array.from(atob(chunkBase64), (c) => c.charCodeAt(0))
      handle.stdinQueue.push(bytes)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      opts.outbound.error(callId, `command_stdin decode failed: ${detail}`)
    }
  }

  function endStdin(callId: string): void {
    const handle = inFlight.get(callId)
    if (handle === undefined) return
    handle.stdinQueue.close()
  }

  function abort(callId: string, reason: string): void {
    const handle = inFlight.get(callId)
    if (handle === undefined) return
    handle.abortController.abort(reason)
    handle.stdinQueue.close()
  }

  function abortForOwner(ownerKey: WsOwnerKey): void {
    for (const handle of inFlight.values()) {
      if (handle.ownerKey === ownerKey) {
        handle.abortController.abort('ws closed')
        handle.stdinQueue.close()
      }
    }
  }

  function inFlightCount(): number {
    return inFlight.size
  }

  return { start, feedStdin, endStdin, abort, abortForOwner, inFlightCount }
}

type ArgsParseResult = { ok: true; value: unknown } | { ok: false; message: string }

function parseArgs(command: { args?: { safeParse?: (input: unknown) => unknown } }, args: unknown): ArgsParseResult {
  if (command.args === undefined) return { ok: true, value: undefined }
  const safe = (
    command.args as {
      safeParse: (input: unknown) => {
        success: boolean
        data?: unknown
        error?: { issues: { path: (string | number)[]; message: string }[] }
      }
    }
  ).safeParse(args)
  if (safe.success === true) return { ok: true, value: safe.data }
  const issues = safe.error?.issues ?? []
  const message =
    issues.length === 0
      ? 'args validation failed'
      : issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`).join('; ')
  return { ok: false, message }
}

type StdinQueue = {
  readable: ReadableStream<Uint8Array>
  push: (chunk: Uint8Array) => void
  close: () => void
}

function createStdinQueue(signal: AbortSignal): StdinQueue {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  const buffered: Uint8Array[] = []

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const chunk of buffered) c.enqueue(chunk)
      buffered.length = 0
      if (closed) c.close()
      signal.addEventListener('abort', () => {
        if (!closed) {
          closed = true
          try {
            c.close()
          } catch {
            // already closed
          }
        }
      })
    },
  })

  function push(chunk: Uint8Array): void {
    if (closed) return
    if (controller === null) {
      buffered.push(chunk)
      return
    }
    controller.enqueue(chunk)
  }

  function close(): void {
    if (closed) return
    closed = true
    if (controller === null) return
    try {
      controller.close()
    } catch {
      // already closed
    }
  }

  return { readable, push, close }
}

function makeWritable(onChunk: (chunk: Uint8Array) => void): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      onChunk(chunk)
    },
  })
}

function writeLine(stream: WritableStream<Uint8Array>, line: string): void {
  const writer = stream.getWriter()
  void writer.write(new TextEncoder().encode(`${line}\n`)).then(() => writer.releaseLock())
}

async function runPromptForCommand(args: {
  text: string
  origin: SessionOrigin
  runtime: PluginRuntime
  agentDir: string
  runtimeVersion: string | undefined
  containerName: string | undefined
  permissions: PermissionService
  signal: AbortSignal
}): Promise<string> {
  // Mirrors src/agent/multimodal/look-at.ts: spawn a session, prompt, capture
  // the final assistant text, dispose. Unlike look-at we want the FULL agent
  // toolset (no `tools: []` / `customTools: []` overrides) so the model can
  // call channel_send, websearch, etc. The system prompt is composed from
  // the agent folder's IDENTITY/SOUL/MEMORY files via the default resource
  // loader (no `systemPromptOverride`).
  const snapshot = args.runtime.get()
  const sessionId = args.origin.kind === 'tui' ? args.origin.sessionId : crypto.randomUUID()
  const { session, dispose } = await createSessionWithDispose({
    origin: args.origin,
    permissions: args.permissions,
    plugins: {
      registry: snapshot.registry,
      hooks: snapshot.hooks,
      sessionId,
      agentDir: args.agentDir,
    },
    ...(args.runtimeVersion !== undefined ? { runtimeVersion: args.runtimeVersion } : {}),
    ...(args.containerName !== undefined ? { containerName: args.containerName } : {}),
  })
  try {
    if (args.signal.aborted) {
      throw new Error('command aborted before prompt could be sent')
    }
    await session.prompt(args.text)
    return session.getLastAssistantText() ?? ''
  } finally {
    session.dispose()
    await dispose()
  }
}

async function runExecForCommand(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  opts: { cwd: string; signal: AbortSignal },
): Promise<CommandExecResult> {
  // Construct the shell command by interpolating template values verbatim.
  // The command author is trusted (their plugin runs in-process anyway), so
  // we do not add shell-quoting; if they need it, they format the string
  // themselves.
  let cmd = strings[0] ?? ''
  for (let i = 0; i < values.length; i++) {
    cmd += String(values[i])
    cmd += strings[i + 1] ?? ''
  }
  const proc = Bun.spawn({
    cmd: ['sh', '-c', cmd],
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: opts.signal,
  })
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as unknown as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as unknown as ReadableStream<Uint8Array>).text(),
  ])
  return { stdout: stdoutText, stderr: stderrText, exitCode }
}
