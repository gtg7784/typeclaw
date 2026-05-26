import { defineCommand } from 'citty'

import { logs, parseTailValue } from '@/container'
import { findAgentDir } from '@/init'

import { c, errorLine } from './ui'

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
    description: 'show the agent container logs (host stage)',
  },
  args: {
    follow: {
      type: 'boolean',
      alias: 'f',
      description: 'stream new log output as it arrives',
      default: false,
    },
    tail: {
      type: 'string',
      alias: 'n',
      description: 'number of lines to show from the end of the logs (non-negative integer or "all")',
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    let tail: string | undefined
    if (args.tail !== undefined) {
      const parsed = parseTailValue(args.tail)
      if (!parsed.ok) {
        console.error(errorLine(parsed.reason))
        process.exit(2)
      }
      tail = parsed.value
    }

    if (args.follow) {
      console.log(c.cyan('Streaming container logs...'))
    } else {
      console.log(c.dim('Showing container logs.'))
    }

    const result = await logs({ cwd, follow: args.follow, tail })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }

    process.exit(result.exitCode)
  },
})
