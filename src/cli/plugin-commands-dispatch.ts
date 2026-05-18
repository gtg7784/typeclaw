import { runHostCommand } from './host-command-runner'
import { renderCommandHelp } from './plugin-command-help'
import { discoverCommands } from './plugin-commands'

export type PluginCommandDispatchOutcome =
  | { kind: 'not-found' }
  | { kind: 'dispatched'; exitCode: number }
  | { kind: 'error'; exitCode: number; message: string }

export type DispatchOptions = {
  name: string
  rawArgs: readonly string[]
  cwd: string
  stdin?: ReadableStream<Uint8Array>
  stdout?: WritableStream<Uint8Array>
  stderr?: WritableStream<Uint8Array>
  signal?: AbortSignal
}

export async function dispatchPluginCommand(opts: DispatchOptions): Promise<PluginCommandDispatchOutcome> {
  const discovery = await discoverCommands({ cwd: opts.cwd })
  const match = discovery.commands.find((c) => c.commandName === opts.name)
  if (match === undefined) {
    // Surface plugin load failures so a user typing `typeclaw <cmd>` sees why
    // their plugin's command isn't listed, instead of a generic "not found".
    if (discovery.loadErrors.length > 0) {
      const stderr = opts.stderr ?? defaultStderr()
      const writer = stderr.getWriter()
      const encoder = new TextEncoder()
      for (const e of discovery.loadErrors) {
        await writer.write(encoder.encode(`[plugin-commands] ${e.entry}: ${e.error}\n`))
      }
      writer.releaseLock()
    }
    return { kind: 'not-found' }
  }

  const stdin = opts.stdin ?? defaultStdin()
  const stdout = opts.stdout ?? defaultStdout()
  const stderr = opts.stderr ?? defaultStderr()
  const signal = opts.signal ?? new AbortController().signal

  if (opts.rawArgs.includes('--help') || opts.rawArgs.includes('-h')) {
    const help = renderCommandHelp(match)
    const writer = stdout.getWriter()
    await writer.write(new TextEncoder().encode(`${help}\n`))
    writer.releaseLock()
    return { kind: 'dispatched', exitCode: 0 }
  }

  if (match.command.surface === 'container') {
    return {
      kind: 'error',
      exitCode: 1,
      message: `command "${opts.name}" requires the agent container (surface: 'container'); the container-side dispatcher is not yet implemented in this build`,
    }
  }

  const result = await runHostCommand({
    agentDir: discovery.agentDir,
    pluginName: match.pluginName,
    pluginVersion: match.pluginVersion,
    command: match.command,
    rawArgs: opts.rawArgs,
    signal,
    stdin,
    stdout,
    stderr,
  })

  if (!result.ok) {
    return { kind: 'error', exitCode: result.exitCode, message: result.message }
  }
  return { kind: 'dispatched', exitCode: result.exitCode }
}

function defaultStdin(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}

function defaultStdout(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      process.stdout.write(chunk)
    },
  })
}

function defaultStderr(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      process.stderr.write(chunk)
    },
  })
}
