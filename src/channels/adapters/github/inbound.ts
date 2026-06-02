import { createHmac, timingSafeEqual } from 'node:crypto'

import type { GithubReviewOn } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { GithubAuthContext } from './auth'
import { removeRequestedReviewer } from './decoy-reviewer'
import type { DeliveryDedup } from './dedup'
import { isGithubEventAllowed } from './event-allowlist'
import { encodeGithubReactionRef, type GithubReactionTarget } from './reactions'

export type GithubInboundLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export type GithubWebhookHandlerOptions = {
  webhookSecret: string
  dedup: DeliveryDedup
  allowlist: () => readonly string[]
  selfId: () => string | null
  selfLogin: () => string | null
  // Defaults to 'pat' when omitted. In 'app' mode classifyReviewRequest also
  // matches the App's decoy reviewer login; see resolveDecoyReviewerLogin.
  authType?: () => 'pat' | 'app'
  // Defaults to true when omitted. When it returns false, every inbound carries
  // an appended operator-policy note telling the agent not to submit an APPROVE
  // review; the github skill keys off that note to downgrade approve→COMMENT.
  allowApprove?: () => boolean
  // Which pull_request action triggers an agent code review. Defaults to
  // 'review_requested' when omitted, preserving the request-driven behavior.
  // 'opened' additionally wakes the bot to review every PR the moment it opens;
  // 'off' suppresses the dedicated review-trigger synthesis entirely (an
  // explicit review_requested no longer wakes a session). Orthogonal to the
  // eventAllowlist (the outer "process this webhook?" gate) — this is the inner
  // "does an admitted pull_request event become a review-trigger inbound?" gate.
  reviewOn?: () => GithubReviewOn
  route: (message: InboundMessage) => void
  logger: GithubInboundLogger
  // Optional: resolves whether the bot is a member of the given team. When
  // omitted, team-reviewer requests are silently dropped (the v1 fallback
  // behavior). The adapter wires this in production; tests inject a fake.
  isBotInTeam?: (input: { org: string; slug: string; login: string }) => Promise<boolean>
  // App-auth only: mints a repo-scoped token used to drop the decoy reviewer
  // once the bot's own review lands. Omitted under PAT auth (no decoy exists).
  authToken?: (context?: GithubAuthContext) => Promise<string>
  // Schedules the decoy-drop off the webhook ACK path so the 200 stays fast.
  // Defaults to fire-and-forget; tests inject a recorder to await the task.
  scheduleBackgroundTask?: (task: () => Promise<void>) => void
  fetchImpl?: typeof fetch
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
    const author = readAuthor(event, payload)
    if (author !== null && isSelfAuthor(author, selfId, selfLogin)) {
      maybeScheduleDecoyReviewerDrop({ event, action, payload, selfLogin, options })
      options.logger.info(
        `[github] dropped self-authored ${event}${action !== null ? `.${action}` : ''} from @${author.login}`,
      )
      return ok()
    }

    const teamIsBotMember = await resolveTeamMembership(event, payload, options)
    const classified = classifyGithubInbound(event, payload, selfLogin, {
      teamIsBotMember,
      authType: options.authType?.() ?? 'pat',
      reviewOn: options.reviewOn?.() ?? 'review_requested',
    })
    if (classified === null) return ok()

    if (delivery !== '') options.dedup.add(delivery)
    options.route(withApprovalPolicy(classified, options.allowApprove?.() ?? true))
    return ok()
  }
}

export const PR_APPROVAL_DISABLED_NOTE =
  'Operator policy: PR approval is disabled for this agent ' +
  '(`channels.github.review.approve: false`). If you review a PR and the ' +
  'verdict is `approve`, submit a `COMMENT` review instead of `APPROVE` — post ' +
  'the findings, but never formally approve.'

