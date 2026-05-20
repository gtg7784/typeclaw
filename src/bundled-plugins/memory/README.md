# typeclaw-plugin-memory

The bundled memory plugin. Owns `MEMORY.md` (long-term memory) and `memory/yyyy-MM-dd.jsonl` (daily streams) plus the two subagents that write them: `memory-logger` and `dreaming`.

This plugin is **auto-loaded** by every TypeClaw agent. There is no `plugins[]` entry to add and no opt-out. To configure it, add a `memory` block to `typeclaw.json`.

## Config

```json
{
  "memory": {
    "idleMs": 10000,
    "bufferBytes": 100000,
    "dreaming": { "schedule": "*/30 * * * *" }
  }
}
```

| Field                      | Default            | Effect                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory.idleMs`            | `10000`            | Debounce window before `memory-logger` spawns after a prompt completes. Minimum `1000`.                                                                                                                                                                                                                                                                            |
| `memory.bufferBytes`       | `100000`           | Size-based ceiling: spawns `memory-logger` when the transcript grows by this many bytes since the last run, even during continuous activity. `0` disables. Minimum `10000` when non-zero.                                                                                                                                                                          |
| `memory.dreaming`          | `{}` (cron job on) | Dreaming cron job is always registered. Override `schedule` to change when it fires.                                                                                                                                                                                                                                                                               |
| `memory.dreaming.schedule` | `"*/30 * * * *"`   | Five-field cron expression. Defaults to every 30 minutes; fires short-circuit with zero LLM cost when nothing sits past the watermark, so frequent no-op fires are cheap and let sporadic agents still consolidate while alive (`src/cron/scheduler.ts` has no catchup for missed fires). Second-level schedules are rejected to avoid noisy no-op dreaming loops. |

All fields are **restart-required** — the plugin reads them once at boot.

## What it contributes

| Kind     | Name                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagent | `memory-logger`            | Reads a parent transcript past a watermark and appends fragments to `memory/<today>.jsonl`. Coalesced per `agentDir`; the plugin chains spawn calls onto a per-agent Promise so two concurrent channel sessions never race on the same daily stream file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Subagent | `dreaming`                 | Reads `MEMORY.md` plus undreamed daily-stream events, **rebalances** the existing topics using per-topic strength signals (citation count, distinct days, recency) injected into its user prompt, rewrites `MEMORY.md` with `memory/yyyy-MM-dd#<fragment-id>` citations, optionally writes muscle-memory skills under `memory/skills/<name>/SKILL.md`, advances the per-day dreamed-id set, **compacts daily streams** by dropping superseded watermarks and dreamed-but-uncited fragments, then commits the result with a summary message (`dream: <summary> <emoji>`, e.g. `dream: 3 fragments + new skill 'pr-review' 🔮`). Coalesced per `agentDir`. The runtime enforces a **citation-superset invariant** on every rewrite: a new MEMORY.md that drops any previously-cited fragment id is reverted to its pre-run bytes (dreamed-ids still advance so the run is not retried in a loop). |
| Cron job | `__plugin_memory_dreaming` | `kind: 'prompt'`, `subagent: 'dreaming'`, scheduled per `memory.dreaming.schedule`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Hook     | `session.idle`             | Per-session debouncer with size-based ceiling. Resets a `setTimeout(idleMs)` on every event; on fire, calls `ctx.spawnSubagent('memory-logger', ...)`. Also `fs.stat`s the transcript on every event and spawns immediately when growth since the last run reaches `bufferBytes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Hook     | `session.end`              | Cancels the debounce timer and immediately spawns `memory-logger` (so the final transcript is captured even when the user disconnects right away).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Memory injection

The rendered `# Memory` section (MEMORY.md + undreamed daily-stream tails) is injected into every session's system prompt by core (`src/agent/index.ts` `createResourceLoader` → `loadMemory`), **not** by a plugin hook. It is appended as the last block of the system prompt, after `gitNudge`, so the most-volatile content (daily streams that grow after every memory-logger fire) sits at the bottom of the cache-suffix region. This way a memory change only invalidates the memory section itself rather than everything downstream of it.

## Memory saturation (LTP/LTD analogue)

