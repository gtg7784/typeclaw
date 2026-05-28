import { createHmac, timingSafeEqual } from 'node:crypto'

import type { InboundMessage } from '@/channels/types'

import type { DeliveryDedup } from './dedup'
import { isGithubEventAllowed } from './event-allowlist'

export type GithubInboundLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export type GithubWebhookHandlerOptions = {
  webhookSecret: string
  dedup: DeliveryDedup
  allowlist: () => readonly string[]
  selfId: () => string | null
  selfLogin: () => string | null
  route: (message: InboundMessage) => void
  logger: GithubInboundLogger
  // Optional: resolves whether the bot is a member of the given team. When
  // omitted, team-reviewer requests are silently dropped (the v1 fallback
  // behavior). The adapter wires this in production; tests inject a fake.
  isBotInTeam?: (input: { org: string; slug: string; login: string }) => Promise<boolean>
}

export function createGithubWebhookHandler(options: GithubWebhookHandlerOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const body = await req.text()
    const signature = req.headers.get('x-hub-signature-256') ?? ''
    if (!(await verifySignature(body, options.webhookSecret, signature))) {
      options.logger.warn('[github] webhook rejected: bad signature')
      return new Response('bad signature', { status: 401 })
    }

    const delivery = req.headers.get('x-github-delivery') ?? ''
    if (delivery !== '' && options.dedup.has(delivery)) {
      options.logger.info(`[github] duplicate delivery ignored id=${delivery}`)
      return ok()
    }

    const event = req.headers.get('x-github-event') ?? ''
    const payload = parseJson(body)
    if (payload === null) return ok()
    const action = readString(payload, 'action')
    if (!isGithubEventAllowed(options.allowlist(), event, action)) return ok()

    const selfId = options.selfId()
    const selfLogin = options.selfLogin()
    const author = readAuthor(payload)
    if (author !== null && isSelfAuthor(author, selfId, selfLogin)) {
      options.logger.info(
        `[github] dropped self-authored ${event}${action !== null ? `.${action}` : ''} from @${author.login}`,
      )
      return ok()
    }

    const teamIsBotMember = await resolveTeamMembership(event, payload, options)
    const classified = classifyGithubInbound(event, payload, selfLogin, {
      teamIsBotMember,
    })
    if (classified === null) return ok()

    if (delivery !== '') options.dedup.add(delivery)
    options.route(classified)
    return ok()
  }
}

export async function verifySignature(body: string, secret: string, sigHeader: string): Promise<boolean> {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(sigHeader)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function classifyGithubInbound(
  event: string,
  payload: Record<string, unknown>,
  selfLogin: string | null,
  options?: { teamIsBotMember?: boolean },
): InboundMessage | null {
  const repository = readRepository(payload)
  if (repository === null) return null
  const base = {
    adapter: 'github' as const,
    workspace: `${repository.owner}/${repository.name}`,
    isDm: false,
    mentionsOthers: false,
    replyToOtherMessageId: null,
  }

  if (event === 'issue_comment') {
    const issue = readRecord(payload.issue)
    const comment = readRecord(payload.comment)
    if (issue === null || comment === null) return null
    const number = readNumber(issue, 'number')
    const id = readNumber(comment, 'id')
    if (number === null || id === null) return null
    const isPullRequest = readRecord(issue.pull_request) !== null
    const user = readUser(comment.user)
    return buildInbound(
      { ...base, chat: `${isPullRequest ? 'pr' : 'issue'}:${number}`, thread: null },
      comment.body,
      id,
      user,
      selfLogin,
      comment.created_at,
    )
  }

  if (event === 'pull_request_review_comment') {
    const pr = readRecord(payload.pull_request)
    const comment = readRecord(payload.comment)
    if (pr === null || comment === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(comment, 'id')
    if (number === null || id === null) return null
    const root = readNumber(comment, 'in_reply_to_id') ?? id
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: String(root) },
      comment.body,
      id,
      readUser(comment.user),
      selfLogin,
      comment.created_at,
    )
  }

  if (event === 'discussion_comment') {
    const discussion = readRecord(payload.discussion)
    const comment = readRecord(payload.comment)
    if (discussion === null || comment === null) return null
    const number = readNumber(discussion, 'number')
    const id = readNumber(comment, 'id')
    if (number === null || id === null) return null
    return buildInbound(
      { ...base, chat: `discussion:${number}`, thread: null },
      comment.body,
      id,
      readUser(comment.user),
      selfLogin,
      comment.created_at,
    )
  }

  if (event === 'issues') {
    const issue = readRecord(payload.issue)
    if (issue === null) return null
    const number = readNumber(issue, 'number')
    const id = readNumber(issue, 'id') ?? number
    if (number === null || id === null) return null
    return buildInbound(
      { ...base, chat: `issue:${number}`, thread: null },
      issue.body,
      id,
      readUser(issue.user),
      selfLogin,
      issue.created_at,
    )
  }

  if (event === 'pull_request') {
    const pr = readRecord(payload.pull_request)
    if (pr === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(pr, 'id') ?? number
    if (number === null || id === null) return null
    const action = readString(payload, 'action')
    if (action === 'review_requested' || action === 'review_request_removed') {
      return classifyReviewRequest({
        action,
        payload,
        pr,
        number,
        base,
        selfLogin,
        teamIsBotMember: options?.teamIsBotMember,
      })
    }
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: null },
      pr.body,
      id,
      readUser(pr.user),
      selfLogin,
      pr.created_at,
    )
  }

  if (event === 'pull_request_review') {
    const pr = readRecord(payload.pull_request)
    const review = readRecord(payload.review)
    if (pr === null || review === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(review, 'id')
    if (number === null || id === null) return null
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: null },
      review.body,
      id,
      readUser(review.user),
      selfLogin,
      review.submitted_at,
    )
  }

  if (event === 'discussion') {
    const discussion = readRecord(payload.discussion)
    if (discussion === null) return null
    const number = readNumber(discussion, 'number')
    const id = readNumber(discussion, 'id') ?? number
    if (number === null || id === null) return null
    return buildInbound(
      { ...base, chat: `discussion:${number}`, thread: null },
      discussion.body,
      id,
      readUser(discussion.user),
      selfLogin,
      discussion.created_at,
    )
  }

  return null
}

