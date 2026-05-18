---
name: typeclaw-plugins
description: TypeClaw plugin authoring and operation guide. Use when writing, editing, configuring, debugging, or installing a TypeClaw plugin — including any work with definePlugin, defineTool, defineSubagent, plugin hooks (session.start/end/idle/prompt, tool.before/after), plugin cron jobs, plugin commands (host/container/either CLI subcommands callable as `typeclaw <name>`), plugin skills, the typeclaw/plugin import path, or per-plugin config blocks in typeclaw.json. Also use when you need to bridge a cron `exec` job to LLM-driven work — the canonical pattern is a `surface: 'container'` plugin command whose `run` calls `ctx.prompt(...)`, invoked as `typeclaw <command>` from cron's `command` array. Triggers on mentions of 'TypeClaw plugin', 'definePlugin', 'plugin hook', 'plugin cron', 'plugin command', 'PluginCommand', 'ContainerCommand', 'HostCommand', 'EitherCommand', 'ctx.prompt', 'ctx.subagent', 'ctx.exec', 'plugins[]', 'typeclaw-plugin-', or any file under src/plugin/ or plugins/.
---

# TypeClaw Plugins

A plugin is a TypeScript module with **one default export** — a call to `definePlugin({ ... })`. The factory returns a contributions object that the runtime translates into tools, subagents, cron jobs, skills, and event hooks. Plugins import only from `typeclaw/plugin` and `zod`.

This skill covers BOTH authoring new plugins AND operating existing ones (config layout, debugging failures, lifecycle).

---

## 1. The Architectural Boundary (read first)

Three layers, sharply separated:

```
Plugin API (typeclaw/plugin)  ← plugins live here. NO @mariozechner/* imports.
        ↓
TypeClaw runtime (src/plugin, src/agent, src/run, src/server, src/cron)
        ↓
Engine (@mariozechner/pi-coding-agent)  ← never visible to plugins
```

**MUST NOT** import anything from `@mariozechner/*` in plugin code. The single bridge file is `src/agent/plugin-tools.ts` (runtime layer, not plugin layer). The boundary is enforced by convention — no lint rule today, but `grep` confirms no `src/plugin/**` file imports `@mariozechner/*`.

**Allowed plugin imports**: `typeclaw/plugin`, `zod`, Node built-ins, your own modules.

---

## 2. Minimum Viable Plugin

```ts
// my-plugin.ts
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  plugin: async (ctx) => ({
    hooks: {
      'session.prompt': (event) => {
        event.prompt += `\n\n[plugin: ${ctx.name}]`
      },
    },
  }),
})
```

That's it. No manifest. No `name`. No `version`. The plugin's name is **derived** at load time (see §4).

---

## 3. Plugin with Config (typed `ctx.config`)

`definePlugin` infers `TConfig` from the literal `configSchema`. **You never write the generic.**

```ts
import { z } from 'zod'
import { definePlugin, defineTool } from 'typeclaw/plugin'

export default definePlugin({
  configSchema: z.object({
    schedule: z.string().default('0 9 * * 1'),
    journalDir: z.string().default('journal'),
  }),
  plugin: async (ctx) => {
    // ctx.config is typed: { schedule: string; journalDir: string }
    return {
      cronJobs: {
        'weekly-digest': {
          schedule: ctx.config.schedule,
          kind: 'prompt',
          prompt: 'Compile this past week into a digest.',
        },
      },
      tools: {
        lookup: defineTool({
          description: 'Look up a journal entry by date.',
          parameters: z.object({ date: z.string() }),
          async execute(args, toolCtx) {
            return { content: [{ type: 'text', text: `looked up ${args.date}` }] }
          },
        }),
      },
    }
  },
})
```

Without `configSchema`, `ctx.config` is `never` and any reference is a type error.

---

## 4. Loading & Naming (typeclaw.json)

```json
{
  "$schema": "./node_modules/typeclaw/typeclaw.schema.json",
  "model": "fireworks/...",
  "plugins": ["typeclaw-plugin-standup-log", "@acme/typeclaw-plugin-foo", "./plugins/local-thing"],
  "standup-log": { "schedule": "0 17 * * 5" },
  "foo": { "...": "..." },
  "local-thing": { "...": "..." }
}
```

### Plugin name derivation (you do NOT declare it)

| Source      | Rule                                                      | Example → Name                                |
| ----------- | --------------------------------------------------------- | --------------------------------------------- |
| NPM package | strip leading scope, then strip `typeclaw-plugin-` prefix | `@acme/typeclaw-plugin-foo` → `foo`           |
| NPM package | strip `typeclaw-plugin-` prefix                           | `typeclaw-plugin-standup-log` → `standup-log` |
| NPM package | no prefix → use as-is                                     | `my-cool-pkg` → `my-cool-pkg`                 |
| Local path  | basename, strip extension                                 | `./plugins/local-thing.ts` → `local-thing`    |

