# Installing AgenC

Three interchangeable install paths share one runtime contract: the runtime
tarball extracts to `$AGENC_HOME/runtime/<version>/` with a `.agenc-runtime-ok`
marker recording the artifact sha256. Any installer finds and reuses a runtime
another one installed.

## One-line installer (macOS / Linux)

```bash
curl -fsSL <installer-url>/install.sh | sh
```

The script (source: `scripts/install/install.sh`):

1. requires `tar` and Node.js >= 25 (Node is also used for uniform JSON
   parsing and sha256 across platforms),
2. fetches the release manifest (`agenc-runtime-manifest.json`) for the latest
   release, or a pinned one with `--version x.y.z`,
3. downloads the per-platform runtime tarball and **verifies its sha256
   against the manifest — a mismatch aborts the install**,
4. extracts to `$AGENC_HOME/runtime/<version>/` and writes the marker,
5. installs an `agenc` wrapper to `--prefix`/bin (default `~/.local/bin`) with
   the absolute Node path baked in (user services run with a minimal PATH),
6. installs and starts the daemon as a systemd user service (Linux) or
   launchd agent (macOS). Skip with `--no-daemon`.

Flags: `--version`, `--manifest-url`, `--repo`, `--prefix`, `--no-daemon`.
Re-running is idempotent: a verified existing install skips the download.

## One-line installer (Windows)

```powershell
iwr -useb <installer-url>/install.ps1 | iex
```

Source: `scripts/install/install.ps1`. Same manifest/verify/extract contract;
installs an `agenc.cmd` shim under `%LOCALAPPDATA%\agenc\bin`. Running the
daemon as a Windows service uses WinSW with `packaging/windows/agenc-daemon.xml`
(manual step; `agenc daemon start` works without it).

## npm launcher

```bash
npm install -g @tetsuo-ai/agenc
```

The launcher's postinstall resolves the same runtime contract via
`packages/agenc/lib/runtime-manager.mjs`.

## Docker

```bash
docker build -f packaging/docker/Dockerfile -t agenc:local .
docker run -it -v agenc-data:/data -e XAI_API_KEY agenc:local
```

Or `docker compose -f packaging/docker/docker-compose.yml up -d`. Non-root
image, state in the `/data` volume, no published ports by default (see the
exposure note in the compose file). VPS deployment shapes:
[`docs/deploy/vps.md`](deploy/vps.md).

## Homebrew (owner-publish pending)

`packaging/homebrew/agenc.rb` is the tap formula template; it wraps
`install.sh` so every path shares one verified contract. It ships with
placeholder URL/sha and must not be published until a release fills them.

## Release/publish steps (owner-gated — do not automate from an agent session)

For the one-line installers to work against a release tag:

1. Build per-platform tarballs (`npm --workspace=@tetsuo-ai/agenc run
   build:runtime-tarball`) and generate the manifest
   (`gen:manifest --repo <repo> --tag agenc-v<version>`).
2. Upload the tarballs **and** `packages/agenc/generated/agenc-runtime-manifest.json`
   as assets on the GitHub release (`agenc-v<version>`). The scripts default to
   `releases/latest/download/agenc-runtime-manifest.json`.
3. Host `scripts/install/install.sh` and `install.ps1` at a stable URL
   (e.g. `get.agenc.ag`) or upload them as release assets on a public
   releases repo.

Tests: `runtime/tests/packaging/install-sh.test.ts` exercises the full sh flow
(fresh install, checksum-mismatch abort, marker idempotency, systemd unit
generation, platform/Node gates) against a synthetic tarball and `file://`
manifest, mirroring `packages/agenc/test/runtime-manager.test.mjs`.
