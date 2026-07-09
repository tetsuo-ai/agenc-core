#!/bin/sh
# AgenC one-line installer (macOS / Linux).
#
#   curl -fsSL <installer-url> | sh
#
# Downloads the per-platform runtime tarball listed in the release manifest,
# verifies its sha256, extracts it under $AGENC_HOME/runtime/<version>/ using
# the exact install contract the npm launcher's runtime-manager uses (same
# directory layout, same .agenc-runtime-ok marker), installs an `agenc`
# wrapper into --prefix/bin, and wires the daemon as a user service.
#
# The npm launcher (`npm install -g @tetsuo-ai/agenc`) and this script are
# interchangeable: either one finds and reuses a runtime the other installed.
#
# Options (flags win over environment):
#   --version <x.y.z>       pin a release (default: latest release manifest)
#   --manifest-url <url>    manifest override; supports file:// and plain paths
#                           (env: AGENC_INSTALL_MANIFEST_URL)
#   --repo <owner/name>     GitHub repo for release downloads
#                           (env: AGENC_INSTALL_REPO, default tetsuo-ai/agenc-core)
#   --prefix <dir>          wrapper install prefix (default: ~/.local)
#   --no-daemon             skip user-service installation
#   AGENC_HOME              runtime install root (default: ~/.agenc)
#
# Test seams (used by runtime/tests/packaging/install-sh.test.ts):
#   AGENC_INSTALL_PLATFORM / AGENC_INSTALL_ARCH override platform detection.
#
# Publishing this script to a stable URL (get.agenc.ag, release asset) and
# uploading agenc-runtime-manifest.json as a release asset are owner/release
# steps; see docs/install.md.

set -u

REPO="${AGENC_INSTALL_REPO:-tetsuo-ai/agenc-core}"
MANIFEST_URL="${AGENC_INSTALL_MANIFEST_URL:-}"
PIN_VERSION=""
PREFIX="${HOME}/.local"
INSTALL_DAEMON=1
MIN_NODE_MAJOR=25

log() { printf 'agenc-install: %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) PIN_VERSION="${2:?--version needs a value}"; shift 2 ;;
    --manifest-url) MANIFEST_URL="${2:?--manifest-url needs a value}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    --no-daemon) INSTALL_DAEMON=0; shift ;;
    -h|--help) sed -n '2,30p' "$0" 2>/dev/null; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

# --- prerequisites -----------------------------------------------------------

command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v node >/dev/null 2>&1 || fail \
  "Node.js >= ${MIN_NODE_MAJOR} is required. Install it (https://nodejs.org) and re-run."

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" \
  || fail "could not determine Node.js version"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null || fail \
  "Node.js >= ${MIN_NODE_MAJOR} required, found $(node -v). Upgrade Node and re-run."

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then DOWNLOADER="wget"
fi

# --- platform ----------------------------------------------------------------

detect_platform() {
  if [ -n "${AGENC_INSTALL_PLATFORM:-}" ]; then
    printf '%s' "$AGENC_INSTALL_PLATFORM"; return
  fi
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) fail "unsupported OS: $(uname -s) (use install.ps1 on Windows)" ;;
  esac
}

detect_arch() {
  if [ -n "${AGENC_INSTALL_ARCH:-}" ]; then
    printf '%s' "$AGENC_INSTALL_ARCH"; return
  fi
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

OS="$(detect_platform)"
ARCH="$(detect_arch)"

# --- fetch helpers (file:// and plain paths supported for testability) -------

fetch_to() {
  # fetch_to <url> <dest>
  _url="$1"; _dest="$2"
  case "$_url" in
    file://*)
      cp "${_url#file://}" "$_dest" || return 1 ;;
    http://*|https://*)
      [ -n "$DOWNLOADER" ] || fail "curl or wget is required to download $_url"
      if [ "$DOWNLOADER" = curl ]; then
        curl -fsSL --proto '=https' --tlsv1.2 -o "$_dest" "$_url" || return 1
      else
        wget -q -O "$_dest" "$_url" || return 1
      fi ;;
    *)
      cp "$_url" "$_dest" || return 1 ;;
  esac
}

sha256_of() {
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

# --- resolve manifest --------------------------------------------------------

AGENC_HOME_DIR="${AGENC_HOME:-${HOME}/.agenc}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agenc-install.XXXXXX")" || fail "mktemp failed"
trap 'rm -rf "$WORK"' EXIT INT TERM

if [ -z "$MANIFEST_URL" ]; then
  if [ -n "$PIN_VERSION" ]; then
    MANIFEST_URL="https://github.com/${REPO}/releases/download/agenc-v${PIN_VERSION}/agenc-runtime-manifest.json"
  else
    MANIFEST_URL="https://github.com/${REPO}/releases/latest/download/agenc-runtime-manifest.json"
  fi
fi

log "fetching release manifest: ${MANIFEST_URL}"
MANIFEST_FILE="$WORK/manifest.json"
fetch_to "$MANIFEST_URL" "$MANIFEST_FILE" || fail "could not fetch manifest: ${MANIFEST_URL}"

