import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { configSchema } from '@/config/config'

describe('config json schema', () => {
  test('toJSONSchema produces a draft 2020-12 object schema', () => {
    const schema = z.toJSONSchema(configSchema, { io: 'input', reused: 'inline' }) as Record<string, unknown>

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.type).toBe('object')

    const properties = schema.properties as Record<string, unknown>
    expect(properties.name).toBeDefined()
    expect(properties.model).toBeDefined()
    expect(properties.port).toBeDefined()
  })

  test('fields with defaults are not required in the input schema', () => {
    const schema = z.toJSONSchema(configSchema, { io: 'input', reused: 'inline' }) as {
      required: string[]
    }

    expect(schema.required).toContain('name')
    expect(schema.required).not.toContain('port')
    expect(schema.required).not.toContain('model')
  })
})
