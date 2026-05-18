---
name: typeclaw-cron
description: Use this skill whenever the user asks you to schedule recurring work, run something on a cron, do something every day/hour/week, set up a periodic task, or read or edit your cron schedule. Triggers include "every morning", "every Monday", "schedule a", "remind me every", "set up a cron", "run X periodically", "watch for new X", "when there's a new Y trigger Z", "poll for", "what's on my cron", "when does X run", or any mention of `cron.json`. Also use when the user wants a scheduled shell-style job that nonetheless needs LLM judgement (the `exec → LLM` pattern) — the canonical answer is a plugin container command invoked from cron's `exec` array, not a third cron kind. Also use for conditional/gated LLM calls — polling-style jobs ("if there are new emails…", "if anyone pushed…", "when a file changes…") where a cheap `ctx.exec` probe should run on every tick but `ctx.prompt` should only fire when there's actual work. Read it before touching `cron.json` — the file has a strict schema, restart semantics, and a best-effort execution model that you must not misrepresent to the user.
---

# typeclaw-cron

You have a cron file at `./cron.json` in your agent folder. It defines periodic jobs that the typeclaw runtime fires on schedule. This skill exists so you do not corrupt the file, do not promise behavior the runtime cannot deliver, and do not surprise the user.

## What cron actually does

The typeclaw runtime starts a scheduler when the container boots. The scheduler reads `cron.json` **once** at startup. While the container runs, it fires each enabled job at its next scheduled time. There is no daemon outside the container — if the container is down, nothing runs.

This is a **best-effort scheduler**. Concretely:

- **Missed ticks are not replayed.** If the container was down at 23:30 and starts at 23:45, the 23:30 fire is lost forever.
- **Overlapping fires are skipped, not queued.** If a job is still running when its next tick arrives, the new tick is dropped (logged) and the next attempt is the tick after that.
- **There are no retries, no timeouts, no failure hooks.** A job that throws is logged and forgotten until its next scheduled fire.

Tell the user this if they ask about reliability. Do not invent guarantees the runtime does not give them.

## The two job kinds

`cron.json` has one top-level key: `jobs`. Each job has a `kind` discriminator, plus shared fields and kind-specific fields.

### Shared fields (all jobs)

