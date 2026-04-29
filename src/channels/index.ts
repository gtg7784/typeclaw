export { createChannelManager, type ChannelManager, type ChannelManagerOptions } from './manager'
export { createChannelRouter, type ChannelRouter, type CreateChannelRouterOptions } from './router'
export { createChannelsReloadable } from './reloadable'
export {
  channelsSchema,
  isAllowed,
  isEngagementOff,
  ADAPTER_IDS,
  STICKY_DEFAULT_WINDOW_MS,
  type AdapterId,
  type AllowRule,
  type ChannelAdapterConfig,
  type ChannelsConfig,
  type EngagementConfig,
} from './schema'
export type { ChannelKey, InboundMessage, OutboundCallback, OutboundMessage, SendResult } from './types'
export { channelKeyId } from './types'
