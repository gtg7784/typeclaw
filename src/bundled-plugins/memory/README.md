# typeclaw-plugin-memory

The bundled memory plugin. Owns `memory/topics/` (sharded long-term memory) and `memory/streams/yyyy-MM-dd.jsonl` (daily fragment streams) plus three subagents that read and write them: `memory-logger`, `dreaming`, `memory-retrieval`.

Auto-loaded by every TypeClaw agent. No `plugins[]` entry to add and no opt-out. Configure via the `memory` block in `typeclaw.json`.

## Config

```json
{
  "memory": {
    "idleMs": 60000,
    "bufferBytes": 500000,
    "injectionBudgetBytes": 16384,
    "dreaming": { "schedule": "*/30 * * * *" }
  }
}
```

| Field                         | Default          | Effect                                                                                                                                                                                                                                         |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.idleMs`               | `60000`          | Debounce window before `memory-logger` spawns after a prompt completes. Minimum `1000`.                                                                                                                                                        |
| `memory.bufferBytes`          | `500000`         | Size-based ceiling: spawns `memory-logger` when the transcript grows by this many bytes since the last run. `0` disables. Minimum `10000` when non-zero.                                                                                       |
| `memory.injectionBudgetBytes` | `16384`          | Total shard-body budget for direct-mode memory injection. Above this, `loadMemory` switches to index-mode (headings + metadata only) and the agent must call `memory_search` to fetch specific topics or recent stream events. Minimum `4096`. |
| `memory.dreaming.schedule`    | `"*/30 * * * *"` | Five-field cron expression for the dreaming subagent.                                                                                                                                                                                          |

All fields are **restart-required** — the plugin reads them once at boot.

## What it contributes

| Kind     | Name                       | Notes                                                                                                                                                                                                                                                                          |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subagent | `memory-logger`            | Reads a parent transcript past a watermark and appends fragments to `memory/streams/<today>.jsonl`. Coalesced per `agentDir`.                                                                                                                                                  |
| Subagent | `dreaming`                 | Reads shards under `memory/topics/` plus undreamed daily-stream events and rebalances the topic shards. Coalesced per `agentDir`. Citation-superset invariant enforced on every run.                                                                                           |
| Subagent | `memory-retrieval`         | On `session.prompt` when injection plan is `index` mode, reads recent prompt + shard listing, writes a focused summary to `memory/.retrieval-cache/<sessionId>.md`. Coalesced per `parentSessionId`.                                                                           |
| Tool     | `memory_search`            | Main-agent tool. Substring/regex search across BOTH topic shards (slugs, frontmatter, bodies) and undreamed daily-stream events (fragment topic/body, legacy prose). Results are discriminated by `source: "topic" \| "stream"`; topics come first, then streams newest-first. |
| Tool     | `delete_topic_shard`       | Subagent-only (dreaming). Deletes a topic shard at `memory/topics/<slug>.md`. Path-guarded.                                                                                                                                                                                    |
| Cron     | `__plugin_memory_dreaming` | `kind: 'prompt'`, `subagent: 'dreaming'`, scheduled per `memory.dreaming.schedule`.                                                                                                                                                                                            |
| Hook     | `session.idle`             | Per-session debouncer with size-based ceiling. Spawns `memory-logger` on idle or buffer-trip.                                                                                                                                                                                  |
| Hook     | `session.end`              | Spawns `memory-logger` immediately; also unlinks the retrieval-cache file for this session.                                                                                                                                                                                    |
| Hook     | `session.prompt`           | When `buildInjectionPlan` returns `mode: 'index'` and origin is not a subagent, spawns `memory-retrieval` to write the cache file used by the next `loadMemory` call.                                                                                                          |

## Memory injection (two-tier)

Default budget is 16 KB. Direct mode when shard bytes sum ≤ budget: all shard bodies are injected verbatim. Index mode when sum > budget: only heading + `cites=N, days=N, lastReinforced=YYYY-MM-DD` per shard, plus a directive for the agent to call `memory_search` to fetch specific topics or recent stream events.

**Channel-origin always uses index mode regardless of total size** — defends against memory bleed into channel responses (the agent treats injected memory as instructions when channel users see it).

When index mode is active, the `memory-retrieval` subagent fires on `session.prompt`, reads the user's recent prompt, decides what's relevant across BOTH topic shards and undreamed stream events, pulls them via `memory_search`/`read`, and writes a focused ≤8 KB summary to `memory/.retrieval-cache/<sessionId>.md`. The NEXT `loadMemory` call for the same session reads and appends that cache file (lag-by-one-prompt). The cache file is unlinked on `session.end`.

## Memory saturation

The dreaming subagent treats topic shards like human long-term memory: **repetition strengthens, lack of repetition saturates**. On every run the runtime computes per-shard strength signals from each shard's frontmatter (`cites`, `days`, `lastReinforced`) and renders them as a table at the top of the dreaming subagent's user prompt.

The subagent uses these signals to:

1. **Promote strong topics.** `days = 1` → tentative ("the user mentioned"). `days >= 3` → confident ("the user consistently"). `days >= 7` → declarative ("the user always"). Promotion is gated on distinct days, not raw citation count.
2. **Merge near-duplicates.** Topics that overlap get folded into one. The merged topic's citation set is the union.
3. **Demote decayed topics.** A weak/decayed topic stays as its own shard but the body should be trimmed to a single line. When index-mode injection is in effect, demoted shards' bodies don't enter the system prompt at all — the index plus `memory_search` retrieval cover them on demand.

There is no `## Historical observations` bucket. Demoted topics live as their own shards; injection-time filtering (the index/direct split) handles the prompt-budget pressure.

