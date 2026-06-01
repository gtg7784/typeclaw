import { describe, expect, test } from 'bun:test'

import type { CommandInfo } from '@/commands'

import { formatChannelCommandHelp } from './commands'

const info = (name: string, description: string): CommandInfo => ({
  name,
  aliases: [],
  description,
  permission: 'session.control',
  requiresLiveSession: true,
})

describe('formatChannelCommandHelp', () => {
  test('renders one line per command with the slash prefix', () => {
    const text = formatChannelCommandHelp([
      info('help', 'List available commands'),
      info('stop', 'Stop the current turn'),
    ])

    expect(text).toBe(
      ['Available commands:', '/help — List available commands', '/stop — Stop the current turn'].join('\n'),
    )
  })

  test('handles an empty registry', () => {
    expect(formatChannelCommandHelp([])).toBe('No commands are available.')
  })
})
