---
name: typeclaw-config
description: Use this skill whenever the user asks you to read or change your runtime configuration, switch model, change the server port, or whenever you yourself need to inspect or edit `typeclaw.json`. Triggers include "what model are you running", "switch to <model>", "change the port", "edit typeclaw.json", "what's in your config", "use a different provider", or any mention of `typeclaw.json` / runtime settings. Read it before touching `typeclaw.json` — the file has a strict schema, a tiny set of allowed values today, and a restart-required semantic that you must not misrepresent to the user.
---

# typeclaw-config

You have a runtime config file at `./typeclaw.json` in your agent folder. It tells the typeclaw runtime which model powers you and which port the websocket server listens on. This skill exists so you do not corrupt the file, do not promise behavior the runtime cannot deliver, and do not surprise the user.

This file is **not** about who you are — that is `IDENTITY.md`, `SOUL.md`, etc. This file is about the machine you run on.

## What `typeclaw.json` actually controls

The runtime reads `typeclaw.json` **once** at container startup. It uses two fields:

- `port` — the TCP port the websocket server binds to inside the container. The TUI on the host stage connects to this. Default `8973`.
- `model` — a fully-qualified `<provider>/<model-id>` string. The runtime resolves this against the built-in provider registry to decide which API to call for every turn.

There is no file watcher. **Editing `typeclaw.json` while the container runs does nothing until the next restart.** When you change it, tell the user explicitly: "Edited `typeclaw.json`. Run `typeclaw down && typeclaw up` (host stage) to pick up the change." You yourself cannot run `typeclaw down`/`up` — those are host-stage commands and you live inside the container. Only the user can restart you. Do not try.

## The schema (this is the whole thing today)

`typeclaw.json` is a single JSON object with these fields:

