import type { FetchAttachmentCallback } from '@/channels/types'

export function createGithubFetchAttachmentCallback(): FetchAttachmentCallback {
  return async () => ({ ok: false, error: 'github-bot-does-not-support-attachments' })
}
