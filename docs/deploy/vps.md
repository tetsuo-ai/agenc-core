# Running AgenC on a VPS

**AgenC 0.7.2.** A $5-class VPS (Hetzner CX11, DigitalOcean basic, Railway
container) runs the daemon fine: providers do the heavy lifting; the daemon is
orchestration. Two supported shapes.

Related: [install](../install.md) · [gateway](../gateway.md) ·
[onboarding](../onboarding.md) · [remote control](../remote-control.md).

## Shape 1 — bare VPS with the one-line installer (recommended)

```bash
# as a normal user (never root) on Ubuntu 24.04 / Debian 12:
curl -fsSL https://get.agenc.ag/install.sh | sh
# verifies compatibility, bytes, and sha256; installs under an ABI-keyed
# $AGENC_HOME/runtime/<version>/<platform>-<arch>-<libc>-node-abi-<abi>/ path,
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

No GHCR image is authorized yet. Build from the tracked source snapshot below;
published amd64/arm64 commands will be added only after the hosted native
multi-architecture release gate lands.

Build from a source checkout:

```bash
commit="$(git rev-parse HEAD)"
epoch="$(git show -s --format=%ct HEAD)"
build_time="$(node -e 'process.stdout.write(new Date(Number(process.argv[1])*1000).toISOString())' "$epoch")"
version="$(node -p 'require("./package.json").version')"
git archive --format=tar HEAD | \
  docker buildx build --load -f packaging/docker/Dockerfile -t agenc:local \
  --build-arg AGENC_BUILD_COMMIT="$commit" \
  --build-arg SOURCE_DATE_EPOCH="$epoch" \
  --build-arg AGENC_BUILD_TIME="$build_time" \
  --build-arg AGENC_VERSION="$version" -
```

Compose (from a checkout):

```bash
export AGENC_BUILD_COMMIT="$(git rev-parse HEAD)"
export SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"
export AGENC_BUILD_TIME="$(node -e 'process.stdout.write(new Date(Number(process.argv[1])*1000).toISOString())' "$SOURCE_DATE_EPOCH")"
export AGENC_VERSION="$(node -p 'require("./package.json").version')"
export AGENC_DOCKER_CONTEXT="$(mktemp -d)"
trap 'rm -rf -- "$AGENC_DOCKER_CONTEXT"' EXIT
git archive --format=tar HEAD | tar -xf - -C "$AGENC_DOCKER_CONTEXT"
docker compose -f packaging/docker/docker-compose.yml up -d
```

Numeric non-root image, read-only root, no Linux capabilities, data-only state
in `/data`, and **no published ports by default**
(see the compose file's exposure note). Pass channel tokens and provider keys
as env (or secrets), never bake them into the image. The peer-credential addon
is prebuilt and root-owned in the image; the daemon never compiles or loads
native code from `/data`, and the release smoke starts it with `/data:noexec`.

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
what they must configure (volume, env passthrough, no published ports). There
is no current GHCR image tag; pin the reviewed source commit until the hosted
multi-architecture release gate authorizes one.
