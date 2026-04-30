#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { configSchema as coreConfigSchema } from '../src/config/config'
import { cronFileSchema } from '../src/cron/schema'
import { buildConfigSchemaWithBundledPlugins } from '../src/run/schema-with-plugins'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const targets: Array<{ path: string; schema: z.ZodType }> = [
  { path: join(repoRoot, 'typeclaw.schema.json'), schema: buildConfigSchemaWithBundledPlugins(coreConfigSchema) },
  { path: join(repoRoot, 'cron.schema.json'), schema: cronFileSchema },
]

for (const { path, schema } of targets) {
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' })
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`Wrote ${path}`)
}
