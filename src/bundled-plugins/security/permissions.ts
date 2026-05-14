export const SECURITY_PERMISSIONS = {
  bypassSecretExfilBash: 'security.bypass.secretExfilBash',
  bypassGitExfil: 'security.bypass.gitExfil',
  bypassSecretExfilRead: 'security.bypass.secretExfilRead',
  bypassSsrf: 'security.bypass.ssrf',
  bypassSessionSearchSecrets: 'security.bypass.sessionSearchSecrets',
  bypassSystemPromptLeak: 'security.bypass.systemPromptLeak',
  bypassOutboundSecret: 'security.bypass.outboundSecret',
  bypassGitRemoteTainted: 'security.bypass.gitRemoteTainted',
} as const

export type SecurityPermission = (typeof SECURITY_PERMISSIONS)[keyof typeof SECURITY_PERMISSIONS]
