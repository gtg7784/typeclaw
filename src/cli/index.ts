#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { channelCommand } from './channel'
import { composeCommand } from './compose'
import { hostdCommand } from './hostd'
import { init } from './init'
import { logsCommand } from './logs'
import { reload } from './reload'
import { restartCommand } from './restart'
import { run } from './run'
import { shellCommand } from './shell'
import { startCommand } from './start'
import { statusCommand } from './status'
import { stopCommand } from './stop'
import { tui } from './tui'

const main = defineCommand({
  meta: {
    name: 'typeclaw',
    description: 'TypeClaw agent runtime',
  },
  subCommands: {
    init,
    run,
    tui,
    start: startCommand,
    stop: stopCommand,
    restart: restartCommand,
    status: statusCommand,
    reload,
    logs: logsCommand,
    shell: shellCommand,
    compose: composeCommand,
    channel: channelCommand,
    _hostd: hostdCommand,
  },
})

runMain(main)
