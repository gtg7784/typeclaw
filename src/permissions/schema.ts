import { z } from 'zod'

import { isBuiltinRoleName } from './builtins'
import { type MatchRule, MATCH_RULE_REGEX_SOURCE, parseMatchRule } from './match-rule'

// The `.regex()` is added so the generated JSON Schema emits a `pattern`
// for editor-time validation (catches typos like `tem:T0123` before the
// agent ever boots). The pattern is intentionally a permissive
// over-approximation of what `parseMatchRule` accepts; the parser owns
// the precise semantic errors (typo suggestions, redundant-form rejection,
// etc.) at boot time. Layering the two means editors flag obvious shape
// mistakes immediately and the parser flags the rest with actionable
// messages.
const matchRuleSchema: z.ZodType<MatchRule> = z
  .string()
  .regex(new RegExp(MATCH_RULE_REGEX_SOURCE), {
    message: "match rule must look like 'tui' / 'slack:T0123' / 'discord:9999 author:U_X'",
  })
  .transform((raw, ctx) => {
    const parsed = parseMatchRule(raw)
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.error })
      return z.NEVER
    }
    return parsed.value
  })

export const MATCH_RULE_JSON_SCHEMA_PATTERN = MATCH_RULE_REGEX_SOURCE

const PERMISSION_NAME = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

const permissionSchema = z.string().min(1).regex(PERMISSION_NAME, {
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
