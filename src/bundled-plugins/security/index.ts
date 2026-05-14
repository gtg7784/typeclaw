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

export { SECURITY_PERMISSIONS, type SecurityPermission } from './permissions'

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

        const checks = [
          can(SECURITY_PERMISSIONS.bypassGitRemoteTainted)
            ? undefined
            : checkGitRemoteTaintedGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
          can(SECURITY_PERMISSIONS.bypassSecretExfilBash)
            ? undefined
            : checkSecretExfilBashGuard({ tool: event.tool, args: event.args }),
          can(SECURITY_PERMISSIONS.bypassGitExfil)
            ? undefined
            : checkGitExfilGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
          can(SECURITY_PERMISSIONS.bypassSecretExfilRead)
            ? undefined
            : checkSecretExfilReadGuard({ tool: event.tool, args: event.args }),
          can(SECURITY_PERMISSIONS.bypassSsrf) ? undefined : checkSsrfGuard({ tool: event.tool, args: event.args }),
          can(SECURITY_PERMISSIONS.bypassSessionSearchSecrets)
            ? undefined
            : checkSessionSearchSecretsGuard({ tool: event.tool, args: event.args }),
          can(SECURITY_PERMISSIONS.bypassSystemPromptLeak)
            ? undefined
            : checkSystemPromptLeakGuard({ tool: event.tool, args: event.args }),
          can(SECURITY_PERMISSIONS.bypassOutboundSecret)
            ? undefined
            : checkOutboundSecretGuard({ tool: event.tool, args: event.args }),
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
