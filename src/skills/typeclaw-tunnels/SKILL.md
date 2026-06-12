---
name: typeclaw-tunnels
description: Use when the user mentions tunnel, ngrok, webhook URL, cloudflared, expose to internet, show my friend, public URL, GitHub webhook, port forward to public, reverse proxy, trycloudflare, or making a container-local service reachable from the internet. Read it before suggesting tunnel add/remove/status/logs or editing typeclaw.json tunnels[]. Also read it the moment a tunnel "doesn't work": a Cloudflare tunnel with no public URL usually means `cloudflared` was never baked into the image — it is opt-in (`docker.file.cloudflared`, default false), so a hand-added tunnel needs it set explicitly. Diagnose root cause by reading typeclaw.json + checking `command -v cloudflared` rather than trusting a single error line; tell the user to set `docker.file.cloudflared: true` and `typeclaw restart`; never curl/vendor cloudflared yourself or report a cryptic error as if the tunnel were down.
---

# typeclaw-tunnels

TypeClaw tunnels expose a container-private HTTP/TCP service to the public internet. Use them for inbound webhooks (especially GitHub) or short-lived demos where the user wants a public URL for a local port.

## When to suggest `typeclaw tunnel add`

Suggest a tunnel when the user asks for any of these:

- "give GitHub a webhook URL", "make GitHub webhooks work", or similar webhook delivery work.
- "expose this to the internet", "show my friend", "public URL", or "share this dashboard".
- "use ngrok" or "cloudflared" for a port running inside the agent container.

Do **not** suggest a tunnel for host-local browsing only. If the user just needs to open a dev server on their own machine, TypeClaw's port-forwarder usually already maps container LISTEN ports to `127.0.0.1:<port>` on the host. Tunnels are for public internet ingress.

## Provider choices

### Cloudflare Quick Tunnel

Choose Cloudflare Quick when the user wants the easiest path:

- No Cloudflare account or signup.
- No host-side binary install; `cloudflared` runs inside the container.
- The URL looks like `https://<random>.trycloudflare.com`.
- The URL rotates on container restart or tunnel restart. That is expected.

For GitHub channel setup, `typeclaw channel add github` can write a channel-owned Cloudflare Quick tunnel named `github-webhook` and set `docker.file.cloudflared: true`. The first `typeclaw start` or `restart` after that rebuilds the image with `cloudflared` installed.

### Cloudflare Named Tunnel

Choose Cloudflare Named when the user has a domain on Cloudflare and wants a stable URL:

- Cloudflare account required (free), plus a domain already in their account's `Websites` list.
- The user creates the tunnel in the Zero Trust dashboard (`Networks → Tunnels → Create`), copies the token, and configures a Public Hostname pointing at `localhost:<port>` (where `<port>` is the in-container upstream).
- The URL is whatever subdomain on their domain they configured (e.g. `https://agent.example.com`).
- The URL never rotates. It's bound to the tunnel in the dashboard, not the process.
- `cloudflared` runs inside the container with `cloudflared tunnel run --token <jwt>`. The token comes from `.env`.

Use `provider: "cloudflare-named"` with `hostname: "https://..."` and `tokenEnv: "CLOUDFLARE_TUNNEL_TOKEN"` (or another env var name set in `.env`). The user must:

1. Create the tunnel in the Cloudflare dashboard.
2. Add at least one Public Hostname mapping `<sub>.<their-domain>` → `localhost:<port>`. A tunnel without a Public Hostname is a no-op — `cloudflared` registers but has nothing to route.
3. Put the dashboard-printed token in `.env` under the env var named in `tokenEnv`.
4. `typeclaw restart` to pick up the new tunnel and the cloudflared layer.

The `hostname` field in `typeclaw.json` is informational — typeclaw uses it for `tunnel-url-changed` events and CLI display, but `cloudflared` reads the actual hostname→upstream mapping from the dashboard. If the user changes the hostname in the dashboard, they must also update `tunnels[].hostname` in `typeclaw.json` or downstream consumers (GitHub webhook registration) will keep using the stale URL.

