import agentBrowserPlugin from '@/bundled-plugins/agent-browser'
import backupPlugin from '@/bundled-plugins/backup'
import explorerPlugin from '@/bundled-plugins/explorer'
import guardPlugin from '@/bundled-plugins/guard'
import memoryPlugin from '@/bundled-plugins/memory'
import operatorPlugin from '@/bundled-plugins/operator'
import securityPlugin from '@/bundled-plugins/security'
import toolResultCapPlugin from '@/bundled-plugins/tool-result-cap'
import type { ResolvedPlugin } from '@/plugin'

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
//
// `tool-result-cap` is registered before `guard` so guard's `tool.after`
// advice (uncommitted-changes warning) appends to already-capped content.
// Reversing this order would make guard advise on the full oversized payload
// and then tool-result-cap would clobber the advice text along with the rest.
//
// `memory` is registered before `backup` so memory's dreaming commits always
// land in the same git index window before backup's commit-and-push cycle.
// They commit disjoint paths today (memory/ vs sessions/ + agent changes),
// but if either ever holds .git/index.lock the deterministic order makes the
// contention easier to reason about.
export const BUNDLED_PLUGINS: ResolvedPlugin[] = [
  { name: 'security', version: undefined, source: '<bundled>', defined: securityPlugin },
  { name: 'tool-result-cap', version: undefined, source: '<bundled>', defined: toolResultCapPlugin },
  { name: 'guard', version: undefined, source: '<bundled>', defined: guardPlugin },
  { name: 'memory', version: undefined, source: '<bundled>', defined: memoryPlugin },
  { name: 'backup', version: undefined, source: '<bundled>', defined: backupPlugin },
  { name: 'agent-browser', version: undefined, source: '<bundled>', defined: agentBrowserPlugin },
  { name: 'explorer', version: undefined, source: '<bundled>', defined: explorerPlugin },
  { name: 'operator', version: undefined, source: '<bundled>', defined: operatorPlugin },
]
