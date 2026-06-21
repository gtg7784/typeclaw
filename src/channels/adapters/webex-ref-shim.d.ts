// TEMPORARY SHIM — delete when agent-messenger ships ref siblings (tracks
// upstream #244 + WebexPerson/WebexMessage/WebexMembership ref work).
//
// typeclaw stores the decoded UUID ref as its canonical Webex identity. Every
// id-bearing object agent-messenger returns therefore needs a `*Ref` sibling
// (the trailing UUID; an email for legacy PEOPLE). These augmentations declare
// the surface we build against now; the installed 2.23.2 types lack them, so
// without this shim typecheck fails. When the SDK version that exports these
// lands, bump the dep and remove this file — the real types take over and the
// `module augmentation has no effect` lint will flag any leftover.

import 'webex-message-handler'
import 'agent-messenger/webex'

declare module 'webex-message-handler' {
  interface DecryptedMessage {
    ref: string
    parentRef?: string
    roomRef: string
    personRef: string
    mentionedPeopleRefs: string[]
  }
}

declare module 'agent-messenger/webex' {
  interface WebexPerson {
    ref: string
  }
  interface WebexMessage {
    ref: string
    roomRef: string
    personRef: string
    parentRef?: string
  }
  interface WebexMembership {
    personRef: string
    roomRef: string
  }
}
