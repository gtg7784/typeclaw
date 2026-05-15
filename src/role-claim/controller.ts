import type { ClaimHandler } from '@/channels/router'
import { grantRole, type PermissionService } from '@/permissions'

import { extractClaimCode } from './code'
import { formatClaimMatchRule } from './match-rule'
import { createPendingClaimRegistry, type PendingClaim, type PendingClaimRegistry } from './pending'

// ClaimController is the runtime singleton that ties the four moving parts
// of the role-claim flow together:
//
//   1. The host CLI (typeclaw role claim) opens a WS and sends `claim_start`.
//   2. The WS server forwards that to controller.startClaim().
//   3. The channel router's claimHandler (also wired here) intercepts DMs
//      bearing the code and calls controller.tryConsumeInbound().
//   4. On consume, the controller writes to typeclaw.json#roles.<role>.match
//      via grantRole, then reloads the live PermissionService so the new
//      match rule takes effect without a container restart.
//
// Result events (completed / error / cancelled) are pushed to subscribers
// the WS server registers, so the host CLI's open WS receives the outcome
// over the same connection.

export type ClaimCompletedEvent = {
  kind: 'completed'
  code: string
  role: string
  matchRule: string
  adapter: string
  authorId: string
}

export type ClaimErrorEvent = {
  kind: 'error'
  code: string
  reason: string
}

export type ClaimCancelledEvent = {
  kind: 'cancelled'
  code: string
}

export type ClaimResultEvent = ClaimCompletedEvent | ClaimErrorEvent | ClaimCancelledEvent

export type ClaimController = {
  startClaim: (input: { code: string; role: string; channel?: string; ttlMs: number }) =>
    | {
        ok: true
        expiresAt: number
      }
    | { ok: false; reason: string }
  cancelClaim: (code: string) => boolean
  current: () => PendingClaim | null
  onResult: (subscriber: (event: ClaimResultEvent) => void) => () => void
  claimHandler: ClaimHandler
}

export type CreateClaimControllerOptions = {
  cwd: string
  permissions: PermissionService
  rolesProvider: () => import('@/permissions').RolesConfig | undefined
  now?: () => number
  registry?: PendingClaimRegistry
  // Test seam: injectable role granter so tests don't touch disk. Production
  // wires the real `grantRole` from src/permissions/grant.ts.
  grant?: (roleName: string, matchRule: string) => { ok: true; added: boolean } | { ok: false; reason: string }
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
}

const KNOWN_BUILT_IN_ROLES = new Set(['owner', 'member', 'trusted'])

export function createClaimController(opts: CreateClaimControllerOptions): ClaimController {
  const now = opts.now ?? Date.now
  const registry = opts.registry ?? createPendingClaimRegistry({ now })
  const grant =
    opts.grant ?? ((roleName: string, matchRule: string) => grantRole({ cwd: opts.cwd, roleName, matchRule }))
  const logger = opts.logger ?? defaultLogger
  const subscribers = new Set<(event: ClaimResultEvent) => void>()

  const emit = (event: ClaimResultEvent): void => {
    for (const sub of subscribers) {
      try {
        sub(event)
      } catch (err) {
        logger.warn(`[role-claim] subscriber threw: ${describe(err)}`)
      }
    }
  }

  const startClaim: ClaimController['startClaim'] = ({ code, role, channel, ttlMs }) => {
    if (!isValidRoleName(role)) {
      return { ok: false, reason: `unknown role '${role}' — built-in roles are owner, member, trusted` }
    }
    const startedAt = now()
    const pending: PendingClaim = {
      code,
      role,
      ttlMs,
      startedAt,
      expiresAt: startedAt + ttlMs,
      ...(channel !== undefined ? { channel } : {}),
    }
    registry.start(pending)
    return { ok: true, expiresAt: pending.expiresAt }
  }

  const claimHandler: ClaimHandler = async (input) => {
    const code = extractClaimCode(input.text)
    if (code === null) return { kind: 'fallthrough' }

    const result = registry.tryConsume(
      code,
      {
        adapter: input.adapter,
        workspace: input.workspace,
        chat: input.chat,
        isDm: input.isDm,
        authorId: input.authorId,
      },
      formatClaimMatchRule,
    )

    if (result.kind === 'no-pending') return { kind: 'fallthrough' }
    if (result.kind === 'no-match') return { kind: 'fallthrough' }
    if (result.kind === 'wrong-channel') {
      const reply = `That claim is for a different channel — please run typeclaw role claim again on this one.`
      emit({ kind: 'error', code, reason: 'wrong-channel' })
      return { kind: 'fail', reply }
    }
    if (result.kind === 'expired') {
      const reply = `That claim code has expired. Run typeclaw role claim again to start a new one.`
      emit({ kind: 'error', code, reason: 'expired' })
      return { kind: 'fail', reply }
    }

    const granted = grant(result.role, result.matchRule)
    if (!granted.ok) {
      const reply = `Sorry, I couldn't save your role: ${granted.reason}`
      emit({ kind: 'error', code, reason: granted.reason })
      return { kind: 'fail', reply }
    }

    try {
      opts.permissions.replaceRoles(opts.rolesProvider())
    } catch (err) {
      logger.warn(`[role-claim] replaceRoles failed after grant: ${describe(err)}`)
    }

    emit({
      kind: 'completed',
      code,
      role: result.role,
      matchRule: result.matchRule,
      adapter: result.origin.adapter,
      authorId: result.origin.authorId,
    })

    const noteAdded = granted.added ? '' : ' (already on file)'
    const reply = `You're paired as ${result.role}${noteAdded}. Welcome aboard!`
    return { kind: 'consumed', reply }
  }

  return {
    startClaim,
    cancelClaim: (code) => {
      const cancelled = registry.cancel(code)
      if (cancelled) emit({ kind: 'cancelled', code })
      return cancelled
    },
    current: () => registry.current(),
    onResult: (sub) => {
      subscribers.add(sub)
      return () => {
        subscribers.delete(sub)
      }
    },
    claimHandler,
  }
}

function isValidRoleName(role: string): boolean {
  if (KNOWN_BUILT_IN_ROLES.has(role)) return true
  return /^[a-z][a-z0-9-]*$/.test(role) && role !== 'guest'
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const defaultLogger = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
}
