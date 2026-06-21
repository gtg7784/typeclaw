// Webex REST ids are base64url of `ciscospark://<cluster>/<TYPE>/<trailing>`.
// The opaque base64 blob is unreadable in logs, `inspect`, and — worst —
// hand-authored permission match rules (`webex:* author:Y2lzY29zcGFyazov...`).
// A `ref` is the decoded trailing value: a plain UUID for ROOM/ORG/MESSAGE,
// a UUID OR an email for PERSON (legacy "Hydra" accounts encode the email),
// and a `personUUID:roomUUID` pair for MEMBERSHIP.
//
// This mirrors agent-messenger's `decodeWebexId` / `toRef` (PR #242/#243)
// exactly, kept local so typeclaw does not depend on the upstream release
// landing first. Once `agent-messenger/webex` re-exports these publicly we
// can swap the import without changing call sites — the semantics match.
//
// `toRef` is intentionally NOT used for outbound API calls: typeclaw keeps the
// canonical base64 id as the wire/session currency. `ref` is for the human-
// facing surfaces (permission rules, logs, inspect) and for accepting a short
// id back as input where the cluster can be recovered from context.

export type WebexRestIdType =
  | 'ROOM'
  | 'PEOPLE'
  | 'MESSAGE'
  | 'ORGANIZATION'
  | 'TEAM'
  | 'MEMBERSHIP'
  | 'ATTACHMENT_ACTION'

export type DecodedWebexId = {
  cluster: string
  type: string
  trailing: string
}

const CISCOSPARK_URI = /^ciscospark:\/\/([^/]+)\/([^/]+)\/(.+)$/

export function decodeWebexId(restId: string): DecodedWebexId | null {
  if (restId === '') return null
  let decoded: string
  try {
    // Buffer's 'base64' mode accepts both base64url ('-'/'_') and missing
    // padding, so it decodes Webex ids across every cluster encoding.
    decoded = Buffer.from(restId, 'base64').toString('utf-8')
  } catch {
    return null
  }
  const match = CISCOSPARK_URI.exec(decoded)
  if (match === null) return null
  return { cluster: match[1]!, type: match[2]!, trailing: match[3]! }
}

export function toRef(id: string): string {
  const decoded = decodeWebexId(id)
  return decoded === null ? id : decoded.trailing
}

// Refuses cross-type collisions: a decoded ROOM uuid must never satisfy an
// `author:` (PERSON) rule even if the trailing uuid strings happen to match.
export function isWebexIdOfType(id: string, type: WebexRestIdType): boolean {
  const decoded = decodeWebexId(id)
  return decoded !== null && decoded.type === type
}