| Field      | Required | Notes                                                                                                         |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `id`       | yes      | Unique. Letters, digits, hyphens, underscores. Used in logs and to coalesce.                                  |
| `schedule` | yes      | Standard 5-field cron expression (`min hr dom mon dow`) or 6-field with seconds. See "Schedule syntax" below. |
| `enabled`  | no       | Defaults to `true`. Set to `false` to keep a job in the file but skip it.                                     |
| `timezone` | no       | IANA name like `Asia/Seoul`. Defaults to UTC (the container's timezone).                                      |

### `kind: "prompt"` — fire a prompt into a fresh session

```json
{
  "id": "daily-summary",
  "schedule": "30 23 * * *",
  "kind": "prompt",
  "prompt": "Read today's session jsonl files in sessions/ and summarize the day into memory/."
}
```

When this fires, the runtime opens a **brand new** `AgentSession` (yours, with your IDENTITY/SOUL/AGENTS files loaded), sends it the `prompt` text as if the user typed it, and disposes the session when done.

What this means for how you write prompts:

- **Treat the prompt as a self-contained instruction to your future self.** It runs in a session with no memory of past prompt-job runs unless you persist across runs (e.g. by writing to `MEMORY.md` or `memory/`).
- **The session has all your tools.** You can `read`, `write`, `bash`, edit files, commit to git — anything you can do in a normal turn.
- **There is no human on the other end.** No one will answer clarifying questions. Make the prompt complete and unambiguous.
- **Be specific about side effects.** "Summarize today" is vague. "Read every `sessions/*.jsonl` modified today and append a summary to `memory/$(date +%F)-summary.md`" is actionable.

### `kind: "exec"` — run a shell command, no LLM

```json
{
  "id": "hourly-backup",
  "schedule": "0 * * * *",
  "kind": "exec",
  "command": ["git", "commit", "-am", "hourly snapshot"]
}
```

The runtime spawns the command directly with `Bun.spawn` from the agent folder (`/agent` inside the container). No agent session is created. No LLM call happens. The command's exit code and stderr are captured to container logs.

Use `exec` only for jobs that are pure mechanics — no judgement required. Examples that fit: git snapshots, log rotation, calling a script that already exists. Examples that **don't** fit: anything where "what do I commit" or "what should I write" depends on context. Use `prompt` for those — **or** the `exec → LLM` bridge below when you want the cron-time discipline of `exec` (exact `command`, no prompt drift) but still need LLM judgement at runtime.

`command` is an array. Index 0 is the executable, the rest are argv. Do **not** put a single shell pipeline in `command[0]` — that won't be parsed by a shell. If you need shell features (`|`, `>`, `&&`), wrap explicitly: `["sh", "-c", "your | pipeline | here"]`.

## `exec → LLM`: bridge via a plugin container command

There are only two cron kinds — `prompt` and `exec`. There is **no** `kind: "exec-then-llm"` and there never will be. If a scheduled job needs to call into LLM-driven behavior from a shell-style entry point (e.g. parse output of a script and decide what to do, or run a multi-tool agent flow with a sharp `command` argv at the cron layer), the supported pattern is:

1. Write a custom typeclaw plugin under `packages/<plugin-name>/` (see the `typeclaw-plugins` and `typeclaw-monorepo` skills).
2. In the plugin, declare a `surface: 'container'` command on `definePlugin({ commands: { ... } })`. Inside its `run`, call `ctx.prompt(...)` — that opens a full agent session inside the running container with the entire toolset, and returns the final assistant text.
3. **Schedule it from the plugin's own `cronJobs`** (the default, see below) — or, when the cadence is user-owned, from `cron.json`'s `exec` array.

### Where to put the schedule: plugin `cronJobs` vs `cron.json`

The same plugin command can be fired by two different schedulers. They look identical at runtime — both end up running `Bun.spawn(['typeclaw', '<cmd>', ...])` from the agent folder with `TYPECLAW_PARENT_ORIGIN_JSON` injected — but they differ in **who owns the cadence**.

| Scheduler                | Schedule lives in            | Best when                                                                                                                                                      | `id` shape                               |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Plugin `cronJobs`**    | The plugin module            | The plugin **author** decides the cadence — installing the plugin should be sufficient                                                                         | `__plugin_<plugin-name>_<key>`           |
| **`cron.json`** (`exec`) | The agent folder's cron.json | The **user** decides the cadence — they want to schedule someone else's command at a custom time, or skip days, or change frequency without forking the plugin | `<user-supplied>` (no underscore prefix) |

**Default to plugin `cronJobs`.** A plugin that ships an `audit-commits` command but no `cronJobs` registration silently demands every user wire it into `cron.json` themselves — that's a documentation tax with no payoff. If the plugin author has an opinion about cadence, they should ship the cron job too. The colocation also means renaming the command and updating its schedule happen in the same commit.

Reach for `cron.json` only when the cadence is genuinely user-specific: "fire `audit-commits` every Sunday at 10pm in Asia/Seoul" is a user decision, not a plugin author's.

### Concrete example: plugin-owned schedule (the default)

```ts
// packages/dev-audits/index.ts
import { z } from 'zod'
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  commands: {
    'audit-commits': {
      surface: 'container',
      description: 'Review recent commits for message quality; write findings to memory/audits/.',
      args: z.object({ since: z.string().default('24h') }),
      async run(ctx, args) {
        await ctx.prompt(
          `Run \`git log --since='${args.since}' --pretty=format:'%h %s'\` and append a critique of weak commit messages to memory/audits/$(date +%F)-commits.md. Be specific — quote bad messages and suggest rewrites.`,
        )
        return 0
      },
    },
  },
  plugin: async () => ({
    cronJobs: {
      // Global cron id becomes __plugin_dev-audits_daily — can't collide
      // with anything in cron.json (those forbid leading underscore).
      daily: {
        schedule: '0 22 * * *',
        timezone: 'Asia/Seoul',
        kind: 'exec',
        command: ['typeclaw', 'audit-commits', '--since=24h'],
      },
    },
  }),
})
```

`typeclaw.json`:

```json
{
  "plugins": ["./packages/dev-audits"]
}
```

That's the whole installation. No `cron.json` edit, no user wiring. `typeclaw restart` and the job is live.

### Concrete example: user-owned schedule (the alternative)

When the user is scheduling a plugin command at a cadence the plugin author didn't anticipate — or the plugin deliberately ships no `cronJobs` because the author had no opinion — drop into `cron.json`:

```json
// cron.json — user wants the audit on a custom schedule
{
  "jobs": [
    {
      "id": "weekly-commit-audit",
      "schedule": "0 22 * * 0",
      "timezone": "Asia/Seoul",
      "kind": "exec",
      "command": ["typeclaw", "audit-commits", "--since=7d"]
    }
  ]
}
```

The runtime semantics are identical to the plugin-cron form: same `Bun.spawn`, same `TYPECLAW_PARENT_ORIGIN_JSON`, same role inheritance. The only practical difference is `id` shape (`weekly-commit-audit` vs `__plugin_dev-audits_daily`) and where the schedule is editable.

Both can coexist — a plugin can ship a daily default in `cronJobs`, and the user can add a different cadence in `cron.json` for the same command. They are independent cron jobs at the scheduler layer.

### When to pick which (decision rules)

Pick **plugin `cronJobs`** when **any** of:

- The plugin author has an opinion about cadence — installing the plugin without an extra step should produce the scheduled behavior.
- The command + the schedule are one feature — they should land in the same PR, version together, and be discoverable in one place.
- Multiple cron jobs in the plugin share configuration and should evolve together (e.g. one daily, one weekly, both reading from the same plugin config block).

Pick **`cron.json`** when **any** of:

- The cadence is user-specific (weekends only, off-hours only, different timezone than the plugin's default).
- The command lives in someone else's plugin and the user wants a different cadence without forking it. (Note: the user's `cron.json` entry runs alongside the plugin's default; if the user wants to **replace** the plugin's default rather than supplement it, the plugin should expose its `schedule` through `configSchema` so users override it in `typeclaw.json` without touching `cron.json`. That's the plugin author's responsibility, not the user's.)
- One-off scheduled prose where writing a plugin is overkill.

Pick plain `kind: "prompt"` (no plugin command at all) when:

- The instruction is one-off, will never be reused, and parametrization is overkill.
- You don't have a plugin yet and the work is genuinely a few sentences of prose.

### What this pattern is NOT

- It is **not** a way to bypass permissions. Both plugin-cron `exec` and `cron.json` `exec` stamp `scheduledByRole` into the spawned session's origin (via `TYPECLAW_PARENT_ORIGIN_JSON`); the plugin command's `ctx.origin` carries that role, and every tool inside `ctx.prompt`'s session resolves against it. A cron scheduled as `scheduledByRole: 'member'` invokes the command's prompt session as a member — no silent elevation. See `typeclaw-permissions`.
- It is **not** a wrapper for shell pipelines you already have working. If `bash some-script.sh` does the job, just use that as the `command` array directly. Reach for the bridge only when LLM judgement is genuinely required inside the periodic work.

Read `typeclaw-plugins` §5.3 for the `cronJobs` registration shape, §5.7 for the full `commands` surface (host/container/either, `args` schema, `ctx.prompt` / `ctx.subagent` / `ctx.exec`, permission gating). Read `typeclaw-monorepo` for where the plugin package lives in `packages/`.

### Conditional LLM calls: gate `ctx.prompt` behind a cheap check

Most polling-style cron jobs are skewed: they fire often (every 5 minutes, every hour) and **most ticks find no work**. A plain `kind: "prompt"` job spends a full LLM round-trip every tick just to discover there's nothing to do. That gets expensive fast — a 5-minute "check for new emails" prompt is ~290 LLM calls a day, even on days where nothing arrived.

The bridge pattern fixes this naturally because `ctx.exec` runs **before** `ctx.prompt`. Do the cheap check first; only spend tokens when there's actual work:

```ts
// packages/inbox-watch/index.ts
import { z } from 'zod'
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  commands: {
    'inbox-check': {
      surface: 'container',
      description: 'Triage new mail since last run; no-op if nothing new.',
      args: z.object({ since: z.string().default('1h') }),
      async run(ctx, args) {
        // Cheap shell check: 0 LLM cost, ~100ms.
        const { stdout, exitCode } = await ctx.exec`gmail unread --since=${args.since} --count`
        if (exitCode !== 0) {
          // Don't drag the LLM into shell failures — log and bail.
          const err = new TextEncoder().encode(`inbox-check: gmail probe failed (exit ${exitCode})\n`)
          const w = ctx.stderr.getWriter()
          await w.write(err)
          w.releaseLock()
          return exitCode
        }
        const count = Number.parseInt(stdout.trim(), 10)
        if (!Number.isFinite(count) || count === 0) {
          // Nothing to do. Return 0 silently so cron logs don't get noisy.
          return 0
        }
        // Expensive LLM path: only reached when there's actual work.
        await ctx.prompt(
          `There are ${count} unread emails since ${args.since}. Use the gmail skill to read them, summarize anything that needs a human reply, and append to memory/inbox/$(date +%F).md.`,
        )
        return 0
      },
    },
  },
  plugin: async () => ({
    cronJobs: {
      // Colocated with the command: install the plugin = the watch is live.
      // Most ticks spend ~100ms of shell; LLM cost only on non-empty inboxes.
      watch: {
        schedule: '*/15 * * * *',
        kind: 'exec',
        command: ['typeclaw', 'inbox-check', '--since=15m'],
      },
    },
  }),
})
```

(If the user wants a different cadence — only during work hours, only weekdays — they add a `cron.json` entry pointing at `["typeclaw", "inbox-check", "--since=…"]` with their own schedule. The plugin's `watch` job and the user's `cron.json` job are independent at the scheduler.)

The shape that matters:

1. **Probe with `ctx.exec` (or an `await` on a Node API) first.** Anything that returns a yes/no signal cheaply: a CLI tool exit code, a count, a file mtime, an HTTP HEAD, a `git log -1 --since=...` output.
2. **Return early when the probe says "no work".** `return 0` exits the command cleanly, cron logs nothing scary, and zero LLM tokens were spent. Critically: do NOT call `ctx.prompt` to "decide whether to act" — that defeats the entire optimization.
3. **Reach for `ctx.prompt` only on the work path.** Pass the probe's output into the prompt so the agent doesn't have to re-discover what triggered the run (e.g. `${count} unread emails`, the list of changed files, the new commit hash). This also shortens the LLM's first turn — it gets to act, not investigate.

Concrete signals you can probe cheaply (in rough order of common use):

| Question                            | Cheap probe                                                           |
| ----------------------------------- | --------------------------------------------------------------------- |
| Are there new emails?               | `gmail unread --since=15m --count` (or your skill's CLI)              |
| Did anyone commit since last check? | `git log --since=15m --pretty=oneline` (empty = no)                   |
| Did a file change?                  | `find <path> -newer .inbox-watch.stamp -type f`                       |
| Is there a new PR/issue?            | `gh pr list --search 'created:>15m' --json number` (empty array = no) |
| Did a service go down?              | `curl -fsS https://... > /dev/null` (non-zero = down)                 |
| Is there a new line in a log?       | `wc -l <log>` vs a stamp file                                         |
| Did `last-run.txt` rot to stale?    | `find last-run.txt -mmin +60` (empty = fresh)                         |

