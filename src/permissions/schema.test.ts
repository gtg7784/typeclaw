import { describe, expect, test } from 'bun:test'

import { rolesConfigSchema } from './schema'

describe('rolesConfigSchema', () => {
  test('accepts a built-in role with just match[]', () => {
    const result = rolesConfigSchema.safeParse({
      trusted: { match: ['slack:T0123 author:U_ME'] },
    })
    expect(result.success).toBe(true)
  })

  test('rejects malformed match rule with a precise error', () => {
    const result = rolesConfigSchema.safeParse({
      trusted: { match: ['slack:T0123 autor:U_ME'] },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toMatch(/Did you mean 'author:'/)
  })

  test('rejects unknown role-name shape', () => {
    const result = rolesConfigSchema.safeParse({
      'Bad Name': { match: ['slack:T0123'], permissions: [] },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toMatch(/role name/)
  })

  test('rejects custom role missing permissions', () => {
    const result = rolesConfigSchema.safeParse({
      partner: { match: ['slack:T0123 author:U_PARTNER'] },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toMatch(/must declare 'permissions'/)
  })

  test('rejects custom role missing match', () => {
    const result = rolesConfigSchema.safeParse({
      partner: { permissions: ['channel.respond'] },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toMatch(/must declare at least one 'match' rule/)
  })

  test('accepts custom role with both match and permissions', () => {
    const result = rolesConfigSchema.safeParse({
      partner: { match: ['slack:T0123 author:U_PARTNER'], permissions: ['channel.respond', 'cron.schedule'] },
    })
    expect(result.success).toBe(true)
  })

  test('rejects malformed permission string', () => {
    const result = rolesConfigSchema.safeParse({
      partner: { match: ['slack:T0123'], permissions: ['NotADottedString'] },
    })
    expect(result.success).toBe(false)
  })

  test('rejects unknown keys in role config (strict mode)', () => {
    const result = rolesConfigSchema.safeParse({
      trusted: { match: ['slack:T0123'], unknown: 'oops' },
    })
    expect(result.success).toBe(false)
  })
})
