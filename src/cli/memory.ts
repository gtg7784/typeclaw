import { defineCommand } from 'citty'

import { proxyContainerCommand } from './container-command-client'
import { dreamsCommand } from './dreams'
import { requireAgentDir } from './require-agent-dir'
import { errorLine } from './ui'

const MEMORY_SEARCH_COMMAND = 'memory-search'

const searchSub = defineCommand({
  meta: {
    name: 'search',
    description: 'vector-search the agent long-term memory inside the running container (host stage)',
  },
  args: {
    query: {
      type: 'positional',
      description: 'the search query',
      required: true,
    },
    topK: {
      type: 'string',
      description: 'return at most N ranked results (default 10)',
    },
    json: {
      type: 'boolean',
      description: 'emit raw JSON results instead of formatted text',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = requireAgentDir()
    const topK = parseTopK(args.topK)
    if (topK === 'invalid') {
      process.stderr.write(`${errorLine('--topK must be a positive integer')}\n`)
      process.exit(2)
    }

    const result = await proxyContainerCommand({
      agentDir: cwd,
      commandName: MEMORY_SEARCH_COMMAND,
      args: {
        query: args.query,
        json: args.json === true,
        ...(topK !== undefined ? { topK } : {}),
      },
      stdout: nodeWritable(process.stdout),
      stderr: nodeWritable(process.stderr),
    })

    if (!result.ok) {
      process.stderr.write(`${errorLine(result.message)}\n`)
      process.exit(result.exitCode)
    }
    process.exit(result.exitCode)
  },
})

export const memoryCommand = defineCommand({
  meta: {
    name: 'memory',
    description: "browse and search the agent's long-term memory",
  },
  subCommands: {
    dreams: dreamsCommand,
    search: searchSub,
  },
})

function parseTopK(raw: unknown): number | undefined | 'invalid' {
  if (typeof raw !== 'string') return undefined
  // Whole-string match, not Number.parseInt — parseInt silently truncates
  // "1.5" to 1 and "10abc" to 10, proxying invalid input as a valid-looking
  // topK. The container's max-50 zod check stays as the upper-bound guard.
  if (!/^[1-9]\d*$/.test(raw)) return 'invalid'
  return Number(raw)
}

function nodeWritable(stream: NodeJS.WriteStream): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      stream.write(chunk)
    },
  })
}
