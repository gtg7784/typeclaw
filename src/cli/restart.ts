import { defineCommand } from 'citty'

import { config, validateConfig } from '@/config'
import { start, stop } from '@/container'
import { findAgentDir, isInitialized } from '@/init'

import { c, errorLine, renderStartSuccess, spinner } from './ui'

export const restartCommand = defineCommand({
  meta: {
    name: 'restart',
    description: 'stop and relaunch the agent container (host stage)',
  },
  args: {
    port: {
      type: 'string',
      description:
        'preferred host port; if it is already bound, typeclaw allocates a free ephemeral port and reports it',
      default: String(config.port),
    },
    build: {
      type: 'boolean',
      description: 'regenerate the Dockerfile from the latest template and rebuild the image',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first.'))
      process.exit(1)
    }

    const validated = validateConfig(cwd)
    if (!validated.ok) {
      console.error(errorLine(validated.reason))
      process.exit(1)
    }

    const stopSpin = spinner()
    stopSpin.start('Stopping container...')
    const stopped = await stop({ cwd })
    if (!stopped.ok) {
      stopSpin.error(stopped.reason)
      process.exit(1)
    }
    stopSpin.stop(stopped.running ? `Stopped ${c.cyan(stopped.containerName)}.` : 'Already stopped.')

    const startSpin = spinner()
    startSpin.start('Starting container...')
    const started = await start({
      cwd,
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
    })
    if (!started.ok) {
      startSpin.error(started.reason)
      process.exit(1)
    }
    startSpin.stop('Started.')

    console.log(renderStartSuccess(started))
  },
})
