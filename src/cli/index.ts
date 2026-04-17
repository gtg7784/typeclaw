#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { init } from './init'
import { tui } from './tui'
import { up } from './up'

const main = defineCommand({
  meta: {
    name: 'typeclaw',
    description: 'TypeClaw agent runtime',
  },
  subCommands: { init, up, tui },
})

runMain(main)
