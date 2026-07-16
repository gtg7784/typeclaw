import { decodeSlackQr, type QrSession } from 'agent-messenger/slack'

// Slack's "Sign in on mobile" QR encodes a URL of the form:
//   https://app.slack.com/t/<workspace>/login/z-app-<app_id>-<secret>?src=qr_code&...
// For workspaces that enforce a confirmation code (a code delivered to the
// user's phone/email), completing the sign-in is a two-step HTTP flow:
//
//   1. GET the QR sign-in URL. It redirects onto the workspace host and renders
//      the "Enter your authentication code" React page. The page has no <form>;
//      instead it embeds a JSON blob in
//        <div id="props_node" data-props="{...}">
//      containing the fields needed to complete sign-in, most importantly
//      `magicLogin` (a second z-app secret) and `action` (`request_primary`
//      once the code has been sent). Reaching this page sends the code.
//   2. POST the confirmation code back to the workspace-host z-app path:
//        POST https://<ws>.slack.com/<z-app-path>?domain=<ws>&domainLogin=1&email=<email>
//        body: 2fa_magiclogin=<magicLogin>&remember=0&has_remember=false
//              &2fa_code=<code>&2fa_action=submit_primary
//      Slack responds 302 and sets the `d=xoxd-...` session cookie.
//
// The magicLogin secret and email are read from the server-rendered data-props,
// never guessed. Only the user's confirmation code is injected. Both the code
// submit contract and the data-props shape were captured from a real login.

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const DEFAULT_MAX_REDIRECTS = 10
const TOKEN_REGEX = /"api_token":"(xoxc-[a-zA-Z0-9-]+)"/

export type ConfirmationLoginError =
  | 'qr_decode_failed'
  | 'signin_page_not_found'
  | 'magic_login_not_found'
  | 'session_not_issued'
  | 'token_failed'

export class SlackConfirmationLoginError extends Error {
  readonly reason: ConfirmationLoginError
  constructor(reason: ConfirmationLoginError, message: string) {
    super(message)
    this.name = 'SlackConfirmationLoginError'
    this.reason = reason
  }
}

export type DecodedQr = { url: string; workspace: string }

export type ConfirmationLoginInput = {
  qrDataUrl: string
  email: string
  /** Called after Slack has sent the confirmation code; returns the code the user received. */
  requestCode: () => Promise<string>
  fetchImpl?: typeof fetch
  decodeQr?: (dataUrl: string) => DecodedQr
  maxRedirects?: number
  debug?: (message: string) => void
}

type SigninProps = {
  magicLogin: string
  emailAddress?: string
  twoFactorType?: string
  action?: string
}

export async function loginWithConfirmationCode(input: ConfirmationLoginInput): Promise<QrSession> {
  const doFetch = input.fetchImpl ?? fetch
  const debug = input.debug
  const decode = input.decodeQr ?? ((dataUrl: string) => decodeSlackQr(dataUrl) as DecodedQr)
  let login: DecodedQr
  try {
    login = decode(input.qrDataUrl.trim())
  } catch (err) {
    throw new SlackConfirmationLoginError('qr_decode_failed', err instanceof Error ? err.message : String(err))
  }
  debug?.(`Decoded QR for workspace ${login.workspace}`)

  const workspaceHost = `${login.workspace}.slack.com`
  const jar = new CookieJar()

  const page = await followToPage(doFetch, login.url, jar, input.maxRedirects ?? DEFAULT_MAX_REDIRECTS, debug)
  if (!page.html) {
    throw new SlackConfirmationLoginError(
      'signin_page_not_found',
      'Could not load the Slack sign-in page after opening the QR link. The link may have expired.',
    )
  }

  const props = parseSigninProps(page.html)
  if (!props?.magicLogin) {
    throw new SlackConfirmationLoginError(
      'magic_login_not_found',
      'Slack did not present a confirmation-code page. The QR link may have expired, or this workspace uses a different sign-in step.',
    )
  }
  debug?.(
    `Sign-in page loaded (twoFactorType=${props.twoFactorType ?? 'unknown'}, action=${props.action ?? 'unknown'})`,
  )

  const code = (await input.requestCode()).trim()

  const postUrl = new URL(page.finalUrl)
  postUrl.search = ''
  postUrl.searchParams.set('domain', login.workspace)
  postUrl.searchParams.set('domainLogin', '1')
  postUrl.searchParams.set('email', props.emailAddress ?? input.email)

  const body = encodeForm({
    '2fa_magiclogin': props.magicLogin,
    remember: '0',
    has_remember: 'false',
    '2fa_code': code,
    '2fa_action': 'submit_primary',
  })

  const cookie = await submitCode(
    doFetch,
    postUrl.toString(),
    body,
    jar,
    input.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    debug,
  )
  if (!cookie) {
    throw new SlackConfirmationLoginError(
      'session_not_issued',
      'The confirmation code was submitted but Slack did not issue a session cookie. The code may be wrong or expired.',
    )
  }
  debug?.('Captured session cookie')

  const token = await refreshTokenFromWeb(workspaceHost, cookie, doFetch)
  if (!token) {
    throw new SlackConfirmationLoginError(
      'token_failed',
      'Slack session was established but the client token could not be retrieved.',
    )
  }
  debug?.('Retrieved client token')

  return { token, cookie, workspace: login.workspace }
}

