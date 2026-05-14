export {
  BUILTIN_ROLE_NAMES,
  BUILTIN_ROLES,
  CORE_PERMISSIONS,
  OWNER_SECURITY_WILDCARD,
  expandOwnerWildcard,
  isBuiltinRoleName,
  type BuiltinRoleName,
  type BuiltinRoleSpec,
} from './builtins'
export {
  MATCH_RULE_REGEX_SOURCE,
  PLATFORMS,
  parseMatchRule,
  type MatchRule,
  type ParseMatchRuleResult,
  type Platform,
} from './match-rule'
export {
  createPermissionService,
  noopPermissionService,
  type CreatePermissionServiceOptions,
  type PermissionService,
} from './permissions'
export { matchesOrigin, type MatchableOrigin } from './resolve'
export { MATCH_RULE_JSON_SCHEMA_PATTERN, rolesConfigSchema, type RoleConfig, type RolesConfig } from './schema'
