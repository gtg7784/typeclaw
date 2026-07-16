import { describe, expect, test } from 'bun:test'

import { loginWithConfirmationCode, SlackConfirmationLoginError } from './slack-confirmation-login'

const WS = 'acme'
const QR_PATH = 'z-app-1563306880084-11602666734978-abcdef'
const MAGIC = 'z-app-1563306880084-11630999195424-ghijkl'
const QR_URL = `https://app.slack.com/t/${WS}/login/${QR_PATH}?src=qr_code&user_id=U1&team_id=T1`
const WS_PAGE_URL = `https://${WS}.slack.com/${QR_PATH}?src=qr_code&user_id=U1&team_id=T1`

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
}

function redirect(location: string, setCookie?: string[]): Response {
  const res = new Response('', { status: 302, headers: new Headers({ location }) })
  if (setCookie) for (const c of setCookie) res.headers.append('set-cookie', c)
  return res
}

function enterCodePage(): Response {
  const props = {
    teamName: 'Acme',
    error: null,
    twoFactorType: 'sms',
    emailAddress: 'user@acme.com',
    action: 'request_primary',
    magicLogin: MAGIC,
    remember: false,
    hasRemember: false,
  }
  const escaped = JSON.stringify(props).replace(/"/g, '&quot;')
  return html(`<div id="enter_code_app_root"><div id="props_node" data-props="${escaped}"></div></div>`)
}

describe('loginWithConfirmationCode', () => {
  test('reads magicLogin from data-props, submits the code, and retrieves the token', async () => {
    const submitted: { url: string; body: string }[] = []
    let sawSession = false

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''

      if (method === 'GET' && url === QR_URL) return redirect(WS_PAGE_URL)
      if (method === 'GET' && url === WS_PAGE_URL) return enterCodePage()
      if (method === 'POST' && url.includes(QR_PATH)) {
        submitted.push({ url, body })
        sawSession = true
        return redirect('https://slack.com/checkcookie?redir=https%3A%2F%2Facme.slack.com%2Fssb%2Fredirect', [
          'd=xoxd-secret; path=/; domain=.slack.com; secure; httponly',
          'd-s=1784; path=/; domain=.slack.com; secure; httponly',
        ])
      }
      if (method === 'GET' && url.startsWith('https://slack.com/checkcookie')) {
        return redirect('https://acme.slack.com/ssb/redirect')
      }
      if (url === 'https://acme.slack.com/ssb/redirect') {
        return html(`<script>var boot = {"api_token":"xoxc-fresh-token"};</script>`)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }) as typeof fetch

    const result = await loginWithConfirmationCode({
      qrDataUrl: 'ignored',
      email: 'user@acme.com',
      requestCode: async () => '123456',
      fetchImpl,
      decodeQr: () => ({ url: QR_URL, workspace: WS }),
    })

    expect(sawSession).toBe(true)
    expect(result.token).toBe('xoxc-fresh-token')
    expect(result.cookie).toBe('xoxd-secret')
    expect(result.workspace).toBe(WS)

    const submit = submitted[0]
    expect(submit?.url).toContain(`https://${WS}.slack.com/${QR_PATH}`)
    expect(submit?.url).toContain('domain=acme')
    expect(submit?.url).toContain('domainLogin=1')
    expect(submit?.url).toContain('email=user%40acme.com')
    expect(submit?.url).not.toContain('src=qr_code')
    expect(submit?.body).toContain(`2fa_magiclogin=${encodeURIComponent(MAGIC)}`)
    expect(submit?.body).toContain('2fa_code=123456')
    expect(submit?.body).toContain('2fa_action=submit_primary')
  })

  test('throws magic_login_not_found when the page has no data-props', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === QR_URL) return redirect(WS_PAGE_URL)
      if (url === WS_PAGE_URL) return html('<div>Link Expired</div>')
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await expect(
      loginWithConfirmationCode({
        qrDataUrl: 'ignored',
        email: 'user@acme.com',
        requestCode: async () => '000000',
        fetchImpl,
        decodeQr: () => ({ url: QR_URL, workspace: WS }),
      }),
    ).rejects.toMatchObject({ reason: 'magic_login_not_found' })
  })

  test('throws session_not_issued when no session cookie is set', async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url === QR_URL) return redirect(WS_PAGE_URL)
      if (method === 'GET' && url === WS_PAGE_URL) return enterCodePage()
      if (method === 'POST' && url.includes(QR_PATH)) return html('<div>Invalid code</div>')
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }) as typeof fetch

    const result = loginWithConfirmationCode({
      qrDataUrl: 'ignored',
      email: 'user@acme.com',
      requestCode: async () => '999999',
      fetchImpl,
      decodeQr: () => ({ url: QR_URL, workspace: WS }),
    })
    await expect(result).rejects.toBeInstanceOf(SlackConfirmationLoginError)
    await expect(result).rejects.toMatchObject({ reason: 'session_not_issued' })
  })
})
