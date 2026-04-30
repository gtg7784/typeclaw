import { z } from 'zod'

import { BUNDLED_PLUGINS } from './bundled-plugins'

export function buildConfigSchemaWithBundledPlugins(coreSchema: z.ZodObject): z.ZodObject {
  const pluginShape: Record<string, z.ZodType> = {}
  for (const plugin of BUNDLED_PLUGINS) {
    const schema = plugin.defined.configSchema
    if (schema !== undefined) {
      pluginShape[plugin.name] = schema as z.ZodType
    }
  }
  return coreSchema.extend(pluginShape)
}
