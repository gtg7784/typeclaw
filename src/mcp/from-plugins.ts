import type { McpServer } from '@/config/config'
import type { RegisteredMcpServer } from '@/plugin/registry'

export function pluginMcpServersToConfig(registered: RegisteredMcpServer[]): McpServer[] {
  return registered.map(({ name, server }) => {
    const base = {
      name,
      enabled: server.enabled ?? true,
      args: [],
      env: {},
      ...(server.description === undefined ? {} : { description: server.description }),
      ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
    }

    if (server.transport.type === 'stdio') {
      return {
        ...base,
        command: server.transport.command,
        args: server.transport.args ?? [],
        env: server.transport.env ?? {},
      } satisfies McpServer
    }

    return {
      ...base,
      url: server.transport.url,
      env: server.transport.env ?? {},
    } satisfies McpServer
  })
}

export function mergeConfigAndPluginMcpServers(
  configServers: readonly McpServer[],
  pluginServers: readonly McpServer[],
  warn: (message: string) => void,
): McpServer[] {
  const names = new Set(configServers.map((server) => server.name))
  const merged = [...configServers]

  for (const server of pluginServers) {
    if (names.has(server.name)) {
      warn(`[mcp] plugin server "${server.name}" shadows config server; skipping`)
      continue
    }
    names.add(server.name)
    merged.push(server)
  }

  return merged
}
