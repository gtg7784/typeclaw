#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { init } from './init'
import { run } from './run'
import { tui } from './tui'

const main = defineCommand({
  meta: {
    name: 'typeclaw',
    description: 'TypeClaw agent runtime',
  },
  // TODO: add `up` (host stage) and `down` commands. `up` will launch the
  // container (docker run) or service (launchctl load) per config, then keep
  // foreground logs attached. `run` is invoked inside that container/service.
  subCommands: { init, run, tui },
})

runMain(main)
