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

3. **Surface the URL to the user.** Send through the TUI / channel:

   > Open this URL in your browser, authorize Claude Code, then paste the auth code back to me:
   >
   > `<URL>`

4. **Wait for the user's code paste.** The user authorizes, copies the code from the post-auth page, and pastes it into the TypeClaw TUI as a regular message. Your next inbound user message is the auth code (or "cancel", or something else).

5. **Validate the code's shape.** OAuth codes from Claude Code are URL-safe base64-ish — typically `[A-Za-z0-9_-]+` of length 20+. Pattern: `/^[A-Za-z0-9_-]{20,}$/`. If the paste doesn't match, ask again — do **not** feed garbage to `setup-token`, which will print an error to the pane that's hard to recover from cleanly.

6. **Feed the code to the tmux pane:**

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

- **`claude setup-token` exits before printing a URL.** Capture the pane, show to user, kill the session. Likely cause: claude is already authenticated (in which case skip auth entirely) or the CLI version doesn't support `setup-token` (older versions used a different command — surface and stop).
- **User pastes garbage / wrong code.** Re-ask once: "That doesn't look like an auth code. Try again, or say 'cancel'." If they fail twice, kill the tmux session, clean up `/tmp/cc-auth`, and tell them to use the API-key path or run `typeclaw shell` + `claude setup-token` manually.
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
