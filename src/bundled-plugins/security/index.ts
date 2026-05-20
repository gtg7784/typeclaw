import { definePlugin } from '@/plugin'

import { HIGH_TIER_PER_GUARD_PERMISSIONS, SECURITY_PERMISSIONS, SEVERITY_PERMISSION } from './permissions'
import type { SecurityPermission, SecuritySeverity } from './permissions'
import {
  GUARD_GIT_EXFIL_SEVERITY,
  GUARD_GIT_REMOTE_TAINTED_SEVERITY,
  checkGitExfilGuard,
  checkGitRemoteTaintedGuard,
  recordGitRemoteTaintIfAny,
} from './policies/git-exfil'
import { GUARD_OUTBOUND_SECRET_SEVERITY, checkOutboundSecretGuard } from './policies/outbound-secret-scan'
import { applyPromptInjectionDefense } from './policies/prompt-injection'
import { clearSessionTaints } from './policies/remote-taint-state'
import { GUARD_SECRET_EXFIL_BASH_SEVERITY, checkSecretExfilBashGuard } from './policies/secret-exfil-bash'
import { GUARD_SECRET_EXFIL_READ_SEVERITY, checkSecretExfilReadGuard } from './policies/secret-exfil-read'
import {
  GUARD_SESSION_SEARCH_SECRETS_SEVERITY,
  checkSessionSearchSecretsGuard,
} from './policies/session-search-secrets'
import { GUARD_SSRF_SEVERITY, checkSsrfGuard } from './policies/ssrf'
import { GUARD_SYSTEM_PROMPT_LEAK_SEVERITY, checkSystemPromptLeakGuard } from './policies/system-prompt-leak'
import type { SecurityBlock } from './policy'

export {
  HIGH_TIER_PER_GUARD_PERMISSIONS,
  SECURITY_PERMISSIONS,
  type SecurityPermission,
  type SecuritySeverity,
  SEVERITY_PERMISSION,
} from './permissions'

// Per-guard permission strings only — tier strings are deliberately
// absent. Block messages name the per-guard permission AND the tier
// permission separately (see withPermissionHint); the per-guard hint
// table answers "which roles carry THIS specific bypass by default."
type PerGuardSecurityPermission = Exclude<
  SecurityPermission,
  | typeof SECURITY_PERMISSIONS.bypassLow
  | typeof SECURITY_PERMISSIONS.bypassMedium
  | typeof SECURITY_PERMISSIONS.bypassHigh
>

// The satisfies clause forces exhaustive coverage of per-guard
// permissions at compile time — adding a new SECURITY_PERMISSIONS entry
// (other than a new tier string) without a hint here is a type error,
// not a silent fallback.
const BYPASS_ROLE_HINT = {
  [SECURITY_PERMISSIONS.bypassSecretExfilBash]:
    'only owner has it by default (medium tier; trusted does NOT carry this — operators can grant `security.bypass.secretExfilBash` explicitly in roles.trusted.permissions[] if they want the pre-PR ergonomics back)',
  [SECURITY_PERMISSIONS.bypassGitExfil]:
    'NOBODY has it by default — high tier requires per-call ack from every role, including owner. Operators can grant `security.bypass.gitExfil` explicitly in roles.<role>.permissions[] to re-open the auto-bypass for one role.',
  [SECURITY_PERMISSIONS.bypassGitRemoteTainted]:
    'NOBODY has it by default — high tier requires per-call ack from every role. Even an operator-granted `security.bypass.gitExfil` does NOT bypass this second-step taint check (the recorder still fires for the first step, so the push is still gated).',
  [SECURITY_PERMISSIONS.bypassSecretExfilRead]: 'only owner has it by default (medium tier)',
  [SECURITY_PERMISSIONS.bypassSsrf]: 'only owner has it by default (medium tier)',
  [SECURITY_PERMISSIONS.bypassSessionSearchSecrets]: 'only owner has it by default (medium tier)',
  [SECURITY_PERMISSIONS.bypassSystemPromptLeak]:
    'NOBODY has it by default — high tier requires per-call ack from every role, including owner.',
  [SECURITY_PERMISSIONS.bypassOutboundSecret]:
    'NOBODY has it by default — high tier requires per-call ack from every role, including owner. The audience-leak rule: even owner posting to a public channel must not silently include credentials.',
} as const satisfies Record<PerGuardSecurityPermission, string>

function withPermissionHint(
  result: SecurityBlock | undefined,
  permission: PerGuardSecurityPermission,
  severity: SecuritySeverity,
): SecurityBlock | undefined {
  if (!result) return result
  const perGuardHint = BYPASS_ROLE_HINT[permission]
  const tierPerm = SEVERITY_PERMISSION[severity]
  return {
    block: true,
    reason: `${result.reason} Or run as a role carrying \`${permission}\` (${perGuardHint}) or the tier permission \`${tierPerm}\`; see the \`typeclaw-permissions\` skill.`,
  }
}

