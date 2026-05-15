---
name: typeclaw-memory
description: Use this skill whenever the user asks what you remember, what you forgot, what you dreamed, why a fact is or isn't in your memory, when memory consolidation happens, or whenever you are about to read or write `MEMORY.md`, anything under `memory/`, or `memory/skills/`. Triggers include "what do you remember", "do you remember X", "forget that", "what did you dream", "when do you dream next", "why did you forget X", "edit MEMORY.md", "add to memory", "your daily streams", "memory-logger", "dreaming", "muscle memory", or any mention of `memory.idleMs` / `memory.dreaming.schedule` in `typeclaw.json`. Read it before you touch any memory file — `MEMORY.md` and `memory/yyyy-MM-dd.md` are runtime-owned, hand-edits are easy to do wrong, and the user almost always means something more specific than "edit memory" when they say it.
---

# typeclaw-memory

You have a two-stage memory system, owned by the bundled `memory` plugin (auto-loaded on every TypeClaw agent — there is no `plugins[]` entry to add and no opt-out). Daily observations flow into `memory/yyyy-MM-dd.md` while you are awake; offline reflection consolidates them into `MEMORY.md` and may distill repeated procedures into muscle-memory skills under `memory/skills/`. Both stages are run by subagents the runtime spawns on its own — not tools you call directly.

This skill exists so you can answer the user's questions about your own memory honestly and so you do not corrupt it by hand-editing.

## The two stages

### Stage 1: memory-logger (online, per-session)

After every prompt completes, the runtime fires the `session.idle` hook. The memory plugin starts a debounce timer (`memory.idleMs`, default `10_000` ms; minimum `1000`). Every subsequent prompt completion resets the timer. When the user has been quiet for `idleMs`, the plugin spawns the **memory-logger** subagent for the current session. It also fires immediately on `session.end` (websocket close) so the final transcript never gets lost.

The memory-logger reads:

1. `MEMORY.md` (long-term memory)
2. The current `memory/yyyy-MM-dd.md` daily stream
3. The transcript of the parent session past a watermark (the `entry=` value of the last fragment or watermark marker for that session)

It writes zero or more **fragments** to today's stream, plus a watermark marker so the next run knows where to resume. It writes nothing else, and it cannot run shell commands or edit existing content (its only tools are `read` and a custom `append`-only file tool — append never truncates, and a leading `\n` is auto-inserted if the existing file did not end in one).

A fragment looks like this in the daily stream:

```
<!-- fragment source=<sessionId> entry=<entryId> -->
## <topic>

**Claim:** <one-sentence assertion>
**Evidence:** <verbatim quote, named premise, or enumerated occurrences>
**Implication:** <how a future agent should behave differently because of this>
```

The Claim/Evidence/Implication structure is **required** and the bar is intentionally high: no Implication, no fragment. The memory-logger explicitly disallows promoting session-bound style/tone to a stable preference, speculation about the user's emotions or motives, and any claim it cannot justify with evidence already in the transcript or existing memory.

### Stage 2: dreaming (offline, scheduled)

The dreaming subagent runs on cron, configured under `memory.dreaming.schedule` (default `"*/30 * * * *"` — every 30 minutes). Multiple runs per day are the norm, not the exception; a fire with nothing past the watermark short-circuits before any LLM call, so most fires cost only a filesystem scan. The cron job id is `__plugin_memory_dreaming` (you cannot list it via the user-facing cron tools — it is plugin-owned).

When dreaming fires, it reads:

1. `MEMORY.md`
2. The **undreamed tail** of every `memory/yyyy-MM-dd.md` (the runtime tells it the exact line range — earlier lines are already consolidated into `MEMORY.md` and must NOT be re-read)

It rewrites `MEMORY.md` with the merged result, advances the per-day watermark in `memory/.dreaming-state.json`, optionally writes muscle-memory skills under `memory/skills/<name>/SKILL.md`, then commits the snapshot with a message shaped like `dream: <summary> <emoji>` — e.g. `dream: 3 fragments + new skill 'pr-review' 🔮`. The summary is derived from the staged diff (line additions in daily streams, newly-added skills, etc.), and the emoji is a random pick from a small thematic pool. After the commit, the runtime sets the `skip-worktree` index flag on the tracked memory artifacts so the user's `git status` and `git diff` stay clean. The flag is cleared and re-applied around every commit.

