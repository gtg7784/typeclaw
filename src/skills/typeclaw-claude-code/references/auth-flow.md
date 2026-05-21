# Auth flow — interactive

Deep dive for the OAuth path. Read it when `SKILL.md`'s "First-time auth (interactive)" section sends you here, or when an auth attempt fails and you need to understand what went wrong.

## Path A — API key (recap)

The API key path is straightforward and lives entirely in `SKILL.md`. Summary:

1. Prompt user for `sk-ant-…`.
2. Validate `/^sk-ant-[A-Za-z0-9_-]{20,}$/`.
3. Read `.env`, merge `ANTHROPIC_API_KEY=<value>` into the parsed map, reconstruct full content, write with `acknowledgeGuards: { nonWorkspaceWrite: true }`.
4. Verify.
5. Ask before restart.

No deep mechanics needed — there is no browser dance.

## Path B — OAuth (full)

OAuth is a three-party dance: you (agent), the user (with a browser), and `claude setup-token` running inside a tmux pane. None of the parties can talk to each other directly; you broker the URL one way and the code the other way.

Auth scratch lives at `/tmp/cc-auth/` (not a git worktree — auth doesn't need git semantics, just a tmux pane and a working directory).

### Why this works on remote-host typeclaw deployments

The typeclaw agent runs inside a Docker container, and the container may be on a host that is not the user's local machine — a remote dev box over SSH, a cloud VM, a shared workstation. The user's browser, by definition, lives on whichever machine they're physically at. This is the same shape that breaks naive OAuth flows: the browser ends up on a different machine than the CLI, so the OAuth redirect (which tries to call back to `http://localhost:<port>/callback` on the user's machine) hits nothing — the CLI is listening on `localhost` inside the container, which the user's browser can't reach.

`claude setup-token` was designed for exactly this case. From the Anthropic docs: _"If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal at the `Paste code here if prompted` prompt. This happens when the browser can't reach Claude Code's local callback server, which is common in WSL2, SSH sessions, and containers."_ The CLI degrades gracefully: when the localhost callback can't fire, the post-authorize page in the browser displays the auth code directly, and the CLI waits at a `Paste code here:` prompt. **There is no local-vs-remote branch in your code path** — the flow below works identically whether the user is on the same machine as the container or on the other side of the planet. Don't add SSH-port-forwarding instructions, don't try to launch a browser from inside the container (`xdg-open` won't work — there is no display), don't suggest the user `typeclaw shell` and run `claude setup-token` by hand. The flow below is the universal path.

The one case that does NOT work this way is **a container with no egress to `claude.ai`** (network sandbox blocking outbound HTTPS to anthropic.com). The `setup-token` process itself needs to reach the OAuth endpoints to fetch the URL and later to exchange the code for a token. If that's blocked, you'll see `setup-token` hang or exit with a DNS / TLS error before the URL even appears in the pane. There is no workaround other than allow-listing `claude.ai`, `console.anthropic.com`, and `api.anthropic.com` — surface this to the user and stop.

### Step-by-step

1. **Spawn the tmux session for auth (not for delegation).** Use a separate session name so it can't be confused with a delegation:

   ```sh
   mkdir -p /tmp/cc-auth && cd /tmp/cc-auth
   tmux new-session -d -s cc-auth-setup -c /tmp/cc-auth claude setup-token
   ```

2. **Wait for the auth URL to appear.** `claude setup-token` prints something like:

   ```
   Open this URL in your browser to authorize Claude Code:
   https://claude.ai/oauth/authorize?…
   Paste the resulting code here:
   ```

   Poll `tmux capture-pane -t cc-auth-setup -p` every 500ms with a 30-second budget. Match the URL with a permissive regex: `https://claude\.ai/oauth/authorize\?[^\s]+`. The exact prompt wording can change between Claude Code versions; the URL pattern is stable.

3. **Surface the URL to the user.** Send through the TUI / channel. Mention BOTH possible browser outcomes so the user knows what to send back:

   > Open this URL in your browser to sign in to Claude Code:
   >
   > `<URL>`
   >
   > After you authorize, your browser will either:
   > (a) show a login code on the page — paste that code back to me, or
   > (b) show a "this site can't be reached" / connection-refused error after redirecting — that's expected when my container can't be reached from your browser. Copy the full address from the top of the browser (it starts with `http://localhost:...` and contains `code=...&state=...`) and paste it back to me.
   >
   > Either is fine — I'll handle both.

4. **Wait for the user's reply.** Their next inbound message is one of: a bare auth code, a full callback URL, or "cancel" / something else. Be ready for all three.

5. **Parse and validate the user's reply.** Three accepted shapes:
   - **Bare code**: `/^[A-Za-z0-9_-]{20,}$/`. Use as-is.
   - **`code=…&state=…` query string** (no scheme/host): extract the `code` parameter, validate with the bare-code pattern.
   - **Full URL**: parse with `new URL(input)`, read `searchParams.get('code')`, validate with the bare-code pattern. The host can be anything (`localhost:1455`, `127.0.0.1:1455`, etc.) — don't be strict on the host; only the `code` parameter matters.

   If none of the three shapes match, ask once more: "That doesn't look like a code or callback URL — paste either the code from the browser page or the full URL from the address bar. Or say 'cancel' to switch to API-key auth." If the second attempt also fails, kill the tmux session, clean up `/tmp/cc-auth`, and recommend the API-key path.

