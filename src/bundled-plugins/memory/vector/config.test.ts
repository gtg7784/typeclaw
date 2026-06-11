import { describe, it, expect } from 'bun:test'

import { vectorConfigSchema } from './config'

describe('vectorConfigSchema', () => {
  it('QA 1.1: no memory.vector block → enabled === false', () => {
    // Given: empty object (no vector config provided)
    const input = {}

    // When: parsing with the schema
    const result = vectorConfigSchema.parse(input)

    // Then: enabled defaults to false
    expect(result.enabled).toBe(false)
  })

  it('QA 1.2: memory.vector.enabled: true → enabled === true', () => {
    // Given: explicit enabled: true
    const input = { enabled: true }

    // When: parsing with the schema
    const result = vectorConfigSchema.parse(input)

    // Then: enabled is true
    expect(result.enabled).toBe(true)
  })
})
