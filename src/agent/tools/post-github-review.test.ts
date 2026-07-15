import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetReviewObserverForTest,
  hasReview,
  resetReviewTurn,
  setReviewOutputObserver,
} from '@/channels/github-review-turn-ledger'
import {
  __resetReviewVerdictGuardForTest,
  configureReviewVerdictCoordinator,
} from '@/channels/github-review-verdict-coordinator'
import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig } from '@/channels/schema'
import type { SubmitReviewRequest } from '@/channels/types'

import { createPostGithubReviewTool } from './post-github-review'

function router() {
  return createChannelRouter({
    agentDir: '/tmp/typeclaw-post-review-test',
    configForAdapter: () => ({
      allow: ['*'],
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }),
  })
}

const githubOrigin = { adapter: 'github' as const, workspace: 'acme/widgets', chat: 'pr:7', thread: null }
const slackOrigin = { adapter: 'slack-bot' as const, workspace: 'T0', chat: 'C0', thread: null }
const fakeCtx = {} as Parameters<ReturnType<typeof createPostGithubReviewTool>['execute']>[4]
const sessionId = 'post-review-session'

async function run(tool: ReturnType<typeof createPostGithubReviewTool>, params: Parameters<typeof tool.execute>[1]) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('post_github_review', () => {
  afterEach(() => {
    resetReviewTurn(sessionId)
    resetReviewTurn('concurrent-session')
    __resetReviewObserverForTest()
    __resetReviewVerdictGuardForTest()
  })

  test('is gated to GitHub-origin sessions', async () => {
    const result = await run(createPostGithubReviewTool({ router: router(), origin: slackOrigin, sessionId }), {
      event: 'COMMENT',
      body: 'summary',
    })
    expect(result.details).toMatchObject({ ok: false })
  })

  test('maps snake_case anchors and returns adapter verification details', async () => {
    const channelRouter = router()
    const requests: SubmitReviewRequest[] = []
    channelRouter.registerReviewSubmitter('github', async (request) => {
      requests.push(request)
      return {
        ok: true,
        reviewId: 44,
        state: 'COMMENTED',
        downgraded: true,
        reanchored: [{ path: 'src/app.ts', line: 99, body: 'outside' }],
      }
    })
    const output: unknown[] = []
    setReviewOutputObserver((event) => output.push(event))
    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'summary',
      comments: [{ path: 'src/app.ts', line: 10, side: 'RIGHT', start_line: 8, start_side: 'RIGHT', body: 'finding' }],
    })

    expect(requests[0]?.comments).toEqual([
      { path: 'src/app.ts', line: 10, side: 'RIGHT', startLine: 8, startSide: 'RIGHT', body: 'finding' },
    ])
    expect(result.details).toMatchObject({ ok: true, reviewId: 44, downgraded: true })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
    expect(output).toEqual([{ sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: 'COMMENT' }])
    expect(result.content[0]).toMatchObject({ type: 'text' })
    if (result.content[0]?.type === 'text') expect(result.content[0].text).toContain('out-of-diff')
  })

  test.each([
    ['APPROVE', 'APPROVED', 'APPROVE'],
    ['REQUEST_CHANGES', 'CHANGES_REQUESTED', 'REQUEST_CHANGES'],
  ] as const)('credits the verified effective %s state to the session ledger', async (event, state, verdict) => {
    const channelRouter = router()
    channelRouter.registerReviewSubmitter('github', async () => ({ ok: true, reviewId: 45, state }))
    const output: unknown[] = []
    setReviewOutputObserver((value) => output.push(value))

    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event,
      body: 'summary',
    })

    expect(result.details).toMatchObject({ ok: true, state })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict })).toBe(true)
    expect(output).toEqual([{ sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: verdict }])
  })

  test('failed or unknown verification receives no ledger credit', async () => {
    const channelRouter = router()
    let state: 'failure' | 'unknown' = 'failure'
    channelRouter.registerReviewSubmitter('github', async () =>
      state === 'failure'
        ? { ok: false, error: 'verification failed', code: 'transient' }
        : { ok: true, reviewId: 46, state: 'PENDING' },
    )
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    state = 'unknown'
    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
  })

  test('shares effective-state and in-flight coordination with the github-cli-auth guard', async () => {
    let effective: 'NONE' | 'APPROVED' = 'APPROVED'
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      await firstGate
      return { ok: true, reviewId: 47, state: 'APPROVED' }
    })

    const effectiveDuplicate = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }),
      { event: 'APPROVE', body: 'summary' },
    )
    expect(effectiveDuplicate.details).toMatchObject({ ok: false })
    expect(submissions).toBe(0)

    effective = 'NONE'
    const first = run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'summary',
    })
    await Bun.sleep(0)
    const concurrent = await run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: githubOrigin,
        sessionId: 'concurrent-session',
      }),
      { event: 'REQUEST_CHANGES', body: 'summary' },
    )
    expect(concurrent.details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    releaseFirst()
    expect((await first).details).toMatchObject({ ok: true })
  })

  test('retains a conservative dedupe shield when POST succeeded but verification outcome is unknown', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: false, error: 'verification timed out', code: 'transient', submitted: true }
    })
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    expect((await run(tool, { event: 'APPROVE', body: 'retry' })).details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
  })
})
