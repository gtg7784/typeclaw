import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import { definePlugin } from '@/plugin'

import { createApproveIdempotencyGuard } from './approve-idempotency'
import { createGithubEffectiveApprovalResolver, createGithubHeadShaResolver } from './effective-approval'
import { analyzeGhCommand } from './gh-command'
import { ensureGitAskPassHelper } from './git-askpass'
import { analyzeGitCommand, defaultGitResolvers } from './git-command'
import { checkGraphqlAuthNudge } from './graphql-auth-nudge'
import { commitReviewIfSucceeded, noteReviewCommand } from './review-recorder'
import { classifyGhToken } from './token-class'

export default definePlugin({
  plugin: async (ctx) => {
    const resolveTokenForRepo = ctx.github.resolveTokenForRepo
    const resolveToken = async (workspace: string) => {
      const result = await resolveTokenForRepo(workspace)
      return result.kind === 'token' ? result.token : null
    }
    const verdictGuard = createApproveIdempotencyGuard({
      resolveEffectiveApproval: createGithubEffectiveApprovalResolver({ resolveToken }),
      resolveHeadSha: createGithubHeadShaResolver({ resolveToken }),
    })

    type HookResult = void | { block: true; reason: string }

    // 'fall-through' means "not a repo-targeting gh command" so the caller can
    // try the git path on the same command (e.g. `git ... # gh` substrings).
    const handleGhCommand = async (params: {
      event: { callId: string; args: Record<string, unknown> }
      command: string
    }): Promise<HookResult | 'fall-through'> => {
      const { event, command } = params
      const review = await noteReviewCommand({ callId: event.callId, command })
      if (review.detected !== null) {
        const block = await verdictGuard.guard({
          callId: event.callId,
          workspace: review.detected.workspace,
          prNumber: review.detected.prNumber,
          verdict: review.detected.verdict,
        })
        if (block !== null) return block
      }
      if (review.dump !== null) return review.dump

      const decision = analyzeGhCommand(command)
      if (decision.kind === 'pass-through') return 'fall-through'

      const tokenClass = classifyGhToken(process.env.GH_TOKEN)
      // Classic PATs reach every owner; nothing to inject or enforce.
      if (tokenClass === 'cross-owner') return

      if (decision.kind === 'block') return { block: true, reason: decision.reason }

      // Fine-grained PATs are single-owner but cannot be re-minted per repo;
      // the seeded GH_TOKEN is the only token we have. Leave it in place so
      // `gh` fails honestly if the named repo is under a different owner.
      if (tokenClass === 'fine-grained-pat') return

      const result = await resolveTokenForRepo(decision.repoSlug)
      if (result.kind === 'unavailable') return { block: true, reason: result.reason }
      // Inject via the internal env overlay (delivered to the spawn / bwrap
      // --setenv by the bash wrapper) so the token never enters the command
      // string, where it could leak through logs or later hooks.
      event.args[TYPECLAW_INTERNAL_BASH_ENV] = { GH_TOKEN: result.token }
      // graphql consumed `-R/--repo` as a mint hint; `gh api` rejects it, so
      // run the command with the flag stripped (token still rides in env).
      if (decision.rewrittenCommand !== undefined) event.args.command = decision.rewrittenCommand
      return
    }

    const handleGitCommand = async (params: {
      event: { args: Record<string, unknown> }
      command: string
      agentDir: string
    }): Promise<HookResult> => {
      const { event, command, agentDir } = params
      // Only App auth re-mints per repo. Classic/fine-grained PATs and absent
      // tokens are left untouched, exactly as the gh path treats them.
      if (classifyGhToken(process.env.GH_TOKEN) !== 'app') return

      const decision = await analyzeGitCommand(command, { cwd: agentDir, resolvers: defaultGitResolvers })
      if (decision.kind === 'pass-through') return
      if (decision.kind === 'block') return { block: true, reason: decision.reason }

      const result = await resolveTokenForRepo(decision.repoSlug)
      if (result.kind === 'unavailable') return { block: true, reason: result.reason }

      const askpass = await ensureGitAskPassHelper()
      const existing = event.args[TYPECLAW_INTERNAL_BASH_ENV]
      const overlay = existing !== null && typeof existing === 'object' ? (existing as Record<string, string>) : {}
      // Token rides in TYPECLAW_GIT_TOKEN (read by the askpass helper), never in
      // argv/config. insteadOf rewrites SSH/scp remotes to https so the helper's
      // credential applies; GIT_TERMINAL_PROMPT=0 fails fast instead of hanging.
      event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
        ...overlay,
        GIT_ASKPASS: askpass,
        TYPECLAW_GIT_TOKEN: result.token,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
        GIT_CONFIG_VALUE_0: 'git@github.com:',
        GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
        GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
      }
      if (decision.rewrittenCommand !== undefined) event.args.command = decision.rewrittenCommand
      return
    }

    return {
      hooks: {
        'tool.before': async (event) => {
          if (event.tool !== 'bash') return
          const command = event.args.command
          if (typeof command !== 'string') return

          if (command.includes('gh')) {
            const ghResult = await handleGhCommand({ event, command })
            if (ghResult !== 'fall-through') return ghResult
          }

          if (command.includes('git')) {
            return await handleGitCommand({ event, command, agentDir: ctx.agentDir })
          }
          return
        },
        'tool.after': async (event) => {
          checkGraphqlAuthNudge({ tool: event.tool, result: event.result })
          const committed = commitReviewIfSucceeded({
            sessionId: event.sessionId,
            callId: event.callId,
            result: event.result,
          })
          await verdictGuard.release({ callId: event.callId, succeeded: committed })
        },
      },
    }
  },
})
