---
name: typeclaw-tunnels
description: Use when the user mentions tunnel, ngrok, webhook URL, cloudflared, expose to internet, show my friend, public URL, GitHub webhook, port forward to public, reverse proxy, trycloudflare, or making a container-local service reachable from the internet. Read it before suggesting tunnel add/remove/status/logs or editing typeclaw.json tunnels[].
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

## Common failure modes

### `cloudflared` is not installed

The Cloudflare Quick provider requires `docker.file.cloudflared: true`. If it is missing, add it to `typeclaw.json` or re-run the GitHub channel setup choosing Cloudflare Quick, then run `typeclaw restart` so the Dockerfile is regenerated and the image rebuilds.

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