MEMORY.md is read into every session's system prompt, so its size is the prompt budget for everything else. Without a saturation policy it grows monotonically — every consolidated topic survives forever and citations accumulate across days. The dreaming subagent therefore treats MEMORY.md like human long-term memory: **repetition strengthens, lack of repetition saturates**.

### How

On every run the runtime computes per-topic strength signals from MEMORY.md's existing citations — `cites` (total), `days` (distinct calendar days those citations span), `last reinforced` (most recent citation date), `age (d)` (whole days since `last reinforced`). The numbers are derived by `src/bundled-plugins/memory/strength.ts` and rendered as a table at the top of the dreaming subagent's user prompt. There is no sidecar file, no schema version, no migration — strength is recomputed on every run from MEMORY.md alone.

The subagent uses these numbers to:

1. **Promote strong topics.** `days = 1` → tentative ("the user mentioned"). `days >= 3` → confident ("the user consistently"). `days >= 7` → declarative ("the user always"). Promotion is gated on distinct days, not raw citation count — five citations on one day is one debugging session, five citations across five days is a recurring pattern.
2. **Merge near-duplicates.** Topics that overlap in subject matter get folded into one, with the merged topic's `fragments:` list as the **union** of the source topics' fragment ids.
3. **Demote decayed topics.** A topic with `cites = 1, days = 1, age >= 30` (or `cites <= 3, days <= 2, age >= 60`) routes into a `## Historical observations` bucket as a one-line bullet. The fact is preserved in the summary, the citation is preserved (so daily-stream GC keeps the underlying fragment), but the bytes shrink from a full topic+paragraph+citation-list to one line. Strong topics (`days >= 3`) are never demoted.

**There is no hard-deletion path** in this iteration. The historical bucket grows monotonically; the subagent is explicitly told not to attempt quarter-summary collapses because the safety net (below) would revert them. If the bucket becomes inconveniently long in practice, a future runtime change will provide a structured drop mechanism — until then every demoted citation stays alive forever via its one-line bullet.

### The citation-superset safety net

After every dreaming run that rewrote MEMORY.md, `src/bundled-plugins/memory/citation-superset.ts` checks that the union of fragment ids cited in the NEW file is a superset of the union cited in the OLD file. If any previously-cited id is missing from the rewrite, the runtime:

1. Restores MEMORY.md to its pre-run bytes via `writeFile(memoryFilePath, memoryTextBefore)`. The pre-run bytes are captured **before** `runSession` so the revert always has a clean source.
2. Skips daily-stream fragment GC for this run (no fragments are dropped).
3. Advances the dreamed-id set anyway — the **conscious anti-loop tradeoff**: this means the run's NEW undreamed fragments are orphaned (they survive in the daily JSONL forever, force-committed, but will not be re-shown to a future dreaming run and therefore never make it into MEMORY.md). The alternative (don't advance) would infinite-loop if the LLM keeps making the same mistake on the same inputs. The orphaned fragments are recoverable from git history (`git log memory/`) by a human operator.
4. Logs a `[dreaming] citation-superset violation: …` warning naming the dropped ids and explicitly stating the orphaning tradeoff.

**Revert-write failure path.** If the `writeFile` in step 1 itself throws (disk full, EACCES, MEMORY.md replaced by a directory by a buggy subagent, etc.), MEMORY.md is in an unknown state. The runtime then:

