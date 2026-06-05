import { WORDMARK_LINES } from '@/shared/wordmark'

import { colors } from './theme'

export type BannerInfo = {
  sessionId: string
  serverVersion?: string
  displayUrl: string
}

export function formatBanner({ sessionId, serverVersion, displayUrl }: BannerInfo): string {
  const logo = WORDMARK_LINES.map((line) => colors.accent(line)).join('\n')
  const version = serverVersion === undefined ? '' : colors.dim(` v${serverVersion}`)
  const card = [
    `${colors.accent('●')} ${colors.bold('session')}${version}  ${colors.dim(sessionId)}`,
    `${colors.dim('  ')}${colors.dim(displayUrl)}`,
  ].join('\n')
  return `${logo}\n\n${card}`
}