# Select the artifact for this platform. Mirrors the launcher's selectArtifact.
SELECTED="$(node -e '
  const { readFileSync } = require("node:fs");
  const [file, os, arch] = process.argv.slice(1);
  const m = JSON.parse(readFileSync(file, "utf8"));
  const artifacts = Array.isArray(m.artifacts) ? m.artifacts : [];
  const a = artifacts.find((x) => x.platform === os && x.arch === arch);
  if (!a) {
    const have = artifacts.map((x) => `${x.platform}-${x.arch}`).join(", ");
    console.error(`no runtime build for ${os}-${arch} (available: ${have || "none"})`);
    process.exit(3);
  }
  if (!m.runtimeVersion || !a.url || !/^[0-9a-f]{64}$/.test(a.sha256 || "")) {
    console.error("manifest artifact is missing runtimeVersion/url/sha256");
    process.exit(4);
  }
  const bin = (a.bins && a.bins.agenc) || "node_modules/@tetsuo-ai/runtime/bin/agenc";
  process.stdout.write([m.runtimeVersion, a.url, a.sha256, bin].join("\n"));
' "$MANIFEST_FILE" "$OS" "$ARCH")" || fail "manifest rejected (${OS}-${ARCH})"

VERSION="$(printf '%s\n' "$SELECTED" | sed -n 1p)"
ARTIFACT_URL="$(printf '%s\n' "$SELECTED" | sed -n 2p)"
ARTIFACT_SHA="$(printf '%s\n' "$SELECTED" | sed -n 3p)"
BIN_REL="$(printf '%s\n' "$SELECTED" | sed -n 4p)"

INSTALL_DIR="${AGENC_HOME_DIR}/runtime/${VERSION}"
MARKER="${INSTALL_DIR}/.agenc-runtime-ok"
RUNTIME_BIN="${INSTALL_DIR}/${BIN_REL}"

# --- download + verify + extract (idempotent via the marker contract) --------

if [ -f "$MARKER" ] && [ "$(cat "$MARKER" 2>/dev/null)" = "$ARTIFACT_SHA" ]; then
  log "runtime ${VERSION} already installed (verified marker) — skipping download"
else
  log "downloading runtime ${VERSION} (${OS}-${ARCH})..."
  TARBALL="$WORK/runtime.tar.gz"
  fetch_to "$ARTIFACT_URL" "$TARBALL" || fail "download failed: ${ARTIFACT_URL}"

  ACTUAL_SHA="$(sha256_of "$TARBALL")" || fail "sha256 computation failed"
  if [ "$ACTUAL_SHA" != "$ARTIFACT_SHA" ]; then
    fail "checksum mismatch for runtime tarball (expected ${ARTIFACT_SHA}, got ${ACTUAL_SHA}). Refusing to install."
  fi
  log "checksum verified"

  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$TARBALL" -C "$INSTALL_DIR" || fail "extraction failed"
  [ -f "$RUNTIME_BIN" ] || fail "runtime extracted but entry missing: ${RUNTIME_BIN}"
  printf '%s' "$ARTIFACT_SHA" > "$MARKER"
  log "runtime ${VERSION} installed at ${INSTALL_DIR}"
fi

# --- wrapper -----------------------------------------------------------------

BIN_DIR="${PREFIX}/bin"
WRAPPER="${BIN_DIR}/agenc"
mkdir -p "$BIN_DIR"
# Bake absolute node + runtime paths: user services (systemd/launchd) run with
# a minimal PATH where version-manager-installed node is not resolvable.
cat > "$WRAPPER" <<EOF
#!/bin/sh
# Generated by AgenC install.sh — rewritten on every install/upgrade.
export AGENC_HOME="\${AGENC_HOME:-${AGENC_HOME_DIR}}"
exec "${NODE_BIN}" "${RUNTIME_BIN}" "\$@"
EOF
chmod 755 "$WRAPPER"
log "installed wrapper: ${WRAPPER}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) : ;;
  *) log "NOTE: ${BIN_DIR} is not on your PATH. Add it, e.g.: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

# --- daemon service ----------------------------------------------------------
# Content mirrors packaging/systemd/agenc-daemon.service and
# packaging/launchd/dev.agenc.daemon.plist, with ExecStart resolved to the
# installed wrapper (user services run with a minimal PATH).

install_daemon_linux() {
  if ! command -v systemctl >/dev/null 2>&1; then
    log "systemctl not found — start the daemon manually: agenc daemon start"
    return 0
  fi
  UNIT_DIR="${HOME}/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "${UNIT_DIR}/agenc-daemon.service" <<EOF
[Unit]
Description=AgenC daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${WRAPPER} daemon start --foreground
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
  if systemctl --user daemon-reload && systemctl --user enable --now agenc-daemon.service; then
    log "daemon installed and started (systemd user service agenc-daemon)"
  else
    log "WARNING: could not enable the systemd user service — start manually: agenc daemon start"
  fi
}

install_daemon_darwin() {
  PLIST_DIR="${HOME}/Library/LaunchAgents"
  PLIST="${PLIST_DIR}/dev.agenc.daemon.plist"
  mkdir -p "$PLIST_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agenc.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${WRAPPER}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
EOF
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
     || launchctl load -w "$PLIST" 2>/dev/null; then
    log "daemon installed and started (launchd dev.agenc.daemon)"
  else
    log "WARNING: could not load the launchd agent — start manually: agenc daemon start"
  fi
}

if [ "$INSTALL_DAEMON" -eq 1 ]; then
  case "$OS" in
    linux) install_daemon_linux ;;
    darwin) install_daemon_darwin ;;
  esac
else
  log "daemon installation skipped (--no-daemon)"
fi

# --- done --------------------------------------------------------------------

log "install complete"
printf '\n  AgenC %s installed.\n\n  Next steps:\n    %s onboard      # guided setup: provider, key, theme, first chat\n    %s doctor       # verify the installation\n    %s daemon status\n\n' \
  "$VERSION" "$WRAPPER" "$WRAPPER" "$WRAPPER"
