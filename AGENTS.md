# Agent Guidelines

> **Audience.** This file is for the AI assistant (or human contributor) working on the typeclaw source tree — the **dev stage** in `## Stages` below. It is **NOT** the runtime prompt for typeclaw agents; that prompt is composed in `src/agent/index.ts` via `composeSystemPrompt` and can be dumped with `bun run debug:prompt`. When sections below describe runtime behavior, they describe what the code in `src/` does — not instructions to the runtime agent.

## Default scope

If the user asks something, it's always about the typeclaw project itself until they specify another scope. Don't drift into upstream/downstream projects (agent-messenger, plugins consumed via npm, etc.) just because the conversation mentions them.

Write only inside this repo and pre-approved temp dirs (`/tmp/`, `$TMPDIR`). Never touch the user's global skills, configs, or agent identities (`~/.claude/`, `~/.agents/`, `~/.config/opencode/`), typeclaw runtime state (`~/.typeclaw/`), credentials (`~/.ssh/`, `~/.aws/`, etc.), shell/OS config, or sibling repos. If you think you need to, stop and ask.

## Pre-commit checks

Before every commit, all three must pass:

```sh
bun run typecheck
bun run lint
bun run format
```

No exceptions. No `--no-verify`. No partial fixes.

## Debugging the system prompt

`bun run debug:prompt` dumps the rendered system prompt for each session-origin kind (`tui`, `cron`, `channel`, `subagent`) with placeholder values, plus a per-section token/char/byte breakdown.

```sh
bun run debug:prompt                       # all 4 origins
bun run debug:prompt --origin cron         # just one
bun run debug:prompt --origin channel --no-git-nudge
```

`composeSystemPrompt` (`src/agent/index.ts`) is the right entry point if you're adding a new section. The cache-suffix contract (least-volatile first → identity → runtime → origin+role → git → memory → now) is enforced by both the helper and `scripts/dump-system-prompt.test.ts`. Reorder one without the other and CI fails. The trailing `## Now` block is pinned last to keep the cache prefix stable across sessions — don't move it.

Slim vs full mode is decided by `deriveSystemPromptMode` (exhaustive `switch` on `origin.kind`). `tui` and `channel` get the full operator-facing prompt; `cron` and `subagent` get the slim base (~245 tok). Production subagents bypass the slim base entirely via `systemPromptOverride`; the slim path only fires for cron today.

## Release

Use the **Release** GitHub Actions workflow (`workflow_dispatch`, see `.github/workflows/release.yml`). It validates the version, runs checks, bumps `package.json`, builds and pushes multi-arch base to `ghcr.io/typeclaw/typeclaw-base:X.Y.Z`, verifies cross-platform pullability, publishes to npm with provenance, then tags + releases. Tags have no `v` prefix.

The workflow is the only supported release path. The GHCR-first-then-npm ordering is load-bearing for the version-pin invariant: a user who `npm install`s before the base image lands cannot `typeclaw start`.

**Version decision.** Specified version → use as-is. Otherwise decide bump level:

- **minor** — new features, new CLI subcommands, new plugin contract surface, breaking changes
- **patch** — bug fixes, refactors, docs, deps, minor improvements
- Never bump major unless asked. Never ask the user which to bump.

`package.json` is the single source of truth for the version.

**Re-running after partial failure.** Every step is idempotent at the same version (GHCR overwrites, `npm publish` is gated by `npm view`, `git tag -f`, `gh release` is gated by `gh release view`). Re-run the workflow at the same version and it cleans up whatever didn't finish.

## Vocabulary

"channel" — or `channel_*` tool/code references — means **`src/channels/`**, this repo's channels subsystem (router, manager, persistence, Slack/Discord adapters). NOT Channel Talk, NOT abstract Slack channels, NOT the agent-messenger `agent-channeltalk*` skills. Only branch out when the user explicitly names a different platform.

## Stages

