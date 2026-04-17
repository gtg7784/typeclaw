# Agent Guidelines

## Stages

TypeClaw runs code in three distinct stages. Each stage has a different filesystem, a different process owner, and a different invocation path. Confusing them is the single most common source of bugs in this codebase, so always name the stage explicitly when discussing any command, path, or mount.

### dev stage — this repo

Where you are when you run `bun test` or `bun run typecheck` on the typeclaw source tree. The `typeclaw` CLI is executed directly from `src/cli/index.ts` (no install step). There is no agent folder and no container — only the source code of typeclaw itself. Changes here affect how agents are scaffolded and how the CLI behaves, but never an agent's runtime state.

### host stage — the user's machine

Where an end user lives once they run `typeclaw init`. Their cwd is an agent folder (e.g. `~/coder/`), which holds `typeclaw.json`, `.env`, `package.json` with `typeclaw` as a dependency, markdown files, and session/memory/workspace dirs. Commands that run here are **launchers**, not the agent itself:

- `typeclaw up` — spawn the container (`docker run`) or load the service (`launchctl load`) configured in `typeclaw.json`.
- `typeclaw down` — stop it.
- `typeclaw tui` — attach a TUI client over a websocket to a running agent.
- `typeclaw compose …` — orchestrate multiple agents across multiple agent folders.

Nothing in the host stage loads the agent runtime itself. Filesystem access is native (no mounts). Secrets live plainly in `.env` for later injection.

### container stage — inside Docker or under launchctl

Where the actual agent process lives. The host stage bind-mounts the agent folder at a well-known path (`/agent` inside Docker; the folder itself under launchctl) and starts a single process that foregrounds the agent loop:

- `typeclaw run` — the foreground process the container/service is configured to execute. Starts the websocket server (`src/server/`), creates an `AgentSession` (`src/agent/`), and speaks to the TUI or channels.

Inside the container, `FIREWORKS_API_KEY` and friends arrive through `--env-file .env`; the `typeclaw` binary itself is resolved through `node_modules/typeclaw` (which in dev-stage scaffolding is a symlink into the dev-stage repo — the host-stage launcher must mount that source at the same path the symlink expects).

### Rules of thumb

- **CLI command names encode stage.** `init` is host-only (it _creates_ the host stage). `up` / `down` / `tui` / `compose` are host-only launchers. `run` is container-only. Anything that reads `process.cwd()` implicitly assumes host stage unless it's called from `run`.
- **When writing paths, annotate the stage.** `./typeclaw.json` means the host-stage agent folder; `/agent/typeclaw.json` means the container stage. Never ship a string that silently conflates them.
- **The Dockerfile lives at the boundary.** `typeclaw init` (dev code running in host stage) writes a Dockerfile that `typeclaw up` (host stage) feeds to `docker run`, which then invokes `typeclaw run` (container stage) as the entrypoint.

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