class CookieJar {
  private readonly map = new Map<string, string>()
  applySetCookies(headers: Headers): void {
    for (const raw of getSetCookies(headers)) {
      const pair = raw.split(';')[0]?.trim()
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      this.map.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
  }
  header(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  dCookie(): string | null {
    const d = this.map.get('d')
    return d && d.startsWith('xoxd-') ? d : null
  }
}

async function followToPage(
  doFetch: typeof fetch,
  startUrl: string,
  jar: CookieJar,
  maxRedirects: number,
  debug?: (m: string) => void,
): Promise<{ html: string; finalUrl: string }> {
  let url = startUrl
  for (let hop = 0; hop < maxRedirects; hop++) {
    if (!isSlackHost(url)) {
      debug?.(`hop ${hop}: refusing non-Slack host`)
      break
    }
    const res = await doFetch(url, { redirect: 'manual', headers: baseHeaders(jar) })
    jar.applySetCookies(res.headers)
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    debug?.(`hop ${hop}: ${res.status}${location ? ` -> ${location}` : ''}`)
    if (!location) {
      return { html: await res.text(), finalUrl: url }
    }
    const next = new URL(location, url).toString()
    if (!isSlackHost(next)) {
      debug?.(`hop ${hop}: redirect leaves Slack (${new URL(next).hostname}); stopping`)
      break
    }
    url = next
  }
  return { html: '', finalUrl: url }
}

async function submitCode(
  doFetch: typeof fetch,
  postUrl: string,
  body: string,
  jar: CookieJar,
  maxRedirects: number,
  debug?: (m: string) => void,
): Promise<string | null> {
  let url = postUrl
  const res = await doFetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...baseHeaders(jar), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  jar.applySetCookies(res.headers)
  debug?.(`code submit: ${res.status}`)
  if (jar.dCookie()) return jar.dCookie()

  // Follow post-login redirects (checkcookie -> ssb/redirect) collecting cookies.
  let location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
  for (let hop = 0; hop < maxRedirects && location; hop++) {
    const next = new URL(location, url).toString()
    if (!isSlackHost(next)) break
    url = next
    const hopRes = await doFetch(url, { redirect: 'manual', headers: baseHeaders(jar) })
    jar.applySetCookies(hopRes.headers)
    debug?.(`post-login hop ${hop}: ${hopRes.status}`)
    if (jar.dCookie()) return jar.dCookie()
    location = hopRes.status >= 300 && hopRes.status < 400 ? hopRes.headers.get('location') : null
  }
  return jar.dCookie()
}

async function refreshTokenFromWeb(host: string, cookie: string, doFetch: typeof fetch): Promise<string | null> {
  try {
    const res = await doFetch(`https://${host}/ssb/redirect`, {
      headers: { Cookie: `d=${cookie}`, 'User-Agent': BROWSER_USER_AGENT },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()
    return html.match(TOKEN_REGEX)?.[1] ?? null
  } catch {
    return null
  }
}

// The "Enter your authentication code" page embeds sign-in state as an
// HTML-escaped JSON blob inside <div id="props_node" data-props="{...}">.
function parseSigninProps(html: string): SigninProps | null {
  const match = html.match(/id="props_node"[^>]*\bdata-props="([^"]*)"/i)
  if (!match?.[1]) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeHtml(match[1]))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const magicLogin = typeof record.magicLogin === 'string' ? record.magicLogin : ''
  if (!magicLogin) return null
  return {
    magicLogin,
    emailAddress: typeof record.emailAddress === 'string' ? record.emailAddress : undefined,
    twoFactorType: typeof record.twoFactorType === 'string' ? record.twoFactorType : undefined,
    action: typeof record.action === 'string' ? record.action : undefined,
  }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function encodeForm(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

function baseHeaders(jar: CookieJar): Record<string, string> {
  const cookie = jar.header()
  return {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(cookie ? { Cookie: cookie } : {}),
  }
}

function isSlackHost(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    if (protocol !== 'https:') return false
    return hostname === 'slack.com' || hostname === 'app.slack.com' || hostname.endsWith('.slack.com')
  } catch {
    return false
  }
}

function getSetCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie()
  const single = headers.get('set-cookie')
  return single ? [single] : []
}