// Gating PR approval lives here (inbound text), not at the bash layer: the
// review is posted via `gh api --input <file>`, so the `event: APPROVE` value
// sits in a temp file the gh-cli-auth command interceptor never inspects. The
// note rides on every inbound (cheap: one line, only when an operator has
// opted out) so it reaches the agent for both webhook review requests and
// plain-language "@bot review this" asks, which arrive on arbitrary inbounds.
function withApprovalPolicy(message: InboundMessage, allowApprove: boolean): InboundMessage {
  if (allowApprove) return message
  const text = message.text === '' ? PR_APPROVAL_DISABLED_NOTE : `${message.text}\n\n${PR_APPROVAL_DISABLED_NOTE}`
  return { ...message, text }
}

// GitHub auto-records the App as a reviewer the moment its review posts, but
// leaves the decoy user pinned as a perpetual "review requested". When the bot
// drops its own review (the self-authored event we're about to discard), fire a
// background DELETE to remove the decoy. The DELETE is authenticated as the App,
// so the resulting review_request_removed webhook has the bot actor as sender
// and is dropped by classifyReviewRequest's self-loop guard — no fresh session.
function maybeScheduleDecoyReviewerDrop(input: {
  event: string
  action: string | null
  payload: Record<string, unknown>
  selfLogin: string | null
  options: GithubWebhookHandlerOptions
}): void {
  const { event, action, payload, selfLogin, options } = input
  if (event !== 'pull_request_review' || action !== 'submitted') return
  if (selfLogin === null) return
  const authToken = options.authToken
  if (authToken === undefined) return
  if ((options.authType?.() ?? 'pat') !== 'app') return
  const decoyLogin = resolveDecoyReviewerLogin(selfLogin, 'app')
  if (decoyLogin === null) return

  const repository = readRepository(payload)
  const pr = readRecord(payload.pull_request)
  const pullNumber = readNumber(pr, 'number')
  if (repository === null || pullNumber === null) return

  const fetchImpl = options.fetchImpl ?? fetch
  const schedule = options.scheduleBackgroundTask ?? defaultScheduleBackgroundTask
  const target = `${repository.owner}/${repository.name}#${pullNumber}`
  schedule(async () => {
    // authToken can throw (installation lookup / token mint), and a thrown
    // failure must still warn — the default scheduler swallows rejections, so
    // catching here is the only place the failure is observable.
    try {
      const token = await authToken({ repoSlug: `${repository.owner}/${repository.name}` })
      const result = await removeRequestedReviewer({
        fetchImpl,
        token,
        owner: repository.owner,
        repo: repository.name,
        pullNumber,
        reviewerLogin: decoyLogin,
      })
      if (result.kind === 'failed') {
        options.logger.warn(`[github] failed to drop decoy reviewer @${decoyLogin} from ${target}: ${result.reason}`)
      }
    } catch (err) {
      options.logger.warn(
        `[github] failed to drop decoy reviewer @${decoyLogin} from ${target}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })
}

function defaultScheduleBackgroundTask(task: () => Promise<void>): void {
  void task().catch(() => {})
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
  options?: { teamIsBotMember?: boolean; authType?: 'pat' | 'app'; reviewOn?: GithubReviewOn },
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
      { kind: 'issue-comment', owner: repository.owner, repo: repository.name, commentId: id },
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
      { kind: 'pr-review-comment', owner: repository.owner, repo: repository.name, commentId: id },
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
      null,
    )
  }

  if (event === 'issues') {
    const issue = readRecord(payload.issue)
    if (issue === null) return null
    const number = readNumber(issue, 'number')
    const id = readNumber(issue, 'id') ?? number
    if (number === null || id === null) return null
    const opener = readUser(issue.user)
    const hasBody = readString(issue, 'body')?.trim() ? true : false
    return buildInbound(
      { ...base, chat: `issue:${number}`, thread: null },
      bodyOrOpenedTitle(issue.body, opener, 'issue', number, readString(issue, 'title')),
      id,
      opener,
      selfLogin,
      issue.created_at,
      { kind: 'issue', owner: repository.owner, repo: repository.name, issueNumber: number },
      !hasBody,
    )
  }

  if (event === 'pull_request') {
    const pr = readRecord(payload.pull_request)
    if (pr === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(pr, 'id') ?? number
    if (number === null || id === null) return null
    const action = readString(payload, 'action')
    const reviewOn = options?.reviewOn ?? 'review_requested'
    if (action === 'review_requested' || action === 'review_request_removed') {
      // `off` disables the dedicated review trigger: these two actions exist
      // only to drive review-request behavior here, so under `off` they wake no
      // session rather than falling through to awareness-only context.
      if (reviewOn === 'off') return null
      return classifyReviewRequest({
        action,
        payload,
        pr,
        number,
        base,
        selfLogin,
        authType: options?.authType ?? 'pat',
        teamIsBotMember: options?.teamIsBotMember,
      })
    }
    if (action === 'opened' && reviewOn === 'opened') {
      const trigger = classifyOpenedReviewTrigger({
        payload,
        pr,
        number,
        base,
        selfLogin,
        authType: options?.authType ?? 'pat',
      })
      if (trigger !== null) return trigger
    }
    const opener = readUser(pr.user)
    const hasBody = readString(pr, 'body')?.trim() ? true : false
    const prText =
      action === 'opened' ? bodyOrOpenedTitle(pr.body, opener, 'PR', number, readString(pr, 'title')) : pr.body
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: null },
      prText,
      id,
      opener,
      selfLogin,
      pr.created_at,
      { kind: 'issue', owner: repository.owner, repo: repository.name, issueNumber: number },
      action === 'opened' && !hasBody,
    )
  }

  if (event === 'pull_request_review') {
    const pr = readRecord(payload.pull_request)
    const review = readRecord(payload.review)
    if (pr === null || review === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(review, 'id')
    if (number === null || id === null) return null
    const reviewer = readUser(review.user)
    const body = readString(review, 'body')
    const hasBody = body !== null && body.trim() !== ''
    const text = hasBody
      ? body
      : reviewer !== null
        ? synthesizeReviewStateText(reviewer.login, number, readString(pr, 'title'), readString(review, 'state'))
        : ''
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: null },
      text,
      id,
      reviewer,
      selfLogin,
      review.submitted_at,
      null,
      !hasBody,
    )
  }

  if (event === 'discussion') {
    const discussion = readRecord(payload.discussion)
    if (discussion === null) return null
    const number = readNumber(discussion, 'number')
    const id = readNumber(discussion, 'id') ?? number
    if (number === null || id === null) return null
    const action = readString(payload, 'action')
    const opener = readUser(discussion.user)
    const hasBody = readString(discussion, 'body')?.trim() ? true : false
    const text =
      action === 'created'
        ? bodyOrOpenedTitle(discussion.body, opener, 'discussion', number, readString(discussion, 'title'))
        : discussion.body
    return buildInbound(
      { ...base, chat: `discussion:${number}`, thread: null },
      text,
      id,
      opener,
      selfLogin,
      discussion.created_at,
      null,
      action === 'created' && !hasBody,
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
  authType: 'pat' | 'app'
  teamIsBotMember: boolean | undefined
}

// A GitHub App can never be a `requested_reviewer` — that field only holds
// real user accounts, and the App actor (`slug[bot]`) is not one. The
// supported workaround is a decoy user account named after the App that an
// operator requests instead (see docs/content/docs/internals/github-decoy-reviewer.mdx).
// Its login is, by convention, the App slug — i.e. `selfLogin` with the
// `[bot]` suffix removed (`my-app[bot]` → `my-app`). This is the single seam
// where that login is resolved: when the decoy account's real login diverges
// from the slug, a future config field replaces this derivation without
// touching the matcher. PAT auth has no decoy (the bot IS a real user that can
// be requested directly), so it returns null.
const BOT_LOGIN_SUFFIX = '[bot]'

function resolveDecoyReviewerLogin(selfLogin: string, authType: 'pat' | 'app'): string | null {
  if (authType !== 'app') return null
  if (!selfLogin.endsWith(BOT_LOGIN_SUFFIX)) return null
  const slug = selfLogin.slice(0, -BOT_LOGIN_SUFFIX.length)
  return slug !== '' ? slug : null
}

function classifyReviewRequest(input: ReviewRequestInput): InboundMessage | null {
  const { action, payload, pr, number, base, selfLogin, authType, teamIsBotMember } = input
  if (selfLogin === null) return null
  const decoyLogin = resolveDecoyReviewerLogin(selfLogin, authType)
  const sender = readUser(payload.sender)
  if (sender === null) return null
  // Self-loop guard: if the bot (or its decoy) requested/un-requested the
  // review, drop the event. The bot adding itself as a reviewer would
  // otherwise wake a fresh session every time it self-assigns.
  if (sender.login === selfLogin || (decoyLogin !== null && sender.login === decoyLogin)) return null

  const requestedUser = readUser(payload.requested_reviewer)
  const requestedTeam = readReviewerTeam(payload.requested_team)

  const isMeAsUser =
    requestedUser !== null &&
    (requestedUser.login === selfLogin || (decoyLogin !== null && requestedUser.login === decoyLogin))
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

type OpenedReviewTriggerInput = {
  payload: Record<string, unknown>
  pr: Record<string, unknown>
  number: number
  base: Pick<InboundMessage, 'adapter' | 'workspace' | 'isDm' | 'mentionsOthers' | 'replyToOtherMessageId'>
  selfLogin: string | null
  authType: 'pat' | 'app'
}

function classifyOpenedReviewTrigger(input: OpenedReviewTriggerInput): InboundMessage | null {
  const { payload, pr, number, base, selfLogin, authType } = input
  if (selfLogin === null) return null
  const sender = readUser(payload.sender) ?? readUser(pr.user)
  if (sender === null) return null
  // Defensive self-loop guard mirroring classifyReviewRequest: the handler-level
  // self-author drop already discards bot-opened PRs, but the decoy account is a
  // distinct login, so a decoy-opened PR would otherwise wake a self-review.
  const decoyLogin = resolveDecoyReviewerLogin(selfLogin, authType)
  if (sender.login === selfLogin || (decoyLogin !== null && sender.login === decoyLogin)) return null

  const title = readString(pr, 'title') ?? `#${number}`
  const head = readString(readRecord(pr.head), 'ref')
  const baseRef = readString(readRecord(pr.base), 'ref')
  const branchSegment = head !== null && baseRef !== null ? ` Branch: ${head} → ${baseRef}.` : ''
  const text =
    `@${sender.login} opened PR #${number}: "${title}".${branchSegment}` +
    ' Please review the changes line-by-line and post your feedback.'

  const updatedAt = readString(pr, 'updated_at') ?? ''
  const prId = readNumber(pr, 'id') ?? number
  const externalMessageId = `pr-${prId}-opened-${updatedAt}`

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
  reactionTarget: GithubReactionTarget | null,
  synthesizedAwareness = false,
): InboundMessage | null {
  if (user === null) return null
  const text = typeof rawText === 'string' ? rawText : ''
  // A body-less inbound reaches engagement as contentless text; in a solo-human
  // channel the fallback engages on it and the agent replies with a generic
  // greeting. The other adapters drop empty text at their classifier — this is
  // the matching guard. Events whose empty body still carries signal (review
  // state, opened-PR/issue title) synthesize non-empty text upstream and so
  // never reach this drop.
  if (text.trim() === '') return null
  // Synthesized awareness lines carry an `@author` prefix describing who acted;
  // that handle is the author, never a third-party mention of the bot, so the
  // body-text mention heuristic must not fire on it.
  const isBotMention = !synthesizedAwareness && selfLogin !== null && text.includes(`@${selfLogin}`)
  return {
    ...key,
    text,
    externalMessageId: String(id),
    ...(reactionTarget !== null ? { reactionRef: encodeGithubReactionRef(reactionTarget) } : {}),
    authorId: String(user.id),
    authorName: user.login,
    authorIsBot: user.type === 'Bot',
    isBotMention,
    replyToBotMessageId: null,
    ts: typeof rawTs === 'string' ? Date.parse(rawTs) || 0 : 0,
  }
}

function bodyOrOpenedTitle(
  rawBody: unknown,
  opener: GithubUser | null,
  kind: 'issue' | 'PR' | 'discussion',
  number: number,
  title: string | null,
): string {
  const body = typeof rawBody === 'string' ? rawBody : ''
  if (body.trim() !== '' || opener === null) return body
  const label = title !== null && title.trim() !== '' ? `: "${title}"` : ''
  return `@${opener.login} opened ${kind} #${number}${label}.`
}

// Neutral phrasing per review state — must never imply a review was requested
// or that action is needed; a COMMENTED review in particular must not read as
// "please review", which is the review-request path's wording.
function synthesizeReviewStateText(
  reviewer: string,
  number: number,
  title: string | null,
  state: string | null,
): string {
  const label = title !== null && title.trim() !== '' ? `: "${title}"` : ''
  // GitHub's pull_request_review webhook can send the state in either case
  // depending on the source (webhook payload vs REST), so normalize before
  // matching — an unmatched state would silently fall back to the neutral verb.
  const normalized = state?.toLowerCase() ?? null
  const verb =
    normalized === 'approved'
      ? 'approved'
      : normalized === 'changes_requested'
        ? 'requested changes on'
        : 'submitted a review on'
  return `@${reviewer} ${verb} PR #${number}${label}.`
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

function readAuthor(event: string, payload: Record<string, unknown>): GithubUser | null {
  for (const candidate of eventAuthorCandidates(event, payload)) {
    const user = readUser(readRecord(candidate)?.user)
    if (user !== null) return user
  }
  // Every GitHub webhook payload carries `sender` — the actor who triggered the
  // delivery. It is the universal fallback so events not enumerated above (and
  // any future ones the user adds to eventAllowlist) still drop self-authored
  // deliveries instead of slipping past the guard.
  return readUser(payload.sender)
}

// Maps each event to the entity whose `user` is the true author of THIS event,
// listed before broader containers. A pull_request_review payload ships both
// `pull_request` (the PR author) and `review` (the reviewer); the self-author
// drop must see the reviewer, so `review` must come first. PR #455's flat order
// (`pull_request` before `review`) made a self-review on someone else's PR
// resolve to the PR author, slip past the drop, and loop (see PR #460).
//
// `pull_request` and `pull_request_review_thread` carry only the `pull_request`
// container, whose `user` is the PR OPENER — not the actor of this delivery.
// For these events the self-author question is "who triggered the action?"
// (review_requested, edited, reopened, resolved, …), which is always
// `payload.sender`, never the opener. Mapping them to `[]` makes readAuthor
// skip the opener and fall through to the `sender` fallback. PR #462's
// `['pull_request']` resolved to the opener, so a human action on a
// bot-opened PR matched the bot and was wrongly dropped (the inbound landed
// as awareness-only "Recent context" and the agent never replied).
const PRIMARY_AUTHOR_KEYS: Record<string, readonly string[]> = {
  issue_comment: ['comment'],
  pull_request_review_comment: ['comment'],
  discussion_comment: ['comment'],
  commit_comment: ['comment'],
  pull_request_review: ['review'],
  pull_request_review_thread: [],
  issues: ['issue'],
  pull_request: [],
  discussion: ['discussion'],
  release: ['release'],
}

const FALLBACK_AUTHOR_KEYS = ['comment', 'review', 'issue', 'pull_request', 'discussion', 'release'] as const

function eventAuthorCandidates(event: string, payload: Record<string, unknown>): unknown[] {
  const keys = PRIMARY_AUTHOR_KEYS[event] ?? FALLBACK_AUTHOR_KEYS
  return keys.map((key) => payload[key])
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