The dreaming subagent has only three tools: `read`, `write`, `ls`. No `bash`. No `edit`. It cannot run shell commands.

`MEMORY.md` after dreaming looks like:

```
# Memory

## <topic>
<conclusion paragraph in dreaming's own words>

fragments:
- memory/yyyy-MM-dd:<line>-<line>
- memory/yyyy-MM-dd:<line>-<line>

## <topic>
<conclusion paragraph>

fragments:
- memory/yyyy-MM-dd:<line>-<line>
```

The first line is always `# Memory`. Topics are level-2 headings. Every topic cites the source fragments by `memory/yyyy-MM-dd:<line>-<line>` so any claim is traceable back to the daily stream entry that justified it.

If the undreamed tails contain only watermarks, or every new fragment is already represented in `MEMORY.md`, dreaming **does nothing** and exits without writing. The watermark advances either way. "No-op dreaming" is a normal outcome, not a failure.

### What gets injected into your prompt every turn

Core's `createResourceLoader` appends a `# Memory` section as the LAST block of your system prompt (after `gitNudge`) by calling `loadMemory`. It is pinned to the cache-suffix end so growth in the daily stream invalidates only the memory section itself, not the skills/tools/history above. The section contains:

- `MEMORY.md` (truncated to 12 KB; if larger, the rest is dropped with a `[truncated]` marker)
- The **undreamed tails** of each `memory/yyyy-MM-dd.md`, with bare watermark lines stripped (they are bookkeeping for the memory-logger, no signal for you)

Already-consolidated content is not injected twice — once a day's stream is fully dreamed, the loader drops it from the prompt entirely.

If `MEMORY.md` is missing, the section shows `[MISSING] Expected at: <path>`. If it exists but is empty (e.g. before the first dreaming run), it shows `[EMPTY] Present at <path> but has no content yet.`

## What you must not do

- **Do not edit `MEMORY.md` directly.** It is dreaming-owned. The default system prompt says this verbatim. If you write to `MEMORY.md` from a normal session, your edit will survive only until the next dreaming run, which rewrites the file from scratch using the consolidation logic above. The user's intent is almost never "diff-edit `MEMORY.md`" — see "When the user asks ..." below for the right routings.
- **Do not write to `memory/yyyy-MM-dd.md`.** Daily streams are memory-logger's territory. The runtime reads watermarks out of these files; a hand-edit in the wrong place silently corrupts the cursor. (`memory/` is gitignored at the agent level but force-committed by the dreaming snapshot — your hand-edit there will not look untracked, but it will still be a bug.)
- **Do not write to `memory/skills/<name>/SKILL.md`.** That is the _muscle memory_ layer, owned exclusively by the dreaming subagent. The `typeclaw-skills` skill says the same thing from the skills-system angle; this skill says it from the memory angle. If you want a hand-authored skill, put it in `.agents/skills/` instead.
- **Do not write to `memory/.dreaming-state.json`.** It is internal bookkeeping (per-day line counts already consolidated). On malformed input the plugin fails open with empty state, so a wrong edit causes one redundant re-consolidation, but it is still a sign you misunderstood the contract.
- **Do not promise the user that an `idleMs` or `dreaming.schedule` change took effect just because you edited `typeclaw.json`.** Both fields are **restart-required** — the plugin reads them once at boot, and `reload` does not re-run plugin factories. Tell the user to run `typeclaw restart` (host stage).
- **Do not invent fragments.** If you find yourself wanting to "seed" a memory by hand, that is a symptom of the previous rules — surface the fact in your reply (so the memory-logger captures it) instead of writing to memory yourself.
- **Do not echo `[truncated]` or `[MISSING]` markers back at the user as if they were part of remembered content.** They are runtime annotations.

## When the user asks "what do you remember?"

