import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'

import { config, validateConfig } from '@/config'
import { start, stop } from '@/container'
import { findAgentDir, isInitialized } from '@/init'

import { preflightDocker, printDockerGuidance } from './docker-preflight'
import { guardIncompleteInit } from './incomplete-init'
import { c, errorLine, renderStartSuccess, reportConfigWarnings, spinner } from './ui'

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

    // Runs before BOTH isInitialized and stop. A wizard abort persists a
    // checkpoint before scaffold writes typeclaw.json, so a checkpoint-but-no-
    // config dir is an incomplete init that should get resume guidance, not the
    // generic config-missing error — and a half-init agent usually has no
    // container to stop. A `continue` falls through to isInitialized, which
    // still catches a truly uninitialized dir.
    const guard = await guardIncompleteInit({
      cwd,
      interactive: Boolean(process.stdout.isTTY),
      confirmContinue: async () => {
        const proceed = await confirm({ message: 'Try restarting anyway?', initialValue: false })
        return !isCancel(proceed) && proceed === true
      },
    })
    if (guard.action === 'block') {
      console.error(errorLine(guard.message))
      process.exit(1)
    }
    if (guard.action === 'abort') {
      process.exit(0)
    }

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first.'))
      process.exit(1)
    }

    const validated = validateConfig(cwd)
    if (!validated.ok) {
      console.error(errorLine(validated.reason))
      process.exit(1)
    }
    reportConfigWarnings(validated.warnings)

    const preflight = await preflightDocker()
    if (!preflight.ok) {
      printDockerGuidance(preflight)
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

    reportConfigWarnings(started.dockerfileWarnings)
    console.log(renderStartSuccess(started))
  },
})
