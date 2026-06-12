import { afterEach, beforeEach, describe, it, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentUsesVector, vectorConfigSchema } from './config'

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

describe('agentUsesVector', () => {
  let dir: string

  async function writeConfig(value: unknown): Promise<void> {
    await writeFile(join(dir, 'typeclaw.json'), JSON.stringify(value))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-vector-config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns true when memory.vector.enabled is true', async () => {
    await writeConfig({ memory: { vector: { enabled: true } } })
    expect(agentUsesVector(dir)).toBe(true)
  })

  it('returns false when memory.vector.enabled is false', async () => {
    await writeConfig({ memory: { vector: { enabled: false } } })
    expect(agentUsesVector(dir)).toBe(false)
  })

  it('returns false when the memory.vector block is absent', async () => {
    await writeConfig({ memory: {} })
    expect(agentUsesVector(dir)).toBe(false)
  })

  it('returns false when the memory block is absent', async () => {
    await writeConfig({ models: { default: 'x' } })
    expect(agentUsesVector(dir)).toBe(false)
  })

  it('fails closed to false when typeclaw.json is missing', () => {
    expect(agentUsesVector(dir)).toBe(false)
  })

  it('fails closed to false when typeclaw.json is malformed JSON', async () => {
    await writeFile(join(dir, 'typeclaw.json'), '{ not json')
    expect(agentUsesVector(dir)).toBe(false)
  })

  it('fails closed to false when memory.vector.enabled has a non-boolean type', async () => {
    await writeConfig({ memory: { vector: { enabled: 'yes' } } })
    expect(agentUsesVector(dir)).toBe(false)
  })
})
