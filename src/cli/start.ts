import { defineCommand } from 'citty'

import { config, loadConfigSync } from '@/config'
import { start } from '@/container'
import { findAgentDir, isInitialized } from '@/init'

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

    if (!isInitialized(cwd)) {
      console.error('TypeClaw config file not found. Run `typeclaw init` first.')
      process.exit(1)
    }

    const cfg = loadConfigSync(cwd)
    const result = await start({
      cwd,
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      autoForward: cfg.autoForward,
      autoForwardExclude: cfg.autoForwardExclude,
    })
    if (!result.ok) {
      console.error(result.reason)
      process.exit(1)
    }

    if (result.built) {
      console.log(`Built image ${result.plan.imageTag}.`)
    }
    console.log(
      `Container ${result.plan.containerName} started on host port ${result.hostPort} (${result.containerId.slice(0, 12)}).`,
    )
    if (result.broker.state === 'registered') {
      console.log(`Port broker active; any port the agent binds is reachable on localhost.`)
    } else if (result.broker.state === 'unavailable') {
      console.warn(`Port broker unavailable: ${result.broker.reason}`)
    }
    console.log(`Follow logs:  typeclaw log -f`)
    console.log(`Attach TUI:   typeclaw tui`)
    console.log(`Stop:         typeclaw stop`)
  },
})
