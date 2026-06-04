import type { MinimalSessionOrigin } from '@/agent/session-meta'

const ADAPTER_DISPLAY: Record<string, string> = {
  'slack-bot': 'Slack',
  'discord-bot': 'Discord',
  github: 'GitHub',
  'telegram-bot': 'Telegram',
  kakaotalk: 'KakaoTalk',
}

const SLACK_CHAT_PREFIX_ADAPTERS = new Set(['slack-bot', 'discord-bot'])

export function originLabel(origin: MinimalSessionOrigin): string {
  switch (origin.kind) {
    case 'tui':
      return 'TUI'
    case 'cron':
      return `Cron ${origin.jobId} (${origin.jobKind})`
    case 'subagent':
      return `Subagent ${origin.subagent}`
    case 'channel':
      return channelLabel(origin)
    case 'system':
      return `System ${origin.component}`
  }
}

function channelLabel(origin: Extract<MinimalSessionOrigin, { kind: 'channel' }>): string {
  const platform = ADAPTER_DISPLAY[origin.adapter] ?? origin.adapter
  const chatPart = renderChat(origin)
  const wsPart = renderWorkspace(origin)
  if (wsPart === '') return `${platform} ${chatPart}`
  return `${platform} ${wsPart}/${chatPart}`
}

function renderChat(origin: Extract<MinimalSessionOrigin, { kind: 'channel' }>): string {
  if (origin.chatName !== undefined && origin.chatName !== '') {
    const prefix = SLACK_CHAT_PREFIX_ADAPTERS.has(origin.adapter) ? '#' : ''
    return `${prefix}${origin.chatName}`
  }
  return origin.chat
}

function renderWorkspace(origin: Extract<MinimalSessionOrigin, { kind: 'channel' }>): string {
  if (origin.workspaceName !== undefined && origin.workspaceName !== '') return origin.workspaceName
  return origin.workspace
}

export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId
  return sessionId.slice(0, 12)
}
