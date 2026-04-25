---
name: typeclaw-cron
description: Use this skill whenever the user asks you to schedule recurring work, run something on a cron, do something every day/hour/week, set up a periodic task, or read or edit your cron schedule. Triggers include "every morning", "every Monday", "schedule a", "remind me every", "set up a cron", "run X periodically", "what's on my cron", "when does X run", or any mention of `cron.json`. Read it before touching `cron.json` — the file has a strict schema, restart semantics, and a best-effort execution model that you must not misrepresent to the user.
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

Use `exec` only for jobs that are pure mechanics — no judgement required. Examples that fit: git snapshots, log rotation, calling a script that already exists. Examples that **don't** fit: anything where "what do I commit" or "what should I write" depends on context. Use `prompt` for those.

`command` is an array. Index 0 is the executable, the rest are argv. Do **not** put a single shell pipeline in `command[0]` — that won't be parsed by a shell. If you need shell features (`|`, `>`, `&&`), wrap explicitly: `["sh", "-c", "your | pipeline | here"]`.

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

1. **Does the work need judgement?** → `prompt`. Otherwise → `exec`.
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
