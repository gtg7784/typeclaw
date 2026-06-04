import { defineCommand } from 'citty'

import { logs, parseTailValue } from '@/container'
import { findAgentDir } from '@/init'

import { runInspectViewer } from './inspect'
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
    list: {
      type: 'boolean',
      description: 'open the session viewer on the logs entry instead of dumping logs',
      default: false,
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

    // The viewer is strictly opt-in via --list, so the default `typeclaw logs`
    // (piped, redirected, -f, or a plain TTY dump) keeps the raw `docker logs`
    // pump that `typeclaw logs | grep` and CI depend on. --list drops into the
    // session viewer pre-opened on the logs entry, where esc returns to the list.
    if (args.list) {
      const exitCode = await runInspectViewer({ cwd, sessionArg: 'logs' })
      process.exit(exitCode)
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
