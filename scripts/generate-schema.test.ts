import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { configSchema } from '@/config/config'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('config.schema.json', () => {
  test('checked-in config.schema.json matches the current configSchema (drift guard)', async () => {
    // If this test fails, someone edited `configSchema` without regenerating
    // config.schema.json. Run `bun run generate:schema` and commit the result.
    const checkedIn = JSON.parse(await readFile(join(repoRoot, 'config.schema.json'), 'utf8'))
    const generated = z.toJSONSchema(configSchema, { io: 'input', reused: 'inline' })

    expect(checkedIn).toEqual(generated)
  })
})
