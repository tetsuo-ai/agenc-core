# Running AgenC on a VPS

**AgenC 0.6.0.** A $5-class VPS (Hetzner CX11, DigitalOcean basic, Railway
container) runs the daemon fine: providers do the heavy lifting; the daemon is
orchestration. Two supported shapes.

Related: [install](../install.md) · [gateway](../gateway.md) ·
[onboarding](../onboarding.md) · [remote control](../remote-control.md).

## Shape 1 — bare VPS with the one-line installer (recommended)

```bash
# as a normal user (never root) on Ubuntu 24.04 / Debian 12:
curl -fsSL https://get.agenc.ag/install.sh | sh
# verifies sha256, installs runtime under $AGENC_HOME/runtime/<version>/,
# wrapper to ~/.local/bin, daemon as a systemd user service

agenc onboard                                  # Act 1: provider/key/theme
agenc security audit --fix                     # must be green before you leave
loginctl enable-linger "$USER"                 # keep user services after logout
```

Optional product path (named agent + phone + spend caps):

```bash
agenc onboard identity
agenc onboard channel                          # Telegram/Discord/Slack/WebChat
agenc gateway install-service                  # always-on channels
agenc onboard autonomy                         # budget → heartbeat → cron → hooks
agenc onboard recap
```

### Remote access — do not publish the daemon port

The daemon binds loopback and refuses non-loopback WebSocket binds without an
explicit override. Keep that posture and reach it via:

- **Tailscale (preferred):** `tailscale up`, then connect over the tailnet
  (`tailscale serve` or an SSH tunnel to loopback).
- **SSH tunnel:** `ssh -N -L 7766:127.0.0.1:7766 user@vps` (default daemon
  WebSocket is `ws://127.0.0.1:7766`).

`agenc security audit` flags a non-loopback override as critical. A red audit
on a VPS is an exposed agent.

Phone remote control of a desktop session uses the signed relay
([remote-control.md](../remote-control.md)) and still requires remote login;
it does **not** require opening the daemon to the public internet.

### Channel gateway on a VPS

Tokens live in `$AGENC_HOME/gateway/env` (`0600`). Prefer
`agenc gateway install-service` (user unit `agenc-gateway`) over long-running
tmux. For always-on after reboot:

```bash
loginctl enable-linger "$USER"
systemctl --user status agenc-daemon
systemctl --user status agenc-gateway
journalctl --user -u agenc-gateway -f
```

WebChat and hooks also bind loopback only by default — tunnel or tailnet to
reach them; do not publish those ports.

## Shape 2 — Docker

Pull the published image (no source checkout):

```bash
docker run -d --restart unless-stopped -v agenc-data:/data \
  -e XAI_API_KEY ghcr.io/tetsuo-ai/agenc:0.6.0
# or :latest when you accept floating tags

# one-shot against the same state:
docker run --rm -v agenc-data:/data ghcr.io/tetsuo-ai/agenc:0.6.0 security audit
```

Build from a source checkout:

```bash
docker build -f packaging/docker/Dockerfile -t agenc:local .
```

Compose (from a checkout):

```bash
docker compose -f packaging/docker/docker-compose.yml up -d
```

Non-root image, state in the `/data` volume, **no published ports by default**
(see the compose file's exposure note). Pass channel tokens and provider keys
as env (or secrets), never bake them into the image.

## Provider credentials

Set BYOK keys in the service environment, never in files inside the image or
repo. For systemd user services:

```bash
systemctl --user edit agenc-daemon
# [Service]
# Environment=XAI_API_KEY=...
# Environment=OPENROUTER_API_KEY=...
```

The unit file itself stays credential-free. Managed OpenRouter
([managed-openrouter.md](../managed-openrouter.md)) uses remote login +
short-lived vended keys instead of a long-lived OpenRouter secret on disk;
BYOK still wins when set.

Channel secrets for the gateway: `$AGENC_HOME/gateway/env` (or Docker env
equivalents), loaded by `agenc gateway run` / the gateway user unit.

## One-click templates (owner-publish step)

Railway/Hostinger/DigitalOcean template listings wrap Shape 2 with the
`agenc-data` volume and env-var prompts for the provider key. Publishing the
templates is an owner/release step; this document is the source of truth for
what they must configure (volume, env passthrough, no published ports, current
image tag `0.6.0`).
