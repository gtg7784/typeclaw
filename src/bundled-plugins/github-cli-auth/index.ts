import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import { definePlugin } from '@/plugin'

import { createApproveIdempotencyGuard } from './approve-idempotency'
import { createGithubEffectiveApprovalResolver } from './effective-approval'
import { analyzeGhCommand } from './gh-command'
import { checkGraphqlAuthNudge } from './graphql-auth-nudge'
import { commitReviewIfSucceeded, noteReviewCommand } from './review-recorder'
import { classifyGhToken } from './token-class'

export default definePlugin({
  plugin: async (ctx) => {
    const resolveTokenForRepo = ctx.github.resolveTokenForRepo
    const verdictGuard = createApproveIdempotencyGuard({
      resolveEffectiveApproval: createGithubEffectiveApprovalResolver({
        resolveToken: async (workspace) => {
          const result = await resolveTokenForRepo(workspace)
          return result.kind === 'token' ? result.token : null
        },
      }),
    })
    return {
      hooks: {
        'tool.before': async (event) => {
          if (event.tool !== 'bash') return
          const command = event.args.command
          if (typeof command !== 'string' || !command.includes('gh')) return

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
          if (decision.kind === 'pass-through') return

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
        },
        'tool.after': async (event) => {
          checkGraphqlAuthNudge({ tool: event.tool, result: event.result })
          const committed = commitReviewIfSucceeded({
            sessionId: event.sessionId,
            callId: event.callId,
            result: event.result,
          })
          verdictGuard.release({ callId: event.callId, succeeded: committed })
        },
      },
    }
  },
})
