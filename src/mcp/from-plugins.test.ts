import { describe, expect, test } from 'bun:test'

import type { McpServer } from '@/config/config'
import type { RegisteredMcpServer } from '@/plugin/registry'

import { mergeConfigAndPluginMcpServers, pluginMcpServersToConfig } from './from-plugins'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('pluginMcpServersToConfig', () => {
  test('maps stdio plugin servers with defaults and env passthrough', () => {
    const env = { API_KEY: { env: 'VISION_API_KEY' } }
    const registered: RegisteredMcpServer[] = [
      {
        pluginName: 'vision',
        name: 'vision',
        logger: noopLogger,
        server: {
          description: 'Vision tools',
          timeoutMs: 5000,
          transport: { type: 'stdio', command: 'vision-mcp', args: ['serve'], env },
        },
      },
    ]

    const servers = pluginMcpServersToConfig(registered)

    expect(servers).toEqual([
      {
        name: 'vision',
        description: 'Vision tools',
        enabled: true,
        timeoutMs: 5000,
        command: 'vision-mcp',
        args: ['serve'],
        env,
      },
    ])
  })

  test('maps http plugin servers and preserves explicit enabled false', () => {
    const env = { TOKEN: { value: 'secret' } }
    const registered: RegisteredMcpServer[] = [
      {
        pluginName: 'remote',
        name: 'remote',
        logger: noopLogger,
        server: {
          enabled: false,
          transport: { type: 'http', url: 'https://mcp.example.com/mcp', env },
        },
      },
    ]

    const servers = pluginMcpServersToConfig(registered)

    expect(servers).toEqual([
      {
        name: 'remote',
        enabled: false,
        url: 'https://mcp.example.com/mcp',
        args: [],
        env,
      },
    ])
  })
})

describe('mergeConfigAndPluginMcpServers', () => {
  test('keeps config servers first and skips plugin servers with colliding names', () => {
    const warnings: string[] = []
    const configServer: McpServer = { name: 'shared', enabled: true, command: 'config-mcp', args: [], env: {} }
    const pluginServers: McpServer[] = [
      { name: 'shared', enabled: true, command: 'plugin-mcp', args: [], env: {} },
      { name: 'plugin-only', enabled: true, url: 'https://mcp.example.com/mcp', args: [], env: {} },
    ]

    const merged = mergeConfigAndPluginMcpServers([configServer], pluginServers, (message) => warnings.push(message))

    expect(merged).toEqual([configServer, pluginServers[1]!])
    expect(warnings).toEqual(['[mcp] plugin server "shared" shadows config server; skipping'])
  })
})