type ReviewRequestInput = {
  action: 'review_requested' | 'review_request_removed'
  payload: Record<string, unknown>
  pr: Record<string, unknown>
  number: number
  base: Pick<InboundMessage, 'adapter' | 'workspace' | 'isDm' | 'mentionsOthers' | 'replyToOtherMessageId'>
  selfLogin: string | null
  teamIsBotMember: boolean | undefined
}

function classifyReviewRequest(input: ReviewRequestInput): InboundMessage | null {
  const { action, payload, pr, number, base, selfLogin, teamIsBotMember } = input
  if (selfLogin === null) return null
  const sender = readUser(payload.sender)
  if (sender === null) return null
  // Self-loop guard: if the bot itself requested (or un-requested) the
  // review, drop the event. The bot adding itself as a reviewer would
  // otherwise wake a fresh session every time it self-assigns.
  if (sender.login === selfLogin) return null

  const requestedUser = readUser(payload.requested_reviewer)
  const requestedTeam = readReviewerTeam(payload.requested_team)

  const isMeAsUser = requestedUser !== null && requestedUser.login === selfLogin
  const isMyTeam = requestedTeam !== null && teamIsBotMember === true
  if (!isMeAsUser && !isMyTeam) return null

  const title = readString(pr, 'title') ?? `#${number}`
  const head = readString(readRecord(pr.head), 'ref')
  const baseRef = readString(readRecord(pr.base), 'ref')
  const branchSegment = head !== null && baseRef !== null ? ` Branch: ${head} → ${baseRef}.` : ''
  const verbed =
    action === 'review_requested'
      ? isMyTeam
        ? `requested a review from team @${requestedTeam?.slug} (you're a member of) on PR #${number}: "${title}".`
        : `requested your review on PR #${number}: "${title}".`
      : isMyTeam
        ? `removed the review request for team @${requestedTeam?.slug} on PR #${number}: "${title}".`
        : `removed your review request on PR #${number}: "${title}".`
  const closing =
    action === 'review_requested'
      ? ' Please review the changes line-by-line and post your feedback.'
      : ' You can stop any in-progress review.'
  const text = `@${sender.login} ${verbed}${branchSegment}${closing}`

  // Synthesize a stable per-event externalMessageId. The PR's `updated_at`
  // changes on every review-request mutation, so combining it with the PR id
  // and the action keeps separate "requested → removed → requested again"
  // events from collapsing into one dedup'd id.
  const updatedAt = readString(pr, 'updated_at') ?? ''
  const prId = readNumber(pr, 'id') ?? number
  const externalMessageId = `pr-${prId}-${action}-${updatedAt}`

  return {
    ...base,
    chat: `pr:${number}`,
    thread: null,
    text,
    externalMessageId,
    authorId: String(sender.id),
    authorName: sender.login,
    authorIsBot: sender.type === 'Bot',
    isBotMention: true,
    replyToBotMessageId: null,
    ts: updatedAt !== '' ? Date.parse(updatedAt) || 0 : 0,
  }
}

