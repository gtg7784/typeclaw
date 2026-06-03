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
        description: 'Stop',
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
    const registry = createCommandRegistry<undefined>([
      { name: 'stop', aliases: ['abort'], description: 'Stop', handler: () => {} },
    ])

    expect(registry.has('STOP')).toBe(true)
    expect(registry.has('abort')).toBe(true)
    expect(registry.has('missing')).toBe(false)
  })

  test('surfaces a handler reply on the handled result', async () => {
    const registry = createCommandRegistry<undefined>([
      { name: 'help', description: 'List', handler: () => ({ reply: 'all commands' }) },
    ])

    await expect(registry.execute('/help', undefined)).resolves.toEqual({
      kind: 'handled',
      name: 'help',
      reply: 'all commands',
    })
  })

  test('lists canonical commands with defaulted policy, folding aliases', () => {
    const registry = createCommandRegistry<undefined>([
      { name: 'stop', aliases: ['abort'], description: 'Stop the turn', handler: () => {} },
      {
        name: 'help',
        description: 'List commands',
        permission: 'none',
        requiresLiveSession: false,
        handler: () => {},
      },
      {
        name: 'restart',
        description: 'Restart the container',
        permission: 'session.admin',
        requiresLiveSession: false,
        wantsLiveSession: true,
        handler: () => {},
      },
    ])

    expect(registry.list()).toEqual([
      {
        name: 'stop',
        aliases: ['abort'],
        description: 'Stop the turn',
        permission: 'session.control',
        requiresLiveSession: true,
        wantsLiveSession: false,
      },
      {
        name: 'help',
        aliases: [],
        description: 'List commands',
        permission: 'none',
        requiresLiveSession: false,
        wantsLiveSession: false,
      },
      {
        name: 'restart',
        aliases: [],
        description: 'Restart the container',
        permission: 'session.admin',
        requiresLiveSession: false,
        wantsLiveSession: true,
      },
    ])
  })

  test('get() resolves aliases to the canonical command info', () => {
    const registry = createCommandRegistry<undefined>([
      { name: 'stop', aliases: ['abort'], description: 'Stop the turn', handler: () => {} },
    ])

    expect(registry.get('ABORT')?.name).toBe('stop')
    expect(registry.get('missing')).toBeUndefined()
  })
})
