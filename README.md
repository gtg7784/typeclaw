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
- **Self-improving** — the agent observes its own work, distills it into sharded long-term memory and reusable skills, and gets sharper over time without you writing prompts for it

If you're like me, TypeClaw is the right choice. If not, that's fine too.

## What you'd expect

- 🐳 **Sandboxed by default** — every agent runs in its own Docker container with `.env` injection and bind-mounted host folders
- 🔌 **Plugin system** — plain TypeScript modules contribute tools, skills, subagents, channels, commands, and typed config
- 💬 **Multi-channel** — Slack, Discord, Telegram, KakaoTalk, GitHub webhooks, and a websocket TUI; one agent, many inboxes
- ⏰ **Cron** — schedule prompts or shell commands; per-job coalescing so slow jobs don't pile up
- 📚 **Skills on demand** — markdown procedures the agent loads only when relevant; zero token cost until used
- 🔎 **Web research** — bundled `scout` subagent plus first-class `websearch` and `webfetch` tools (DuckDuckGo via curl-impersonate, Wikipedia)
- 🛡 **Security guards** — bundled `tool.before` policies catch secret exfil, SSRF, prompt injection, tainted git remotes, and silent privilege escalation (role/cron promotion) before they fire
- 📊 **Usage, inspect, doctor** — `typeclaw usage` reports token/$ spend per session, model, or day; `typeclaw inspect` replays a session transcript and tails live activity; `typeclaw doctor` diagnoses host, agent folder, and plugin state

## Where it goes further

- 🌱 **Self-improving** — bundled `memory` plugin logs sessions to daily streams, then a `dreaming` subagent distills them into sharded long-term memory (`memory/topics/`) on its own schedule; no prompts to write
- 🧠 **Muscle memory** — repeated procedures get distilled into reusable skills the agent writes for itself and loads on later runs
- 💾 **Auto-backup** — the bundled `backup` plugin commits session logs and memory on every idle window with an LLM-generated commit subject
- 🪄 **Subagents** — first-class child sessions with their own system prompt, payload schema, and per-payload coalescing; cron and the main agent fire them through one in-process Stream
- 🪪 **Roles and permissions** — `owner` / `trusted` / `member` / `guest` with first-message match rules per channel; gates `channel.respond`, cron scheduling, and security bypasses, so a Slack stranger can't tell the agent to push to main
- 👥 **Group chat awareness** — knows who's in the room, distinguishes humans from bots, and stays engaged after a reply without re-mentioning
- 🧱 **Managed-file guards** — `typeclaw.json`, `cron.json`, memory shards, and bundled skills are protected from accidental rewrites; invalid config writes and silent role/cron privilege grants are rejected at the tool boundary
- 🌐 **Headed browser inside the container** — bundled `agent-browser` plugin ships Chrome under Xvfb so the agent can drive real web pages past bot fingerprinting
- 🌍 **Tunnels and auto port-forward** — dev servers inside the container appear on `localhost` (even loopback-only ones); public URLs via Cloudflare Quick (zero signup) or your own external URL, with GitHub webhooks self-registered at the resulting URL
- 🔄 **Hot reload** — change `typeclaw.json`, run `typeclaw reload` — no restart for most fields
- 🔁 **Self-restart** — the agent can bounce its own container when it updates itself
- 🎼 **Compose** — orchestrate multiple agents across multiple folders

Memory loop and subagent architecture are covered in detail in [AGENTS.md](./AGENTS.md) and [`src/bundled-plugins/memory/README.md`](./src/bundled-plugins/memory/README.md).

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

See `typeclaw --help` for the full command surface, or [typeclaw.dev](https://typeclaw.dev) for guides and configuration reference.

## Development

```sh
git clone https://github.com/typeclaw/typeclaw
cd typeclaw
bun install
bun run test
```

Pre-commit checks (all must pass — no exceptions):

```sh
bun run typecheck
bun run lint
bun run format
```

See [AGENTS.md](./AGENTS.md) for the long-form architecture notes — stages, hostd internals, message stream, plugin contracts, and the testing philosophy. The docs site at [typeclaw.dev](https://typeclaw.dev) lives in [`docs/`](./docs/).

## Acknowledgments

- **Multi-channel** is powered by [agent-messenger](https://github.com/agent-messenger/agent-messenger) — every non-GitHub adapter (`slack-bot`, `discord-bot`, `telegram-bot`, `kakaotalk`) is built on its SDK. Thanks to the maintainers for the credential extraction, listener protocols, and platform coverage that made multi-channel a feature instead of a year-long project.
- **Subagent architecture** is inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by [@code-yeongyu](https://github.com/code-yeongyu). Thanks for the shape that made this clean.

## License

MIT