1. Read `MEMORY.md`. Summarize at the topic level — do not dump the whole file unless asked. Cite specific topics by their level-2 headings.
2. If relevant to the current task, also read the undreamed-tail of recent `memory/yyyy-MM-dd.md` files for fresh observations not yet consolidated. (Note: these are already in your prompt under `# Memory`, so usually you can just refer to them rather than re-reading.)
3. If `MEMORY.md` is `[MISSING]` or `[EMPTY]`, say so plainly. The first dreaming run creates the file; if dreaming has never fired (e.g. no `memory.dreaming.schedule` configured, or fewer than ~24 hours since hatching), there is genuinely nothing yet.

## When the user asks "do you remember X?"

1. Search `MEMORY.md` and recent daily streams for a fragment matching X.
2. If you find one: say what you found and cite the source (the topic heading from `MEMORY.md`, or the fragment line range from the daily stream).
3. If you do not find one: say so plainly. **Do not invent a memory** to be helpful. The honest answer is "no, that is not in my memory" — the user can then decide whether to repeat the context now (which the memory-logger will pick up) or skip it.

## When the user asks "forget X" / "remove X from your memory"

You cannot remove a fragment cleanly. The right response depends on what X is:

- **A fact in `MEMORY.md` that the user wants overridden** — surface a contradiction in your next reply ("noted: [X] is no longer correct, [Y] is what holds now"). The memory-logger picks the contradiction up as a fragment with the standard "supersedes existing memory" structure, and dreaming will replace the prior topic on its next run. The change is not instant — it lands at the next dreaming consolidation.
- **A specific fragment in a daily stream the user wants gone before it gets consolidated** — read the file, locate the fragment, propose the surgical edit to the user, and (only if they confirm) `write` the edited file back. **Do not delete the watermark line on the same fragment** — that breaks the memory-logger's cursor for the originating session.
- **Everything (full memory wipe)** — that is the user's call, not yours. Tell them: removing `MEMORY.md` is a one-line `rm`, but they should also remove `memory/.dreaming-state.json` so dreaming re-consolidates the still-present daily streams from scratch on its next run. If they want the daily streams gone too, `rm -rf memory/` (and the runtime will recreate the directory on the next memory-logger spawn). Confirm explicitly before any of this. Then commit the deletions with a `typeclaw-git`-compliant message naming what was removed and why.

## When the user asks "what did you dream?" / "when do you dream next?"

1. **What you dreamed**: read the most recent `dream:` git commit on your agent folder (`git log --grep='^dream:' -1`) and show the diff against `MEMORY.md` if useful. The commit timestamp tells you when dreaming last ran. If the answer is "no `dream:` commits yet", say that — `MEMORY.md` may exist but be the auto-created empty file from the first dreaming attempt.
2. **When you dream next**: read `memory.dreaming.schedule` from `typeclaw.json` (default `"*/30 * * * *"` — every 30 minutes). Translate the cron expression to a wall-clock time in the agent's `TZ`. The dreaming cron job is **always registered** even when `memory.dreaming` is omitted; the default schedule applies. Tell the user honestly when the next fire is in the agent's local time.

## When the user asks "what's a daily stream?" / "where is your memory stored?"

Stay concrete. Use this map:

| File / dir                      | What it is                                                                    | Who writes it                                                  | Tracked in git                                               |
| ------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| `MEMORY.md`                     | Long-term memory, consolidated topics with fragment citations.                | Dreaming subagent (rewrites in full on each run).              | Yes (force-committed under `dream:` commits, skip-worktree). |
| `memory/yyyy-MM-dd.md`          | Daily fragment streams. Append-only during the day.                           | Memory-logger subagent (one fragment ≈ one prompt completion). | Gitignored, but force-committed in the dreaming snapshot.    |
| `memory/skills/<name>/SKILL.md` | Muscle-memory skills distilled from recurring procedures.                     | Dreaming subagent only.                                        | Gitignored, force-committed in the dreaming snapshot.        |
| `memory/.dreaming-state.json`   | Per-day watermarks (line counts already consolidated). Plain JSON, fail-open. | Dreaming subagent.                                             | Gitignored, force-committed in the dreaming snapshot.        |

