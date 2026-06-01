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

## How it works

`checkBunHygieneGuard` in `policy.ts` does not regex the raw command. It runs a small single-pass tokenizer (`splitSegments`) that turns the command into a list of **segments**, each a list of **words**:

- Segments break on real command separators — `;`, `&&`, `||`, `|`, `&`, newline, `\r` — and on subshell / command-substitution openers (`(`, `$(`, backtick).
- The tokenizer is quote-aware (a separator inside `"..."`/`'...'` is literal) and escape-aware (`\x` is a literal `x`, so `\npm` resolves to `npm` and `\;` is not a separator).

For each segment, the guard strips leading **preamble words** (`sudo`, `env`, `command`, `exec`, `nice`, and any `VAR=val` assignment) to find the real command word, then classifies:

1. command word is `npm`/`npx`/`pnpm`/`pnpx`/`yarn` (or `bun`) **and** the segment has an install subcommand **and** a global flag → `globalInstall`;
2. command word is a non-bun manager (not via global) → `nonBunPackageManager`;
3. otherwise → allowed.

A `globalInstall` verdict on any segment wins over a plain non-bun verdict. This is a command-position detector, not a full shell parser — it doesn't interpret redirections or expansions beyond boundary marking — but it is linear-time and closes the structural gaps a single regex left open.

## Why a tokenizer, not a regex

The earlier implementation matched boundary-anchored regexes against an escape/quote-normalized copy of the command. Review surfaced three structural gaps that are awkward to close with one regex but fall out naturally from the segment model:

- **Escaped / quoted command words.** `\npm install`, `"npm" install`, `'npm' install`, `n\px …` all run the real binary; the tokenizer collapses escapes and quotes at the word level, so each resolves to its bare command word.
- **Leading assignments.** `FOO=bar npm install` runs npm with `FOO` set. Stripping `VAR=val` (and `sudo`/`env`/`command`/`exec`/`nice`) preamble words finds the manager behind them.
- **Newline = separate command.** `npm install\n-g typescript` is two commands; the `-g` does not make the install global. Per-segment scoping means a flag in one segment never combines with an install in another, so this classifies as `nonBunPackageManager` (the `npm install` line), not `globalInstall`.

It also recognizes an explicit falsy global flag (`--global=false|0|no|off`) as **not** a global install, and detects managers inside subshells / command substitutions.

## Option placement in global installs

Because classification scans a segment's words as a set (after preamble stripping), options may sit anywhere relative to the subcommand and the global flag, in either order: `npm --prefix /tmp install -g x`, `npm install --foo bar -g x`, `npm -g install x`, `pnpm add --reporter silent -g foo`, and `bun --cwd /x add -g foo` all attribute to `globalInstall`.

## What is NOT blocked

- `bun`, `bunx`, `bun run`, `bun add`, `bun install` (local) — the intended package commands. (`bun add -g` / `bun install -g` are still blocked as global installs: bun globals live in `~/.bun`, outside `/agent`, and are wiped on restart.)
- A non-bun manager name appearing as a substring or argument: `my-npm-wrapper`, `./npm`, `cat npm-debug.log`, `git commit -m "drop npm"`, `grep -rn npx src/`, `echo "npm install -g foo"`. Only the **command word** of a segment is classified, so a manager name inside an argument, path, quoted string, or longer token never trips the guard.

## Ordering against other bundled plugins

Registered after `guard` in `src/run/bundled-plugins.ts`. It guards a disjoint surface (package-manager bash commands), so its position only matters for precedence: keeping it after `security` and `guard` means any of their blocks wins first.

## Tests

- `policy.test.ts` — pure-function unit tests for the detection logic: every global-install form, every non-bun manager, the allowed-command set (bun/bunx, substrings, paths, quoted text), both bypasses, the global-install-takes-precedence rule, escaped/quoted evasions, leading-assignment preambles, newline-as-separator scoping, falsy `--global=`, option placement, and subshell/substitution detection.
- `index.test.ts` — composition tests: the plugin registers the `tool.before` hook and wires it to the policy (block on global install, block on npx, allow bunx, honor the bypass).
