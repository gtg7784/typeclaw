import type { Stream } from '@/stream'

import { parsePrVerdictActivityPayload } from './github-verdict-activity'
import type { ChannelRouter } from './router'

export type PrVerdictActivityBridgeLogger = {
  info: (msg: string) => void
}

export type PrVerdictActivityBridgeOptions = {
  stream: Stream
  router: Pick<ChannelRouter, 'injectPrVerdictActivity'>
  logger?: PrVerdictActivityBridgeLogger
}

export type PrVerdictActivityBridge = {
  stop: () => void
}

const consoleLogger: PrVerdictActivityBridgeLogger = {
  info: (msg) => console.log(msg),
}

// Bridges `pr.verdict-activity` broadcasts on the in-process Stream into a router
// call so the OTHER live sessions reviewing the same PR get a stand-down reminder
// once one of them lands a formal verdict. Mirrors the subagent-completion bridge:
// one broadcast subscriber, self-filtering payload parse, single router call. The
// verdict reaches the bus via the turn-ledger review observer (src/run/index.ts),
// because plugins have no direct stream access.
export function createPrVerdictActivityBridge(options: PrVerdictActivityBridgeOptions): PrVerdictActivityBridge {
  const logger = options.logger ?? consoleLogger
  const unsubscribe = options.stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const parsed = parsePrVerdictActivityPayload(msg.payload)
    if (parsed === null) return
    const result = options.router.injectPrVerdictActivity(parsed)
    if (result.count > 0) {
      logger.info(
        `[channels] pr-verdict stand-down fanned out to ${result.count} sibling session(s) for ${parsed.workspace}#${parsed.prNumber} verdict=${parsed.verdict}`,
      )
    }
  })
  return { stop: unsubscribe }
}