| Field     | Required | Type    | Notes                                                                                                                                                            |
| --------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema` | no       | string  | Path to `typeclaw.schema.json` for editor autocompletion. Scaffolded as `./node_modules/typeclaw/typeclaw.schema.json`. Leave it alone unless the user moves it. |
| `port`    | no       | integer | 1–65535. Defaults to `8973` (T9 spelling of "TYPE"). Change only if the default collides with something on the user's host.                                      |
| `model`   | no       | string  | Must be one of the values listed in the **Allowed models** section below. Defaults to `fireworks/accounts/fireworks/routers/kimi-k2p6-turbo`.                    |

The runtime parses this file with a strict schema (`zod`). **Unknown fields are tolerated but ignored** — they do nothing. Do not invent fields like `provider`, `apiKey`, `temperature`, `maxTokens`, `systemPrompt`, `tools`, `timeout`, etc. They will be silently dropped. If the user asks for one of those, say it is not yet supported and (if it makes sense) suggest they file a request.

A scaffolded `typeclaw.json` looks like:

```json
{
  "$schema": "./node_modules/typeclaw/typeclaw.schema.json",
  "model": "fireworks/accounts/fireworks/routers/kimi-k2p6-turbo"
}
```

The runtime will fill in `port` from the default if it is omitted.

## Allowed models

Today, the model registry contains exactly **one** entry:

| `model` value                                          | Display name    | Provider  | Notes                                                                  |
| ------------------------------------------------------ | --------------- | --------- | ---------------------------------------------------------------------- |
| `fireworks/accounts/fireworks/routers/kimi-k2p6-turbo` | Kimi K2.6 Turbo | Fireworks | Requires `FIREWORKS_API_KEY` in `.env`. Reasoning model, 256K context. |

**Do not write any other value into `model`.** The schema enum will reject the file at load, and the runtime will refuse to boot the agent process. If the user names a model that isn't in this table — "switch me to GPT-5", "use Claude" — be honest:

> "Right now my registry only has Kimi K2.6 Turbo on Fireworks. More providers are planned but not wired up yet. If you want a different model, that needs a typeclaw release, not a config edit."

Do **not** edit `typeclaw.json` to a model the registry doesn't know, even if the user insists. That bricks the agent on next restart.

## Provider credentials

`typeclaw.json` does **not** hold API keys. Credentials live in `./.env` (gitignored). For the only currently-supported model:

- `FIREWORKS_API_KEY` — required for any `fireworks/...` model.

If the user wants to rotate or change the key, edit `.env`, not `typeclaw.json`. After editing `.env`, the same restart rule applies: `typeclaw down && typeclaw up` on the host stage.

Never echo, log, or commit values from `.env`. `.env` is gitignored by default — keep it that way.

## Editing `typeclaw.json` safely

`typeclaw.json` is a single canonical file at the agent folder root. It is committed to git (not gitignored). Treat it like a config file you own.

### Workflow

1. **Read the whole file first** with the `read` tool. Don't assume what's in it — the user may have customized it.
2. **Modify in memory.** Change only the field(s) the user asked about. Leave `$schema` alone.
3. **Write the whole file back** with the `write` tool. Always pretty-printed (2-space indent), trailing newline, fields in stable order: `$schema` first, then alphabetical (`model`, `port`).
4. **Validate before declaring done.** A malformed `typeclaw.json` will refuse to boot the agent on next restart. Sanity-check your JSON manually or with `bash` (`cat typeclaw.json | jq .`) before considering the edit done.
5. **Commit the change.** `git add typeclaw.json && git commit -m "Change <field> to <value>"`. Use the imperative mood; explain in the body why if it isn't obvious. `typeclaw.json` is not gitignored, so an uncommitted edit will pollute your next commit.
6. **Tell the user to restart.** "Edited `typeclaw.json`. Run `typeclaw down && typeclaw up` (host stage) to pick up the change."

### Required-shape checklist (catch this before writing)

- The file parses as JSON
- Top-level is an object (not an array, not a string)
- If `port` is set: integer, 1–65535
- If `model` is set: exactly one of the values in **Allowed models** above
- No unknown top-level keys you invented — they are silently ignored, which means the user thinks they took effect and they did not

## Things you must not do

- **Do not invent fields the schema doesn't support** (no `provider`, `apiKey`, `temperature`, `maxTokens`, `systemPrompt`, `tools`, `timeout`, `retry`, etc.). They will be silently ignored. Lying to the user that "I added a temperature field" when the runtime ignores it is a worse failure than refusing.
- **Do not move secrets into `typeclaw.json`.** It is committed to git. API keys belong in `.env`.
- **Do not change `port` casually.** The host-stage `typeclaw up` launcher publishes a port mapping it learned at `up` time. Changing the port in `typeclaw.json` without re-running `typeclaw up` (which re-reads it) means the TUI will connect to the wrong port and silently fail. If you change `port`, tell the user explicitly that the next `typeclaw up` will pick the new mapping.
- **Do not change `model` to something not in the registry.** The agent will refuse to boot. If the user wants a model that isn't there, this is a typeclaw-side change, not a config edit.
- **Do not edit `typeclaw.json` from inside an `exec` cron job's `command`.** That mutates the file behind the runtime's back; the change does not apply until the next restart anyway.
- **Do not delete `$schema`.** It powers editor autocompletion for the user. Leaving it in costs nothing.

## When the user says "what model are you running"

1. **Read `typeclaw.json`.** Don't guess from prior conversation — the user may have changed it since you last looked.
2. Report the `model` field verbatim, plus the human-readable name from the **Allowed models** table.
3. If `model` is missing from the file, say so and report the default (`fireworks/accounts/fireworks/routers/kimi-k2p6-turbo` → Kimi K2.6 Turbo).

## When the user says "switch to <model>"

1. **Check the Allowed models table.** Is the requested model in it?
2. **If yes:** read `typeclaw.json`, change `model`, write it back, commit, tell the user to restart.
3. **If no:** do not edit anything. Tell the user the registry doesn't have it yet, and that adding a model is a typeclaw release, not a config change.

## When the user says "change the port"

1. Confirm the new port is 1–65535 and not in the privileged range (<1024) unless the user explicitly knows they need it.
2. Read `typeclaw.json`, set `port`, write it back, commit.
3. Tell the user: "The next `typeclaw up` (host stage) will publish the new port mapping. The current container will keep running on the old port until then."

## What this skill does _not_ cover

- **Cron jobs** (`cron.json`) — see the `typeclaw-cron` skill.
- **Identity, soul, persona** (`IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`) — these are not runtime config; they are _you_. Edit them directly when relevant; no skill needed.
- **Skills themselves** (`.agents/skills/`, `skills/`) — these are loaded from disk by the runtime; they are not driven by `typeclaw.json`.
- **Docker / launchctl wiring** — that is host-stage, controlled by `Dockerfile` and the `typeclaw up` launcher, not by `typeclaw.json`.