- Skips the dreamed-id advance (so the next run gets a second chance at the same input).
- Skips compaction (so no fragments are GC'd against an ambiguous citation set).
- Skips the commit (so a known-bad on-disk state is not snapshotted).
- Logs a `[dreaming] citation-superset violation AND revert failed: …` ERROR with the recovery command (`git checkout -- MEMORY.md && typeclaw restart`).

The check exists because the daily-stream GC in `compactDailyStreams` drops any fragment that is `dreamedIds ∧ ¬citedIds`. Citations in MEMORY.md are the only thing that keeps a fragment alive past its first dreaming run — an omitted id means the underlying fragment would be permanently deleted on the next compaction.

## Files on disk

- **`MEMORY.md`** — long-term memory. Created by the dreaming subagent on first run if absent. Force-committed by the runtime; `skip-worktree` flag is set so the human's `git status` stays clean.
- **`memory/yyyy-MM-dd.jsonl`** — daily fragment streams. One event per line, discriminated union of `fragment | watermark | legacy_prose`, lossy-preserving one-shot migration from older `.md` streams. Appended to by `memory-logger`. Created on demand. Gitignored at the agent's level but force-committed alongside `MEMORY.md` after each dreaming run.
- **`memory/skills/<name>/SKILL.md`** — _muscle memory_. Skills the dreaming subagent distills from repeated procedures it sees in daily streams. Auto-discovered as first-class skills by `createResourceLoader`, and force-committed under the same `memory/` snapshot path as the daily streams. Written or refined with the standard `write` / `edit` tools; the bundled guard plugin enforces the exact `memory/skills/<name>/SKILL.md` path shape, single-segment kebab/snake-case names, matching frontmatter, and symlink/path-traversal safety. There is no runtime skill-delete tool; outright deletion of muscle-memory skills remains a user decision.
- **`memory/.dreaming-state.json`** — per-day **dreamed-id sets**: which stream-event ids the dreaming subagent has already reasoned over. Plain JSON, schema version `2`. The next dreaming run reads only fragments whose id is NOT in the set. On malformed input or a version mismatch (including legacy `version: 1` line-count files from before the id-based switch), the plugin fails open with empty state — one extra dreaming run re-reads each day, then the file is stable.

`typeclaw init` does **not** scaffold these files. They appear when needed.

## How `session.idle` works

Core fires `session.idle` immediately after every `session.prompt()` completion (success or error). The plugin owns the debounce: it keeps a `Map<sessionId, Timeout>` and resets the timer on every event. When the timer fires, the plugin spawns `memory-logger` for that session.

If the user starts a new prompt before the timer fires, the next `session.idle` event resets the timer. If the user disconnects, `session.end` cancels the timer and fires `memory-logger` immediately so the final transcript is captured.

In channel sessions, the agent rarely goes idle long enough to trip the timer because new participant messages keep arriving. The size-based ceiling handles this: on every `session.idle` the plugin `fs.stat`s the transcript and compares against the size at the last memory-logger run. Once growth reaches `memory.bufferBytes`, the timer is cancelled and `memory-logger` spawns immediately. The watermark on the output side absorbs any over-firing — if a buffer-trip arrives on a transcript chunk that's all tool noise, `memory-logger` reads it, decides nothing is worth logging, advances the watermark, and exits.

## Migration notes (from before the plugin existed)

- `memory.idleMs` and `memory.dreaming.schedule` already existed in core's `typeclaw.json` schema. They moved into this plugin's `configSchema` verbatim. Existing agents continue to work with no config change.
- `memory.dreaming.schedule` was previously live-reloadable. It is now **restart-required** because plugin config is read once at boot. To change the schedule, edit `typeclaw.json` and run `typeclaw restart`.
- The cron job ID changed from `__internal_dreaming` to `__plugin_memory_dreaming`. Anything that referenced the old ID (custom dashboards, scripts) needs updating.

## Tests

- `index.test.ts` — composition tests (config schema, hook wiring, debounce semantics, MEMORY.md auto-create).
- `memory-logger.test.ts` — system prompt invariants, watermark handling.
- `dreaming.test.ts` — orchestration, watermark advancement, git snapshot (including muscle-memory skill files), system prompt + tool-surface invariants, citation-superset safety net (revert on dropped id, dreamed-ids still advance, no-revert on legitimate merge, no-revert on first-ever run), saturation-prompt invariants (rebalance-every-run, promotion ladder, historical bucket, demotion thresholds, bucket overflow synthesis).
- `dreaming-state.test.ts` — fail-open semantics on malformed state.
- `watermark.test.ts` — marker parsing.
- `append-tool.test.ts` — append-only semantics.
- `src/bundled-plugins/guard/policies/skill-authoring.test.ts` — runtime skill authoring guard: path sandboxing, name validation, YAML frontmatter, and write/edit final-content validation.
- `load-memory.test.ts` — memory section rendering, undreamed-tail filtering, watermark stripping.
- `topics.test.ts` — citation-attributing parser (per-topic citation grouping for strength signals).
- `strength.test.ts` — per-topic strength computation (distinct days, recency, age clamping) and markdown table rendering.
- `citation-superset.test.ts` — the safety-net check (superset semantics, missing-id reporting, summary truncation).
