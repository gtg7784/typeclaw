# TypeClaw

> A TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime.

## Why?

There are great agents out there. None of them were quite the shape I wanted:

- **OpenClaw** — feature-rich, but heavy
- **NanoClaw** — simple, but no plugin system
- **PicoClaw** — fast, but Go (so plugins live outside the runtime)
- **ZeroClaw** — light, but Rust (same problem, different ecosystem)
- **Hermes Agent** — awesome, but Python

None of that matters to most people. It matters to me. If you're like me, TypeClaw is the right choice.

TypeClaw is the agent I wanted to use:

- **TypeScript end to end** — agent core, plugins, channel adapters, CLI, TUI all in one language
- **Bun-native plugins** — plugins are just TS modules; no IPC, no FFI, hot-reloadable config
- **Docker-friendly by default** — every agent runs in its own container; the host CLI is purely a launcher
- **Multi-channel out of the box** — Slack, Discord, TUI, websocket — all routed through one in-process stream
- **Self-improving** — the agent observes its own work, distills it into long-term memory and reusable skills, and gets sharper over time without you writing prompts for it

## Features

- 🐳 **Sandboxed by default** — every agent runs in its own Docker container, with an `.env` and bind-mounted host folders
- 🔌 **Plugin system** — plain TypeScript modules contribute tools, skills, subagents, channels, commands, and typed config
- 💬 **Multi-channel** — Slack, Discord, Telegram, KakaoTalk, and a websocket TUI out of the box; GitHub for webhook-driven flows; one agent, many inboxes
- 👥 **Group chat awareness** — knows who's in the room, distinguishes humans from bots, and stays engaged after a reply without re-mentioning
- 🛡 **Roles and permissions** — owner / trusted / member / guest with first-message match rules per channel; gates `channel.respond`, cron scheduling, and security bypasses
- 🔒 **Security guards** — bundled `tool.before` policies catch secret exfil, SSRF, prompt injection, and tainted git remotes before they fire; high-severity actions always require a per-call ack
- 🧱 **Managed-file guards** — `typeclaw.json`, `cron.json`, `MEMORY.md`, and bundled skills are protected from accidental rewrites; invalid config writes are rejected at the tool boundary
- ⏰ **Cron** — schedule prompts or shell commands; per-job coalescing so slow jobs don't pile up; jobs inherit the scheduling actor's role
- 📚 **Skills on demand** — markdown procedures the agent loads only when relevant; zero token cost until used
- 🪄 **Subagents** — first-class child sessions with their own system prompt, payload schema, and per-payload coalescing; plugins ship them, cron and the main agent fire them via an in-process Stream (see below)
- 🌱 **Self-improving** — bundled memory plugin observes the agent's work and consolidates it into long-term memory (see below)
- 🧠 **Muscle memory** — repeated procedures get distilled into reusable skills that the agent writes for itself
- 💾 **Auto-backup** — the bundled `backup` plugin commits session logs and memory on every idle window with an LLM-generated commit subject
- 🔎 **Web research** — bundled `scout` subagent, `explorer` for general local search, plus first-class `websearch` and `webfetch` tools (DuckDuckGo via curl-impersonate, Wikipedia)
- 🌐 **Headed browser inside the container** — bundled `agent-browser` plugin ships Chrome under Xvfb so the agent can drive real web pages past bot fingerprinting
- 🔄 **Hot reload** — change `typeclaw.json`, `typeclaw reload` — no restart for most fields
- 🔁 **Self-restart** — the agent can bounce its own container when it updates itself
- 🌐 **Auto port-forward** — dev servers inside the container appear on `localhost`, even loopback-only ones
- 🌍 **Public tunnels** — Cloudflare Quick (zero signup) or bring-your-own external URL; the agent self-registers GitHub webhooks at the resulting public URL
- 📊 **Usage and doctor** — built-in `typeclaw usage` reports token/$ spend per session, model, or day; `typeclaw doctor` diagnoses host, agent folder, and plugin state
- 🎼 **Compose** — orchestrate multiple agents across multiple folders

### 🪄 Subagents, in detail

Subagents are TypeClaw's primitive for "spawn a fresh session to do one specific thing." Not threads, not tool calls, not RPCs — full child sessions with their own model, system prompt, and tool surface, addressable by name.