export default definePlugin({
  permissions: Object.values(SECURITY_PERMISSIONS),
  // High-tier per-guard strings AND the `security.bypass.high` tier
  // string itself are excluded from the owner-wildcard expansion. Owner
  // still has the wildcard sentinel (so future low/medium plugin-
  // contributed bypasses keep auto-flowing to owner), but audience-leak
  // guards require either per-call ack or an explicit operator grant.
  ownerWildcardExclusions: [...HIGH_TIER_PER_GUARD_PERMISSIONS, SECURITY_PERMISSIONS.bypassHigh],
  plugin: async (ctx) => ({
    hooks: {
      'session.prompt': async (event) => {
        applyPromptInjectionDefense(event)
      },
      'tool.before': async (event) => {
        const can = (perm: string) => ctx.permissions.has(event.origin, perm)
        const canBypass = (severity: SecuritySeverity, perGuardPerm: string): boolean =>
          can(SEVERITY_PERMISSION[severity]) || can(perGuardPerm)

        // Taint-recording runs FIRST, independently of the gitExfil guard.
        // The gitRemoteTainted defense depends on it. We pass through
        // `permittedBypass` for actors who can skip gitExfil (via either the
        // per-guard permission or the medium-tier permission) so the
        // recorder still fires for them — an acked or permission-bypassed
        // command will actually run, so its remote change must be remembered.
        recordGitRemoteTaintIfAny({
          tool: event.tool,
          args: event.args,
          sessionId: event.sessionId,
          permittedBypass: canBypass(GUARD_GIT_EXFIL_SEVERITY, SECURITY_PERMISSIONS.bypassGitExfil),
        })

        const checks: (SecurityBlock | undefined)[] = [
          canBypass(GUARD_GIT_REMOTE_TAINTED_SEVERITY, SECURITY_PERMISSIONS.bypassGitRemoteTainted)
            ? undefined
            : withPermissionHint(
                checkGitRemoteTaintedGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
                SECURITY_PERMISSIONS.bypassGitRemoteTainted,
                GUARD_GIT_REMOTE_TAINTED_SEVERITY,
              ),
          canBypass(GUARD_SECRET_EXFIL_BASH_SEVERITY, SECURITY_PERMISSIONS.bypassSecretExfilBash)
            ? undefined
            : withPermissionHint(
                checkSecretExfilBashGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSecretExfilBash,
                GUARD_SECRET_EXFIL_BASH_SEVERITY,
              ),
          canBypass(GUARD_GIT_EXFIL_SEVERITY, SECURITY_PERMISSIONS.bypassGitExfil)
            ? undefined
            : withPermissionHint(
                checkGitExfilGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
                SECURITY_PERMISSIONS.bypassGitExfil,
                GUARD_GIT_EXFIL_SEVERITY,
              ),
          canBypass(GUARD_SECRET_EXFIL_READ_SEVERITY, SECURITY_PERMISSIONS.bypassSecretExfilRead)
            ? undefined
            : withPermissionHint(
                checkSecretExfilReadGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSecretExfilRead,
                GUARD_SECRET_EXFIL_READ_SEVERITY,
              ),
          canBypass(GUARD_SSRF_SEVERITY, SECURITY_PERMISSIONS.bypassSsrf)
            ? undefined
            : withPermissionHint(
                checkSsrfGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSsrf,
                GUARD_SSRF_SEVERITY,
              ),
          canBypass(GUARD_SESSION_SEARCH_SECRETS_SEVERITY, SECURITY_PERMISSIONS.bypassSessionSearchSecrets)
            ? undefined
            : withPermissionHint(
                checkSessionSearchSecretsGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSessionSearchSecrets,
                GUARD_SESSION_SEARCH_SECRETS_SEVERITY,
              ),
          canBypass(GUARD_SYSTEM_PROMPT_LEAK_SEVERITY, SECURITY_PERMISSIONS.bypassSystemPromptLeak)
            ? undefined
            : withPermissionHint(
                checkSystemPromptLeakGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSystemPromptLeak,
                GUARD_SYSTEM_PROMPT_LEAK_SEVERITY,
              ),
          canBypass(GUARD_OUTBOUND_SECRET_SEVERITY, SECURITY_PERMISSIONS.bypassOutboundSecret)
            ? undefined
            : withPermissionHint(
                checkOutboundSecretGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassOutboundSecret,
                GUARD_OUTBOUND_SECRET_SEVERITY,
              ),
        ]
        for (const result of checks) {
          if (result) return result
        }
        return undefined
      },
      'session.end': async (event) => {
        clearSessionTaints(event.sessionId)
      },
    },
  }),
})
