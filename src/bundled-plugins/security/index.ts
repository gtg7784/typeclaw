import { definePlugin } from '@/plugin'

import { SECURITY_PERMISSIONS } from './permissions'
import { checkGitExfilGuard, checkGitRemoteTaintedGuard, recordGitRemoteTaintIfAny } from './policies/git-exfil'
import { checkOutboundSecretGuard } from './policies/outbound-secret-scan'
import { applyPromptInjectionDefense } from './policies/prompt-injection'
import { clearSessionTaints } from './policies/remote-taint-state'
import { checkSecretExfilBashGuard } from './policies/secret-exfil-bash'
import { checkSecretExfilReadGuard } from './policies/secret-exfil-read'
import { checkSessionSearchSecretsGuard } from './policies/session-search-secrets'
import { checkSsrfGuard } from './policies/ssrf'
import { checkSystemPromptLeakGuard } from './policies/system-prompt-leak'
import type { SecurityBlock } from './policy'

export { SECURITY_PERMISSIONS, type SecurityPermission } from './permissions'

// Maps each guard permission to a one-line hint about which built-in roles
// already carry it. Kept next to the hook so adding a new bypass permission
// forces a same-file edit — the hint is part of the permission's contract,
// not optional documentation. `owner` always carries every `security.bypass.*`
// via the wildcard expansion in builtins.ts.
const BYPASS_ROLE_HINT: Record<string, string> = {
  [SECURITY_PERMISSIONS.bypassSecretExfilBash]: 'owner and trusted have it by default',
  [SECURITY_PERMISSIONS.bypassGitExfil]: 'only owner has it by default',
  [SECURITY_PERMISSIONS.bypassGitRemoteTainted]: 'only owner has it by default',
  [SECURITY_PERMISSIONS.bypassSecretExfilRead]: 'only owner has it by default',
  [SECURITY_PERMISSIONS.bypassSsrf]: 'only owner has it by default',
  [SECURITY_PERMISSIONS.bypassSessionSearchSecrets]: 'only owner has it by default',
  [SECURITY_PERMISSIONS.bypassSystemPromptLeak]: 'only owner has it by default',
  [SECURITY_PERMISSIONS.bypassOutboundSecret]: 'only owner has it by default',
}

function withPermissionHint(result: SecurityBlock | undefined, permission: string): SecurityBlock | undefined {
  if (!result) return result
  const hint = BYPASS_ROLE_HINT[permission] ?? 'no built-in role carries it'
  return {
    block: true,
    reason: `${result.reason} Or run as a role carrying \`${permission}\` (${hint}); see the \`typeclaw-permissions\` skill.`,
  }
}

export default definePlugin({
  permissions: Object.values(SECURITY_PERMISSIONS),
  plugin: async (ctx) => ({
    hooks: {
      'session.prompt': async (event) => {
        applyPromptInjectionDefense(event)
      },
      'tool.before': async (event) => {
        const can = (perm: string) => ctx.permissions.has(event.origin, perm)

        // Taint-recording runs FIRST, independently of the gitExfil guard.
        // The gitRemoteTainted defense depends on it. We pass through
        // `permittedBypass` for actors who can skip gitExfil via permission
        // so the recorder still fires for them (an acked or
        // permission-bypassed command will actually run, so its remote
        // change must be remembered).
        recordGitRemoteTaintIfAny({
          tool: event.tool,
          args: event.args,
          sessionId: event.sessionId,
          permittedBypass: can(SECURITY_PERMISSIONS.bypassGitExfil),
        })

        const checks: (SecurityBlock | undefined)[] = [
          can(SECURITY_PERMISSIONS.bypassGitRemoteTainted)
            ? undefined
            : withPermissionHint(
                checkGitRemoteTaintedGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
                SECURITY_PERMISSIONS.bypassGitRemoteTainted,
              ),
          can(SECURITY_PERMISSIONS.bypassSecretExfilBash)
            ? undefined
            : withPermissionHint(
                checkSecretExfilBashGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSecretExfilBash,
              ),
          can(SECURITY_PERMISSIONS.bypassGitExfil)
            ? undefined
            : withPermissionHint(
                checkGitExfilGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
                SECURITY_PERMISSIONS.bypassGitExfil,
              ),
          can(SECURITY_PERMISSIONS.bypassSecretExfilRead)
            ? undefined
            : withPermissionHint(
                checkSecretExfilReadGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSecretExfilRead,
              ),
          can(SECURITY_PERMISSIONS.bypassSsrf)
            ? undefined
            : withPermissionHint(
                checkSsrfGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSsrf,
              ),
          can(SECURITY_PERMISSIONS.bypassSessionSearchSecrets)
            ? undefined
            : withPermissionHint(
                checkSessionSearchSecretsGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSessionSearchSecrets,
              ),
          can(SECURITY_PERMISSIONS.bypassSystemPromptLeak)
            ? undefined
            : withPermissionHint(
                checkSystemPromptLeakGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassSystemPromptLeak,
              ),
          can(SECURITY_PERMISSIONS.bypassOutboundSecret)
            ? undefined
            : withPermissionHint(
                checkOutboundSecretGuard({ tool: event.tool, args: event.args }),
                SECURITY_PERMISSIONS.bypassOutboundSecret,
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
