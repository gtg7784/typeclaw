import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { configSchema } from '@/config/config'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('typeclaw.schema.json', () => {
  test('checked-in typeclaw.schema.json matches the current configSchema (drift guard)', async () => {
    // If this test fails, someone edited `configSchema` without regenerating
    // typeclaw.schema.json. Run `bun run generate:schema` and commit the result.
    const checkedIn = JSON.parse(await readFile(join(repoRoot, 'typeclaw.schema.json'), 'utf8'))
    const generated = z.toJSONSchema(configSchema, { io: 'input', reused: 'inline' })

    expect(checkedIn).toEqual(generated)
  })
})