## Citation-superset safety net

`checkCitationSupersetAcrossShards` checks that the union of fragment ids cited in NEW shards is a superset of the union cited in OLD shards. Violation triggers:

1. `restoreShardSnapshot` restores every pre-run shard to byte-identical bytes AND deletes any new shards created during the run.
2. Daily-stream fragment GC is skipped.
3. Dreamed-ids ADVANCE anyway — the **conscious anti-loop tradeoff**: orphaned fragments survive in the daily JSONL (force-committed) but won't be re-shown to a future dreaming run. The alternative (don't advance) would infinite-loop if the LLM keeps making the same mistake.
4. The commit is skipped.

A `[dreaming] citation-superset violation: …` warning logs the dropped ids and explicitly names the orphaning tradeoff.

## Files on disk

- **`memory/topics/<slug>.md`** — per-topic shards with YAML frontmatter (`heading`, `cites`, `days`, `lastReinforced`, `tags?`) + body markdown. Runtime owns the frontmatter (recomputed after every dreaming run from the body's citations); dreaming subagent writes body only.
- **`memory/streams/yyyy-MM-dd.jsonl`** — daily fragment streams. One event per line, discriminated union of `fragment | watermark | legacy_prose`. Force-committed alongside the shards.
- **`memory/MEMORY.md.pre-shard.bak`** — one-shot pre-migration backup created by the boot migration. Safe to delete after verifying.
- **`memory/skills/<name>/SKILL.md`** — muscle memory. Skills the dreaming subagent distills from repeated procedures. Auto-loaded as first-class skills.
- **`memory/.dreaming-state.json`** — per-day dreamed-id sets.
- **`memory/.retrieval-cache/<sessionId>.md`** — ephemeral retrieval summaries. Written by `memory-retrieval`, read by `loadMemory` on the next prompt of the same session, unlinked on `session.end`.

## One-shot boot migration

When the plugin boots against an agent folder with a root `MEMORY.md` and no `memory/topics/`, it runs `runShardingMigration`. Steps:

1. Detect prerequisites.
2. Reset `memory/.migrating/` if a previous run crashed mid-flight.
3. Run the legacy `.md → .jsonl` daily-stream migration (existing behavior).
4. Parse `MEMORY.md` via `parseTopicsWithBodies`.
5. **Stage topic shards** in `memory/.migrating/topics/` (originals untouched).
6. **Stage streams** by COPY (not rename) to `memory/.migrating/streams/`.
7. Stage pre-shard backup by COPY.
8. **Verify staging** via `checkCitationSupersetAcrossShards`. On failure, abort and KEEP `memory/.migrating/` for human inspection. Originals untouched.
9. **Atomic finalization**: rename three dirs (`topics`, `streams`, `.pre-shard.bak`), then unlink originals.

Crash-recovery branches at boot: stale `memory/.migrating/` with no `topics/` → cleanup + retry; leftover `memory/.migrating/` alongside complete `topics/` → cleanup only; orphan root `MEMORY.md` or `memory/<date>.jsonl` alongside the new layout → delete orphans.

The migration is idempotent and crash-safe.

## How `session.idle` works

Core fires `session.idle` immediately after every `session.prompt()` completion. The plugin owns the debounce: a `Map<sessionId, Timeout>` reset on every event. When the timer fires, the plugin spawns `memory-logger` for that session.

If the user starts a new prompt before the timer fires, the next `session.idle` resets it. If the user disconnects, `session.end` cancels the timer and fires `memory-logger` immediately.

In busy channel sessions the agent rarely goes idle long enough to trip the timer. The size-based ceiling handles this: on every `session.idle` the plugin `fs.stat`s the transcript and compares against the size at the last memory-logger run. Once growth reaches `memory.bufferBytes`, the timer is cancelled and `memory-logger` spawns immediately.

## Tests

Test files in this directory (kebab-case, `.test.ts` neighbors): `paths`, `slug`, `frontmatter`, `topics`, `shard-snapshot`, `delete-tool`, `citations`, `citation-superset`, `migration`, `load-shards`, `load-memory`, `injection-plan`, `search-tool`, `memory-retrieval`, `memory-logger`, `dreaming`, `index`, `integration`. Plus guard policies in `../guard/policies/`: `memory-topics-delete`, `memory-topics-write`, `memory-retrieval-cache-write`.

## Migration notes (from before the plugin existed)

- `memory.idleMs` and `memory.dreaming.schedule` already existed in core's `typeclaw.json` schema and moved into this plugin's `configSchema` verbatim.
- `memory.dreaming.schedule` is now **restart-required** because plugin config is read once at boot.
- The cron job ID is `__plugin_memory_dreaming` (previously `__internal_dreaming`).
