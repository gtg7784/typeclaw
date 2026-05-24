# Auth flow — interactive (Codex CLI)

Deep dive for the auth paths. Read it when `SKILL.md`'s "First-time auth (interactive)" section sends you here, or when an auth attempt fails and you need to understand what went wrong.

The two paths are intentionally symmetric: in both, the user produces one artifact on their side, pastes it to you, you validate it, you do read-modify-write on `.env` (or write `~/.codex/auth.json`), you offer a restart. Only the credential medium differs.

## Path A — API key (`OPENAI_API_KEY`)

The API key path is direct. Summary:

1. Prompt user for `sk-…`.
2. Validate `/^sk-[A-Za-z0-9_-]{20,}$/`.
3. Read `.env`, merge `OPENAI_API_KEY=<value>` into the parsed map, reconstruct full content, write with `acknowledgeGuards: { nonWorkspaceWrite: true }`.
4. Verify.
5. Ask before restart.

When to recommend it: the user has an **OpenAI API account** (api.openai.com billing, no ChatGPT subscription) or specifically wants per-token billing. They get their key from `platform.openai.com/api-keys`. Cost is metered per-token against the API workspace.

### `OPENAI_API_KEY` vs `CODEX_API_KEY`

Both env vars are recognized by the CLI, but they behave differently:

- `OPENAI_API_KEY` — Used by both the interactive TUI and `codex exec`. This is the right variable for our flow (we drive the TUI).
- `CODEX_API_KEY` — **Only honored by `codex exec`**. Setting it for the TUI silently does nothing; the TUI will still fire the Auth picker. Empirically confirmed in upstream docs. Use `OPENAI_API_KEY`.

### Auth precedence on the Codex side

When multiple credentials coexist, Codex CLI resolves in this order (highest first):

1. `~/.codex/auth.json` if present — this OVERRIDES env vars for the interactive TUI.
2. `OPENAI_API_KEY` from env.
3. (Picker fires.)

The first-match-wins rule is the OPPOSITE of how some Anthropic flows resolve (where env wins over file). If the user previously logged in with `codex login` and the `auth.json` still exists, setting `OPENAI_API_KEY` in `.env` will appear to do nothing because Codex preferentially loads `auth.json`. Mitigation: ask the user to remove `~/.codex/auth.json` if they want the env path to take effect.

## Path B — OAuth (`codex login` → `~/.codex/auth.json` file copy)

This is the path for users with a ChatGPT **Plus / Pro / Team / Enterprise** subscription. Inference cost draws against the subscription's monthly Codex credit pool, not per-token billing.

Unlike Anthropic's `claude setup-token` (which prints a long-lived token to stdout), Codex's `codex login` writes a credential **file** at `~/.codex/auth.json` on the user's machine. The user copies that file's contents back to you, and you write it to `~/.codex/auth.json` inside the container.

### Why on the user's machine, not in the container

The OAuth flow uses a `localhost:1455` callback server, which means the browser and the local CLI process need to be on the same machine. A typeclaw container has no browser, no display, and (for remote-host deployments) is on a different machine from the user's browser anyway. The user's local machine already has `codex` installed for them to be a subscriber in the first place — they're the right place to run the one-off `codex login` command.

There's also a `codex login --device-auth` flag for headless / cross-machine cases, but the resulting credential still lands at `~/.codex/auth.json` on the machine that ran the command, so the user-to-container copy step is the same either way.

### Step-by-step

1. **Confirm prerequisites with the user, in one message:**

   > To set up OAuth auth, you'll generate a credential file on your own machine. Two prerequisites:
   >
   > 1. Do you have the `codex` CLI installed locally? If not: `npm install -g @openai/codex`.
   > 2. Do you have a paid ChatGPT subscription? (Codex via OAuth requires Plus, Pro, Team, or Enterprise.)
   >
   > Once both are true, reply "ready" and I'll send the next step.

   This single confirmation up-front is the difference between a one-paste flow and a multi-turn debugging session when the user discovers mid-flow that their CLI isn't installed.

2. **When the user confirms, send the generation instructions:**

   > Great. On your machine, run:
   >
   > ```sh
   > codex login
   > ```
   >
   > It opens a browser, you authorize with your ChatGPT account, and the terminal confirms "Signed in." Now run:
   >
   > ```sh
   > cat ~/.codex/auth.json
   > ```
   >
   > Copy the entire JSON output — it's a small object with either an `OPENAI_API_KEY` field, OR a `tokens` object containing `access_token` / `refresh_token` / `id_token`, OR both. Paste it back to me. Treat it like a password — the `refresh_token` if present is long-lived.

3. **Wait for the user's reply.** Expected shapes:
   - **A JSON object string** starting with `{`. The expected shape.
   - **An error message** if `codex login` failed on their side. See the failure-mode list below.
   - **"cancel"** or equivalent. Drop the flow cleanly.

4. **Parse and validate**, in order:
   1. Trim leading/trailing whitespace.
   2. `JSON.parse(value)` — if it throws, refuse: "That doesn't look like valid JSON. Make sure you pasted the entire `cat` output including the surrounding `{` and `}`."
   3. The parsed object must be a non-null plain object with at least one of: an `OPENAI_API_KEY` string field, OR a `tokens` object with at least one of `access_token`/`refresh_token`. If neither path is present, refuse and ask again.
   4. If validation fails twice, drop OAuth and recommend the API-key path.

