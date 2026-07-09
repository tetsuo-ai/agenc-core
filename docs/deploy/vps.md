# Running the AgenC daemon on a VPS

A $5-class VPS (Hetzner CX11, DigitalOcean basic, Railway container) runs the
daemon fine: the heavy lifting is provider-side, the daemon is orchestration.
Two supported shapes:

## Shape 1 — bare VPS with the one-line installer (recommended)

```bash
# as a normal user (never root) on Ubuntu 24.04 / Debian 12:
curl -fsSL https://get.agenc.ag/install.sh | sh     # verifies sha256, installs the
                                               # systemd user service
agenc onboard                                  # provider + key + first chat
agenc security audit --fix                     # must be green before you leave
loginctl enable-linger "$USER"                 # keep the user service running
                                               # after logout
```

Remote access: **do not** publish the daemon port. The daemon binds loopback
and refuses non-loopback WebSocket binds without an explicit override; keep it
that way and reach it via:

- **Tailscale (preferred):** `tailscale up`, then connect clients over the
  tailnet to the loopback-forwarded port (`tailscale serve` or an SSH tunnel).
- **SSH tunnel:** `ssh -N -L 18789:127.0.0.1:<port> user@vps`.

`agenc security audit` flags the non-loopback override as critical for exactly
this reason; a red audit on a VPS is an exposed agent.

## Shape 2 — Docker

```bash
git clone <repo> && cd agenc-core
docker build -f packaging/docker/Dockerfile -t agenc:local .
docker run -d --restart unless-stopped -v agenc-data:/data \
  -e XAI_API_KEY agenc:local
# one-shot commands against the same state:
docker run --rm -v agenc-data:/data agenc:local security audit
```

Or `docker compose -f packaging/docker/docker-compose.yml up -d` (no ports
published by default; see the file's exposure note).

## Provider credentials

Set BYOK keys in the service environment, never in files inside the image or
repo. For systemd user services: `systemctl --user edit agenc-daemon` and add
`Environment=XAI_API_KEY=...` (the unit file itself stays credential-free).

## One-click templates (owner-publish step)

Railway/Hostinger/DigitalOcean template listings wrap Shape 2 with the
`agenc-data` volume and env-var prompts for the provider key. Publishing the
templates is an owner/release step; this document is the source of truth for
what they must configure (volume, env passthrough, no published ports).
