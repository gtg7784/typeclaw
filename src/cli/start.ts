import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'

import { config, validateConfig } from '@/config'
import { resolveController } from '@/container'
import { findAgentDir, isInitialized } from '@/init'

import { preflightDocker, printDockerGuidance } from './docker-preflight'
import { guardIncompleteInit } from './incomplete-init'
import { errorLine, renderStartSuccess, reportConfigWarnings, spinner } from './ui'

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'launch the agent container in the background (host stage)',
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

    // Runs BEFORE the isInitialized check: a wizard abort persists a checkpoint
    // before scaffold writes typeclaw.json, so a checkpoint-but-no-config dir is
    // an incomplete init, not a "never initialized" one. Guarding first means
    // that case gets the resume guidance instead of the generic config-missing
    // error. A `continue` (no incomplete checkpoint, or "try anyway") falls
    // through to isInitialized, which still catches a truly uninitialized dir.
    const guard = await guardIncompleteInit({
      cwd,
      interactive: Boolean(process.stdout.isTTY),
      confirmContinue: async () => {
        const proceed = await confirm({ message: 'Try starting anyway?', initialValue: false })
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

    const s = spinner()
    s.start('Starting container...')
    const result = await resolveController().start({
      cwd,
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
    })
    if (!result.ok) {
      s.error(result.reason)
      process.exit(1)
    }
    s.stop(result.alreadyRunning ? 'Already running.' : 'Started.')

    reportConfigWarnings(result.dockerfileWarnings)
    console.log(renderStartSuccess(result))
  },
})
