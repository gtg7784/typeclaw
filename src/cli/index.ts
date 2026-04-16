#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { tui } from './tui'
import { up } from './up'

const main = defineCommand({
  meta: {
    name: 'typeclaw',
    description: 'TypeClaw agent runtime',
  },
  subCommands: { up, tui },
})

runMain(main)
