# typeclaw-plugin-bun-hygiene

The bundled bun-hygiene plugin. Registers a `tool.before` hook that blocks two classes of `bash` command:

1. **Global package installs** — `npm install -g`, `pnpm add -g`, `yarn global add`, `bun add -g`, and their `--global` / bundled-flag variants.
2. **Non-bun package managers** — any `npm`, `npx`, `pnpm`, `pnpx`, or `yarn` invocation.

This plugin is **auto-loaded** by every TypeClaw agent. There is no `plugins[]` entry to add. Both guards carry an `acknowledgeGuards` escape hatch (below) for the cases where the agent genuinely needs the blocked command.

## Why it exists

**Global installs don't persist.** The agent folder is bind-mounted at `/agent`; everything else in the container — including `~/.bun`, `~/.npm`, and the global `node_modules` a global install writes to — is ephemeral and wiped on every `typeclaw restart`. An agent that runs `npm install -g some-cli` gets a tool that works for the rest of the session and silently vanishes on the next boot, leading to confusing "command not found" failures that look like regressions. The fix is to either add the dependency to `package.json` (`bun add <pkg>`, which lives in the bind-mounted folder and survives) or run it once without installing (`bunx <pkg>`).

**The container standardizes on bun.** TypeClaw is Bun-native end to end (see the root README). Mixing in `npm`/`pnpm`/`yarn` produces competing lockfiles and install trees, and `npx` pulls a second package-execution path when `bunx` already covers it. Steering every package-manager call to bun keeps the dependency state coherent.

Both guards **block with guidance** rather than silently rewriting the command — the agent sees exactly why the command was rejected and what to run instead, the same UX as the bundled `security` and `guard` policies.

## Guards

| Guard                  | Triggers on                                                                                       | Guidance in the block reason                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `globalInstall`        | `npm`/`pnpm` install/add with `-g`/`--global`, `yarn global add`, `bun add -g` / `bun install -g` | Use `bun add <pkg>` (persists) or `bunx <pkg>` (ephemeral run).            |
| `nonBunPackageManager` | `npm`, `npx`, `pnpm`, `pnpx`, `yarn` at a command boundary                                        | Use `bun install` / `bun add <pkg>`, and `bunx <pkg>` instead of npx/pnpx. |

A global install (e.g. `npm install -g x`) trips **only** `globalInstall`, not both — the global install is the more specific violation, so acknowledging `globalInstall` lets the command through without a second acknowledgement for `nonBunPackageManager`.

## Bypass

Both guards follow the repo-wide `acknowledgeGuards` convention (shared with the `security` and `guard` plugins). To run a blocked command intentionally, pass the matching flag in the `bash` tool arguments:

```jsonc
// bash tool args
{ "command": "npm install", "acknowledgeGuards": { "nonBunPackageManager": true } }
{ "command": "npm install -g some-cli", "acknowledgeGuards": { "globalInstall": true } }
```

## What is NOT blocked

- `bun`, `bunx`, `bun run`, `bun add`, `bun install` (local) — the intended package commands.
- A non-bun manager name appearing as a substring or argument: `my-npm-wrapper`, `./npm`, `cat npm-debug.log`, `git commit -m "drop npm"`, `grep -rn npx src/`. Matching is anchored to a command boundary (start of line or after `;`, `&&`, `||`, `|`, `&`, newline, or a subshell/substitution opener), with an optional `sudo` / `env VAR=...` preamble, so package-manager names inside quotes, paths, or longer tokens do not trip the guard.

## How it works

The plugin registers a single `tool.before` hook delegating to `checkBunHygieneGuard` in `policy.ts`. The hook returns `{ block: true, reason }` (rejecting the tool call) or `undefined` (passing it through). Detection is regex-on-raw-string, deliberately matching the sibling `security/policies/secret-exfil-bash.ts` guard rather than introducing a shell parser — the command-boundary anchoring is what keeps the false-positive surface small.

## Ordering against other bundled plugins

Registered after `guard` in `src/run/bundled-plugins.ts`. It guards a disjoint surface (package-manager bash commands), so its position only matters for precedence: keeping it after `security` and `guard` means any of their blocks wins first.

## Tests

- `policy.test.ts` — pure-function unit tests for the detection logic: every global-install form, every non-bun manager, the allowed-command set (bun/bunx, substrings, paths, quoted text), both bypasses, and the global-install-takes-precedence rule.
- `index.test.ts` — composition tests: the plugin registers the `tool.before` hook and wires it to the policy (block on global install, block on npx, allow bunx, honor the bypass).