5. **Confirm receipt without echoing the credential.** Reply something like "Got it, validating and writing to `~/.codex/auth.json`." Never include any token field in your reply, in a log line, in a sentinel, in a commit message, or anywhere else.

6. **Ensure the directory exists.** Create `~/.codex/` if missing (`mkdir -p ~/.codex`). The Dockerfile layer creates it for the hooks config but won't fail if it already exists.

7. **Write `~/.codex/auth.json`** with the JSON-stringified canonical form (re-emit via `JSON.stringify(parsed, null, 2)` so you don't preserve weird whitespace from the paste). Use `acknowledgeGuards: { nonWorkspaceWrite: true }`.

8. **Verify** by re-reading the file and re-parsing.

9. **Ask before restart**, same prompt as the API-key path.

10. On yes → call the `restart` tool. On no → `typeclaw restart` themselves when ready.

11. **Done.** There is no auth scratch directory, no tmux session to tear down, no worktree. The OAuth path has the same on-disk footprint as the API-key path: one credential file under `$HOME`.

## Failure modes on the user's side

These all surface as the user's reply being an error message instead of a JSON object. Recognize them, do not validate them as credentials, and respond with the matching guidance.

- **"command not found: codex"** — they don't have the CLI installed locally. Point them at `npm install -g @openai/codex`.
- **"You don't have access to a paid ChatGPT plan"** — they're on a free account. `codex login` (via ChatGPT OAuth) requires Plus / Pro / Team / Enterprise. They either upgrade or use the API-key path.
- **"Browser didn't open"** — they're on a headless local environment. Recommend `codex login --device-auth` for the device-code flow, which prints a URL+code they can complete on any device.
- **`~/.codex/auth.json` doesn't exist after login** — login failed silently. Have them re-run `codex login` and watch for error output.
- **They report success but pasted a string that fails JSON.parse** — most likely they pasted just one field or shell prompt cruft. Re-ask: "Paste the full contents of `~/.codex/auth.json` starting with `{` and ending with `}`."

## Failure modes after you've written the credential

- **`typeclaw restart` fails or the container won't come up** — the credential is on disk, the restart is the problem. Don't re-prompt for auth; surface the restart failure and tell the user to run `typeclaw restart` from their host shell to see the underlying error.
- **`codex` invocations after restart still hit the Auth picker** — the credential file is being rejected. Three likely causes:
  1. **JSON parse error inside Codex.** The file is on disk but malformed in a way `JSON.parse` accepted but Codex's schema validator rejects. `cat ~/.codex/auth.json | jq .` to inspect; surface to the user.
  2. **`OPENAI_API_KEY` env var conflict.** Per the precedence rules above, `auth.json` overrides `OPENAI_API_KEY` — but if both are present and `auth.json` is malformed, Codex MAY fall back to the env var, which could be wrong/stale. Check `.env` for a stale `OPENAI_API_KEY` line and remove if the user is committing to OAuth.
  3. **Token expired or revoked.** Tokens have a finite lifetime; revocation happens if the user signed out from `chatgpt.com` or revoked the Codex CLI integration. Have them re-run `codex login` and re-paste.

## Things you must not do during auth

- **Do not run `codex login` inside the container.** Use the user-machine flow above. The in-container OAuth dance doesn't work — the container has no browser, and even with `--device-auth` the resulting credential file would land inside the container's `$HOME`, defeating the user-paste pattern that lets the typeclaw operator broker the credential without seeing it.
- **Do not log, echo, paste-back, or otherwise transcribe the user's credential.** Not in a confirmation message, not in a sentinel, not in a commit. The `refresh_token` is long-lived; a leak is significantly worse than a momentary "did you mean this?" reflection.
- **Do not write the credential to `~/.codex/auth.json` until you've validated its format.** A malformed credential quietly turns into a broken auth that surfaces only on the next codex invocation, long after the user has moved on.
- **Do not retry validation more than once.** If the first paste fails JSON.parse, ask once with clearer guidance ("paste the full output of `cat ~/.codex/auth.json` starting with `{`"). If the second also fails, drop the OAuth path and recommend API-key auth.
- **Do not advise the user to `typeclaw shell` and run `codex login` inside the container as a "fallback".** It does not work — the container has no browser. Use the user-machine flow.
- **Do not assume the `auth.json` schema.** OpenAI may change the shape — today's keys are `OPENAI_API_KEY` and `tokens.{access_token, refresh_token, id_token}`, but future versions may add or rename fields. Validate by presence of at least ONE known key, not by exhaustive shape match.
- **Do not write to `~/.codex/auth.json` without `acknowledgeGuards: { nonWorkspaceWrite: true }`.** Same guard contract as `.env` writes.
- **Do not patch-edit `~/.codex/auth.json`.** Read-modify-write the whole file (or just write the new contents wholesale — there's nothing to preserve from a stale `auth.json` on a fresh delegation).
- **Do not store `OPENAI_API_KEY` in `~/.codex/auth.json`'s `OPENAI_API_KEY` field as a workaround for env-var precedence.** If the user wants the API-key path, the canonical location is `.env`. Mixing the two creates ambiguity for the next person debugging an auth failure.
- **Do not branch on local-vs-remote container topology.** The user-machine flow is the same whether the container is on the user's laptop or on a remote host — the user runs `codex login` on whatever local machine they're at, the credential works in either container.
