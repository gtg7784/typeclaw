import { describe, expect, test } from 'bun:test'

import { createCommandRegistry, parseCommand } from './index'

describe('parseCommand', () => {
  test('parses command name and arguments', () => {
    expect(parseCommand('  /stop now please  ')).toEqual({ name: 'stop', args: 'now please' })
  })

  test('normalizes names and ignores non-commands', () => {
    expect(parseCommand('/STOP')).toEqual({ name: 'stop', args: '' })
    expect(parseCommand('hello /stop')).toBeNull()
    expect(parseCommand('//not-a-command')).toBeNull()
  })
})

describe('createCommandRegistry', () => {
  test('executes registered commands and aliases', async () => {
    const handled: string[] = []
    const registry = createCommandRegistry<{ label: string }>([
      {
        name: 'stop',
        aliases: ['abort'],
        handler: ({ label }, command) => {
          handled.push(`${label}:${command.name}`)
        },
      },
    ])

    await expect(registry.execute('/abort', { label: 'channel-turn' })).resolves.toEqual({
      kind: 'handled',
      name: 'stop',
    })
    expect(handled).toEqual(['channel-turn:abort'])
  })

  test('reports unknown and non-command input without running handlers', async () => {
    const registry = createCommandRegistry<undefined>([])

    await expect(registry.execute('/missing', undefined)).resolves.toEqual({ kind: 'unknown-command', name: 'missing' })
    await expect(registry.execute('plain text', undefined)).resolves.toEqual({ kind: 'not-command' })
  })

  test('reports whether a command or alias is registered', () => {
    const registry = createCommandRegistry<undefined>([{ name: 'stop', aliases: ['abort'], handler: () => {} }])

    expect(registry.has('STOP')).toBe(true)
    expect(registry.has('abort')).toBe(true)
    expect(registry.has('missing')).toBe(false)
  })
})