The **derived name is the key** for the per-plugin config block at the top level of `typeclaw.json`. Two plugins with the same derived name are a boot error.

### Local path safety

Local plugin paths **must resolve inside `agentDir`**. Absolute paths (`/etc/...`) and parent-traversing paths (`../../foo`) are rejected with:

```
plugin path escapes agent directory: <entry> (resolved to <abs-path>)
```

This is why `./plugins/x.ts` works and `/Users/me/x.ts` does not.

### Recommended location: `packages/<plugin-name>/`

The agent folder is a **bun monorepo**, and `packages/` is its workspace root. **Custom plugins go there.** A `./packages/standup-log/` plugin is a real workspace package — bun installs its dependencies, the workspace symlink machinery makes it importable, and it lands in git like any other reusable code. Concretely:

```
packages/
  standup-log/
    package.json
    index.ts            # exports default definePlugin({ ... })
    index.test.ts
```

```json
// typeclaw.json
{
  "plugins": ["./packages/standup-log"],
  "standup-log": { "schedule": "0 17 * * 5" }
}
```

The derived plugin name is `standup-log` (basename of the path), so the per-plugin config block uses that key. Read the `typeclaw-monorepo` skill for the full package layout, dependency wiring (`workspace:*`), root-script conventions, and how to share code between multiple workspace packages.

Putting plugins anywhere else (a top-level `./plugins/` folder, a script under `workspace/`, an absolute path) works — but loses the workspace's dependency hoisting, gets you no `bun install` integration, and (for `workspace/`) silently disappears on the next clone because `workspace/` is gitignored.

### Boot-time effects

- `plugins` is a **`restart-required`** field. Editing the array (add/remove/reorder) needs `typeclaw restart` to take effect — `reload` won't pick it up.
- A factory throw, a `configSchema` rejection, a duplicate plugin name, or a duplicate tool/subagent/skill/cron name → **boot fails**. All registrations from the offending plugin are atomically rolled back.

---

## 5. The Contributions Object

```ts
type PluginExports = {
  tools?: Record<string, Tool>
  subagents?: Record<string, Subagent>
  cronJobs?: Record<string, PluginCronJob>
  skills?: Record<string, PluginSkill> // string-form
  skillsDirs?: string[] // file-form (absolute paths)
  hooks?: Hooks
}
```

Every key is optional. The runtime reads each and wires it in.

### 5.1 `tools` — global names

```ts
import { z } from 'zod'
import { defineTool } from 'typeclaw/plugin'

tools: {
  standup_query: defineTool({
    description: 'Read past journal entries.',
    parameters: z.object({ date: z.string().optional() }),
    async execute(args, toolCtx) {
      // toolCtx: { signal, sessionId, agentDir, logger }
      return { content: [{ type: 'text', text: '...' }] }
    },
  }),
}
```

- Tool names are **global**. Two plugins cannot register the same name.
- `parameters` is a **Zod schema**. The runtime converts to JSON Schema via `z.toJSONSchema(schema, { io: 'input', reused: 'inline' })`.
- Args are **validated once** before `tool.before` hooks see them — no double-parse. Hooks receive `event.args` as a **mutable bag** (`Record<string, unknown>`); mutations propagate to later hooks and to `execute`.
- `ToolContext` is **stripped down** to `{ signal, sessionId, agentDir, logger }`. It does NOT expose the engine's `ExtensionContext`. If your tool wants `read`/`bash`/etc., it cannot call them — declare a subagent with `tools: [readTool, ...]` instead.
- `ToolResult.content` uses TypeClaw's `ContentPart` union: `{ type: 'text'; text }` or `{ type: 'image'; mimeType; data }`.

### 5.2 `subagents` — declarative

```ts
import { z } from 'zod'
import { readTool, defineSubagent } from 'typeclaw/plugin'

subagents: {
  'journal-writer': defineSubagent({
    systemPrompt: 'You are a journal writer.',
    tools: [readTool],                    // built-in refs (re-exported)
    customTools: [appendTool],            // plugin-defined tools, scoped to this subagent
    payloadSchema: z.object({
      parentSessionId: z.string(),
      agentDir: z.string(),
    }),
    async handler(ctx, runSession) {
      // ctx: { userPrompt, agentDir, payload }
      await runSession({ userPrompt: buildPrompt(ctx.payload) })
    },
  }),
}
```