For "since last run" semantics, write a stamp file at the end of every successful run: `await ctx.exec\`touch .inbox-watch.stamp\``. The next tick's probe compares against it via `-newer`or`mtime`. Stamp files belong in `workspace/`or under`memory/state/` — never at the agent root.

When NOT to gate:

- **The work is small enough that the LLM probe is the action.** A daily "summarize today" job that always has something to summarize doesn't need a gate; the prompt does the work.
- **The probe is as expensive as the prompt.** If your "is there work?" check requires reading 200 files anyway, just let the LLM do it once with the full toolset.
- **You genuinely want the LLM to decide intent on every tick.** Rare, but valid — e.g. a "morning standup" job that always produces output regardless of how busy yesterday was.

Pitfalls to avoid:

- **Don't promise the user "the agent checks every 5 minutes" if you've written `*/5 * * * *` without a gate.** That's 12 LLM calls an hour for empty inboxes. Either gate it, or slow the schedule to match what the work actually warrants.
- **Don't gate inside `ctx.prompt` itself** ("if there are new emails, do X; else do nothing"). The LLM still ran. The gate has to be in shell code outside `ctx.prompt`.
- **Don't leak probe failures into the LLM session.** If `ctx.exec` exits non-zero, decide explicitly: bail with the same exit code (`return exitCode`), or recover with a fallback path. Don't fall through into `ctx.prompt` with no input — the agent will improvise, and the improvisation is usually worse than a clean `cron failed: ...` log line.

