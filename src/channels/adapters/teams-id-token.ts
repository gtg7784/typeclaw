import { TeamsClient } from 'agent-messenger/teams'

import type { TeamsAccountRecord } from '@/secrets/schema'

// The Teams realtime trouter WebSocket authenticates every connect (and every
// reconnect) with an `Authorization: Bearer <idToken>` header. The upstream
// agent-messenger SDK only knows how to obtain that token by scraping the
// `authtoken` cookie out of the Teams desktop app's on-disk SQLite database (or
// a local Chromium profile) — see agent-messenger/.../teams/token-extractor.ts.
// TypeClaw runs headless in a container where neither exists, so the scrape
// always returns null and the SDK throws `no_id_token` on start and in a
// reconnect loop.
//
// The token the trouter wants is an ordinary AAD OAuth bearer for the Teams /
// Skype "spaces" resource — the SAME resource family that our stored
// `aad_refresh_token` was minted against by the device-code login
// (agent-messenger/.../teams/device-login.ts stores `skypeScoped.refreshToken`).
// So instead of scraping, we mint the bearer in-container with a standard AAD
// `refresh_token` grant, exactly as the SDK's own `exchangeForSkypeScope` does.
// Those helpers are not exported from `agent-messenger/teams`, so the minimal
// grant is reproduced here; the scope/authority constants are mirrored from the
// SDK's `app-config.ts` and traced back to it in the comments below.

// From agent-messenger/.../teams/app-config.ts:
//   DEVICE_CODE_SCOPE_SKYPE      (personal / MSA)
//   WORK_DEVICE_CODE_SCOPE_SKYPE (work / AAD)
const SKYPE_SCOPE_PERSONAL = 'service::api.fl.spaces.skype.com::MBI_SSL openid profile offline_access'
const SKYPE_SCOPE_WORK = 'https://api.spaces.skype.com/.default openid profile offline_access'

// From agent-messenger/.../teams/app-config.ts: CONSUMER_TENANT_ID / WORK_TENANT_ID
const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'
const WORK_TENANT_AUTHORITY = 'organizations'

// From agent-messenger/.../teams/app-config.ts: TEAMS_WEB_CLIENT_ID / TEAMS_DESKTOP_CLIENT_ID.
// Only used when the stored account never captured its own aad_client_id.
const TEAMS_WEB_CLIENT_ID = '5e3ce6c0-2b1f-4285-8d4b-75ee78787346'
const TEAMS_DESKTOP_CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type MintTeamsIdTokenDeps = {
  fetch?: FetchLike
}

// Returns a freshly minted skype/spaces-scoped AAD access token to use as the
// trouter bearer, or null when the account lacks the AAD refresh trio needed to
// mint one (a legacy extracted-token account) — the caller degrades to REST-only
// in that case. Throws only on an unexpected transport failure; an AAD error
// response resolves to null so the caller degrades rather than crash-loops.
export async function mintTeamsIdToken(
  account: TeamsAccountRecord,
  deps: MintTeamsIdTokenDeps = {},
): Promise<string | null> {
  const refreshToken = account.aad_refresh_token
  if (refreshToken === undefined || refreshToken === '') return null

  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init))
  const clientId = account.aad_client_id ?? defaultClientId(account.account_type)
  const scope = account.account_type === 'personal' ? SKYPE_SCOPE_PERSONAL : SKYPE_SCOPE_WORK

  let response: Response
  try {
    response = await doFetch(tokenUrl(account), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope,
      }),
    })
  } catch {
    return null
  }

  if (!response.ok) return null
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown }
  return typeof body.access_token === 'string' && body.access_token !== '' ? body.access_token : null
}

export type TeamsIdTokenMinter = (account: TeamsAccountRecord) => Promise<string | null>

// A TeamsClient whose realtime `getIdToken()` mints the trouter bearer from the
// account's AAD refresh token instead of scraping a desktop/browser cookie.
// `TeamsListener` re-calls this on every (re)connect, so it re-mints each time —
// matching the SDK's own "re-extract on every attempt" contract. Returning null
// (legacy account without the AAD trio, or an expired refresh token) makes the
// SDK throw `no_id_token`, which the adapter catches to degrade to REST-only.
export class ContainerTeamsClient extends TeamsClient {
  constructor(
    private readonly idTokenAccount: () => TeamsAccountRecord | null,
    private readonly mint: TeamsIdTokenMinter = mintTeamsIdToken,
  ) {
    super()
  }

  override async getIdToken(): Promise<string | null> {
    const account = this.idTokenAccount()
    return account === null ? null : this.mint(account)
  }
}

function tokenUrl(account: TeamsAccountRecord): string {
  const tenant =
    account.account_type === 'personal' ? CONSUMER_TENANT_ID : (account.aad_tenant_id ?? WORK_TENANT_AUTHORITY)
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
}

function defaultClientId(accountType: TeamsAccountRecord['account_type']): string {
  return accountType === 'work' ? TEAMS_DESKTOP_CLIENT_ID : TEAMS_WEB_CLIENT_ID
}
