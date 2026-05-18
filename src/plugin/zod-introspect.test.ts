import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { coerceFlag, describeLeaf, isPrimitiveZodObject } from './zod-introspect'

describe('describeLeaf', () => {
  test('classifies bare primitives', () => {
    expect(describeLeaf(z.string()).kind).toBe('string')
    expect(describeLeaf(z.number()).kind).toBe('number')
    expect(describeLeaf(z.boolean()).kind).toBe('boolean')
  })

  test('classifies enum and literal as string', () => {
    expect(describeLeaf(z.enum(['a', 'b'])).kind).toBe('string')
    expect(describeLeaf(z.literal('x')).kind).toBe('string')
  })

  test('classifies unsupported leaves as unknown', () => {
    expect(describeLeaf(z.array(z.string())).kind).toBe('unknown')
    expect(describeLeaf(z.object({})).kind).toBe('unknown')
    expect(describeLeaf(z.tuple([z.string()])).kind).toBe('unknown')
  })

  test('unwraps optional and marks required=false', () => {
    const d = describeLeaf(z.string().optional())
    expect(d.kind).toBe('string')
    expect(d.required).toBe(false)
  })

  test('unwraps default and reports the default value as JSON', () => {
    const d = describeLeaf(z.number().default(7))
    expect(d.kind).toBe('number')
    expect(d.required).toBe(false)
    expect(d.defaultValue).toBe('7')
  })

  test('unwraps nullable', () => {
    const d = describeLeaf(z.string().nullable())
    expect(d.kind).toBe('string')
    expect(d.required).toBe(true)
  })

  test('unwraps nested wrappers: optional + default', () => {
    const d = describeLeaf(z.string().optional().default('hi'))
    expect(d.kind).toBe('string')
    expect(d.required).toBe(false)
    expect(d.defaultValue).toBe('"hi"')
  })

  test('unwraps nested wrappers: nullable + optional', () => {
    const d = describeLeaf(z.string().nullable().optional())
    expect(d.kind).toBe('string')
    expect(d.required).toBe(false)
  })

  test('captures description from .describe()', () => {
    const d = describeLeaf(z.string().describe('a name'))
    expect(d.description).toBe('a name')
  })

  test('captures description through wrappers', () => {
    const d = describeLeaf(z.string().describe('inner').optional())
    expect(d.description).toBe('inner')
  })

  test('returns sensible defaults for non-Zod inputs', () => {
    expect(describeLeaf(undefined).kind).toBe('unknown')
    expect(describeLeaf(null).kind).toBe('unknown')
    expect(describeLeaf({}).kind).toBe('unknown')
  })
})

describe('coerceFlag', () => {
  test('boolean: true / "true" / "false"', () => {
    expect(coerceFlag(z.boolean(), true, 'k')).toBe(true)
    expect(coerceFlag(z.boolean(), 'true', 'k')).toBe(true)
    expect(coerceFlag(z.boolean(), 'false', 'k')).toBe(false)
  })

  test('boolean: rejects other strings', () => {
    expect(() => coerceFlag(z.boolean(), 'maybe', 'loud')).toThrow(/--loud: expected true\/false/)
  })

  test('number: parses positive and negative', () => {
    expect(coerceFlag(z.number(), '3', 'k')).toBe(3)
    expect(coerceFlag(z.number(), '-2', 'k')).toBe(-2)
  })

  test('number: rejects empty string (would silently become 0)', () => {
    expect(() => coerceFlag(z.number(), '', 'count')).toThrow(/--count: empty value/)
  })

  test('number: rejects NaN', () => {
    expect(() => coerceFlag(z.number(), 'abc', 'n')).toThrow(/not a number/)
  })

  test('number: rejects bare flag (no value)', () => {
    expect(() => coerceFlag(z.number(), true, 'count')).toThrow(/requires a numeric value/)
  })

  test('string: bare flag is rejected (no value supplied)', () => {
    expect(() => coerceFlag(z.string(), true, 'name')).toThrow(/--name requires a value/)
  })

  test('string: empty string is accepted (Zod schema enforces non-empty if it wants)', () => {
    expect(coerceFlag(z.string(), '', 'k')).toBe('')
  })

  test('unwraps default before classifying', () => {
    expect(coerceFlag(z.number().default(0), '7', 'k')).toBe(7)
  })
})

describe('isPrimitiveZodObject', () => {
  test('accepts z.object with primitive leaves', () => {
    expect(isPrimitiveZodObject(z.object({ name: z.string(), count: z.number() }))).toBe(true)
  })

  test('accepts wrapped primitives', () => {
    expect(
      isPrimitiveZodObject(
        z.object({
          name: z.string().describe('n').optional(),
          loud: z.boolean().default(false),
          maybe: z.string().nullable(),
        }),
      ),
    ).toBe(true)
  })

  test('rejects non-object schemas', () => {
    expect(isPrimitiveZodObject(z.string())).toBe(false)
    expect(isPrimitiveZodObject(z.array(z.string()))).toBe(false)
    expect(isPrimitiveZodObject(undefined)).toBe(false)
    expect(isPrimitiveZodObject(null)).toBe(false)
  })

  test('rejects z.object with nested object leaf', () => {
    expect(isPrimitiveZodObject(z.object({ inner: z.object({ x: z.string() }) }))).toBe(false)
  })

  test('rejects z.object with array leaf', () => {
    expect(isPrimitiveZodObject(z.object({ tags: z.array(z.string()) }))).toBe(false)
  })
})
