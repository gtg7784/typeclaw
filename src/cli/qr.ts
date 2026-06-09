import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import QRCode from 'qrcode'

const execFileAsync = promisify(execFile)

// The upstream LINE SDK's QR login hands back a raw auth URL
// (https://line.me/R/au/q/...), which is not scannable on its own — the LINE
// mobile app needs an actual QR image. This module renders that URL the way the
// upstream `agent-line` CLI does: an HTML page opened in the browser plus, on a
// TTY, an inline ASCII QR. Every external effect is best-effort so a non-TTY or
// browserless host degrades to a machine-readable scan payload rather than
// blocking login.

export type QRPresentation = {
  qrUrl: string
  htmlPath: string | null
  terminal: string | null
  opened: boolean
}

export type DisplayQROptions = {
  title: string
  scanInstruction: string
  brandColor?: string
  isTty?: boolean
  opener?: (filePath: string) => Promise<void>
  tmpDir?: string
  now?: () => number
}

export async function buildQRHtml(
  url: string,
  options: { title: string; scanInstruction: string; brandColor: string },
): Promise<string> {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2 })
  const title = escapeHtml(options.title)
  const instruction = escapeHtml(options.scanInstruction)
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:-apple-system,system-ui,sans-serif;background:${options.brandColor}}
.card{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.15)}
h1{margin:0 0 8px;font-size:22px;color:#111}p{margin:0 0 24px;color:#666;font-size:14px}
svg{width:280px;height:280px}</style></head>
<body><div class="card"><h1>${title}</h1><p>${instruction}</p>${svg}</div></body></html>`
}

export async function renderTerminalQR(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'terminal', small: true })
}

// Writes the QR HTML to a temp file and tries to open it in the default
// browser, and (when on a TTY) renders an inline ASCII QR. Every external
// effect is best-effort: a failure to write, open, or render degrades the
// result rather than throwing, so login is never blocked by presentation.
export async function displayQR(url: string, options: DisplayQROptions): Promise<QRPresentation> {
  const brandColor = options.brandColor ?? '#06C755'
  const isTty = options.isTty ?? process.stderr.isTTY === true
  const now = options.now ?? Date.now
  const dir = options.tmpDir ?? tmpdir()

  const htmlPath = await writeQRHtmlFile(url, {
    title: options.title,
    scanInstruction: options.scanInstruction,
    brandColor,
    dir,
    stamp: now(),
  })

  let opened = false
  if (htmlPath !== null) {
    const open = options.opener ?? openInBrowser
    opened = await open(htmlPath).then(
      () => true,
      () => false,
    )
  }

  const terminal = isTty ? await renderTerminalQR(url).catch(() => null) : null

  return { qrUrl: url, htmlPath, terminal, opened }
}

async function writeQRHtmlFile(
  url: string,
  options: { title: string; scanInstruction: string; brandColor: string; dir: string; stamp: number },
): Promise<string | null> {
  try {
    const html = await buildQRHtml(url, options)
    const slug =
      options.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'qr'
    const htmlPath = join(options.dir, `typeclaw-${slug}-${options.stamp}.html`)
    await writeFile(htmlPath, html, { mode: 0o600 })
    return htmlPath
  } catch {
    return null
  }
}

async function openInBrowser(filePath: string): Promise<void> {
  const platform = process.platform
  if (platform === 'darwin') {
    await execFileAsync('open', [filePath])
    return
  }
  if (platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', filePath])
    return
  }
  await execFileAsync('xdg-open', [filePath])
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
