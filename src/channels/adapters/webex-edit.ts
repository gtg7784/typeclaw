import type { AdapterId } from '@/channels/schema'
import type { EditMessageCallback, EditMessageResult } from '@/channels/types'

// Both WebexClient and WebexBotClient expose the same edit primitive
// (webex-bot delegates to webex), so one factory serves both adapters —
// parameterized on the adapter id it guards against. Webex addresses an edit
// by (messageId, roomId): the router's `chat` IS the roomId.
type WebexEditClient = {
  editMessage: (messageId: string, roomId: string, text: string, options?: { markdown?: boolean }) => Promise<unknown>
}

export function createWebexEditMessageCallback(deps: {
  adapter: Extract<AdapterId, 'webex' | 'webex-bot'>
  client: WebexEditClient
}): EditMessageCallback {
  return async (req): Promise<EditMessageResult> => {
    if (req.adapter !== deps.adapter) {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'not-supported' }
    }
    try {
      await deps.client.editMessage(req.messageId, req.chat, req.text)
    } catch (err) {
      return { ok: false, error: describe(err), code: classifyEditError(err) }
    }
    return { ok: true }
  }
}

// Webex REST returns 404 for a gone/foreign message id and 403 when the token
// can't edit the target; anything else is treated as a soft not-found miss.
function classifyEditError(err: unknown): NonNullable<(EditMessageResult & { ok: false })['code']> {
  const status = httpStatus(err)
  if (status === 403 || status === 401) return 'permission-denied'
  return 'not-found'
}

function httpStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