`typeclaw init` does **not** scaffold any of these. They appear when needed — `MEMORY.md` and `memory/` are created by the first dreaming run; daily streams appear when the first memory-logger fires.

## When the user asks about `memory.idleMs` or `memory.dreaming.schedule`

These are the only two configurable knobs. They live in the `memory` block of `typeclaw.json`:

```json
{
  "memory": {
    "idleMs": 10000,
    "dreaming": { "schedule": "*/30 * * * *" }
  }
}
```

| Field                      | Default              | Effect                                                                                                                                                                                                        | Reload class      |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `memory.idleMs`            | `10000` (min `1000`) | Debounce window before `memory-logger` spawns after a prompt completes.                                                                                                                                       | Restart-required. |
| `memory.dreaming`          | `{}` (cron job on)   | Dreaming cron job is always registered. Override `schedule` to change when it fires.                                                                                                                          | Restart-required. |
| `memory.dreaming.schedule` | `"*/30 * * * *"`     | Cron expression. Parsed via `cron-parser`; an invalid expression fails config load. Fires with nothing past the watermark short-circuit before any LLM call, so frequent no-op fires are intentionally cheap. | Restart-required. |

Both fields are restart-required because plugin config is read once at boot. After editing them, tell the user: "Edited `memory.<field>` — restart-required. Run `typeclaw restart` (host stage) to pick up the change." The bundled plugin's config schema is merged into `typeclaw.schema.json`, so editor autocomplete will validate these fields, but a `reload` will not re-instantiate the plugin.

To **disable dreaming entirely**, omit the `memory.dreaming` block. The cron job will not be registered. `MEMORY.md` will then never get consolidated automatically — the daily streams keep growing, and your prompt's `# Memory` section keeps showing more and more undreamed tails until the user re-enables dreaming. Warn them about this if they ask to disable it.

To **shorten the memory-logger debounce** (e.g. for testing): drop `memory.idleMs` toward `1000`. Anything below `1000` is rejected by the config schema. Cost: more memory-logger spawns, more turn latency from the spawn handshake (the spawn is async but the LLM cost is real).

## When you are unsure whether something belongs in memory

Use this hierarchy. The first one that fits wins:

1. **Operational lesson the next agent should follow** ("when the user says ‘ship it’, run typecheck before committing") → it belongs in **`AGENTS.md`**, not memory. AGENTS.md is your operating manual; memory is for facts and observations, not procedure rules.
2. **A fact about the user** (their name, their preferences, their context) that you learned from this conversation → mention it in your reply with confident phrasing. The memory-logger will capture it. **Do not edit `USER.md` mid-session as a substitute for memory** — `USER.md` is for hatching-time identity and durable, user-confirmed traits, not for in-flight observations.
3. **A multi-step procedure the user has guided you through more than once** that should become a reusable skill → flag the recurrence in your reply ("looks like we keep going through the same N-step flow for X"). Dreaming watches for repetition across daily streams and will distill it into `memory/skills/<name>/SKILL.md` if the bar is met (multi-step, recurred across multiple fragments / days, trigger conditions clearly statable, steps generalizable). You should not author muscle-memory skills directly.
4. **An ephemeral observation** that doesn't change behavior — let it pass. Memory-logger has a strict bar; padding it with noise hurts the next agent's signal.

## What this skill does _not_ cover

- **The `bunx skills` CLI and the broader skill ecosystem** (system / user / muscle-memory layers, lockfile-based "downloaded vs hand-authored", `bunx skills add/remove/update` workflow) — see `typeclaw-skills`.
- **Editing `typeclaw.json` outside the `memory` block** (port, model, mounts, plugins, channels) — see `typeclaw-config`.
- **The cron file format and scheduling** (`cron.json`) — see `typeclaw-cron`. The dreaming cron job is plugin-owned and lives outside `cron.json`; you cannot configure or list it through the cron skill.
- **Plugin authoring** (`definePlugin`, contributing tools/subagents/cron jobs) — see `typeclaw-plugins`. The memory plugin is an example of the patterns that skill describes.
- **Identity files** (`IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`) — these are not memory. Edit them directly when relevant; no skill needed for that.
