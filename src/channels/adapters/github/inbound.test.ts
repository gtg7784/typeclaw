import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'

import type { InboundMessage } from '@/channels/types'

import { createDeliveryDedup } from './dedup'
import { classifyGithubInbound, createGithubWebhookHandler, verifySignature } from './inbound'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

describe('verifySignature', () => {
  it('accepts the GitHub docs test vector', async () => {
    const ok = await verifySignature(
      'Hello, World!',
      "It's a Secret to Everybody",
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    )
    expect(ok).toBe(true)
  })
})

describe('classifyGithubInbound', () => {
  it('classifies issue comments on pull requests as PR chats', () => {
    const msg = classifyGithubInbound('issue_comment', issueCommentPayload({ pullRequest: true }), 'typeclaw-bot')
    expect(msg?.workspace).toBe('acme/project')
    expect(msg?.chat).toBe('pr:7')
    expect(msg?.thread).toBe(null)
    expect(msg?.authorName).toBe('alice')
  })

  it('classifies review comments into root-comment threads', () => {
    const msg = classifyGithubInbound('pull_request_review_comment', reviewCommentPayload(), 'typeclaw-bot')
    expect(msg?.chat).toBe('pr:7')
    expect(msg?.thread).toBe('101')
  })

  describe('pull_request.review_requested', () => {
    it('wakes the bot when it is the requested reviewer', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.thread).toBe(null)
      expect(msg?.text).toContain('@alice')
      expect(msg?.text).toContain('requested your review on PR #7')
      expect(msg?.text).toContain('feat-branch → main')
      expect(msg?.text).toContain('Please review the changes line-by-line')
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.authorName).toBe('alice')
    })

    it('drops requests targeting someone else', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'someone-else' }),
        'typeclaw-bot',
      )
      expect(msg).toBe(null)
    })

    it('drops self-loop when the bot requested itself', () => {
      const payload = reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })
      ;(payload.sender as Record<string, unknown>).login = 'typeclaw-bot'
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('wakes the bot when its team is requested and membership resolves true', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot', {
        teamIsBotMember: true,
      })
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).toContain("team @reviewers (you're a member of)")
    })

    it('drops team requests when membership resolves false', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot', {
        teamIsBotMember: false,
      })
      expect(msg).toBe(null)
    })

    it('drops team requests when membership is unknown (handler did not resolve)', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('mints distinct externalMessageIds for requested → removed → requested again', () => {
      const requested = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:00:00Z' }),
        'typeclaw-bot',
      )
      const removed = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:01:00Z' }),
        'typeclaw-bot',
      )
      const requestedAgain = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:02:00Z' }),
        'typeclaw-bot',
      )
      expect(requested?.externalMessageId).not.toBe(removed?.externalMessageId)
      expect(removed?.externalMessageId).not.toBe(requestedAgain?.externalMessageId)
      expect(requested?.externalMessageId).not.toBe(requestedAgain?.externalMessageId)
    })

    it('falls back to PR id when title/branch info is absent', () => {
      const payload = reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })
      delete (payload.pull_request as Record<string, unknown>).title
      delete (payload.pull_request as Record<string, unknown>).head
      delete (payload.pull_request as Record<string, unknown>).base
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg?.text).toContain('PR #7')
      expect(msg?.text).not.toContain('Branch:')
    })
  })

  describe('pull_request.review_request_removed', () => {
    it('emits a cleanup signal when the bot is un-requested', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).toContain('removed your review request')
      expect(msg?.text).toContain('You can stop any in-progress review.')
    })

    it('drops removal events for other reviewers', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'someone-else' }),
        'typeclaw-bot',
      )
      expect(msg).toBe(null)
    })
  })
})

