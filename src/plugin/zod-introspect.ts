import { z } from 'zod'

export type LeafKind = 'string' | 'number' | 'boolean' | 'unknown'

export type LeafDescription = {
  kind: LeafKind
  required: boolean
  defaultValue: string | undefined
  description: string | undefined
}

// Walks the chain of Zod 4 wrappers (optional, default, nullable) and returns
// the inner-most leaf node. Reads `_def.type` (Zod 4's lowercase discriminator)
// directly because the public `instanceof ZodOptional` checks don't work for
// `.innerType` — Zod 4 types it as the base `$ZodType`, not the public class
// hierarchy. If Zod ships a breaking change to `_def.type`, this is the only
// file that needs to update.
export function describeLeaf(leaf: unknown): LeafDescription {
  let cur: unknown = leaf
  let required = true
  let defaultValue: string | undefined
  let description: string | undefined

  while (cur !== null && typeof cur === 'object') {
    const node = cur as {
      _def?: { type?: string; innerType?: unknown; defaultValue?: unknown }
      description?: string
    }
    if (typeof node.description === 'string') description = node.description
    const def = node._def
    if (def === undefined) break
    if (def.type === 'optional') {
      required = false
      cur = def.innerType
      continue
    }
    if (def.type === 'default') {
      required = false
      const raw = typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : def.defaultValue
      defaultValue = raw === undefined ? undefined : JSON.stringify(raw)
      cur = def.innerType
      continue
    }
    if (def.type === 'nullable') {
      cur = def.innerType
      continue
    }
    return { kind: classify(def.type), required, defaultValue, description }
  }
  return { kind: 'unknown', required, defaultValue, description }
}

function classify(t: string | undefined): LeafKind {
  switch (t) {
    case 'string':
    case 'literal':
    case 'enum':
      return 'string'
    case 'number':
    case 'int':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'unknown'
  }
}

// Coerces a single CLI flag value (string from argv or `true` when bare) to the
// type the leaf expects. Throws a precise error referencing the flag key when
// coercion fails; the caller surfaces the message to stderr.
export function coerceFlag(leaf: unknown, raw: string | true, key: string): unknown {
  const info = describeLeaf(leaf)
  if (info.kind === 'boolean') {
    if (raw === true || raw === 'true') return true
    if (raw === 'false') return false
    throw new Error(`--${key}: expected true/false, got "${raw}"`)
  }
  if (info.kind === 'number') {
    if (raw === true) throw new Error(`--${key} requires a numeric value`)
    if (raw === '') throw new Error(`--${key}: empty value rejected; pass a number`)
    const n = Number(raw)
    if (Number.isNaN(n)) throw new Error(`--${key}: not a number: "${raw}"`)
    return n
  }
  if (raw === true) throw new Error(`--${key} requires a value`)
  return raw
}

// Returns true when `schema` is a Zod 4 z.object whose leaf properties are all
// primitive-shaped (string/number/boolean, with optional/default/nullable
// wrappers). Plugin command args schemas MUST satisfy this in v1.
export function isPrimitiveZodObject(schema: unknown): schema is z.ZodObject<z.ZodRawShape> {
  if (!(schema instanceof z.ZodObject)) return false
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, unknown>
  for (const leaf of Object.values(shape)) {
    if (describeLeaf(leaf).kind === 'unknown') return false
  }
  return true
}