| Field           | Required | Notes                                                                        |
| --------------- | -------- | ---------------------------------------------------------------------------- |
| `systemPrompt`  | yes      | Replaces the main agent's system prompt entirely for the subagent's session. |
| `tools`         | no       | `BuiltinToolRef[]` — re-exported refs only.                                  |
| `customTools`   | no       | `Tool[]` — visible only to this subagent, NOT to the main agent.             |
| `payloadSchema` | no       | Validated on every invocation.                                               |
| `handler`       | no       | If absent, the runtime calls `runSession()` with the original user prompt.   |

**Built-in tool refs** re-exported from `typeclaw/plugin`:

```ts
import { readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool } from 'typeclaw/plugin'
```

Subagent names are global; the runtime uses the name **verbatim** (not prefixed). Pick discriminating names (`journal-writer`, not `worker`).

`runSession({ userPrompt? })` resolves when the spawned session completes one prompt. The session is created and disposed inside the call.

### 5.3 `cronJobs` — prefixed global ids

```ts
cronJobs: {
  'weekly-digest': {
    schedule: '0 9 * * 1',
    kind: 'prompt',
    prompt: 'Compile this past week into a digest.',
    subagent: 'journal-writer',           // optional; routes through subagent registry
    payload: { /* validated by journal-writer's payloadSchema at boot */ },
  },
  'log-rotate': {
    schedule: '0 0 * * *',
    kind: 'exec',
    command: ['bun', 'run', 'scripts/rotate.ts'],
  },
  // Canonical pattern when the plugin also declares a `commands` entry (§5.7):
  // the cron job invokes the plugin's own command. Same Bun.spawn dispatch as
  // a cron.json `exec` job pointing at the same command — provenance, role
  // inheritance, and scheduledByRole stamping all work identically.
  daily: {
    schedule: '0 22 * * *',
    timezone: 'Asia/Seoul',
    kind: 'exec',
    command: ['typeclaw', 'audit-commits', '--since=24h'],
  },
}
```

- The map key is a **suffix**. The runtime constructs the global cron id as `__plugin_<plugin-name>_<key>` (e.g., `__plugin_standup-log_weekly-digest`).
- `cron.json` user job ids cannot start with underscore, so collision is impossible by construction.
- A `prompt` job's `subagent` and `payload` are **validated against the registry at boot** — bad references fail loudly on disk, not 6 hours later when the job fires.
- Only two kinds: `prompt` and `exec`. Plugins do not extend the schema.

**When to use plugin `cronJobs` vs `cron.json`.** Both schedulers fire `Bun.spawn(['typeclaw', '<cmd>', ...])` identically; what differs is **who owns the cadence**. Plugin `cronJobs` is the right home when the plugin author has an opinion about when the job runs (installing the plugin = scheduled behavior is live, no user wiring required). `cron.json` is for user-owned cadences — weekends only, custom timezone, off-hours runs. **Default to plugin `cronJobs`** when shipping a command that has a natural cadence; reach for `cron.json` only when the cadence is user-specific. See `typeclaw-cron` for the full rules.

For the `exec → LLM` and conditional-`ctx.prompt`-gating patterns that this scheduling layer enables, see §5.7 below and `typeclaw-cron`.

### 5.4 `skills` — string-form (per-session tmpdir)

```ts
skills: {
  'standup-log': {
    description: 'How to use the standup log.',
    content: '# Standup log\n\n...',
    frontmatter: { 'allowed-tools': ['standup_query'] },
  },
}
```

- Materializes to a per-session tmpdir as `<sanitized-name>/SKILL.md` at session start. Disposed on websocket close.
- The map key becomes the skill's `name`. Names are **global** across plugins.
- Sanitization: lowercase, non-`[a-z0-9_-]` chars become `-`. Duplicate sanitized names throw at registration.

### 5.5 `skillsDirs` — file-form (paths)

```ts
import { join } from 'node:path'

skillsDirs: [join(import.meta.dir, 'skills')]
```

Each path is added to the resource loader's skill paths verbatim. Discovery walks for `SKILL.md` files. **No collision check** on directory paths (intentional — multiple plugins can contribute different skills from the same dir).

### 5.6 `hooks`

```ts
hooks: {
  'session.start':  async (event, ctx) => { /* { sessionId, agentDir } */ },
  'session.end':    async (event, ctx) => { /* { sessionId } */ },
  'session.idle':   async (event, ctx) => { /* { sessionId, parentTranscriptPath, idleMs } */ },
  'session.prompt': async (event, ctx) => {
    event.prompt += `\n\n${await readToday(ctx.agentDir)}`  // mutate by reassign
  },
  'tool.before': async (event, ctx) => {
    // event.args is a MUTABLE BAG — mutate to rewrite, or:
    if (event.args.danger === true) return { block: true, reason: 'unsafe' }
  },
  'tool.after': async (event, ctx) => {
    // observe or transform event.result
  },
}
```

