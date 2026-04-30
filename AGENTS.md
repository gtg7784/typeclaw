# Agent Guidelines

## Pre-commit checks

Before every commit, run all three of these and ensure they pass:

```sh
bun run typecheck
bun run lint
bun run format
```

No exceptions. If any of them fail, fix the cause before committing — do not `--no-verify`, do not stage partial fixes.

## Stages

TypeClaw runs code in three distinct stages. Each stage has a different filesystem, a different process owner, and a different invocation path. Confusing them is the single most common source of bugs in this codebase, so always name the stage explicitly when discussing any command, path, or mount.

### dev stage — this repo

Where you are when you run `bun test` or `bun run typecheck` on the typeclaw source tree. The `typeclaw` CLI is executed directly from `src/cli/index.ts` (no install step). There is no agent folder and no container — only the source code of typeclaw itself. Changes here affect how agents are scaffolded and how the CLI behaves, but never an agent's runtime state.

### host stage — the user's machine

Where an end user lives once they run `typeclaw init`. Their cwd is an agent folder (e.g. `~/coder/`), which holds `typeclaw.json`, `.env`, `package.json` with `typeclaw` as a dependency, markdown files, a truly-ignored `workspace/` (the agent's free-write zone), and `sessions/` + `memory/` — both gitignored at the agent's level but force-committed by TypeClaw itself (auto-backup for sessions, dreaming subagent for memory). Commands that run here are **launchers**, not the agent itself:

- `typeclaw start` — spawn the container (`docker run`) configured in `typeclaw.json`.
- `typeclaw stop` — stop it.
- `typeclaw restart` — `stop` then `start` with the same flags as `start`.
- `typeclaw log [-f]` — show (or follow) the container's stdout/stderr via `docker logs`.
- `typeclaw tui` — attach a TUI client over a websocket to a running agent.
- `typeclaw compose …` — orchestrate multiple agents across multiple agent folders.
- `typeclaw _portbroker --container <name> --cwd <agent-folder>` — internal foreground process spawned detached by `typeclaw start`. Polls `/proc/net/tcp[6]` inside the container via `docker exec` and userland-proxies every new LISTEN port to the same port on `127.0.0.1`. Reaped by `typeclaw stop` via PID file. Underscore-prefixed because end users never invoke it directly. See `src/portbroker/`.

Nothing in the host stage loads the agent runtime itself. Filesystem access is native (no mounts). Secrets live plainly in `.env` for later injection.

The host stage owns one persistent state directory: `~/.typeclaw/` (override with `TYPECLAW_HOME` for tests). It contains `run/<container>-portbroker.pid` (live broker PID, removed on `typeclaw stop`) and `log/<container>-portbroker.log` (broker stdout/stderr, append-only, no rotation). `src/portbroker/pidfile.ts` is the only writer; nothing else in the host stage persists between CLI invocations.

### container stage — inside Docker

Where the actual agent process lives. The host stage bind-mounts the agent folder at `/agent` inside the container and starts a single process that foregrounds the agent loop:

- `typeclaw run` — the foreground process the container is configured to execute. Starts the websocket server (`src/server/`), creates an `AgentSession` (`src/agent/`), and speaks to the TUI or channels.

Inside the container, `FIREWORKS_API_KEY` and friends arrive through `--env-file .env`; the `typeclaw` binary itself is resolved through `node_modules/typeclaw` (which in dev-stage scaffolding is a symlink into the dev-stage repo — the host-stage launcher must mount that source at the same path the symlink expects).

### Rules of thumb

- **CLI command names encode stage.** `init` is host-only (it _creates_ the host stage). `start` / `stop` / `restart` / `log` / `tui` / `compose` are host-only launchers. `run` is container-only. Anything that reads `process.cwd()` implicitly assumes host stage unless it's called from `run`.
- **When writing paths, annotate the stage.** `./typeclaw.json` means the host-stage agent folder; `/agent/typeclaw.json` means the container stage. Never ship a string that silently conflates them.
- **The Dockerfile lives at the boundary.** `typeclaw init` (dev code running in host stage) writes a Dockerfile that `typeclaw start` (host stage) feeds to `docker run`, which then invokes `typeclaw run` (container stage) as the entrypoint.
- **TypeClaw owns the Dockerfile and `.gitignore`, and rewrites them on every `start` — not just on `init`.** The agent folder is treated as a managed workspace, not a one-time scaffold. `start` calls `refreshDockerfile` / `refreshGitignore` unconditionally so version drift between the CLI and the agent folder is corrected automatically. The `.gitignore` is then auto-committed if it changed; the Dockerfile is not (see next bullet). **Consequence: to ship a Dockerfile template change, edit `src/init/dockerfile.ts` and run `typeclaw start --build` in any agent folder. Do not instruct users to delete their Dockerfile or re-run `init`.** The `wx` flag inside `writeDockerAssets` only governs the `init`-time write and is not the system's overwrite policy.
- **The `.gitignore` template (`src/init/gitignore.ts`) splits into two categories that look identical to the gitignore parser but are very different to the system.** _Truly-ignored_ entries (`.env`, `node_modules/`, `workspace/`, `mounts/`, `Dockerfile`, `.DS_Store`) never enter git history. _System-managed_ entries (`sessions/`, `memory/`) are gitignored so the agent doesn't stage them by hand, but TypeClaw force-commits them on its own schedule — `sessions/` via auto-backup, `memory/` via the dreaming subagent. Keep that visual split in `gitignore.ts`'s section comments; any doc that lumps the two categories together is wrong.
- **`Dockerfile` is in the truly-ignored category specifically because `start` regenerates it from the CLI template every run.** Tracking it would only produce noisy `Update Dockerfile` commits whenever `src/init/dockerfile.ts` changes, with zero new information — the source of truth is in this repo, not in the agent folder. Cloning an agent folder onto a fresh machine works because `start` writes the Dockerfile before `docker build` ever reads it. The implication is that an agent folder is only meaningful when paired with the typeclaw CLI; without it, you cannot reproduce the image from the folder alone.
- **`typeclaw.json` has two access patterns, one per stage.** `src/config/config.ts` exports both `config` (a module-import-time snapshot, the eager const consumed by host-stage CLI arg defaults) and `getConfig()` (the live pointer that the container stage updates on `reload`). Host-stage CLI processes are short-lived and use `config` directly. Container-stage runtime code (anything reachable from `typeclaw run` — `createSession`, internal cron job builders) MUST go through `getConfig()` so reloads take effect. Boot-only fields (`port`, `mounts`, `plugins`) are reported as `restart-required` by the reload diff because the values are captured at server start; reload returns success but the change won't apply until the container restarts. The fence is the `FIELD_EFFECTS` table in `src/config/config.ts`, and a guard test in `src/config/reloadable.test.ts` fails if a new schema field lacks a classification — keep both in sync when adding fields. Plugin-owned config blocks (e.g. `memory.*` for the bundled memory plugin) live under `typeclaw.json`'s catchall and are validated by the plugin at boot — `restart-required` since the plugin reads them once.
- **`typeclaw.json#port` is the _preferred_ host port, not a guarantee.** `typeclaw start` allocates a free host port on every run: it tries the configured value (default `8973`) first via `net.createServer().listen(...)` and falls back to a kernel-assigned ephemeral port if it's bound. The container's internal port is fixed at `CONTAINER_PORT` (also `8973`, in `src/container/port.ts`), so the docker mapping is asymmetric: `-p ${hostPort}:${CONTAINER_PORT}`. Two consequences: (1) Docker is the runtime authority for "what host port is this agent on?" — `typeclaw tui` / `typeclaw reload` resolve their connect URL via `docker port <container> 8973/tcp`, falling back to `typeclaw.json#port` only when the container isn't running. (2) `typeclaw run` (container stage) MUST default `--port` to `CONTAINER_PORT`, never to `config.port`, otherwise the in-container Bun server would listen on a port the docker mapping doesn't forward. The `findFreePort → docker run → retry-on-bind-failure` flow lives in `src/container/start.ts`; `resolveHostPort` (in `src/container/port.ts`) is the discovery side.

## Testing Philosophy

### 1. Test behavior, not implementation

A good test survives refactors of its subject's internals and fails only when **observable behavior** changes. Concretely: if you renamed a private helper or split a function in two and tests broke, the tests were coupled to implementation.

**Acceptance bar: the mutation check.**

After writing a test, ask: "If I comment out the line of production code this test is supposed to guard, does the test fail?" If not, the test verifies nothing meaningful.

Applied during review: when adding a new step to a pipeline (e.g. `writeDockerfile`), commenting out the wiring MUST break at least one test. Otherwise the test suite gives false confidence.

### 2. Test at the right layer

Code has layers. Tests must target the layer that owns the behavior being verified.

- **CLI / UI layer** — prompts, spinners, `process.exit`, argument parsing. Hard to test, and rarely worth testing. Keep thin.
- **Domain / pipeline layer** — the actual logic: composition of steps, data transformations, orchestration. **This is the primary test surface.**
- **Primitive layer** — individual file writes, shell invocations, pure functions. Unit-test for edge cases not easily covered by pipeline tests.

When you find yourself mocking `@clack/prompts` or stubbing `process.cwd` to test domain logic, that's a signal: the domain logic is in the wrong place. Extract it into a pure function and test it directly.

**Example in this codebase:** `src/init/index.ts` owns the `runInit` pipeline (scaffold → install → git). `src/cli/init.ts` is a thin shell that collects input via prompts, calls `runInit`, and renders progress via spinners. Pipeline tests target `runInit` directly — no CLI mocking needed.

### 3. Pipeline tests must verify composition, not just steps

For orchestrator functions that compose multiple sub-steps (pipelines, workflows, sagas):

- Unit tests on each sub-step are **necessary but not sufficient**.
- You also need tests that exercise the orchestrator end-to-end and assert on:
  - **Order of execution** (sequence of events / side-effect observable ordering)
  - **Data flow between steps** (step N sees the output of step N-1)
  - **Failure propagation** (fatal vs soft-fail semantics)

If a new step can be added, removed, or reordered without breaking a test, composition is untested.

**How to do it:** make the orchestrator emit observable events (progress callbacks, returned result structures, or async-iterator yields) and assert on the observed sequence.

### 4. One function, one concern

A function that both prompts the user AND runs business logic AND handles `process.exit` has three concerns and three reasons to change. Split them:

- The pure logic becomes testable without mocks.
- The I/O layer becomes small enough that manual review is sufficient.
- New steps get added to the pure layer and are caught by pipeline tests.

### 5. Test doubles sparingly

Every mock is a theory about how a collaborator behaves. Theories rot. Prefer:

1. **Real implementations with controlled inputs** — tmp directories, in-memory state, real subprocess calls when fast enough. This is the default in `src/init/index.test.ts`: real `bun install`, real `git`, real files in `mkdtemp` dirs.
2. **Hand-rolled fakes** when the real thing is genuinely unavailable or too slow.
3. **Mocking libraries** only as a last resort, and only at module boundaries.

If a test requires mocking `@clack/prompts` just to exercise logic, refactor. Don't mock.

### 6. When to skip testing

From the common coding rules: simple data classes, type-only files, auto-generated code, and trivial constants don't need tests. Use judgment — a test that only restates a literal is noise.

### 7. TDD is the default, not a ceremony

Write the failing test first when:

- Behavior is non-trivial
- Edge cases matter
- The API shape is unclear (tests force you to be a consumer)

Skip TDD for throwaway scripts or when the test setup outweighs the logic being tested. This is a tool, not a religion.

## File Layout

Domain logic lives in `src/<domain>/`. Examples: `src/init/`, `src/config/`, `src/server/`, `src/agent/`.

- `src/cli/` is **UI only** — citty commands, clack prompts, spinners, `process.exit`. Delegate to `src/<domain>/` for anything testable.
- Tests live next to code as `<file>.test.ts`.
- Domain entry points are `src/<domain>/index.ts`. Split into multiple files only when a single file gets complex.

## Port broker

`src/portbroker/` is a **host-stage** subsystem that makes any TCP port the agent binds inside its container reachable on `localhost` from the user's machine, with no `typeclaw.json` edits and no container restart. Default-on (`autoForward: true` in the schema). Architecturally: it's the only host-stage daemon in the codebase, and the only persistent host-stage state (`~/.typeclaw/`).

### Why it exists

Docker fundamentally cannot publish new ports on a running container — `HostConfig.PortBindings` is create-time-only, and `docker update` does not cover networking. Without the broker, a process that binds `:5173` inside the container is invisible from the host unless `:5173` was passed to `docker run -p` up front. Pre-declaring every port the agent might ever bind is hostile UX. The broker closes the gap by polling the container's `/proc/net/tcp[6]` via `docker exec` and userland-proxying each LISTEN port through a host-side `Bun.listen` + `Bun.connect` pair to the container's bridge IP.

### Process topology

`typeclaw start` (host stage, short-lived) calls `start()` in `src/container/start.ts`. After the `docker run` succeeds, when `autoForward` is true it invokes `spawnBrokerDetached()` from `src/portbroker/spawn.ts`, which spawns a separate Bun process executing `typeclaw _portbroker --container <name> --cwd <agent-folder>`, redirects its stdio to `~/.typeclaw/log/<name>-portbroker.log`, calls `proc.unref()`, and writes `~/.typeclaw/run/<name>-portbroker.pid`. The CLI then exits; the broker survives because (a) stdio is piped to a file (not inherited), (b) the parent process did not await the child, (c) `unref()` removed the child handle from the parent's event loop. **This is the only place in the codebase that uses detached spawning** — keep it that way.

`typeclaw stop` calls `stopBrokerDetached()` (in `src/container/stop.ts`, before `docker stop`) which reads the pidfile, sends SIGTERM, and removes the pidfile. The broker traps SIGTERM/SIGINT in `src/cli/portbroker.ts`, calls `broker.stop()` to release every host listener and detach from the detector loop, then exits 0.

### Components and ownership

- `src/portbroker/forwarder.ts` — one TCP forward (`hostPort` → `upstreamHost:upstreamPort`). Pure: knows nothing about Docker. Tested end-to-end with two real Bun sockets on loopback.
- `src/portbroker/detector.ts` — polls `docker exec <name> sh -c "cat /proc/net/tcp /proc/net/tcp6"` every 750ms, parses LISTEN entries, emits `open`/`close` events on diff. Tolerates transient `docker exec` failures up to `maxConsecutiveFailures` (default 5). `parseListeningPorts()` is a pure function over the proc text and gets golden-file unit tests.
- `src/portbroker/index.ts` — composition: container-IP resolver + detector + forwarder map. Excludes `cfg.port` (the WS server) and any user entries in `cfg.autoForwardExclude` automatically.
- `src/portbroker/spawn.ts` — detached lifecycle (spawn, pidfile, SIGTERM). The only caller of `Bun.spawn` with `unref()`.
- `src/portbroker/pidfile.ts` — `~/.typeclaw/run/<name>-portbroker.pid` r/w/rm with stale-PID detection via `process.kill(pid, 0)`. Honors `TYPECLAW_HOME` for test isolation.
- `src/cli/portbroker.ts` — internal foreground entry. Underscore-prefixed (`_portbroker`) so users don't see it in `--help`. Re-validates `autoForward` on startup so a config flip + container restart cleanly disables forwarding.

### Why a poll loop and not a stream-target hook

Streams (`src/stream/`) are container-stage only. The host-stage broker has no access to in-container events except via WebSocket reload or `docker exec`. Adding a host↔container IPC channel just to push port-open events is more code, more failure modes, and would require teaching the agent itself about port lifecycles. Polling `/proc/net/tcp` via `docker exec` is one bounded shell-out per 750ms, parses ~few KB of text, and works for any process that binds a TCP socket regardless of whether it cooperates with TypeClaw.

### Rules of thumb

- **`autoForward` defaults to `true` at the user-facing schema layer (`configSchema`), but the `start()` function default is `false`.** This is intentional. Tests and programmatic callers of `start()` get a deterministic, side-effect-free default; the `true` default lives in the user contract (`typeclaw.json`) and the CLI plumbs it through explicitly. Adding a daemon spawn as an implicit default of a function call breaks unit-test isolation.
- **Both `autoForward` and `autoForwardExclude` are `restart-required` in `FIELD_EFFECTS`.** The broker reads its config once at spawn time; reload won't re-evaluate it.
- **Host port equals container port.** Always, no exceptions. There is no random-port fallback because predictable URLs are the whole point. Port collisions are logged (`skip-eaddrinuse`) and the affected port is just not forwarded.
- **The broker's pidfile is the source of truth for "is a broker running for this agent?"** `typeclaw start` checks it before spawning. Stale PIDs (no live process) are treated as no-broker — the next `start` will spawn a fresh one.
- **`Dockerfile` does not need changes.** The broker lives entirely on the host. Container images stay untouched. This keeps the broker decoupled from image rebuilds.

## Message Stream

`src/stream/` is the in-process coordination primitive that the WS server, cron, and the agent's own tool use to talk to each other. It's an in-memory pub/sub keyed by typed targets. **Nothing is persisted**; if the Bun process crashes, all in-flight stream state is lost. Persistence is deliberately out of scope — agentic work is not resumable mid-LLM-call, and the container is the failure unit.

### Targets

A `StreamMessage` carries a `target` discriminating four kinds, each with documented semantics:

- **`broadcast`** — fan-out to every matching subscriber. Used for live notifications (mood, status, presence). The WS server forwards these to connected TUIs as `notification` messages.
- **`session: { sessionId }`** — addressed to a specific live `AgentSession`. Used for TUI input queueing — the WS server publishes here, the per-session drain loop subscribes. Exactly one logical consumer per session.
- **`new-session: { subagent }`** — spawn a fresh subagent session. Published by the cron consumer (when a `prompt` job carries a `subagent` field) and by the WS server (when a session goes idle and the memory-logger should run). Consumed by the `SubagentConsumer` in `src/agent/subagents.ts`, which looks `subagent` up in the in-process registry, validates the payload against the registered `payloadSchema`, and invokes the `Subagent`'s `handler`. Coalescing is per `inFlightKey(name, payload)` — production wiring keys memory-logger by `parentSessionId` (so different parent sessions run in parallel) and dreaming by `agentDir`.
- **`cron: { jobId }`** — emitted by the cron scheduler when a job fires. Consumed by the `CronConsumer` in `src/cron/consumer.ts`, which dispatches to the prompt or exec runner and handles per-jobId coalescing. When a `prompt` job carries a `subagent` field, the consumer republishes to `new-session` instead of running the prompt itself.

Targets are typed unions, not stringly-typed topics. Adding a fifth kind is a deliberate design choice; we do not have a generic `handler` extension point.

### Subagents

`src/agent/subagents.ts` defines the engine-shaped `Subagent` type and the `SubagentConsumer` that subscribes to `new-session` stream messages. Subagents are never called directly from the cron consumer or the server — both go through the stream so any future caller (a tool, a plugin, an event handler) can fire a subagent by publishing to `new-session` without importing the registry. Production wiring in `src/run/index.ts` builds the registry exclusively from plugin contributions: the bundled memory plugin (`plugins/memory/`) is auto-loaded before any user-declared plugins and contributes the `memory-logger` and `dreaming` subagents. Each plugin `Subagent` may declare an `inFlightKey(payload)` function; the consumer reads it at dispatch time and uses `${name}:${key}` as the in-flight set key, allowing per-payload concurrency (e.g. memory-logger keyed by `parentSessionId`). When a `Subagent` declares a `payloadSchema`, the cron loader validates `cron.json`'s `payload` field against it at parse time and at every `reloadAll()` — bad configs fail fast on disk, not 6 hours later when the job fires.

### Bundled plugins

`plugins/memory/` ships with TypeClaw and is auto-loaded by `startAgent` before any user-declared `plugins[]`. The runtime statically imports `plugins/memory/index.ts` and passes it via `LoadPluginsOptions.bundled`. Bundled plugins are not copied into agent folders and are not user-listable. The `memory` config block in `typeclaw.json` (`{ idleMs, dreaming: { schedule } }`) is consumed by this plugin via its `configSchema`; both fields are restart-required because the plugin reads them once at factory time. **`session.idle` is the prompt-end signal** — core fires the hook synchronously after every `session.prompt()` resolves in `src/server/index.ts` `drain()`. Plugins that want delayed reactions (e.g. memory-logger) install their own `setTimeout` and reset it on each event.

### Wire protocol contract

The TUI ↔ WS protocol depends on the stream-driven drain loop in two non-obvious ways. **A wire-protocol change without an in-place container restart will silently break the live UX** because the server runs the source it loaded at process start.

- **Concurrent prompts must not race.** When a `Stream` is wired into the server, `{ type: 'prompt' }` is **not** awaited inline. It's published to `target: { kind: 'session' }` and a per-session drain loop owns all `session.prompt()` calls. The fallback path (no stream) preserves the old direct-prompt behavior so `createServer` is still usable in tests that don't inject a stream. See `src/server/index.ts` `drain()` and `enqueuePrompt()`.
- **Queued user prompts render in execution order, not submission order.** The TUI does not append the `> text` history line at submit time. The server emits `{ type: 'prompt_started', messageId, text }` from the drain loop right after `shift()` and before `await session.prompt()`. The TUI's `prompt_started` handler is what appends the history line. This means an old container running pre-`prompt_started` server code will leave typed messages invisible in the chat — restart the container after any change to the drain or protocol. The `[QUEUED]` panel above the editor still shows pending items in the meantime.
- **`interrupt`-delivery prompts abort on receipt, not in queue order.** `delivery: 'interrupt'` calls `session.abort()` from the publish path so the in-flight `prompt()` resolves immediately, then the drain loop dequeues the new prompt as usual.

### Cron split (celery model)

`src/cron/scheduler.ts` is a **pure clock**. It computes next-fire times and invokes `onFire(job)`. It knows nothing about how a job runs.

`src/cron/consumer.ts` is the **executor**. It subscribes to `target: { kind: 'cron' }`, dispatches by `job.kind` to the prompt or exec runner, and tracks `inFlight` jobIds for per-job coalescing. The scheduler does not coalesce; the consumer does.

This split means a long-running job no longer blocks subsequent ticks at the scheduler layer — the scheduler fires N times for N ticks, and any overlapping fires for the same job are dropped by the consumer with a warning. Same observable behavior as before, cleaner ownership.

### `stream_snapshot` agent tool

`src/agent/tools/stream-snapshot.ts` exposes a read-only tool to the agent that reads from the broker's bounded ring buffer (default 1000 events). The agent can ask "what cron jobs fired in the last minute?" or "did any broadcasts arrive while I was thinking?" without any wire round-trip — the tool is in-process. Read-only by design: the agent cannot publish via this tool. Wired into `createSession` only when a `Stream` is injected.

### Rules of thumb

- **The stream is in-memory and ephemeral.** Anything that must survive a restart belongs elsewhere (session JSONL files, `cron.json`, MEMORY.md). Don't try to use the stream as a queue for important work.
- **Wire-protocol changes require a container restart.** The Bun process loads the source once at start. Editing `src/server/` or `src/shared/protocol.ts` and reconnecting the TUI is not enough; the container must restart (`typeclaw restart`) so the server picks up the new code.
- **Each new target kind is a deliberate addition.** When you find yourself wanting to use the stream for a new use case, prefer a typed target (`{ kind: 'whisper', ... }`, `{ kind: 'channel', ... }`) over a generic catch-all. The four current kinds each pay for themselves with a concrete consumer.
- **Drain loops own serialization.** If a target should have one logical consumer (`session`, `cron`), the consumer is responsible for not running things concurrently. The broker fans out; it doesn't gate.