`upstreamPort` is not used for `cloudflare-named` — the dashboard's Public Hostname mapping captures it. The schema rejects `upstreamPort` on named tunnels to surface drift early.

### External URL

Choose External when the user already has their own reverse proxy or tunnel:

- ngrok, a Cloudflare named tunnel managed outside TypeClaw, Caddy on a VPS, Tailscale Funnel, or any HTTPS reverse proxy.
- The URL is stable because the user owns it.
- TypeClaw does not spawn a subprocess for this provider; it records the URL and broadcasts it to channel consumers.

Use `provider: "external"` with `externalUrl: "https://..."`. External URLs must be HTTPS.

## Commands

- `typeclaw tunnel add <name>` — add a manual tunnel to `typeclaw.json`.
- `typeclaw tunnel list` — show all configured tunnels and their current URL/health.
- `typeclaw tunnel status <name>` — inspect one tunnel in detail.
- `typeclaw tunnel logs <name>` — print the tunnel's recent log ring.
- `typeclaw tunnel logs <name> -f` — follow live tunnel logs.
- `typeclaw tunnel remove <name>` — remove a manual tunnel. Channel-owned tunnels should be removed through the owning channel flow, not by hand.

Tunnel config is **restart-required**. After adding/removing/changing `tunnels[]` or `docker.file.cloudflared`, the user must run `typeclaw restart` from the host stage.

## Reading `tunnel status`

Healthy Cloudflare Quick tunnels should show:

- provider `cloudflare-quick`.
- a current `https://...trycloudflare.com` URL after cloudflared has emitted one.
- health like `healthy` or equivalent live/running state.
- restart count near zero for a stable tunnel.

Unhealthy signs:

- no URL after startup.
- repeated restarts or increasing restart count.
- `unhealthy` / `permanently-failed` state.
- last error mentioning spawn failure, missing binary, or cloudflared exit.

For External tunnels, the URL should be the configured `externalUrl`; there may be no subprocess health to inspect.

## Reading `tunnel logs`

Healthy Cloudflare Quick logs usually include:

- cloudflared startup lines.
- a line containing the public `https://...trycloudflare.com` URL.
- no rapid repeated exit/restart sequence.

Unhealthy logs often show:

- `cloudflared` not found or spawn failure.
- repeated process exits followed by backoff/restart lines.
- Cloudflare connection errors or network failures.
- no URL emission before the process exits.

Use `typeclaw tunnel logs <name> -f` while restarting the agent if you need to watch URL discovery live.

## Diagnosing "the tunnel doesn't work" (you, the agent)

When a tunnel has no public URL, **diagnose the root cause directly — don't stop at a single error line.** The most common cause by far is that `cloudflared` was never baked into the image (it's opt-in; see below), not a runtime outage. These checks always work from your shell inside the container:

1. **Read `typeclaw.json`.** Look at `tunnels[]` (is the tunnel even configured? which `provider`?) and `docker.file.cloudflared` (is it `true`?).
2. **Check the binary:** `command -v cloudflared`. If a `cloudflare-quick` / `cloudflare-named` tunnel is configured but this prints nothing, the cloudflared layer was never installed — that is the root cause (see "### `cloudflared` is not installed" below).
3. **Check the upstream is alive:** the service the tunnel points at must be listening on its `upstreamPort` inside the container (e.g. `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:<upstreamPort>/`).

Then tell the user honestly and offer the fix. For the common "hand-added tunnel, no `cloudflared`" case, send something like:

> This agent has a `cloudflare-quick` tunnel configured, but `cloudflared` was never installed into the image — it's opt-in (`docker.file.cloudflared`, default `false`), and this tunnel was hand-added to `typeclaw.json` without enabling it. Want me to set `docker.file.cloudflared: true`? It's a boot setting, so after I edit it you'll run `typeclaw restart` from the host project directory, and the tunnel URL will come up.

