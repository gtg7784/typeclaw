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

## Escaped / quoted evasion

The shell strips quotes and backslash escapes before deciding which binary to run, so `\npm install`, `"npm" install`, `'npm' install`, and `n\px create-next-app` all execute the real npm/npx. Matching the raw command string misses every one of those.

Before matching, the guard normalizes the command **for detection only** (the original command is never executed from the normalized form): each `\x` escape collapses to `x` (and `\<space>` to a space), and quote characters are dropped. Crucially, all whitespace is preserved, so the command-boundary anchoring still distinguishes a manager at command position (`"npm" install` → blocked) from one inside an argument (`echo "npm install"` → allowed). The normalized form is only used to test the manager regexes — it never replaces the command that runs.

## Option placement in global installs

A global install is recognized regardless of where options sit within the same simple command, in either order: `npm --prefix /tmp install -g x`, `npm install --foo bar -g x`, and `npm -g install x` all attribute to `globalInstall` (the specific guard) rather than falling through to the generic `nonBunPackageManager` guard. Tokens may appear before, between, and after the subcommand and the global flag, as long as no segment separator (`;`, `&&`, `||`, `|`, `&`, newline) intervenes.

## What is NOT blocked

- `bun`, `bunx`, `bun run`, `bun add`, `bun install` (local) — the intended package commands.
- A non-bun manager name appearing as a substring or argument: `my-npm-wrapper`, `./npm`, `cat npm-debug.log`, `git commit -m "drop npm"`, `grep -rn npx src/`, `echo "npm install -g foo"`. Matching is anchored to a command boundary (start of line or after `;`, `&&`, `||`, `|`, `&`, newline, or a subshell/substitution opener), with an optional `sudo` / `env VAR=...` preamble, so package-manager names inside quotes, paths, or longer tokens do not trip the guard — even after escape/quote normalization, because normalization preserves whitespace and the boundary still requires command position.

## How it works

The plugin registers a single `tool.before` hook delegating to `checkBunHygieneGuard` in `policy.ts`. The hook returns `{ block: true, reason }` (rejecting the tool call) or `undefined` (passing it through). Detection runs command-boundary-anchored regexes against an escape/quote-normalized copy of the command. The repo has no shell-parsing dependency and the sibling security guards (`secret-exfil-bash.ts`, `git-exfil.ts`) match raw strings; this guard adds a minimal, whitespace-preserving normalization pass rather than a full shell parser, keeping the false-positive surface small while closing the obfuscation hole.

## Ordering against other bundled plugins

Registered after `guard` in `src/run/bundled-plugins.ts`. It guards a disjoint surface (package-manager bash commands), so its position only matters for precedence: keeping it after `security` and `guard` means any of their blocks wins first.

## Tests

- `policy.test.ts` — pure-function unit tests for the detection logic: every global-install form, every non-bun manager, the allowed-command set (bun/bunx, substrings, paths, quoted text), both bypasses, and the global-install-takes-precedence rule.
- `index.test.ts` — composition tests: the plugin registers the `tool.before` hook and wires it to the policy (block on global install, block on npx, allow bunx, honor the bypass).
