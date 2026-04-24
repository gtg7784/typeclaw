#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { downCommand } from './down'
import { init } from './init'
import { reload } from './reload'
import { run } from './run'
import { tui } from './tui'
import { upCommand } from './up'

const main = defineCommand({
  meta: {
    name: 'typeclaw',
    description: 'TypeClaw agent runtime',
  },
  // TODO: `up` currently launches a Docker container. Add launchctl support
  // for macOS services per TypeClaw.md Phase 3.
  subCommands: { init, run, tui, up: upCommand, down: downCommand, reload },
})

runMain(main)
