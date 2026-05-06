# typeclaw-plugin-memory

The bundled memory plugin. Owns `MEMORY.md` (long-term memory) and `memory/yyyy-MM-dd.md` (daily streams) plus the two subagents that write them: `memory-logger` and `dreaming`.

This plugin is **auto-loaded** by every TypeClaw agent. There is no `plugins[]` entry to add and no opt-out. To configure it, add a `memory` block to `typeclaw.json`.

## Config

```json
{
  "memory": {
    "idleMs": 10000,
    "bufferBytes": 100000,
    "dreaming": { "schedule": "0 4 * * *" }
  }
}
```

| Field                      | Default            | Effect                                                                                                                                                                                    |
| -------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.idleMs`            | `10000`            | Debounce window before `memory-logger` spawns after a prompt completes. Minimum `1000`.                                                                                                   |
| `memory.bufferBytes`       | `100000`           | Size-based ceiling: spawns `memory-logger` when the transcript grows by this many bytes since the last run, even during continuous activity. `0` disables. Minimum `10000` when non-zero. |
| `memory.dreaming`          | `{}` (cron job on) | Dreaming cron job is always registered. Override `schedule` to change when it fires.                                                                                                      |
| `memory.dreaming.schedule` | `"0 4 * * *"`      | Five-field cron expression. Applies whether `memory.dreaming` is omitted, empty, or explicitly set. Second-level schedules are rejected to avoid noisy no-op dreaming loops.              |

All fields are **restart-required** — the plugin reads them once at boot.

## What it contributes

| Kind     | Name                       | Notes                                                                                                                                                                                                                                                                             |
| -------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagent | `memory-logger`            | Reads a parent transcript past a watermark and appends fragments to `memory/<today>.md`. Coalesced per `parentSessionId`.                                                                                                                                                         |
| Subagent | `dreaming`                 | Reads `MEMORY.md` plus undreamed daily-stream tails, rewrites `MEMORY.md`, optionally writes muscle-memory skills under `memory/skills/<name>/SKILL.md`, advances the per-day watermark, and `git commit -m Dream` the result. Coalesced per `agentDir`.                          |
| Cron job | `__plugin_memory_dreaming` | `kind: 'prompt'`, `subagent: 'dreaming'`, scheduled per `memory.dreaming.schedule`.                                                                                                                                                                                               |
| Hook     | `session.prompt`           | Appends the rendered memory section (`# Memory`, `MEMORY.md`, undreamed stream tails) to `event.prompt`.                                                                                                                                                                          |
| Hook     | `session.idle`             | Per-session debouncer with size-based ceiling. Resets a `setTimeout(idleMs)` on every event; on fire, calls `ctx.spawnSubagent('memory-logger', ...)`. Also `fs.stat`s the transcript on every event and spawns immediately when growth since the last run reaches `bufferBytes`. |
| Hook     | `session.end`              | Cancels the debounce timer and immediately spawns `memory-logger` (so the final transcript is captured even when the user disconnects right away).                                                                                                                                |

## Files on disk

- **`MEMORY.md`** — long-term memory. Created by the dreaming subagent on first run if absent. Force-committed by the runtime; `skip-worktree` flag is set so the human's `git status` stays clean.
- **`memory/yyyy-MM-dd.md`** — daily fragment streams. Appended to by `memory-logger`. Created on demand. Gitignored at the agent's level but force-committed alongside `MEMORY.md` after each dreaming run.
- **`memory/skills/<name>/SKILL.md`** — _muscle memory_. Skills the dreaming subagent distills from repeated procedures it sees in daily streams. Auto-discovered as first-class skills by `createResourceLoader`, and force-committed under the same `memory/` snapshot path as the daily streams. Written or refined with the standard `write` / `edit` tools; the bundled guard plugin enforces the exact `memory/skills/<name>/SKILL.md` path shape, single-segment kebab/snake-case names, matching frontmatter, and symlink/path-traversal safety. There is no runtime skill-delete tool; outright deletion of muscle-memory skills remains a user decision.
- **`memory/.dreaming-state.json`** — per-day watermarks (line counts already consolidated into `MEMORY.md`). Plain JSON; on malformed input the plugin fails open with empty state.

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
- `dreaming.test.ts` — orchestration, watermark advancement, git snapshot (including muscle-memory skill files), system prompt + tool-surface invariants.
- `dreaming-state.test.ts` — fail-open semantics on malformed state.
- `watermark.test.ts` — marker parsing.
- `append-tool.test.ts` — append-only semantics.
- `plugins/guard/policies/skill-authoring.test.ts` — runtime skill authoring guard: path sandboxing, name validation, YAML frontmatter, and write/edit final-content validation.
- `load-memory.test.ts` — memory section rendering, undreamed-tail filtering, watermark stripping.
