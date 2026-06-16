import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import { definePlugin } from '@/plugin'
import { resolveHiddenPaths } from '@/sandbox'

import { createApproveIdempotencyGuard } from './approve-idempotency'
import { createGithubEffectiveApprovalResolver, createGithubHeadShaResolver } from './effective-approval'
import { analyzeGhCommand, effectiveGhTokensForAuthenticatedUserEndpoint } from './gh-command'
import { ensureGitAskPassHelper } from './git-askpass'
import { analyzeGitCommand, defaultGitResolvers, resolveGhDefaultRepoFromCwd } from './git-command'
import { checkGraphqlAuthNudge } from './graphql-auth-nudge'
import { commitReviewIfSucceeded, noteReviewCommand } from './review-recorder'
import { classifyGhToken, shouldMintAppToken } from './token-class'

export default definePlugin({
  plugin: async (ctx) => {
    const resolveTokenForRepo = ctx.github.resolveTokenForRepo
    const hasAppTokenResolver = ctx.github.hasAppTokenResolver

    // A .env PAT is broad and long-lived, so it may only reach bash that runs
    // WITHOUT bwrap's --clearenv — otherwise a low-trust, stranger-drivable
    // sandbox could exfiltrate it. We gate on the SAME signal applyBashSandbox
    // uses (resolveHiddenPaths empty => unsandboxed) rather than a role name, so
    // the credential policy can never diverge from the actual sandbox decision
    // and custom roles follow their real fs.see.secrets / security.bypass grant.
    const runsUnsandboxed = (origin: SessionOrigin | undefined): boolean => {
      const { dirs, files } = resolveHiddenPaths(ctx.permissions, origin, ctx.agentDir)
      return dirs.length === 0 && files.length === 0
    }

    // The PAT is in the container env but stripped by --clearenv for this role,
    // and a PAT is not re-mintable per repo, so there is no token to inject. Tell
    // the AGENT (model-visible block) instead of letting git/gh fail ambiguously
    // — the silent variant of this is exactly what caused a multi-day debugging
    // hunt. App auth is the supported path for low-trust roles.
    const sandboxedPatWithheldReason =
      'A classic/fine-grained GitHub PAT is configured (via .env GH_TOKEN), but this command runs ' +
      'in a sandboxed (low-trust) role whose environment is cleared before bash — so the PAT is ' +
      'withheld here and is NOT available to git/gh. This is a deliberate guard, not missing auth: a ' +
      'broad, long-lived PAT must not be reachable from a low-trust sandbox. Configure GitHub App auth ' +
      '(channels.github) to grant per-repo, short-lived tokens that DO work for sandboxed roles.'

    let warnedSandboxedPatWithheld = false
    const warnSandboxedPatWithheldOnce = (): void => {
      if (warnedSandboxedPatWithheld) return
      warnedSandboxedPatWithheld = true
      ctx.logger.warn(
        'GH_TOKEN (classic/fine-grained PAT) withheld from a sandboxed role: the env is cleared for ' +
          'low-trust bash, so git/gh have no credential. Configure GitHub App auth (channels.github) ' +
          'for per-repo tokens that work in sandboxed roles.',
      )
    }
    // `/user` resolves the caller's USER identity. An App installation token is not
    // a user, so GitHub rejects it on a token-class basis (403, or no-token error in
    // the sandbox) no matter how valid the token is. We block-and-guide so the agent
    // does not misread this as "I have no auth" — it does, for repo-scoped calls.
    const appUserEndpointReason =
      '`gh api /user` (and `/user/...`) resolves the calling USER. This agent authenticates ' +
      'as a GitHub App with a per-repo installation token, which is not a user identity — so ' +
      '`/user` cannot work here, and this failure is NOT a sign that auth is missing (repo-' +
      'scoped calls still work). It is not a valid auth/login check. For repo data use ' +
      '`gh <cmd> -R owner/repo` or `gh api /repos/owner/repo/...`; for the actor, read the ' +
      'PR/issue/comment context you were given instead of `gh api /user`.'
    const resolveToken = async (workspace: string) => {
      const result = await resolveTokenForRepo(workspace)
      return result.kind === 'token' ? result.token : null
    }
    const verdictGuard = createApproveIdempotencyGuard({
      resolveEffectiveApproval: createGithubEffectiveApprovalResolver({ resolveToken }),
      resolveHeadSha: createGithubHeadShaResolver({ resolveToken }),
    })

    type HookResult = void | { block: true; reason: string }

    // A TRUSTED repo to fill in for a repo-less `gh` command, resolved from
    // sources the command author cannot forge: (1) a GitHub channel session's
    // own repo (origin.workspace comes from the signed webhook payload), then
    // (2) the working tree's `origin` remote. NOT from any `-R`/path in the
    // command (that is the attacker-controllable input the parser already
    // handles). The slug is still gated by the repos[] allowlist at mint time.
    const resolveTrustedFallbackRepo = async (origin: SessionOrigin | undefined): Promise<string | undefined> => {
      if (origin?.kind === 'channel' && origin.adapter === 'github' && origin.workspace !== '') {
        return origin.workspace
      }
      const fromCwd = await resolveGhDefaultRepoFromCwd(ctx.agentDir, defaultGitResolvers)
      return fromCwd ?? undefined
    }

    // When a repo-less `gh` is blocked but a trusted repo IS available, show the
    // exact single-bare rewrite so the agent recovers in one step instead of
    // guessing. Composition blocks get a split-the-script instruction. The
    // returned text is appended to the block reason (synchronous, always seen).
    const buildGhBlockGuidance = (code: string, fallbackRepo: string | undefined): string => {
      const slug = fallbackRepo ?? 'owner/repo'
      if (code === 'composition') {
        return (
          ` Run each gh as its own single bare command, e.g. \`gh label edit <name> -R ${slug} --name ...\` —` +
          ' not inside a function, `if`/`then`, `&&`, `;`, or `$(...)`.'
        )
      }
      return ` For example: \`gh <cmd> -R ${slug}\` as a single bare command.`
    }

    // 'fall-through' means "not a repo-targeting gh command" so the caller can
    // try the git path on the same command (e.g. `git ... # gh` substrings).
    const handleGhCommand = async (params: {
      event: { callId: string; args: Record<string, unknown>; origin?: SessionOrigin }
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

      // Analyze first WITHOUT the fallback: an explicit `-R`/path repo must win,
      // and we only pay for fallback resolution (a git subprocess) when the
      // command is otherwise repo-less. A trusted fallback is then applied ONLY to
      // a `missing-repo` block (never to composition/non-literal/multi-owner/api),
      // and re-analysis re-runs the SAME composition gate, so a compound command
      // still blocks. `fallbackRepoUsed` marks an inject that came from the
      // fallback so we also set GH_REPO (gh needs the repo, not just the token).
      let decision = analyzeGhCommand(command)
      let fallbackRepo: string | undefined
      let fallbackRepoUsed = false
      if (decision.kind === 'block' && decision.code === 'missing-repo') {
        fallbackRepo = await resolveTrustedFallbackRepo(event.origin)
        if (fallbackRepo !== undefined) {
          const withFallback = analyzeGhCommand(command, fallbackRepo)
          if (withFallback.kind === 'inject') {
            decision = withFallback
            fallbackRepoUsed = true
          }
        }
      }

      // `/user` classifies as pass-through (no repo to mint for), so this block
      // must run BEFORE the pass-through return. Resolve the EFFECTIVE token per
      // `/user` invocation (a command-local `GH_TOKEN=…`/`GITHUB_TOKEN=…` overrides
      // process env, matching gh) and block only when that token is App / none-with-
      // minter — a command-local PAT override carries a user identity, so `/user`
      // works for it and must not be blocked.
      const userEndpointTokens = effectiveGhTokensForAuthenticatedUserEndpoint(command, {
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      })
      if (userEndpointTokens.some((token) => shouldMintAppToken(token, hasAppTokenResolver()))) {
        return { block: true, reason: appUserEndpointReason }
      }

      if (decision.kind === 'pass-through') return 'fall-through'

      // The `-R` strip is a pure syntax fix (`gh api` rejects `-R`), independent
      // of token minting, so apply it for EVERY token class — including the PAT
      // paths below that return without injecting. Only `inject` decisions carry
      // `rewrittenCommand`, and only after the single-bare/safe-pipeline gate in
      // analyzeGhCommand, so this never rewrites a blocked or unsafe shape.
      if (decision.kind === 'inject' && decision.rewrittenCommand !== undefined) {
        event.args.command = decision.rewrittenCommand
      }

      const tokenClass = classifyGhToken(process.env.GH_TOKEN)

      // PAT classes (classic = cross-owner, fine-grained) are not re-minted per
      // repo; the seeded GH_TOKEN is the only token we have. App minting, when
      // available, is still preferred for SANDBOXED roles (the PAT can't reach
      // them), so a PAT must NOT suppress minting there — only for unsandboxed
      // execution does the PAT win. Unsandboxed: the PAT already rides inherited
      // process.env, but re-asserting it in the overlay keeps the command-local
      // GH_TOKEN explicit and consistent with the git path. Sandboxed PAT-only:
      // block with guidance instead of failing silently.
      // Set when a sandboxed PAT falls through to App minting: the tail's
      // shouldMintAppToken(process.env.GH_TOKEN) re-check would see the PAT and
      // bail, so this flag forces the mint that the PAT must not suppress.
      let mintForSandboxedPat = false
      if (tokenClass === 'cross-owner' || tokenClass === 'fine-grained-pat') {
        // Unsandboxed: the PAT authenticates directly (it already rides inherited
        // process.env). For a repo-targeting command we re-assert it in the
        // overlay so behavior is explicit and matches the git path; otherwise we
        // pass through. The App-oriented missing-repo / multi-owner BLOCK does
        // NOT apply — a PAT needs no per-repo mint — so we never surface it here.
        if (runsUnsandboxed(event.origin)) {
          if (decision.kind === 'inject') {
            event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
              GH_TOKEN: process.env.GH_TOKEN as string,
              ...(fallbackRepoUsed && fallbackRepo !== undefined ? { GH_REPO: fallbackRepo } : {}),
            }
          }
          return
        }
        // Sandboxed: the PAT is stripped by --clearenv. Prefer App minting when
        // available (a PAT must NOT suppress it, or the original silent-failure
        // bug returns); otherwise block with guidance rather than failing mute.
        if (!shouldMintAppToken(undefined, hasAppTokenResolver())) {
          if (decision.kind === 'block') {
            return { block: true, reason: decision.reason + buildGhBlockGuidance(decision.code, fallbackRepo) }
          }
          warnSandboxedPatWithheldOnce()
          return { block: true, reason: sandboxedPatWithheldReason }
        }
        mintForSandboxedPat = true
      }

      if (decision.kind === 'block') {
        return { block: true, reason: decision.reason + buildGhBlockGuidance(decision.code, fallbackRepo) }
      }

      // No App auth (no App-class GH_TOKEN and no live minter): leave whatever
      // is seeded so `gh` fails honestly rather than us guessing a token. The
      // sandboxed-PAT mint path bypasses this PAT-class re-check via the flag.
      if (!mintForSandboxedPat && !shouldMintAppToken(process.env.GH_TOKEN, hasAppTokenResolver())) return

      const result = await resolveTokenForRepo(decision.repoSlug)
      if (result.kind === 'unavailable') return { block: true, reason: result.reason }
      // Inject via the internal env overlay (delivered to the spawn / bwrap
      // --setenv by the bash wrapper) so the token never enters the command
      // string, where it could leak through logs or later hooks. When the repo
      // came from a trusted fallback (not an explicit -R), also set GH_REPO so
      // `gh` actually targets it — a token alone leaves the repo unresolved.
      // GH_REPO is non-secret; the token still scopes reach to that repo.
      event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
        GH_TOKEN: result.token,
        ...(fallbackRepoUsed ? { GH_REPO: decision.repoSlug } : {}),
      }
      return
    }

    const handleGitCommand = async (params: {
      event: { args: Record<string, unknown>; origin?: SessionOrigin }
      command: string
      agentDir: string
    }): Promise<HookResult> => {
      const { event, command, agentDir } = params
      const tokenClass = classifyGhToken(process.env.GH_TOKEN)
      const isPat = tokenClass === 'cross-owner' || tokenClass === 'fine-grained-pat'

      // A PAT is not re-mintable per repo. For unsandboxed roles it rides the
      // git-askpass path so SSH/scp remotes get rewritten to https and clone
      // works uniformly (matching the gh path). For sandboxed roles the PAT is
      // withheld (env cleared): mint an App token instead if available, else
      // block with guidance rather than letting git fail silently. App auth must
      // still mint for sandboxed roles even when a PAT is present.
      const useEnvPat = isPat && runsUnsandboxed(event.origin)
      // Sandboxed PAT: the env is cleared, so the PAT can't reach git. Mint an
      // App token instead when a minter is live (a PAT must NOT suppress it);
      // otherwise block with guidance below rather than fail silently.
      const mintForSandboxedPat = isPat && !useEnvPat && shouldMintAppToken(undefined, hasAppTokenResolver())
      if (isPat && !useEnvPat && !mintForSandboxedPat) {
        const decision = await analyzeGitCommand(command, { cwd: agentDir, resolvers: defaultGitResolvers })
        if (decision.kind === 'pass-through') return
        if (decision.kind === 'block') return { block: true, reason: decision.reason }
        warnSandboxedPatWithheldOnce()
        return { block: true, reason: sandboxedPatWithheldReason }
      }

      // Neither a usable PAT nor App auth: leave the command untouched so git
      // fails honestly rather than us guessing a token. App auth is detected by
      // the live minter too, not just an App-class GH_TOKEN: multi-owner /
      // no-repos App configs never seed GH_TOKEN yet can mint. The mintForSandboxedPat
      // flag forces minting past this PAT-class re-check.
      if (!useEnvPat && !mintForSandboxedPat && !shouldMintAppToken(process.env.GH_TOKEN, hasAppTokenResolver())) return

      const decision = await analyzeGitCommand(command, { cwd: agentDir, resolvers: defaultGitResolvers })
      if (decision.kind === 'pass-through') return
      if (decision.kind === 'block') return { block: true, reason: decision.reason }

      // The unsandboxed-PAT path uses the PAT directly; otherwise mint a per-repo
      // App token. Both ride TYPECLAW_GIT_TOKEN (read by the askpass helper),
      // never argv/config.
      let gitToken: string
      if (useEnvPat) {
        gitToken = process.env.GH_TOKEN as string
      } else {
        const result = await resolveTokenForRepo(decision.repoSlug)
        if (result.kind === 'unavailable') return { block: true, reason: result.reason }
        gitToken = result.token
      }

      const askpass = await ensureGitAskPassHelper()
      const existing = event.args[TYPECLAW_INTERNAL_BASH_ENV]
      const overlay = existing !== null && typeof existing === 'object' ? (existing as Record<string, string>) : {}
      // insteadOf rewrites SSH/scp remotes to https so the helper's credential
      // applies; GIT_TERMINAL_PROMPT=0 fails fast instead of hanging.
      event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
        ...overlay,
        GIT_ASKPASS: askpass,
        TYPECLAW_GIT_TOKEN: gitToken,
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
          const review = commitReviewIfSucceeded({
            sessionId: event.sessionId,
            callId: event.callId,
            result: event.result,
          })
          await verdictGuard.release({ callId: event.callId, succeeded: review.committed })
          // A backstop-recovered verdict had no guard() reservation, so release()
          // could not arm the lag shield — do it explicitly here so the next
          // same-commit submission is deduped.
          if (review.landedFromResult !== null) {
            await verdictGuard.noteLandedReview(review.landedFromResult)
          }
        },
      },
    }
  },
})
