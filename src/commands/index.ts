export type CommandHandler<Context> = (context: Context, command: ParsedCommand) => Promise<void> | void

export type Command<Context> = {
  name: string
  aliases?: readonly string[]
  handler: CommandHandler<Context>
}

export type ParsedCommand = {
  name: string
  args: string
}

export type CommandResult =
  | { kind: 'not-command' }
  | { kind: 'unknown-command'; name: string }
  | { kind: 'handled'; name: string }

export type CommandRegistry<Context> = {
  parse: (text: string) => ParsedCommand | null
  has: (name: string) => boolean
  execute: (text: string, context: Context) => Promise<CommandResult>
}

// TODO: Add plugin-contributed commands once the public command context is stable.

export function createCommandRegistry<Context>(commands: readonly Command<Context>[]): CommandRegistry<Context> {
  const byName = new Map<string, Command<Context>>()
  for (const command of commands) {
    registerName(byName, command.name, command)
    for (const alias of command.aliases ?? []) {
      registerName(byName, alias, command)
    }
  }

  return {
    parse: parseCommand,
    has: (name) => byName.has(name.toLowerCase()),
    execute: async (text, context) => {
      const parsed = parseCommand(text)
      if (parsed === null) return { kind: 'not-command' }
      const command = byName.get(parsed.name)
      if (!command) return { kind: 'unknown-command', name: parsed.name }
      await command.handler(context, parsed)
      return { kind: 'handled', name: command.name }
    },
  }
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null

  const body = trimmed.slice(1)
  const match = /^(?<name>[a-z][a-z0-9_-]*)(?:\s+(?<args>[\s\S]*))?$/i.exec(body)
  if (!match?.groups) return null

  return {
    name: match.groups.name!.toLowerCase(),
    args: match.groups.args ?? '',
  }
}

function registerName<Context>(
  byName: Map<string, Command<Context>>,
  rawName: string,
  command: Command<Context>,
): void {
  const name = rawName.toLowerCase()
  if (byName.has(name)) {
    throw new Error(`duplicate command: ${name}`)
  }
  byName.set(name, command)
}
