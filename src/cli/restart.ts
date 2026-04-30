import { defineCommand } from 'citty'

import { config, loadConfigSync, validateConfig } from '@/config'
import { start, stop } from '@/container'
import { findAgentDir, isInitialized } from '@/init'

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
      console.error('TypeClaw config file not found. Run `typeclaw init` first.')
      process.exit(1)
    }

    const validated = validateConfig(cwd)
    if (!validated.ok) {
      console.error(validated.reason)
      process.exit(1)
    }

    const stopped = await stop({ cwd })
    if (!stopped.ok) {
      console.error(stopped.reason)
      process.exit(1)
    }
    if (stopped.running) {
      console.log(`Stopped ${stopped.containerName}.`)
    }

    const cfg = loadConfigSync(cwd)
    const started = await start({
      cwd,
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      autoForward: cfg.autoForward,
      autoForwardExclude: cfg.autoForwardExclude,
    })
    if (!started.ok) {
      console.error(started.reason)
      process.exit(1)
    }

    if (started.built) {
      console.log(`Built image ${started.plan.imageTag}.`)
    }
    console.log(
      `Container ${started.plan.containerName} started on host port ${started.hostPort} (${started.containerId.slice(0, 12)}).`,
    )
    if (started.broker.state === 'registered') {
      console.log(`Port broker active; any port the agent binds is reachable on localhost.`)
    } else if (started.broker.state === 'unavailable') {
      console.warn(`Port broker unavailable: ${started.broker.reason}`)
    }
    console.log(`Follow logs:  typeclaw logs -f`)
    console.log(`Attach TUI:   typeclaw tui`)
    console.log(`Stop:         typeclaw stop`)
  },
})