| Hook             | Direction           | Payload                                       | Notes                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.start`  | observe             | `{ sessionId, agentDir }`                     | Awaited before TUI gets `connected`.                                                                                                                                                                                                                                           |
| `session.end`    | observe             | `{ sessionId }`                               | Awaited before close handler resolves.                                                                                                                                                                                                                                         |
| `session.idle`   | observe             | `{ sessionId, parentTranscriptPath, idleMs }` | Fires **after every prompt completion** (success or error). The agent is "idle" the moment it stops responding. Plugins owning idle-debounced work (e.g. memory-logger spawn) install their own `setTimeout` and reset it on each event. `idleMs` is reserved (currently `0`). |
| `session.prompt` | intervene           | `{ prompt, sessionId, agentDir }`             | Reassign `event.prompt`. Runs once per session start, in plugin-load order.                                                                                                                                                                                                    |
| `tool.before`    | intervene           | `{ tool, sessionId, callId, args }`           | Fires for plugin-defined tools and TypeClaw-exposed system tools, including built-in pi tools when plugins are wired. Mutate `event.args`, or return `{ block: true, reason }`. First block short-circuits.                                                                    |
| `tool.after`     | observe / transform | `{ tool, sessionId, callId, result }`         | Fires after plugin-defined tools and TypeClaw-exposed system tools. Observe `event.result`; tool result mutation is best-effort and tool-specific.                                                                                                                             |

**Multiple plugins** for the same hook run **in plugin-load order**. For `session.prompt`, the next plugin sees the previous plugin's mutated string.

#### CRITICAL: `session.prompt` and provider prompt caching

Provider prompt caching makes the **prefix** of the system prompt 5–10× cheaper on subsequent calls. Cache hits require **byte-identical prefixes**.

- **Append** to `event.prompt` → cache-safe. Always prefer this.
- **Prepend** or **replace** → invalidates the cache for every LLM call until the prompt changes again.

If your content varies per session, **append**. If it's stable across sessions, prepending is fine but understand the cost.

### 5.7 `commands` — typeclaw CLI subcommands

A plugin can register top-level CLI commands invocable as `typeclaw <name>` from any shell sitting in the agent folder. **Unlike every other contribution in §5, `commands` is declared by-value on `definePlugin(...)`, NOT inside the factory return.** This is so the host-stage CLI can dispatch commands without booting the plugin runtime (no `bun install`, no factory, no engine spin-up just to print `--help`).

```ts
import { z } from 'zod'
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  commands: {
    'standup-now': {
      surface: 'container',
      description: 'Generate a standup write-up for today from sessions/.',
      args: z.object({
        date: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
      }),
      async run(ctx, args) {
        const text = await ctx.prompt(
          `Read sessions/ for ${args.date ?? 'today'} and write a 3-bullet standup to standup/${args.date ?? 'today'}.md.`,
        )
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(text + '\n'))
        writer.releaseLock()
        return 0
      },
    },
  },
  plugin: async (ctx) => ({
    /* tools, hooks, cron, ... */
  }),
})
```

Once installed, the user (or a cron `exec` job) runs `typeclaw standup-now --date=2026-05-18`. `typeclaw --help` lists all discovered plugin commands automatically — no separate registration.

#### The three surfaces

| `surface`     | Runs where                                                          | `ctx` has                                                                 | Use when                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'container'` | Inside the running agent container, proxied over WS by the host CLI | `prompt`, `subagent`, `exec`, `permissions`, `origin`, `signal` + streams | The command needs the agent runtime — LLM calls (`ctx.prompt`), subagent invocation, permission checks. **This is the bridge for `exec → LLM` from cron (see below).** |
| `'host'`      | On the user's machine, no container required                        | `streams`, `signal`, `logger`, `agentDir` (host path)                     | The command only touches host-side state (files, host binaries, prompts the user). Container does NOT need to be running.                                              |
| `'either'`    | Whichever stage invoked it — same author code runs in both          | The intersection (`streams`, `signal`, `logger`, `agentDir`)              | The command's logic is stage-agnostic. `agentDir` resolves to `/agent` in the container and the host path on the host, automatically.                                  |

The `surface: 'container'` command requires the container to be running. The host CLI opens a WebSocket to `/commands` on the agent's port, sends `exec_command`, and streams stdout/stderr back. Ctrl-C on the host propagates as `AbortSignal` to `ctx.signal` inside the container.