Only after the user agrees: edit `typeclaw.json` (use the `typeclaw-config` skill), ask them to `typeclaw restart` from the **host** stage, and confirm the URL once the rebuilt container is back. Never `curl`/vendor `cloudflared` yourself.

### If `typeclaw tunnel status/list/logs` prints `✖ [object ErrorEvent]`

On older containers the in-container CLI couldn't reach the agent websocket (it resolved the port/token via `docker`, which isn't on `$PATH` inside the container), so these commands failed at the handshake with the opaque line `✖ [object ErrorEvent]`. **That is a CLI-reachability quirk, not a tunnel outage** — do not report it to the user as "the tunnel is down" or "I can't get the URL." Fall back to the direct diagnosis above (read `typeclaw.json`, `command -v cloudflared`, probe the upstream). Current containers resolve the websocket from the in-container `TYPECLAW_*` env instead, so `tunnel status` works in-container and prints a real `detail` line; if you still see `[object ErrorEvent]`, the agent is running an older build and the direct checks are authoritative.

## Common failure modes

### `cloudflared` is not installed

`docker.file.cloudflared` defaults to `false`, so a fresh image ships without the `cloudflared` binary. Both Cloudflare providers (`cloudflare-quick` and `cloudflare-named`) require `docker.file.cloudflared: true`. `typeclaw tunnel add` and `typeclaw channel add github` (with a Cloudflare provider) write it automatically; a hand-edited `typeclaw.json` must set it explicitly. After setting it, run `typeclaw restart` so the Dockerfile is regenerated and the image rebuilds.

If a tunnel is configured but the binary is missing, the tunnel goes **`permanently-failed`** and `typeclaw tunnel status` shows the detail `cloudflared binary not found in image; set docker.file.cloudflared: true in typeclaw.json and run typeclaw restart` — fix it the same way.

### Named tunnel says "permanently-failed" with `tokenEnv` in the detail

The env var named in `tunnels[].tokenEnv` is not set or is empty in the agent's `.env`. The provider intentionally does not retry this case — fix `.env`, then `typeclaw restart`. `cloudflared` is never spawned with a missing token.

### Named tunnel is healthy but no traffic flows

Two likely causes:

1. The Cloudflare dashboard's Public Hostname tab for this tunnel is empty. A tunnel with no public hostname is a no-op — `cloudflared` registers and waits, but Cloudflare has nothing to route to it. `curl https://<hostname>` returns Cloudflare error 530 or 1033.
2. The Public Hostname's upstream `localhost:<port>` does not match the in-container service port. typeclaw cannot detect this drift; the user must align the dashboard and the container.

### Quick tunnel URL changed

This is normal. Quick Tunnel URLs rotate on restart. GitHub channel-owned tunnels handle this by flowing the resolved URL through the channel manager's `tunnelUrl()` callback and restarting the adapter; do not persist the rotating URL into `typeclaw.json`.

### Repeated restarts

Inspect `typeclaw tunnel status <name>` and `typeclaw tunnel logs <name>`. Look for spawn errors, network restrictions, or cloudflared exiting before URL discovery. The tunnel manager backs off and eventually stops retrying after repeated failures without a URL.

### GitHub webhooks are not delivered

Check in this order:

1. `typeclaw tunnel status github-webhook` has a current URL.
2. `typeclaw tunnel logs github-webhook` shows a URL and no crash loop.
3. The GitHub channel config has repos listed under `channels.github.repos`.
4. The channel adapter was restarted after the URL arrived. Channel-owned tunnel URLs should flow through `tunnelUrl()` into adapter `start()`, not through config mutation.
5. GitHub repo webhook settings point at the current URL if using External; for Cloudflare Quick, expect TypeClaw to re-register on URL changes.
