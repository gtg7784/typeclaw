#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { hostdCommand } from './hostd'
import { init } from './init'
import { logsCommand } from './logs'
import { reload } from './reload'
import { restartCommand } from './restart'
import { run } from './run'
import { shellCommand } from './shell'
import { startCommand } from './start'
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
    reload,
    logs: logsCommand,
    shell: shellCommand,
    _hostd: hostdCommand,
  },
})

runMain(main)