export type GithubReviewerTeam = { slug: string; id: number; org: string | null }

export function readReviewerTeam(value: unknown): GithubReviewerTeam | null {
  const team = readRecord(value)
  const slug = readString(team, 'slug')
  const id = readNumber(team, 'id')
  if (slug === null || id === null) return null
  const org = readString(readRecord(team?.organization), 'login')
  return { slug, id, org }
}

function buildInbound(
  key: Pick<
    InboundMessage,
    'adapter' | 'workspace' | 'chat' | 'thread' | 'isDm' | 'mentionsOthers' | 'replyToOtherMessageId'
  >,
  rawText: unknown,
  id: number,
  user: GithubUser | null,
  selfLogin: string | null,
  rawTs: unknown,
): InboundMessage | null {
  if (user === null) return null
  const text = typeof rawText === 'string' ? rawText : ''
  return {
    ...key,
    text,
    externalMessageId: String(id),
    authorId: String(user.id),
    authorName: user.login,
    authorIsBot: user.type === 'Bot',
    isBotMention: selfLogin !== null && text.includes(`@${selfLogin}`),
    replyToBotMessageId: null,
    ts: typeof rawTs === 'string' ? Date.parse(rawTs) || 0 : 0,
  }
}

async function resolveTeamMembership(
  event: string,
  payload: Record<string, unknown>,
  options: GithubWebhookHandlerOptions,
): Promise<boolean | undefined> {
  if (event !== 'pull_request') return undefined
  const action = readString(payload, 'action')
  if (action !== 'review_requested' && action !== 'review_request_removed') return undefined
  const team = readReviewerTeam(payload.requested_team)
  if (team === null) return undefined
  const selfLogin = options.selfLogin()
  if (selfLogin === null) return false
  if (options.isBotInTeam === undefined) return false
  // The team payload sometimes omits `organization.login`. Fall back to the
  // repository owner, which is the only org GitHub can legally route team
  // reviewers from on a given PR.
  const org = team.org ?? readRepository(payload)?.owner ?? null
  if (org === null) return false
  try {
    return await options.isBotInTeam({ org, slug: team.slug, login: selfLogin })
  } catch (err) {
    options.logger.warn(`[github] team membership lookup failed: ${describe(err)}`)
    return false
  }
}

function readRepository(payload: Record<string, unknown>): { owner: string; name: string } | null {
  const repository = readRecord(payload.repository)
  const owner = readRecord(repository?.owner)
  const ownerLogin = readString(owner, 'login')
  const name = readString(repository, 'name')
  if (ownerLogin === null || name === null) return null
  return { owner: ownerLogin, name }
}

function readAuthor(payload: Record<string, unknown>): GithubUser | null {
  const candidates = [payload.comment, payload.issue, payload.pull_request, payload.discussion, payload.review]
  for (const candidate of candidates) {
    const user = readUser(readRecord(candidate)?.user)
    if (user !== null) return user
  }
  return null
}

// Matches by id OR login. Issue #452 captured a self-responding loop where
// the id-only guard didn't fire and the bot replied to its own comments ~8
// times in a row. Login is the second line of defense and aligns with the
// slack/discord/telegram/kakaotalk adapters, which all drop self-authored
// events at the classifier layer.
function isSelfAuthor(author: GithubUser, selfId: string | null, selfLogin: string | null): boolean {
  if (selfId !== null && String(author.id) === selfId) return true
  if (selfLogin !== null && author.login === selfLogin) return true
  return false
}

type GithubUser = { login: string; id: number; type?: string }

function readUser(value: unknown): GithubUser | null {
  const user = readRecord(value)
  const login = readString(user, 'login')
  const id = readNumber(user, 'id')
  if (login === null || id === null) return null
  const type = readString(user, 'type') ?? undefined
  return { login, id, ...(type !== undefined ? { type } : {}) }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown
    return readRecord(parsed)
  } catch {
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(obj: Record<string, unknown> | null, key: string): string | null {
  const value = obj?.[key]
  return typeof value === 'string' ? value : null
}

function readNumber(obj: Record<string, unknown> | null, key: string): number | null {
  const value = obj?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function ok(): Response {
  return new Response('ok', { status: 200 })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
