import { z } from 'zod'

import { definePlugin } from '@/plugin'

import { type CapOptions, capToolResult } from './cap-result'

const DEFAULT_IMAGE_MAX_BYTES = 262_144
const DEFAULT_TEXT_MAX_BYTES = 65_536
const MIN_IMAGE_MAX_BYTES = 1_024
const MIN_TEXT_MAX_BYTES = 1_024

export const toolResultCapConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    imageMaxBytes: z.number().int().min(MIN_IMAGE_MAX_BYTES).default(DEFAULT_IMAGE_MAX_BYTES),
    textMaxBytes: z.number().int().min(MIN_TEXT_MAX_BYTES).default(DEFAULT_TEXT_MAX_BYTES),
    exemptTools: z.array(z.string()).default([]),
  })
  .default({
    enabled: true,
    imageMaxBytes: DEFAULT_IMAGE_MAX_BYTES,
    textMaxBytes: DEFAULT_TEXT_MAX_BYTES,
    exemptTools: [],
  })

// Helper for non-plugin call sites (e.g. channel-session-factory's load-time
// pass) to parse the same `tool-result-cap` config block and resolve it to
// the runtime options shape, or `null` when the plugin is disabled. Keeps
// the schema and the disable rule in one place.
export function resolveCapOptionsFromConfig(raw: unknown): CapOptions | null {
  const parsed = toolResultCapConfigSchema.parse(raw)
  if (!parsed.enabled) return null
  return {
    imageMaxBytes: parsed.imageMaxBytes,
    textMaxBytes: parsed.textMaxBytes,
    exemptTools: new Set(parsed.exemptTools),
  }
}

export default definePlugin({
  configSchema: toolResultCapConfigSchema,
  plugin: async (ctx) => {
    const { enabled, imageMaxBytes, textMaxBytes, exemptTools } = ctx.config
    if (!enabled) return {}

    const options = {
      imageMaxBytes,
      textMaxBytes,
      exemptTools: new Set(exemptTools),
    }

    return {
      hooks: {
        'tool.after': (event) => {
          const stats = capToolResult(event.tool, event.result, options)
          if (stats.imagesReplaced > 0 || stats.textsTruncated > 0) {
            ctx.logger.info(
              `[tool-result-cap] capped ${event.tool} call=${event.callId}: imagesReplaced=${stats.imagesReplaced} textsTruncated=${stats.textsTruncated} bytesElided=${stats.bytesElided}`,
            )
          }
        },
      },
    }
  },
})