6. **Feed the extracted code to the tmux pane** (NOT the full URL — `setup-token` expects just the code at its `Paste code here:` prompt):

   ```sh
   tmux send-keys -t cc-auth-setup "<code>" Enter
   ```

7. **Wait for `setup-token` to print the resulting token.** Poll `capture-pane` again, this time matching for `CLAUDE_CODE_OAUTH_TOKEN=` literally — the CLI prints the line ready to copy into `.env`. The pattern: `CLAUDE_CODE_OAUTH_TOKEN=([A-Za-z0-9_-]+)`.

   Budget: 30s. If the timeout hits, capture the pane and surface — the user authorized but the CLI didn't print the token (network issue, server-side error).

8. **Extract the token.** Strip ANSI escapes from the captured pane content, then run the regex. Take the first capture group.

9. **Validate the token format.** `/^[A-Za-z0-9_-]{30,}$/`. The captured pane could include trailing whitespace, partial redraws, etc. — be strict.

10. **Tear down auth tmux.** `tmux kill-session -t cc-auth-setup`. The token is now in your variable; the pane has no further use.

11. **Write to `.env` (read-modify-write).** Same pattern as the API key path: read existing `.env`, merge `CLAUDE_CODE_OAUTH_TOKEN=<value>`, reconstruct, write with `acknowledgeGuards: { nonWorkspaceWrite: true }`.

12. **Verify and ask before restart**, identical to the API key path.

13. **Clean up:** `rm -rf /tmp/cc-auth`.

## Failure modes and what to do

- **`claude setup-token` exits before printing a URL.** Capture the pane, show to user, kill the session. Three likely causes: (a) claude is already authenticated (in which case skip auth entirely); (b) the CLI version doesn't support `setup-token` (older versions used a different command — surface and stop); (c) the container has no egress to `claude.ai` / `console.anthropic.com` and the OAuth handshake failed at the DNS or TLS layer. For (c), the user has to allow-list those hosts in their container egress policy — there is no workaround.
- **User pastes garbage / not a code or URL.** Re-ask once with the parsing reminder ("paste either the code from the browser page or the full URL from the address bar"). If they fail twice, kill the tmux session, clean up `/tmp/cc-auth`, and tell them to use the API-key path or run `typeclaw shell` + `claude setup-token` manually.
- **`setup-token` rejects the code** (server-side: wrong account, expired code, race). The pane shows an error. Capture it, surface to the user, kill the session. Don't retry automatically — the user has to start a fresh authorization.
- **`setup-token` hangs after the code paste.** 30-second timeout. Capture pane, surface, kill. Most likely network: the CLI is trying to exchange the code for a token and can't reach `api.anthropic.com`.
- **Token written but restart fails.** The credential is on disk; just tell the user "Auth landed, but I couldn't restart the container — run `typeclaw restart` yourself when ready."

## Things you must not do during auth

- **Do not assume `claude setup-token` is non-interactive.** It is a TUI flow with input prompts; pipes will not work. Always tmux.
- **Do not type the user's pasted code anywhere except `send-keys` into the auth pane.** Don't log it, don't echo it back, don't put it in a sentinel. It's a short-lived OAuth code but it's still a credential.
- **Do not skip the `CLAUDE_CODE_OAUTH_TOKEN=` regex match and just grab the whole pane.** The pane has ANSI, prompts, banner text. Match for the literal `KEY=value` shape; anything else is brittle.
- **Do not write the token to `.env` until you've validated its format.** A malformed token quietly turns into a broken auth that surfaces only on the next claude invocation, long after the user has moved on.
- **Do not retry OAuth automatically on a server-side rejection.** OAuth codes are single-use; retrying the same code always fails. The user has to start a fresh authorize flow.
- **Do not run auth from inside a delegation worktree.** Auth is separate from delegation. Mixing them in the same `/tmp/cc-<id>/` directory means a future `git worktree remove` could nuke an in-flight auth session, and confuses cleanup. Auth lives at `/tmp/cc-auth/`; delegations live at `/tmp/cc-<task-id>/`.
- **Do not try to launch a browser from inside the container** (`xdg-open`, `open`, `python -m webbrowser`, etc.). The container has no display, no DBus, no desktop integration. These either silently fail or fail with a confusing error. The user is on a different machine — surface the URL through the TUI / channel and let the user open it on whatever device they're physically at.
- **Do not advise the user to set up SSH port forwarding** to make the OAuth callback reachable. It's tempting (forward `localhost:1455` from the user's machine to the container so the browser redirect lands) but it adds complexity and a failure mode for zero benefit — the code-paste fallback already handles the cross-device case identically. `claude setup-token` is built for this; trust it.
- **Do not advise the user to run `claude setup-token` themselves via `typeclaw shell`.** That works as a manual escape hatch when everything else fails, but it abandons the agent-mediated flow — you lose the validation, the format-check, the `.env` write, and the restart prompt. Only fall back to manual instructions after the in-agent flow has failed twice in a way that's not the user's fault (e.g. parser mismatch on the captured pane, persistent network errors).
- **Do not branch on local-vs-remote in your auth code path.** There is no signal you can read inside the container that reliably tells you whether the user's browser is on the same host or not (`hostname`, the docker bridge IP, etc. are not reliable). The flow above works for both cases; don't try to optimize for the local case at the cost of correctness for the remote case.
