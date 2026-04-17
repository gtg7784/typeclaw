#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { configSchema } from '../src/config/config'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = join(repoRoot, 'config.schema.json')

const schema = z.toJSONSchema(configSchema, { io: 'input', reused: 'inline' })
await writeFile(outPath, `${JSON.stringify(schema, null, 2)}\n`)

console.log(`Wrote ${outPath}`)
