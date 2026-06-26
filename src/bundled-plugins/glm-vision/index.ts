import { join } from 'node:path'

import { z } from 'zod'

import { definePlugin } from '@/plugin'

const glmVisionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    version: z.string().default('0.1.4'),
  })
  .default({ enabled: true, version: '0.1.4' })

export default definePlugin({
  configSchema: glmVisionConfigSchema,
  permissions: ['mcp'],
  plugin: async (ctx) => {
    if (!ctx.config.enabled) return {}
    if (!ctx.models.usesProvider('zai-coding')) return {}

    const hasKey = ctx.hasSecret('ZAI_CODING_API_KEY')
    const doctorChecks = {
      'coding-key': {
        description: 'GLM vision (Z.AI) coding-plan key is configured',
        run: async () => {
          // Presence-only; never read or log the secret value.
          const keyPresent =
            typeof process.env.ZAI_CODING_API_KEY === 'string' && process.env.ZAI_CODING_API_KEY.length > 0
          if (keyPresent) {
            return { status: 'ok' as const, message: 'ZAI_CODING_API_KEY present; GLM vision MCP active' }
          }
          return {
            status: 'warning' as const,
            message: 'Set ZAI_CODING_API_KEY to enable GLM vision (bunx @z_ai/mcp-server)',
          }
        },
      },
    }

    const baseExports = {
      skillsDirs: [join(import.meta.dir, 'skills')],
      doctorChecks,
    }

    if (!hasKey) return baseExports

    return {
      ...baseExports,
      mcpServers: {
        'glm-vision': {
          description:
            'GLM-4.6V vision via the GLM Coding Plan: image/video analysis, OCR, UI-to-code, diagram and chart reading.',
          transport: {
            type: 'stdio' as const,
            command: 'bunx',
            args: [`@z_ai/mcp-server@${ctx.config.version}`],
            env: { Z_AI_API_KEY: { env: 'ZAI_CODING_API_KEY' }, Z_AI_MODE: { value: 'ZAI' } },
          },
        },
      },
    }
  },
})