1. **Declare.** A plugin contributes one via `definePlugin({ plugin: async () => ({ subagents: { scout: createScoutSubagent() } }) })`. Each subagent specifies its `systemPrompt`, optional `payloadSchema` (zod, validated at spawn time), `handler`, and optional `inFlightKey(payload)` for coalescing.
2. **Spawn.** The main agent and plugin hooks both call `ctx.spawnSubagent('scout', { prompt })`, which goes straight to `invokeSubagent`. Cron jobs with a `subagent` field take the other route — the scheduler publishes to the `new-session` Stream target and the `SubagentConsumer` picks it up. Both paths converge on the same `invokeSubagent`.
3. **Inherit.** The spawn stamps `spawnedByRole` and `spawnedByOrigin` from the parent, so permission checks against the subagent's tools resolve correctly — no role laundering, no implicit owner fallback. The override system prompt bypasses the operator-facing base prompt entirely, so subagents are cheap to run (~280 tokens of system prompt vs ~1500+ for a full session).
4. **Coalesce.** `inFlightKey` returns a string per payload; concurrent spawns with the same `(name, key)` are dropped with a warning. Both `memory-logger` and `dreaming` key by `agentDir`, so two concurrent sessions for the same agent serialize instead of racing on the daily stream file or `MEMORY.md`.

