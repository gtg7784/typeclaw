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