TypeClaw runs code in three stages with different filesystems, process owners, and invocation paths. Confusing them is the most common bug source. Name the stage explicitly when discussing any command, path, or mount.

### dev stage — this repo

Running `bun run test` / `bun run typecheck` on the typeclaw source tree. CLI executes directly from `src/cli/index.ts`. No agent folder, no container.

### host stage — the user's machine

The user's cwd after `typeclaw init`. Holds `typeclaw.json`, `.env`, `package.json`, markdown files, `workspace/` (free-write zone), `sessions/` + `memory/` (gitignored but force-committed by typeclaw). Host commands are **launchers**:

- `typeclaw start` — `docker run` the configured container.
- `typeclaw stop` — `docker stop` + `docker rm`.
- `typeclaw restart` — `stop` then `start`.
- `typeclaw logs [-f]` — container logs with local-time prefix reformatting.
- `typeclaw tui` — attach a TUI over websocket.
- `typeclaw compose` — orchestrate multiple agents.
- `typeclaw _hostd` — hidden singleton daemon. See [Host daemon (hostd)](https://typeclaw.dev/docs/internals/hostd).

Persistent host state lives in `~/.typeclaw/` (override with `TYPECLAW_HOME` for tests). `src/hostd/paths.ts` is the only writer.

### container stage — inside Docker

The agent folder is bind-mounted at `/agent`. The container's entrypoint is:

- `typeclaw run` — starts the websocket server (`src/server/`), creates an `AgentSession` (`src/agent/`), speaks to TUI/channels.

`FIREWORKS_API_KEY` and friends arrive via `--env-file .env`. The `typeclaw` binary resolves through `node_modules/typeclaw` (in dev, a symlink into this repo).

### Rules of thumb

- **CLI command names encode stage.** `init`/`start`/`stop`/`restart`/`logs`/`tui`/`compose` are host-only. `run` is container-only. Anything that reads `process.cwd()` implicitly assumes host stage unless called from `run`.
- **Annotate stages on paths.** `./typeclaw.json` = host stage; `/agent/typeclaw.json` = container stage.
- **TypeClaw owns Dockerfile + .gitignore and rewrites both on every `start`.** Not just on `init`. `refreshDockerfile` returns `{ changed }`; on change, `start()` ORs into `needsBuild`, so the next start rebuilds without `--build`. To ship a Dockerfile template change, edit `src/init/dockerfile.ts` and run `typeclaw start`. Do not tell users to re-run `init`.
- **`.gitignore` has two categories.** _Truly-ignored_ (`.env`, `node_modules/`, `workspace/`, `mounts/`, `Dockerfile`, `.DS_Store`) — never in git. _System-managed_ (`sessions/`, `memory/`) — gitignored so the agent doesn't stage by hand, but force-committed by typeclaw on its own schedule. Keep that split in `gitignore.ts` section comments.
- **Per-agent Dockerfile pins `typeclaw-base:X.Y.Z` to the installed typeclaw version.** `refreshDockerfile` reads `<agent>/node_modules/typeclaw/package.json#version`. Removing or republishing a `typeclaw-base:X.Y.Z` tag after release breaks every installed copy on rebuild. GHCR has no immutability flag — don't.
- **Dev mode (`file:`/`link:` typeclaw deps) falls back to inlining the heavy stack on `oven/bun:1-slim`** because the matching GHCR tag doesn't exist yet. New heavy-stack layers must land in BOTH `buildBaseDockerfile` (next release's base) AND the inline branch of `buildDockerfile` (dev/tests). `typeclaw start --build` detects locally-linked deps and threads `force: true` so `bun install --force` runs.
- **`refreshDockerfile` runs AFTER `ensureDeps` in `start()`.** Order is load-bearing: the version pin reads `node_modules/typeclaw/package.json#version`, which `bun install` populates.
- **`typeclaw.json` has two access patterns.** Host-stage CLI uses the `config` snapshot. Container-stage runtime code (anything reachable from `typeclaw run`) MUST go through `getConfig()` so reloads take effect. Boot-only fields are `restart-required`; the `FIELD_EFFECTS` table in `src/config/config.ts` is the fence, and a guard test in `src/config/reloadable.test.ts` fails if a new schema field lacks a classification.
- **`validateConfig` is the single host-side gate.** Every host path that consumes `typeclaw.json` goes through it before doing anything destructive. It also walks `config.mounts` and runs `validateMount` (existence, readability, writability). New host-side callers route through `validateConfig`, not `loadConfigSync`.
- **`typeclaw.json#port` is preferred, not guaranteed.** `start` allocates a free port via `net.createServer().listen(...)` and falls back to ephemeral. The container's internal port is fixed (`CONTAINER_PORT`, `src/container/port.ts`). Mapping is asymmetric: `-p ${hostPort}:${CONTAINER_PORT}`. Docker is the runtime authority — `typeclaw tui`/`reload` use `docker port <container> 8973/tcp`. `typeclaw run` MUST default `--port` to `CONTAINER_PORT`, never to `config.port`.
- **Containers run WITHOUT `--rm`.** Load-bearing for debuggability: a crashed container's logs must survive past exit. `typeclaw stop` does `docker stop` + `docker rm`; `start`'s preflight force-removes stale corpses. Do not "modernize" this back.
- **Containers run with `--security-opt seccomp=unconfined`.** Required so `bwrap` (in baseline apt) can create user/pid/mount namespaces from inside Docker — the per-tool sandbox for subagent bash calls depends on it. The outer container is a single-tenant trust boundary, so seccomp's multi-tenant protections are not load-bearing for typeclaw's threat model; the inner bwrap sandbox is what matters for subagent isolation. See [/docs/internals/sandbox](https://typeclaw.dev/docs/internals/sandbox). Do not "harden" this back without first replacing the inner sandbox path with an equivalent boundary.
- **`sandbox.realProc` defaults to `true`, so containers get `--cap-add=SYS_ADMIN` by default.** This is load-bearing for the core subagent workflow: sandboxed external-package CLIs (`bunx agent-*`, `bun add <pkg>`, `bun run <pkg-bin>`) need a real `/proc/self/{fd,maps}`, which the older `--tmpfs /proc` profile couldn't provide — every such call aborted with Bun's opaque `NotDir`. The `real-proc` strategy (`unshare --pid --fork --mount --mount-proc -- bwrap …`) mounts a fresh procfs scoped to a NEW pid namespace, so PID isolation and the `/proc/N/environ` secret-leak guard both survive; the trade is the `CAP_SYS_ADMIN` grant, accepted on the single-tenant boundary (same rationale as `seccomp=unconfined`). The strategy is read from the BOOT-TIME `config` snapshot in `applyBashSandbox` (`src/agent/plugin-tools.ts`), NOT live `getConfig()`, so it stays coherent with the boot-time capability grant — `sandbox` is `restart-required` for exactly this reason. Don't flip the default back to `false` without restoring an equivalent external-package path; `false` is a valid opt-out (no `SYS_ADMIN`) but cannot run external packages in the sandbox.

## Testing Philosophy

### 1. Test behavior, not implementation

Tests must survive refactors and fail only when **observable behavior** changes. After writing a test, ask: "If I comment out the production line this test guards, does it fail?" If not, the test verifies nothing.

### 2. Test at the right layer

- **CLI / UI layer** — prompts, spinners, `process.exit`, argv. Keep thin, rarely test.
- **Domain / pipeline layer** — composition, transformations, orchestration. **Primary test surface.**
- **Primitive layer** — file writes, shell calls, pure functions. Unit-test for edge cases.

If you're mocking `@clack/prompts` or stubbing `process.cwd` to test domain logic, the domain logic is in the wrong place. Extract a pure function and test it directly. Example: `src/init/index.ts` owns the `runInit` pipeline; `src/cli/init.ts` is a thin shell.

### 3. Pipeline tests must verify composition

Unit tests on sub-steps are necessary but not sufficient. You also need orchestrator tests asserting on order of execution, data flow between steps, and failure propagation. If a step can be added/removed/reordered without breaking a test, composition is untested. Make orchestrators emit observable events (callbacks, returned structures, async-iterator yields) and assert on the sequence.

### 4. One function, one concern

A function that prompts AND runs logic AND handles `process.exit` has three reasons to change. Split them: pure logic is testable, I/O is small enough to review, new steps get caught by pipeline tests.

### 5. Test doubles sparingly

Every mock is a theory about a collaborator. Theories rot. Prefer:

1. Real implementations with controlled inputs (tmp dirs, real `bun install`, real `git`).
2. Hand-rolled fakes when the real thing is unavailable or too slow.
3. Mocking libraries only as a last resort, at module boundaries.

### 6. When to skip

Simple data classes, type-only files, auto-generated code, trivial constants. A test that restates a literal is noise.

### 7. TDD is the default, not a ceremony

Write the failing test first for non-trivial behavior, edge cases, or unclear APIs. Skip TDD when setup outweighs the logic. This is a tool, not a religion.

## File Layout

Domain logic lives in `src/<domain>/`. Examples: `src/init/`, `src/config/`, `src/server/`, `src/agent/`.

- `src/cli/` is **UI only** — citty, clack, spinners, `process.exit`. Delegate to `src/<domain>/`.
- Tests live next to code as `<file>.test.ts`.
- Domain entry points are `src/<domain>/index.ts`. Split files only when one gets complex.

## Architecture

The architecture reference lives in the published docs under [Internals](https://typeclaw.dev/docs/internals). It's terse, file-path-heavy, and aimed at the same audience as this file — someone about to edit `src/`.

| Subsystem                                                                                     | Where                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Skills loading sources, naming, lazy semantics                                                | [/docs/internals/skills](https://typeclaw.dev/docs/internals/skills)                       |
| `.env` / `secrets.json`, the `Secret` shape, bridge idempotency, KakaoTalk encryption-at-rest | [/docs/internals/secrets](https://typeclaw.dev/docs/internals/secrets)                     |
| Roles, match-rule DSL, cron/subagent provenance, security guard tiers                         | [/docs/internals/permissions](https://typeclaw.dev/docs/internals/permissions)             |
| `src/hostd/`, three trust channels, control protocol, portbroker                              | [/docs/internals/hostd](https://typeclaw.dev/docs/internals/hostd)                         |
| `src/tunnels/`, providers, channel-adapter integration                                        | [/docs/internals/tunnels](https://typeclaw.dev/docs/internals/tunnels)                     |
| `src/stream/` targets, subagent dispatch, cron split, TUI wire-protocol                       | [/docs/internals/message-stream](https://typeclaw.dev/docs/internals/message-stream)       |
| `src/channels/` engage/observe decision, context buffer, suppressors, peer-bot loop guard     | [/docs/internals/engagement](https://typeclaw.dev/docs/internals/engagement)               |
| `src/agent/todo/` tools, durable scope resolution, fail-closed auto-continuation budgets      | [/docs/internals/todo-continuation](https://typeclaw.dev/docs/internals/todo-continuation) |
| `web_search` tool, `curl-impersonate` pin, DDG failure modes                                  | [/docs/internals/web-search](https://typeclaw.dev/docs/internals/web-search)               |
| Xvfb, NET_ADMIN drop, persistent-`$HOME` overlay, agent-browser headed-mode wrapper           | [/docs/internals/xvfb](https://typeclaw.dev/docs/internals/xvfb)                           |
| `bwrap` per-tool sandbox, `seccomp=unconfined` rationale, OrbStack `/proc` workaround         | [/docs/internals/sandbox](https://typeclaw.dev/docs/internals/sandbox)                     |

The source for these pages is `docs/content/docs/internals/*.mdx` in this repo. Edit there when subsystem behavior changes — the published site rebuilds from the same files.