Bundled subagents today: `scout` (web research), `explorer` (local search), `operator` (long-horizon plan-then-do), `memory-logger` + `dreaming` (the memory loop), `backup` runner (auto-commit). See [`src/agent/subagents.ts`](./src/agent/subagents.ts) and [AGENTS.md § Subagents](./AGENTS.md#subagents) for the contract.

### 🌱 Self-improving, in detail

The bundled `memory` plugin turns lived experience into reusable knowledge. No manual prompt engineering. No curated example library.

1. **Observe.** After every idle turn, a `memory-logger` subagent reads the transcript and appends notable fragments to `memory/yyyy-MM-dd.md`. Cheap, frequent, lossy by design.
2. **Dream.** On a cron schedule (default 4am), a `dreaming` subagent consolidates daily streams into `MEMORY.md`, and — when it spots a procedure worth remembering — writes it as **muscle memory**: a new skill at `memory/skills/<name>/SKILL.md`.
3. **Apply.** Tomorrow's prompt sees the updated `MEMORY.md`. Muscle-memory skills sit alongside bundled and user-installed ones, loaded on demand. Every dream is committed with a one-line summary — e.g. `dream: 3 fragments + new skill 'pr-review' 🔮` — so growth is auditable.

See [`src/bundled-plugins/memory/README.md`](./src/bundled-plugins/memory/README.md) for the full contract.

## Install

```sh
bun add -g typeclaw
```

Requires Bun ≥ 1.1 and Docker (or OrbStack) on the host.

## Quickstart

```sh
mkdir my-agent && cd my-agent
typeclaw init        # scaffold typeclaw.json, .env, Dockerfile, package.json
typeclaw start       # build + run the container
typeclaw tui         # attach a terminal UI to the running agent
```

That's it. The agent is now alive, listening on a websocket, ready to receive prompts from the TUI or any wired channel.

## CLI

| Command                             | Purpose                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `typeclaw init`                     | Scaffold a new agent folder                                                           |
| `typeclaw start`                    | Build and run the container                                                           |
| `typeclaw stop`                     | Stop the container                                                                    |
| `typeclaw restart`                  | `stop` then `start`                                                                   |
| `typeclaw status`                   | Show container + daemon registration state                                            |
| `typeclaw logs`                     | Stream container stdout/stderr with local timestamps; `-f` to follow                  |
| `typeclaw tui`                      | Attach a terminal UI over the agent's websocket                                       |
| `typeclaw shell`                    | Open a shell inside the running container                                             |
| `typeclaw reload`                   | Push a live config reload to the running agent                                        |
| `typeclaw compose`                  | Orchestrate multiple agents                                                           |
| `typeclaw cron list`                | List every cron job registered in the running agent (user `cron.json` + plugins)      |
| `typeclaw channel add <kind>`       | Wire a new channel adapter (Slack, Discord, Telegram, KakaoTalk, GitHub)              |
| `typeclaw channel set <kind>`       | Rotate the credentials of an already-configured channel (bot/app tokens, PAT, etc.)   |
| `typeclaw channel reauth kakaotalk` | Re-authenticate KakaoTalk after a stale-token 401 or to rotate the stored password    |
| `typeclaw tunnel ...`               | Add/list/status/remove public tunnels and inspect tunnel logs                         |
| `typeclaw role ...`                 | List declared roles and mint first-message claim codes for channel actors             |
| `typeclaw provider ...`             | Manage LLM provider credentials (`add` / `set` / `remove` / `list`); API key or OAuth |
| `typeclaw model ...`                | Manage model profiles in `typeclaw.json` (`models.default`, `models.fast`, …)         |
| `typeclaw doctor`                   | Diagnose the host, agent folder, and plugins; surface remediation steps               |
| `typeclaw usage [view]`             | Report LLM token usage and cost — by `daily`, `session`, `models`, or `origin`        |

## Configuration

Agent folder layout after `init`:

```
my-agent/
├── typeclaw.json     # main config (schema-validated)
├── cron.json         # scheduled jobs (optional)
├── .env              # secrets, injected via --env-file
├── Dockerfile        # auto-managed by typeclaw, refreshed every `start`
├── package.json      # `typeclaw` as a dependency
├── .gitignore        # auto-managed
├── workspace/        # agent's free-write zone (gitignored)
├── sessions/         # JSONL session logs (gitignored, force-committed by auto-backup)
└── memory/           # MEMORY.md + muscle-memory skills (gitignored, force-committed by dreaming)
```

`typeclaw.json` is JSON Schema–validated (see `typeclaw.schema.json`). Highlights:

- `port` — preferred host port (CLI falls back to ephemeral on conflict)
- `mounts` — host directories to expose inside the container
- `plugins` — list of plugin module specifiers
- `channels` — `slack-bot` / `discord-bot` / `telegram-bot` / `kakaotalk` / `github` config
- `roles` — per-role permissions and match rules; built-ins are `owner` / `trusted` / `member` / `guest`
- `models` — model profiles (`default`, `fast`, `deep`, …) bound to `<provider>/<model>` refs
- `portForward` — allow/deny list for auto port forwarding (default: `*`)
- `tunnels` — declare public URLs for inbound webhooks and ad-hoc exposure (`cloudflare-quick` or `external`)
- `dockerfile` — toggles for `gh`, `python`, `tmux`, `ffmpeg`, `cjkFonts`, `xvfb`, `cloudflared`, plus `append` lines
- `memory` — idle window and dreaming schedule for the memory plugin
- `backup` — idle window and commit-message-LLM ref for the auto-backup plugin
- `toolResultCap` — image/text byte caps applied to oversized tool results

`Dockerfile` and `.gitignore` are owned by TypeClaw and rewritten on every `start` — edit `src/init/dockerfile.ts` and re-run `start --build` to ship template changes.

### Bundled plugins

These ship with the runtime and auto-load before any user-declared `plugins[]`. They're configured under their own `typeclaw.json` keys (e.g. `memory`, `backup`) and can be tuned but not removed.

| Plugin            | Purpose                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `memory`          | Observe-and-dream loop: distills sessions into `MEMORY.md` and writes muscle-memory skills under `memory/skills/`       |
| `backup`          | Force-commits `sessions/` and `memory/` on every idle window with an LLM-generated commit subject                       |
| `security`        | `tool.before` guards for secret exfil, SSRF, prompt injection, outbound-secret scanning, and git-remote taint detection |
| `guard`           | Protects managed files (`typeclaw.json`, `cron.json`, `MEMORY.md`, bundled skills) from accidental or invalid writes    |
| `tool-result-cap` | Truncates oversized tool results (images, text) before they hit the model context                                       |
| `agent-browser`   | Headed Chrome under Xvfb inside the container, with a dashboard proxy for live cursor + DOM inspection                  |
| `scout`           | Web-research subagent — fans out parallel `websearch` + `webfetch` calls and synthesizes findings                       |
| `explorer`        | General local-search subagent (codebase + `workspace/` + tmp) for "where is X?" questions                               |
| `operator`        | Long-horizon task executor subagent for multi-step plan-then-do flows                                                   |

### Secrets

Credentials live in two gitignored files: `.env` (plain `KEY=value` lines, injected into the container via `--env-file`) and `secrets.json` (a structured store managed by TypeClaw). **Env-wins**: when a credential's canonical env var (e.g. `FIREWORKS_API_KEY`, `SLACK_BOT_TOKEN`) is set, that value is used at runtime — `secrets.json` is never auto-mutated to capture it. Every secret-bearing field in `secrets.json` is a `Secret` (`string | { value?, env? }`), so the file can rebind a credential to a custom env-var name on demand. See [AGENTS.md § Secrets](./AGENTS.md#secrets) for the full contract.

## Development

```sh
git clone https://github.com/typeclaw/typeclaw
cd typeclaw
bun install
bun test
```

Pre-commit checks (must all pass — no exceptions):

```sh
bun run typecheck
bun run lint
bun run format
```

See [AGENTS.md](./AGENTS.md) for the long-form architecture notes — stages, hostd internals, message stream, plugin contracts, and the testing philosophy.

## Website

The landing page and documentation site at [typeclaw.dev](https://typeclaw.dev) lives in [`docs/`](./docs/). It's a Next.js + Fumadocs app — see [`docs/README.md`](./docs/README.md) for layout and the contributor workflow.

## Acknowledgments

- **Multi-channel** is powered by [agent-messenger](https://github.com/agent-messenger/agent-messenger) — every non-GitHub adapter (`slack-bot`, `discord-bot`, `telegram-bot`, `kakaotalk`) is built on its SDK. Thanks to the agent-messenger maintainers for the credential extraction, listener protocols, and platform coverage that made multi-channel a feature instead of a year-long project.
- **Subagent architecture** is inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by [@code-yeongyu](https://github.com/code-yeongyu). Thanks for the shape that made this clean.

## License

MIT
