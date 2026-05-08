import type { ResolvedPlugin } from '@/plugin'

import agentBrowserPlugin from '../../plugins/agent-browser'
import guardPlugin from '../../plugins/guard'
import memoryPlugin from '../../plugins/memory'
import securityPlugin from '../../plugins/security'

// Consumed by both `startAgent` (auto-loaded before user plugins) AND
// `scripts/generate-schema.ts` (each entry's `defined.configSchema` is merged
// into `typeclaw.schema.json` keyed by plugin name). Adding a bundled plugin
// here automatically extends the JSON schema; core `configSchema` does not
// need to know about plugin-owned blocks.
//
// Order matters: `security` is listed first because its `tool.before` hook
// must get first refusal on every tool call (HookBus runs hooks in
// registration order and short-circuits on the first `{ block: true }`).
// Letting `guard` run first would still work today since the two plugins
// guard disjoint surfaces, but seeding the order now means future overlap
// (e.g. a security policy on writes) blocks before guard's softer advice.
export const BUNDLED_PLUGINS: ResolvedPlugin[] = [
  { name: 'security', version: undefined, source: '<bundled>', defined: securityPlugin },
  { name: 'guard', version: undefined, source: '<bundled>', defined: guardPlugin },
  { name: 'memory', version: undefined, source: '<bundled>', defined: memoryPlugin },
  { name: 'agent-browser', version: undefined, source: '<bundled>', defined: agentBrowserPlugin },
]
