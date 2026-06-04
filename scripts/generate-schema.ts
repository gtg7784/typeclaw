#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { configSchema as coreConfigSchema } from '../src/config/config'
import { cronFileSchema } from '../src/cron/schema'
import { buildConfigSchemaWithBundledPlugins } from '../src/run/schema-with-plugins'
import { secretsFileSchema } from '../src/secrets/schema'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// auth.schema.json is the permanent compatibility alias for secrets.schema.json.
// Old agent folders may still carry an `auth.json`, or a `secrets.json` whose
// `$schema` still points at the pre-rename URL; the alias lets those resolve in
// editors. It is tiny and re-emitting it has no maintenance cost, so we keep it
// indefinitely rather than rewriting `$schema` in every old agent folder.
const targets: Array<{ path: string; schema: z.ZodType }> = [
  { path: join(repoRoot, 'typeclaw.schema.json'), schema: buildConfigSchemaWithBundledPlugins(coreConfigSchema) },
  { path: join(repoRoot, 'cron.schema.json'), schema: cronFileSchema },
  { path: join(repoRoot, 'secrets.schema.json'), schema: secretsFileSchema },
  { path: join(repoRoot, 'auth.schema.json'), schema: secretsFileSchema },
]

for (const { path, schema } of targets) {
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' })
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`Wrote ${path}`)
}
