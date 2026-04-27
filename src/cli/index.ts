#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { init } from './init'
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
  // TODO: `start` currently launches a Docker container. Add launchctl support
  // for macOS services per TypeClaw.md Phase 3.
  subCommands: { init, run, tui, start: startCommand, stop: stopCommand, restart: restartCommand, reload },
})

runMain(main)
