---
name: typeclaw-memory
description: Use this skill whenever the user asks what you remember, what you forgot, what you dreamed, why a fact is or isn't in your memory, when memory consolidation happens, or whenever you are about to read or write `MEMORY.md`, anything under `memory/`, or `memory/skills/`. Triggers include "what do you remember", "do you remember X", "forget that", "what did you dream", "when do you dream next", "why did you forget X", "edit MEMORY.md", "add to memory", "your daily streams", "memory-logger", "dreaming", "muscle memory", or any mention of `memory.idleMs` / `memory.bufferBytes` / `memory.dreaming.schedule` in `typeclaw.json`. Read it before you touch any memory file — `MEMORY.md` and `memory/yyyy-MM-dd.jsonl` are runtime-owned, hand-edits are easy to do wrong, and the user almost always means something more specific than "edit memory" when they say it.
---

# typeclaw-memory

The agent's long-term memory is sharded across files in `memory/topics/<slug>.md`. Each shard is one topic with YAML frontmatter (`heading`, `cites`, `days`, `lastReinforced`, optional `tags`) + body markdown. Runtime owns the frontmatter — don't try to author it; write the body and let the runtime compute the metadata.

## Reading

The `# Memory` section of every system prompt comes from these shards plus undreamed daily-stream tails. When total shard bytes are above the 16 KB injection budget (or when speaking in a channel), only the heading + `cites=N, days=N, lastReinforced=YYYY-MM-DD` shows; call `memory_search` to fetch the bodies you need.

## Writing

You don't author shards directly. The dreaming subagent (runs on a cron schedule, default every 30 minutes) reads undreamed fragments from `memory/streams/<date>.jsonl` and rebalances the shards.

If you have a procedure you've now done twice and want to externalize as muscle memory, write a skill at `memory/skills/<name>/SKILL.md`. The runtime auto-loads these as first-class skills on next boot. Skill name must be a single-segment kebab-case slug. Frontmatter requires `name` + `description`.

## Citations

Citations in shard bodies use the canonical form `streams/yyyy-MM-dd#<fragment-id>`. Legacy `memory/yyyy-MM-dd#<fragment-id>` is still parsed during the migration window. Every citation you emit MUST resolve to a fragment in the corresponding daily stream — the citation-superset check reverts your run if any pre-existing citation goes missing.

## `memory_search` tool

When index-mode injection hides bodies, use `memory_search({query, asRegex?, full?, maxResults?})` to find and load specific topics. Substring (case-insensitive) by default; `asRegex: true` for regex. Returns matches with line-context excerpts; `full: true` returns the entire shard body.

## Per-shard truncation

Individual shards are capped at 12 KB on injection (defense against a runaway shard blowing the budget). Keep topic bodies focused and short.