describe('createGithubWebhookHandler — review_requested team gating', () => {
  it('consults isBotInTeam and routes when membership is active', async () => {
    const routed: InboundMessage[] = []
    const calls: Array<{ org: string; slug: string; login: string }> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async (input) => {
        calls.push(input)
        return true
      },
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    const body = JSON.stringify(reviewRequestedTeamPayload())
    const response = await handler(signedRequest(body, 'pull_request', 'team-1'))

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' }])
    expect(routed[0]?.chat).toBe('pr:7')
  })

  it('drops the event when isBotInTeam resolves false', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async () => false,
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    await handler(signedRequest(JSON.stringify(reviewRequestedTeamPayload()), 'pull_request', 'team-2'))
    expect(routed).toHaveLength(0)
  })

  it('drops the event when isBotInTeam throws', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async () => {
        throw new Error('boom')
      },
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    await handler(signedRequest(JSON.stringify(reviewRequestedTeamPayload()), 'pull_request', 'team-3'))
    expect(routed).toHaveLength(0)
  })
})

describe('createGithubWebhookHandler', () => {
  it('acks before the fire-and-forget route promise settles', async () => {
    const routed: InboundMessage[] = []
    const routeWait = Promise.withResolvers<void>()
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger,
      route: (msg) => {
        routed.push(msg)
        void routeWait.promise
      },
    })

    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))
    const response = await handler(signedRequest(body, 'issue_comment', 'delivery-1'))

    expect(response.status).toBe(200)
    expect(routed[0]?.chat).toBe('issue:7')
    routeWait.resolve()
  })

  it('drops duplicate deliveries without routing twice', async () => {
    let count = 0
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger,
      route: () => {
        count++
      },
    })
    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))

    await handler(signedRequest(body, 'issue_comment', 'same-delivery'))
    await handler(signedRequest(body, 'issue_comment', 'same-delivery'))

    expect(count).toBe(1)
  })
})

function signedRequest(body: string, event: string, delivery: string): Request {
  const sig = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
  return new Request('https://example.com/github', {
    method: 'POST',
    headers: {
      'x-hub-signature-256': sig,
      'x-github-event': event,
      'x-github-delivery': delivery,
    },
    body,
  })
}

function repo(): Record<string, unknown> {
  return { name: 'project', owner: { login: 'acme' } }
}

function user(): Record<string, unknown> {
  return { login: 'alice', id: 10, type: 'User' }
}

function issueCommentPayload(options: { pullRequest: boolean }): Record<string, unknown> {
  return {
    action: 'created',
    repository: repo(),
    issue: { number: 7, ...(options.pullRequest ? { pull_request: {} } : {}) },
    comment: { id: 99, body: '@typeclaw-bot hello', created_at: '2026-01-01T00:00:00Z', user: user() },
  }
}

function reviewCommentPayload(): Record<string, unknown> {
  return {
    action: 'created',
    repository: repo(),
    pull_request: { number: 7 },
    comment: { id: 102, in_reply_to_id: 101, body: 'review', created_at: '2026-01-01T00:00:00Z', user: user() },
  }
}

function pullRequestForReview(updatedAt: string): Record<string, unknown> {
  return {
    number: 7,
    id: 700,
    title: 'Add the thing',
    updated_at: updatedAt,
    head: { ref: 'feat-branch' },
    base: { ref: 'main' },
    user: user(),
  }
}

function reviewRequestedPayload(options: { reviewerLogin: string; updatedAt?: string }): Record<string, unknown> {
  return {
    action: 'review_requested',
    repository: repo(),
    pull_request: pullRequestForReview(options.updatedAt ?? '2026-01-01T00:00:00Z'),
    requested_reviewer: { login: options.reviewerLogin, id: 42, type: 'User' },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function reviewRequestRemovedPayload(options: { reviewerLogin: string; updatedAt?: string }): Record<string, unknown> {
  return {
    action: 'review_request_removed',
    repository: repo(),
    pull_request: pullRequestForReview(options.updatedAt ?? '2026-01-01T00:01:00Z'),
    requested_reviewer: { login: options.reviewerLogin, id: 42, type: 'User' },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function reviewRequestedTeamPayload(): Record<string, unknown> {
  return {
    action: 'review_requested',
    repository: repo(),
    pull_request: pullRequestForReview('2026-01-01T00:00:00Z'),
    requested_team: { slug: 'reviewers', id: 5000 },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}
