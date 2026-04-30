#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { init } from './init'
import { logCommand } from './log'
import { portbrokerdCommand } from './portbrokerd'
import { reload } from './reload'
import { restartCommand } from './restart'
import { run } from './run'
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
    log: logCommand,
    _portbrokerd: portbrokerdCommand,
  },
})

runMain(main)
