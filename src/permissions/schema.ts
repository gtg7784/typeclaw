import { z } from 'zod'

import { isBuiltinRoleName } from './builtins'
import { type MatchRule, MATCH_RULE_REGEX_SOURCE, parseMatchRule } from './match-rule'

const matchRuleSchema: z.ZodType<MatchRule> = z.string().transform((raw, ctx) => {
  const parsed = parseMatchRule(raw)
  if (!parsed.ok) {
    ctx.addIssue({ code: 'custom', message: parsed.error })
    return z.NEVER
  }
  return parsed.value
})

export const MATCH_RULE_JSON_SCHEMA_PATTERN = MATCH_RULE_REGEX_SOURCE

const PERMISSION_NAME = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

const permissionSchema = z
  .string()
  .min(1)
  .refine((s) => PERMISSION_NAME.test(s), {
    message: "permission must be lowercase dotted form like 'cron.schedule' or 'security.bypass.foo'",
  })

const roleConfigSchema = z
  .object({
    match: z.array(matchRuleSchema).default([]),
    permissions: z.array(permissionSchema).optional(),
  })
  .strict()

export type RoleConfig = z.infer<typeof roleConfigSchema>

export const rolesConfigSchema = z.record(z.string(), roleConfigSchema).superRefine((roles, ctx) => {
  for (const [name, role] of Object.entries(roles)) {
    if (!isValidRoleName(name)) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `role name '${name}' must match /^[a-z][a-z0-9-]*$/`,
      })
      continue
    }
    if (!isBuiltinRoleName(name)) {
      if (role.permissions === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [name, 'permissions'],
          message: `custom role '${name}' must declare 'permissions' (built-in defaults apply only to built-in role names)`,
        })
      }
      if (role.match.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: [name, 'match'],
          message: `custom role '${name}' must declare at least one 'match' rule`,
        })
      }
    }
  }
})

export type RolesConfig = z.infer<typeof rolesConfigSchema>

const ROLE_NAME = /^[a-z][a-z0-9-]*$/
function isValidRoleName(name: string): boolean {
  return ROLE_NAME.test(name)
}
