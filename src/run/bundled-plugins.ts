import type { ResolvedPlugin } from '@/plugin'

import agentBrowserPlugin from '../../plugins/agent-browser'
import memoryPlugin from '../../plugins/memory'

// Consumed by both `startAgent` (auto-loaded before user plugins) AND
// `scripts/generate-schema.ts` (each entry's `defined.configSchema` is merged
// into `typeclaw.schema.json` keyed by plugin name). Adding a bundled plugin
// here automatically extends the JSON schema; core `configSchema` does not
// need to know about plugin-owned blocks.
export const BUNDLED_PLUGINS: ResolvedPlugin[] = [
  { name: 'memory', version: undefined, source: '<bundled>', defined: memoryPlugin },
  { name: 'agent-browser', version: undefined, source: '<bundled>', defined: agentBrowserPlugin },
]
