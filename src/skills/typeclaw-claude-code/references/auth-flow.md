# Auth flow — operator-owned (Claude Code)

Claude Code authentication is outside the model-driven tool boundary. **Authenticated Claude Code delegation is unavailable from model-driven TypeClaw tools.** The agent must not read, print, parse, copy, write, verify, or probe any credential value or credential file.

## No readiness bypass

Do not check environment variables or profile-file existence as a way to enable delegation. TypeClaw masks canonical credential files and directories from model-driven bash, strips reusable credential environments, and unconditionally blocks non-bash tools from opening them. Provider authentication available to trusted runtime code is not delegated to a model-driven Claude child.

## When authentication is missing

Stop the delegation and tell the operator:

> Authenticated Claude Code delegation is unavailable from model-driven TypeClaw tools. Authenticate and run Claude Code directly as the host-side operator. Do not send an API key or OAuth token in chat.

The operator may manage Claude Code authentication directly on the host. The model must not broker that path, request `claude setup-token` output, or transfer a credential into the container.

If Claude Code presents an auth prompt that requires entering or inspecting a credential, exit the delegated session. Do not run `claude setup-token` in the container or paste a key/token through tmux.

## Runtime separation

Trusted runtime provisioning does not authorize a model-driven child. Any exported persistent profile remains masked, and the sandbox intentionally does not mount it or preserve Anthropic credential variables. Restarting cannot change this policy boundary.

## Hard prohibitions

- Never ask for or accept an API key, OAuth token, access token, or credential-file contents in chat.
- Never use `read`, `write`, `edit`, `look_at`, channel attachment tools, or shell commands to access `.env`, `secrets.json`, `auth.json`, `~/.claude/.credentials.json`, or their persistent backing directories.
- Never put credentials in prompts, tmux keystrokes, command arguments, sentinels, transcripts, logs, commits, or scratch files.
- Never treat a guard acknowledgement as authorization to handle credentials. Canonical credentials are blocked independently of plugin guard hooks.
- If a credential is offered, tell the user not to send it and redirect them to host-side setup.