## Schedule syntax

Standard cron, parsed by [`cron-parser`](https://github.com/harrisiirak/cron-parser). 5-field is the common form.

```
*    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    └─ day of week (0-7, SUN-SAT, 0 and 7 both = Sunday)
│    │    │    └────── month (1-12, JAN-DEC)
│    │    └─────────── day of month (1-31)
│    └───────────────── hour (0-23)
└─────────────────────── minute (0-59)
```

Common patterns:

| Schedule       | Meaning                            |
| -------------- | ---------------------------------- |
| `*/15 * * * *` | every 15 minutes                   |
| `0 * * * *`    | every hour, on the hour            |
| `30 9 * * 1-5` | 09:30 every weekday                |
| `0 0 * * 0`    | Sunday midnight                    |
| `0 0 1 * *`    | first day of every month, midnight |

Predefined aliases also work: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.

If you set `timezone`, the schedule is interpreted in that zone. **Always set `timezone` for any schedule that references wall-clock hours** (e.g. "every morning at 7"); otherwise it runs in UTC and will surprise the user.

## Editing `cron.json` safely

`cron.json` is a single canonical file at the agent folder root. It is committed to git (not gitignored). Treat it like a config file you own.

### Workflow

1. **Read the whole file first** with the `read` tool. Don't assume what's in it.
2. **Modify in memory.** Add, remove, or change jobs in the parsed JSON.
3. **Write the whole file back** with the `write` tool. Always pretty-printed (2-space indent), trailing newline, sorted-stable order.
4. **Apply with the `reload` tool.** Call the `reload` tool — it re-reads `cron.json` and updates the live scheduler. The tool returns `[cron] ok: ...` with an added/removed/updated/unchanged summary on success, or `[cron] failed: ...` with the exact validation error on failure. **If reload fails, the live schedule is left unchanged** — fix `cron.json` based on the error message and call `reload` again.
5. **Commit the change** _after_ a successful reload. See the `typeclaw-git` skill for the commit-message rule (decision context required). `cron.json` is not gitignored, so an uncommitted edit will pollute your next commit.

### Required fields checklist (catch this before writing)

For every job you add:

- `id` is unique within the file
- `id` matches `[a-zA-Z0-9_-]+` (no spaces, no slashes, no dots)
- `schedule` parses as cron
- `kind` is exactly `"prompt"` or `"exec"`
- If `prompt`: `prompt` is non-empty
- If `exec`: `command` is a non-empty array of non-empty strings
- If a wall-clock schedule was requested: `timezone` is set

### Applying changes — the `reload` tool

The scheduler does **not** auto-reload `cron.json` when you edit it. You must call the `reload` tool to apply changes. There is no file watcher by design — reload is explicit so you always know when the live schedule changed.

**Safety contract**: reload validates `cron.json` first. If validation fails (bad JSON, invalid cron expression, duplicate id, etc.), the live schedule is left running with the previous configuration and `reload` returns the failure reason. Reload cannot break the running agent.

**The user can also reload from the host** with `typeclaw reload`. You don't need to ask them to — call the tool yourself when you finish an edit. But be aware they have the same primitive available.

If you finished an edit and the user only sees an in-flight job from the previous schedule, that job will complete naturally — reload never interrupts a running fire. Tell the user this if they wonder why their old job is still wrapping up.

## Things you must not do

- **Do not edit `cron.json` from inside an `exec` job's `command`.** Exec jobs run without an LLM and have no way to call the `reload` tool, so the file mutation will not take effect until something else triggers a reload. If you genuinely need scheduled cron-management, write a `prompt` job whose prompt is "edit cron.json to ..." and let the prompt-fire's session call `reload` itself.
- **Do not put secrets in `prompt` or `command`.** `cron.json` is committed to git. Reference env vars or files instead (`["sh", "-c", "curl -H \"Authorization: Bearer $TOKEN\" ..."]`).
- **Do not promise sub-second precision or guaranteed execution.** This is best-effort — see "What cron actually does" above.
- **Do not invent fields the schema doesn't support** (no `retry`, `timeout`, `onFailure`, `concurrency`, etc.). They will be silently ignored at best, or rejected at worst.

## When the user says "every X"

Pick `kind` first, then schedule, then timezone:

1. **Does the work need judgement?** → `prompt`. Otherwise → `exec`. Edge case: the user wants exact `command` argv AND judgement (e.g. `["typeclaw", "audit-commits", "--since=24h"]`), or the same logic to be reusable from a shell, or the job to take flags. In that case → `exec` with `command: ["typeclaw", "<plugin-command>", ...]`, and write the plugin command. See "`exec → LLM`: bridge via a plugin container command" above.
2. **Translate the cadence to cron.** "Every morning at 7" → `0 7 * * *`. "Every weekday at 9:30" → `30 9 * * 1-5`. "Every five minutes" → `*/5 * * * *`. If you are not sure, ask once. Don't guess on tricky cases like "every other Friday".
3. **Timezone.** If the user mentioned a wall-clock time, set `timezone` to their zone. If unknown, ask once or default to the timezone in `USER.md` if it's recorded there.
4. **Pick a stable `id`.** Use kebab-case that describes the job, not the schedule. `daily-summary` not `0-23-30`.
5. **Write it. Call `reload`. If reload succeeded, commit it.** If reload failed, fix `cron.json` based on the error and retry — do not commit a broken file.

## Reading cron history

There is no "list past fires" tool. To see what cron has done:

- **Container logs:** `docker logs <container>` shows `[cron] firing prompt <id>` and `[cron] <id> failed: ...` lines, plus stdout/stderr from `exec` jobs. The user runs this on the host stage.
- **Session jsonl:** every `prompt` fire creates a session under `sessions/`. The session metadata includes timestamps. You can `read` and `grep` these.
- **Git log:** if a job commits its work (e.g. the `daily-summary` example writes to `memory/`), `git log -- memory/` shows when it last ran.

If the user asks "did the daily summary run?", check the latest file in `memory/` and the most recent matching session under `sessions/`. Don't claim it ran if you can't see evidence.