#### `ContainerCommandContext` — what you get inside `run`

```ts
type ContainerCommandContext = {
  readonly name: string // plugin name (e.g. 'standup-log'), NOT command name
  readonly version: string | undefined
  readonly agentDir: string // /agent inside the container
  readonly logger: PluginLogger
  readonly permissions: PermissionService
  readonly origin: SessionOrigin // caller's origin — cron job, TUI op, etc.
  readonly signal: AbortSignal // aborts on ws close or host Ctrl-C
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: WritableStream<Uint8Array>
  readonly stderr: WritableStream<Uint8Array>
  readonly prompt: (text: string) => Promise<string> // full LLM session, full toolset, returns last assistant text
  readonly subagent: (name: string, payload?: unknown) => Promise<void>
  readonly exec: (cmd: TemplateStringsArray, ...values: unknown[]) => Promise<CommandExecResult>
}
```

Key facts about each capability:

- **`ctx.prompt(text)`** opens a brand-new `AgentSession` with the full agent toolset (read/bash/edit/write/grep/find/ls + plugin tools), sends `text` as if a user typed it, and returns the last assistant message. The session is created and disposed inside the call. The session uses **slim system prompt mode** (subagent-shaped origin) so you save ~2000 tokens per LLM call versus a normal TUI session.
- **`ctx.subagent(name, payload)`** invokes a registered subagent (yours or another plugin's). Returns when the subagent's `runSession` resolves.
- **`ctx.exec` is a tagged template** — `await ctx.exec\`git log --oneline -10\``runs the command in the agent folder with`ctx.signal` threaded through. Aborts kill the entire process group (SIGTERM → 5s grace → SIGKILL) so daemonized grandchildren don't outlive the abort.
- **`ctx.origin`** carries the caller's `SessionOrigin`. For host-invoked (TUI op) calls it's `{ kind: 'tui', ... }`; for cron-invoked calls it's the cron job's origin including `scheduledByRole`. **No silent role elevation** — a cron job running as `scheduledByRole: 'member'` invokes the command with that same role, and permission checks inside the command resolve accordingly.

#### The cron-exec → LLM bridge (the headline use case)

Cron `kind: 'prompt'` already gives you LLM-driven scheduled work. Cron `kind: 'exec'` gives you shell-only work. **There is no `exec → LLM` cron kind** by design — that would be a third schema field nobody else needs. The supported pattern instead is: write a `surface: 'container'` plugin command whose `run` calls `ctx.prompt(...)`, then point a cron `exec` job at it.

```json
// cron.json
{
  "jobs": [
    {
      "id": "daily-standup",
      "schedule": "30 9 * * 1-5",
      "timezone": "Asia/Seoul",
      "kind": "exec",
      "command": ["typeclaw", "standup-now"]
    }
  ]
}
```

```ts
// packages/standup-log/index.ts
export default definePlugin({
  commands: {
    'standup-now': {
      surface: 'container',
      description: 'Generate today’s standup.',
      async run(ctx) {
        await ctx.prompt(
          `Read sessions/$(date +%F)*.jsonl and append a 3-bullet standup to memory/standups/$(date +%F).md.`,
        )
        return 0
      },
    },
  },
  plugin: async () => ({}),
})
```

Why this beats writing a `kind: 'prompt'` job:

- The command is reusable from the TUI, from another cron job, from a `compose` orchestration, or from a manual `typeclaw standup-now` invocation.
- Args (`--date`, `--dry-run`, etc.) are declared once via `args: z.object({...})` and parsed/validated by the runtime.
- The full `ContainerCommandContext` is available — you can mix LLM calls (`ctx.prompt`) with shell calls (`ctx.exec`) inside one command, which a pure-prompt cron job cannot.
- The cron job stays trivially auditable: `command: ["typeclaw", "standup-now"]` is exact, not a wall of natural-language prose.
- **You can gate `ctx.prompt` behind a cheap `ctx.exec` probe** so a high-frequency poll (every 15 min for new mail, every commit for CI failures) only spends LLM tokens when there's actual work. A pure `kind: 'prompt'` cron job pays for an LLM round-trip on every tick, including the 99% of ticks that turn out to be no-ops. See `typeclaw-cron` "Conditional LLM calls" for the full recipe and a list of cheap probes (mail count, `git log --since`, file mtime, `gh pr list`, HTTP HEAD, stamp files).
- **The schedule colocates with the command in your plugin's own `cronJobs` (§5.3)** — installing the plugin is sufficient, no `cron.json` edit required. The shape is `command: ['typeclaw', '<your-command>', ...]` in a plugin cron `exec` job. Reach for `cron.json` only when the user explicitly owns the cadence (weekends only, custom timezone, etc.). See `typeclaw-cron` for the decision rules.

For the cron-side phrasing of this rule (when to pick `prompt` vs `exec → typeclaw <cmd>`, where to put the schedule, and how to gate the LLM call conditionally) read `typeclaw-cron`.

#### `args` — Zod object schema with primitive leaves

```ts
args: z.object({
  date: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
  dryRun: z.boolean().default(false),
  count: z.number().int().min(1).max(100).default(10),
})
```

- The top level **MUST** be `z.object({...})`. Leaves should be primitives (`string`, `number`, `boolean`, `literal`, `enum`) so `--help` can render `--<name>=<type>`.
- Args are validated locally by the host CLI **before** any WS round-trip, so bad args fail fast with a clean error and exit code 2. The container re-validates as defense-in-depth.
- `.describe(...)` populates `--help` output. Use it.
- Omit `args` entirely if the command takes no flags.

#### `permissions: [...]` on the command

```ts
{
  surface: 'container',
  permissions: ['standup-log.write.standup'],
  async run(ctx, args) {
    ctx.permissions.assert(ctx.origin, 'standup-log.write.standup')
    // ...
  },
}
```

Declared permissions are surfaced in `--help` and (for container commands) checked against the caller's origin. Same `<plugin>.<verb>.<noun>` shape as the rest of the permission system; see `typeclaw-permissions`.

#### `isolated: true` (container surface only)

```ts
{
  surface: 'container',
  isolated: true,  // currently degrades to in-process with a warning on stderr
  async run(ctx, args) { /* ... */ },
}
```

Reserved for a future subprocess sandbox. Today the runtime accepts the flag and emits a warning on the per-command stderr (visible to the invoking CLI) but executes in-process anyway. Set it now if you genuinely want the isolation when it lands; otherwise omit.

#### Discovery and naming

- Command names are **global across all plugins**. Two plugins registering `standup-now` is a discovery error — the second one is dropped and logged on `--help`.
- Command names are NOT auto-prefixed with the plugin name. Pick discriminating names (`standup-now`, not `run`).
- `typeclaw --help` (in any agent folder) lists every discovered plugin command with description, surface, and which plugin owns it.
- `typeclaw <name> --help` renders args, surface, plugin name + version. Free.

#### What's NOT supported

- **No host-stage CLI commands that mutate the live container without going through `restart` / `reload`.** A host command can `Bun.spawn('typeclaw', ['reload'])` if it needs to push a config change, but there's no privileged backdoor.
- **No tool-style `content: ContentPart[]` return.** Commands write to `ctx.stdout` and return an exit code. They are CLI processes, not LLM tool calls.
- **No streaming token output from `ctx.prompt`** yet — the full LLM response arrives as one stdout burst. Chunked streaming is on the roadmap.
- **No nested command dispatch.** A command cannot invoke `typeclaw <other-cmd>` and expect to share state; spawn a subprocess or share a subagent instead.

---

## 6. PluginContext

```ts
type PluginContext<TConfig = never> = {
  readonly name: string // derived
  readonly version: string | undefined // package.json (npm only)
  readonly agentDir: string // absolute, agent folder root
  readonly config: TConfig // inferred from configSchema
  readonly logger: PluginLogger // prefixed: [plugin:<name>]
  spawnSubagent: (name: string, payload?: unknown) => Promise<void>
}
```

### `spawnSubagent` boot gate

`spawnSubagent` is **gated until boot completes**. Calling it from inside the `plugin` factory throws:

```
plugin <name>: spawnSubagent("<x>") called before boot completed; subagent registry is not yet wired
```

Safe call sites: event handlers, tool `execute`, subagent handlers (subagents can spawn other subagents).

### What's NOT on `ctx`

No `ctx.stream`, no `ctx.server`, no `ctx.reloadRegistry`, no `ctx.registerX(...)`. **Everything contributed is in the returned object. Everything read is on `ctx`.** That's the entire surface.

---

## 7. Failure Modes (verbatim error messages)

When something goes wrong, you'll see one of these. Memorize the patterns.

| Trigger                                      | Error                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Local path escapes agentDir                  | `plugin path escapes agent directory: <entry> (resolved to <abs>)`                                     |
| Local path doesn't exist                     | `plugin path does not exist: <entry> (resolved to <abs>)`                                              |
| Two plugins resolve to same name             | `plugin name conflict: <name> (entry <entry>) already loaded`                                          |
| Config doesn't match schema                  | `plugin <name>: config invalid: <zod issues>`                                                          |
| Config block exists but plugin has no schema | `plugin <name>: config block "<name>" present in typeclaw.json but plugin declares no configSchema`    |
| Factory threw                                | `plugin <name>: factory threw: <error message>`                                                        |
| Tool name collision                          | `plugin <name>: tool "<tool>" already registered by plugin <other>`                                    |
| Subagent name collision                      | `plugin <name>: subagent "<sub>" already registered by plugin <other>`                                 |
| Skill name collision                         | `plugin <name>: skill "<skill>" already registered by plugin <other>`                                  |
| Cron id collision                            | `plugin <name>: cron job "<id>" globalId "<global>" conflicts with plugin <other>`                     |
| Empty identifier                             | `plugin <name>: empty <kind>` (kind: tool name / subagent name / cron job id / skill name)             |
| Skill name dup after sanitization            | `plugin <name>: duplicate skill name after sanitization: <localName>`                                  |
| `spawnSubagent` called too early             | `plugin <name>: spawnSubagent("<x>") called before boot completed; subagent registry is not yet wired` |

**Atomic rollback**: on any of these (during load), every contribution from the offending plugin — tools, subagents, cron jobs, skills, skillsDirs, **and hooks** — is discarded before the error bubbles up. There is no partial state.

---

## 8. Common Pitfalls

### ❌ Importing the engine

```ts
// WRONG — boundary violation
import { something } from '@mariozechner/pi-coding-agent'
```

**Plugins use `typeclaw/plugin` only.** The runtime translates to engine types behind the scenes.

### ❌ Calling `spawnSubagent` from the factory

```ts
// WRONG — throws "called before boot completed"
plugin: async (ctx) => {
  await ctx.spawnSubagent('worker', {}) // TOO EARLY
  return {
    /* ... */
  }
}
```

```ts
// CORRECT — call it from a hook or tool
plugin: async (ctx) => ({
  hooks: {
    'session.idle': async () => {
      await ctx.spawnSubagent('worker', {
        /* ... */
      }) // OK after boot
    },
  },
})
```

### ❌ Prepending in `session.prompt`

```ts
// WRONG — invalidates provider prompt cache on every call
'session.prompt': (event) => {
  event.prompt = `[CONTEXT]\n${dynamicData}\n${event.prompt}`
}
```

```ts
// CORRECT — append (cache-safe)
'session.prompt': (event) => {
  event.prompt += `\n\n[CONTEXT]\n${dynamicData}`
}
```

### ❌ Assuming `tool.before/after` only cover plugin tools

`tool.before` / `tool.after` also intercept TypeClaw-exposed system tools, including `read`, `bash`, `edit`, `write`, etc. when plugins are wired into the session. Scope your hook by `event.tool` before mutating args or blocking.

### ❌ Forgetting plugin name derivation

```json
// WRONG — config block uses package name verbatim
{
  "plugins": ["typeclaw-plugin-standup-log"],
  "typeclaw-plugin-standup-log": { ... }   // ignored! plugin sees empty config
}
```

```json
// CORRECT — config block uses DERIVED name
{
  "plugins": ["typeclaw-plugin-standup-log"],
  "standup-log": { ... }
}
```

### ❌ Editing `plugins[]` and expecting `reload` to apply it

`plugins` is `restart-required`. Run `typeclaw restart` after changing the array. The reload diff will tell you, but watch for it.

### ❌ Two plugins declaring the same global tool/subagent/skill name

Boot fails. Pick discriminating names. The runtime does NOT auto-prefix tool/subagent/skill names with the plugin name (only cron ids are prefixed with `__plugin_<name>_`).

### ❌ Calling built-in tools from inside a plugin tool's `execute`

Plugin `ToolContext` is `{ signal, sessionId, agentDir, logger }`. There is no `ctx.read()`, no `ctx.bash()`. Plugin tools are leaf operations. If your tool needs to chain built-ins, declare a subagent with `tools: [readTool, ...]` and let the LLM orchestrate.

---

## 9. Operational Reference

### Where things live

- **Plugin module source**: `src/plugin/` (types, define, loader, manager, registry, hooks, skills, context)
- **Engine bridge**: `src/agent/plugin-tools.ts` (the ONLY file that imports both plugin and engine types)
- **Plugin wiring at boot**: `src/run/index.ts` (`startAgent` calls `loadPlugins`, merges into registries)
- **Hook fire sites**:
  - `session.prompt`: `src/agent/index.ts` `createResourceLoader` (after default prompt assembly)
  - `session.idle`: `src/server/index.ts` `drain()` — fires immediately after every `session.prompt()` resolves (success or error)
  - `session.start`/`session.end`: `src/server/index.ts` ws open/close
  - `tool.before`/`tool.after`: `src/agent/plugin-tools.ts` `wrapPluginTool`, `wrapSystemTool`, and `wrapSystemAgentTool`
- **Schema additions**: `src/config/config.ts` (`plugins` array, `.catchall(z.unknown())` for per-plugin blocks, `extractPluginConfigs`)

### Audit log on boot

After successful load, the runtime emits to stdout:

```
[plugin] loaded N plugin(s): standup-log v0.1.0, foo (local)
```

Local plugins have no version. Use this to confirm what's actually loaded.

### Debugging a missing config

If `ctx.config.foo` is unexpectedly missing or default:

1. Verify the **derived plugin name** matches the top-level config block key in `typeclaw.json`.
2. Verify `configSchema` is on `definePlugin({ ... })`, not on the inner `plugin` function.
3. Check audit log for `plugin <name>: config invalid: ...` — defaults don't apply if the block fails validation.

### Debugging a not-firing hook

1. `session.start` / `session.end` are tied to **websocket** open/close. They don't fire during cron-only invocations.
2. `tool.before` / `tool.after` fire for plugin-defined and TypeClaw-exposed system tools only when plugins are wired into the session. Confirm the session loaded your plugin and check `event.tool` matches the expected tool name.
3. Hooks that throw are logged (`reportHookError`) and do NOT abort the loop. Check the plugin logger output.

### Restart vs reload

| Change                             | Effect                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| Edit a hook handler body           | Container restart (new code)                              |
| Edit a tool's `execute` body       | Container restart                                         |
| Add/remove an entry in `plugins[]` | Container restart (`restart-required`)                    |
| Change a per-plugin config value   | Container restart (factory only runs at boot)             |
| Edit `cron.json` (non-plugin)      | Reload picks it up (existing `cron.json` reload pipeline) |

When in doubt: `typeclaw restart`.

---

## 10. Anti-Goals (intentionally NOT supported)

If you find yourself wanting any of these, the design has gone wrong somewhere — file an issue rather than working around it:

- **Plugin sandboxing**. Plugins run with full Bun privileges. The container is the sandbox.
- **Hot plugin reload**. `typeclaw restart` to pick up plugin code or config changes.
- **Stream subscriptions**. Plugins observe through the typed `hooks` surface; they cannot subscribe to the in-process pub/sub directly.
- **Server-side TUI push notifications** from plugin code. Tool calls reach the TUI via existing `tool_start`/`tool_end` events.
- **Dockerfile fragments** contributed by plugins. The Dockerfile is core-managed.
- **New cron job kinds** beyond `prompt` and `exec`. (Subagent invocation is a `prompt` variant, not a separate kind. For `exec → LLM`, write a container plugin command and call it from cron `exec` — see §5.7.)
- **Reload-registry scopes** for plugin-owned state.
- **`extendConfig`** for arbitrary top-level fields outside the plugin's own config block.
- **Per-LLM-call hooks** (`llm.params` / `llm.headers`). Wait until a real plugin needs them.

---

## 11. Quick Reference Card

```ts
import { z } from 'zod'
import {
  definePlugin, // wrap module
  defineTool, // (optional, identity helper for type inference)
  defineSubagent, // (optional, identity helper)
  // built-in tool refs:
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  findTool,
  lsTool,
  // types:
  type PluginContext,
  type PluginExports,
  type Tool,
  type Subagent,
  type ToolContext,
  type ToolResult,
  type ContentPart,
  type Hooks,
  type SessionPromptEvent,
  type ToolBeforeEvent,
} from 'typeclaw/plugin'
```

**Plugin shape**:

```ts
export default definePlugin({
  configSchema: z.object({
    /* ... */
  }), // optional
  commands: {
    /* name: { surface, run, args?, ... } */
  }, // optional, declared BY-VALUE (not inside factory)
  permissions: ['my-plugin.write.x'], // optional
  plugin: async (ctx) => ({
    // required
    tools,
    subagents,
    cronJobs,
    skills,
    skillsDirs,
    hooks,
    doctorChecks, // all optional
  }),
})
```

**Cron global id**: `__plugin_<plugin-name>_<key>`

**Plugin name = derived**: scope-stripped, `typeclaw-plugin-` prefix stripped (npm), or basename minus extension (local).

**Command name = global**: NOT prefixed with plugin name. Two plugins registering the same command name is a discovery error (second is dropped, logged on `--help`).

**`exec → LLM` from cron**: write `surface: 'container'` command calling `ctx.prompt(...)`, point cron `exec` job at `["typeclaw", "<command-name>"]`. There is no native `exec → LLM` cron kind by design.

**Boundary**: `src/plugin/**` MUST NOT import `@mariozechner/*`.
