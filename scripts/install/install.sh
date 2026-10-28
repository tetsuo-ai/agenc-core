#!/bin/sh
# AgenC one-line installer (macOS / Linux).
#
#   curl -fsSL https://get.agenc.ag/install.sh | sh
#
# Downloads the per-platform runtime tarball listed in the release manifest,
# verifies its sha256, extracts it under
# $AGENC_HOME/runtime/<version>/<platform>-<arch>-<libc>-node-abi-<abi>-sha256-<digest>/ using
# the exact install contract the npm launcher's runtime-manager uses (same
# directory layout, same .agenc-runtime-ok marker), installs an `agenc`
# wrapper into --prefix/bin, and wires the daemon as a user service.
#
# The npm launcher (`npm install -g @tetsuo-ai/agenc`) and this script are
# interchangeable: either one finds and reuses a runtime the other installed.
#
# Options (flags win over environment):
#   --version <x.y.z>       pin a release (default: latest release manifest)
#   --manifest-url <url>    explicit HTTPS mirror or explicit local file/path
#                           (env: AGENC_INSTALL_MANIFEST_URL)
#   --repo <owner/name>     GitHub repo for release downloads
#                           (env: AGENC_INSTALL_REPO, default tetsuo-ai/agenc-releases)
#   --prefix <dir>          wrapper install prefix (default: ~/.local)
#   --no-daemon             skip user-service installation
#   --verbose               plain per-phase log instead of the progress display
#   AGENC_HOME              runtime install root (default: ~/.agenc)
#
# Test seams (used by runtime/tests/packaging/install-sh.test.ts):
#   AGENC_INSTALL_PLATFORM / AGENC_INSTALL_ARCH and AGENC_INSTALL_*_VERSION
#   override compatibility detection. AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE and
#   AGENC_INSTALL_BOOTSTRAP_LIBATOMIC_ARCHIVE may point at local copies of the
#   exact pinned bootstrap payloads; production byte counts and sha256 values
#   are still mandatory.
#
# Publishing this script to a stable URL (get.agenc.ag, release asset) and
# uploading agenc-runtime-manifest-v2.json (plus the frozen v0.7.2 legacy
# bridge) as release assets are owner/release
# steps; see docs/install.md.

set -u

# The installer executes several inline Node programs before it has any local
# trusted state. Do not let an ambient preload or disabled TLS verification
# rewrite that bootstrap. NODE_EXTRA_CA_CERTS remains supported for reviewed
# enterprise CAs, and Node's explicit environment-proxy mode keeps the usual
# HTTPS_PROXY/NO_PROXY contract functional.
unset NODE_OPTIONS
unset NODE_PATH NODE_TLS_REJECT_UNAUTHORIZED
unset LD_LIBRARY_PATH LD_PRELOAD DYLD_LIBRARY_PATH DYLD_INSERT_LIBRARIES
NODE_USE_ENV_PROXY=1
export NODE_USE_ENV_PROXY

OFFICIAL_REPO="tetsuo-ai/agenc-releases"
REPO="${AGENC_INSTALL_REPO:-tetsuo-ai/agenc-releases}"
MANIFEST_URL="${AGENC_INSTALL_MANIFEST_URL:-}"
MANIFEST_EXPLICIT=0
[ -n "$MANIFEST_URL" ] && MANIFEST_EXPLICIT=1
PIN_VERSION=""
DEFAULT_PREFIX="${HOME}/.local"
PREFIX="$DEFAULT_PREFIX"
PREFIX_EXPLICIT=0
INSTALL_DAEMON=1
SUPPORTED_NODE_MAJOR=26
SUPPORTED_NODE_MINOR=5
SUPPORTED_NODE_VERSION=26.12.1
NODE_COMPAT_RELEASE_TAG="agenc-v0.11.2"
LEGACY_BRIDGE_NODE_MAJOR=25
LEGACY_BRIDGE_NODE_MINOR=9
MAX_MANIFEST_BYTES=1048576
MAX_ARTIFACT_BYTES=268435456
MAX_SIGSTORE_BUNDLE_BYTES=4194304
MAX_GH_ARCHIVE_BYTES=67108864
PROVENANCE_SCHEMA="agenc-runtime-provenance/v1"
DUAL_PROVENANCE_SCHEMA="agenc-runtime-provenance/v2"
PROVENANCE_REPOSITORY="tetsuo-ai/agenc-core"
PROVENANCE_WORKFLOW="tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml"
PROVENANCE_HOSTNAME="github.com"
PROVENANCE_OIDC_ISSUER="https://token.actions.githubusercontent.com"
PROVENANCE_PREDICATE_TYPE="https://slsa.dev/provenance/v1"

log() { printf 'agenc-install: %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

# --- progress presentation ---------------------------------------------------
#
# A person watching a terminal wants one live line and a short result per phase;
# a log wants the full sentence, unchanged and greppable. So the pretty form is
# strictly a stderr-TTY affordance: with stderr redirected -- CI, `2>file`, the
# packaging tests -- every message below stays byte-identical to the plain log
# it has always been. `--verbose` opts a TTY back into that same plain log.
#
# Only the happy-path phase lines route through step(). Warnings and failures
# keep calling log() directly, so they stand out against the checkmarks instead
# of being dressed up as one.
VERBOSE=0
UI=0
ui_color() { :; }
ui_init() {
  if [ "$VERBOSE" = 0 ] && [ -t 2 ] && [ "${TERM:-dumb}" != "dumb" ]; then UI=1; fi
  [ "$UI" = 1 ] || return 0
  if [ -z "${NO_COLOR:-}" ]; then
    UI_DIM="$(printf '\033[2m')"; UI_BOLD="$(printf '\033[1m')"
    UI_GREEN="$(printf '\033[32m')"; UI_CYAN="$(printf '\033[36m')"
    UI_YELLOW="$(printf '\033[33m')"; UI_RESET="$(printf '\033[0m')"
  else
    UI_DIM=""; UI_BOLD=""; UI_GREEN=""; UI_CYAN=""; UI_YELLOW=""; UI_RESET=""
  fi
  UI_CLR="$(printf '\033[2K\r')"
  # Same locale gate as the closing wordmark: block glyphs only where the
  # terminal can render them, ASCII everywhere else.
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]*8*) UI_OK="✔"; UI_WORK="⋯"; UI_WARN="⚠"; UI_STYLE=unicode ;;
    *) UI_OK="+"; UI_WORK="-"; UI_WARN="!"; UI_STYLE=ascii ;;
  esac
}

# Renders a path the way a person would write it: $HOME as ~, everything else
# verbatim. Never assume a location -- AGENC_HOME and --prefix both move these.
ui_path() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# step <plain-log-sentence> [pretty-label] [detail]
# Plain mode emits exactly the sentence this phase has always logged.
step() {
  if [ "$UI" = 1 ]; then
    printf '%s  %s%s%s %s %s%s%s\n' \
      "$UI_CLR" "$UI_GREEN" "$UI_OK" "$UI_RESET" "${2:-$1}" "$UI_DIM" "${3:-}" "$UI_RESET" >&2
  else
    log "$1"
  fi
}

# Transient "working on it" line, overwritten by the step() that follows it.
# Nothing is emitted in plain mode: a log does not need a line it cannot see
# being erased.
step_begin() {
  [ "$UI" = 1 ] || return 0
  printf '%s  %s%s%s %s' "$UI_CLR" "$UI_CYAN" "$UI_WORK" "$UI_RESET" "$1" >&2
}

BOOTSTRAP_WORK=""
INSTALL_TMP_ROOT=""
WORK=""
UPDATE_LEASE=""
cleanup_installer() {
  [ -z "$UPDATE_LEASE" ] || /bin/rm -f "$UPDATE_LEASE"
  [ -z "$WORK" ] || /bin/rm -rf "$WORK"
  [ -z "$INSTALL_TMP_ROOT" ] || /bin/rmdir "$INSTALL_TMP_ROOT" 2>/dev/null || true
  [ -z "$BOOTSTRAP_WORK" ] || /bin/rm -rf "$BOOTSTRAP_WORK"
}
trap cleanup_installer EXIT
trap 'trap - EXIT; cleanup_installer; exit 130' INT
trap 'trap - EXIT; cleanup_installer; exit 143' TERM

while [ $# -gt 0 ]; do
  case "$1" in
    --version) PIN_VERSION="${2:?--version needs a value}"; shift 2 ;;
    --manifest-url) MANIFEST_URL="${2:?--manifest-url needs a value}"; MANIFEST_EXPLICIT=1; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; PREFIX_EXPLICIT=1; shift 2 ;;
    --no-daemon) INSTALL_DAEMON=0; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) sed -n '2,30p' "$0" 2>/dev/null; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

ui_init

# --- prerequisites -----------------------------------------------------------

# Platform selection cannot depend on a host Node: modern standalone installs
# deliberately work when no Node executable is present.
detect_platform() {
  if [ -n "${AGENC_INSTALL_PLATFORM:-}" ]; then
    case "$AGENC_INSTALL_PLATFORM" in
      linux|darwin) printf '%s' "$AGENC_INSTALL_PLATFORM"; return ;;
      *) fail "unsupported operating-system platform override: $AGENC_INSTALL_PLATFORM" ;;
    esac
  fi
  [ -x /usr/bin/uname ] || fail "the trusted operating-system uname executable is required"
  case "$(/usr/bin/uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) fail "unsupported operating-system platform: $(/usr/bin/uname -s)" ;;
  esac
}

detect_arch() {
  if [ -n "${AGENC_INSTALL_ARCH:-}" ]; then
    case "$AGENC_INSTALL_ARCH" in
      x64|arm64) printf '%s' "$AGENC_INSTALL_ARCH"; return ;;
      *) fail "unsupported operating-system architecture override: $AGENC_INSTALL_ARCH" ;;
    esac
  fi
  [ -x /usr/bin/uname ] || fail "the trusted operating-system uname executable is required"
  case "$(/usr/bin/uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) fail "unsupported operating-system architecture: $(/usr/bin/uname -m)" ;;
  esac
}

OS="$(detect_platform)" || exit 1
ARCH="$(detect_arch)" || exit 1

node_contract() {
  "$1" -e '
    const [expectedPlatform, expectedArch, mode] = process.argv.slice(1);
    const [major, minor] = process.versions.node.split(".").map(Number);
    const legacy = mode === "legacy";
    const versionOk = legacy ? major === 25 && minor >= 9 : major === 26 && minor >= 5;
    const abiOk = legacy ? process.versions.modules === "141" : process.versions.modules === "147";
    if (!versionOk || !abiOk || process.versions.napi !== "10" ||
        process.platform !== expectedPlatform || process.arch !== expectedArch) process.exit(1);
  ' "$OS" "$ARCH" "$2" >/dev/null 2>&1
}

bootstrap_modern_node() {
  case "${OS}-${ARCH}" in
    linux-x64)
      NODE_DIST_FILE="node-v26.12.1-linux-x64.tar.gz"
      NODE_DIST_SHA="0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132"
      NODE_DIST_BYTES=62907493
      NODE_COMPAT_FILE="agenc-node-bootstrap-libatomic-linux-x64.tar.gz"
      NODE_COMPAT_SHA="1f7bafeb33c504e59e0143d917354f70d40989e286e651ecabafbb9ad4c31833"
      NODE_COMPAT_BYTES=26074
      NODE_COMPAT_LIBRARY_SHA="5d7b55b28da42d1f298277089903a3eca81610b6aed627fc25270353ff24cbbd"
      NODE_COMPAT_LIBRARY_BYTES=28920
      ;;
    linux-arm64)
      NODE_DIST_FILE="node-v26.12.1-linux-arm64.tar.gz"
      NODE_DIST_SHA="a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f"
      NODE_DIST_BYTES=62602144
      NODE_COMPAT_FILE="agenc-node-bootstrap-libatomic-linux-arm64.tar.gz"
      NODE_COMPAT_SHA="327f0db1f8b6f2c2d787a1d95e20a76f0b94146785d1499f1d23c50186ad9d13"
      NODE_COMPAT_BYTES=27660
      NODE_COMPAT_LIBRARY_SHA="d3c76f7e4ef68232200c8d4ee91c91162b06a952d3a81afdab9b7ad379185dd2"
      NODE_COMPAT_LIBRARY_BYTES=70232
      ;;
    darwin-x64)
      NODE_DIST_FILE="node-v26.12.1-darwin-x64.tar.gz"
      NODE_DIST_SHA="b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff"
      NODE_DIST_BYTES=59800211
      ;;
    darwin-arm64)
      NODE_DIST_FILE="node-v26.12.1-darwin-arm64.tar.gz"
      NODE_DIST_SHA="1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8"
      NODE_DIST_BYTES=58334853
      ;;
    *) fail "no pinned Node.js bootstrap distribution for ${OS}-${ARCH}" ;;
  esac
  for tool in /usr/bin/tar /usr/bin/wc; do
    [ -x "$tool" ] || fail "trusted bootstrap tool is unavailable: $tool"
  done
  if [ -x /usr/bin/sha256sum ]; then
    NODE_SHA_TOOL=/usr/bin/sha256sum
  elif [ -x /usr/bin/shasum ]; then
    NODE_SHA_TOOL=/usr/bin/shasum
  else
    fail "a trusted operating-system SHA-256 tool is required"
  fi
  BOOTSTRAP_PARENT="${TMPDIR:-/tmp}"
  [ -d "$BOOTSTRAP_PARENT" ] || fail "bootstrap temporary parent is unavailable"
  BOOTSTRAP_WORK="$(/usr/bin/mktemp -d "${BOOTSTRAP_PARENT%/}/agenc-node-bootstrap.XXXXXX")" ||
    fail "could not create private Node bootstrap directory"
  /bin/chmod 700 "$BOOTSTRAP_WORK" ||
    fail "could not secure private Node bootstrap directory"
  if [ "$OS" = linux ]; then
    NODE_COMPAT_ARCHIVE="${BOOTSTRAP_WORK}/${NODE_COMPAT_FILE}"
    if [ -n "${AGENC_INSTALL_BOOTSTRAP_LIBATOMIC_ARCHIVE:-}" ]; then
      case "$AGENC_INSTALL_BOOTSTRAP_LIBATOMIC_ARCHIVE" in
        /*) : ;;
        *) fail "AGENC_INSTALL_BOOTSTRAP_LIBATOMIC_ARCHIVE must be an absolute path" ;;
      esac
      [ -f "$AGENC_INSTALL_BOOTSTRAP_LIBATOMIC_ARCHIVE" ] &&
        [ ! -L "$AGENC_INSTALL_BOOTSTRAP_LIBATOMIC_ARCHIVE" ] ||
        fail "pinned local Node compatibility archive is not a regular file"
      /bin/cp "$AGENC_INSTALL_BOOTSTRAP_LIBATOMIC_ARCHIVE" "$NODE_COMPAT_ARCHIVE" ||
        fail "could not copy pinned local Node compatibility archive"
    else
      [ -x /usr/bin/curl ] ||
        fail "the trusted operating-system curl executable is required to bootstrap Node.js"
      NODE_COMPAT_URL="https://github.com/tetsuo-ai/agenc-releases/releases/download/${NODE_COMPAT_RELEASE_TAG}/${NODE_COMPAT_FILE}"
      /usr/bin/curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
        --max-time 120 --max-filesize "$NODE_COMPAT_BYTES" \
        --output "$NODE_COMPAT_ARCHIVE" "$NODE_COMPAT_URL" ||
        fail "could not download pinned Node.js compatibility payload"
    fi
    NODE_COMPAT_ACTUAL_BYTES="$(/usr/bin/wc -c < "$NODE_COMPAT_ARCHIVE")"
    [ "$NODE_COMPAT_ACTUAL_BYTES" -eq "$NODE_COMPAT_BYTES" ] 2>/dev/null ||
      fail "Node.js compatibility byte count mismatch (expected ${NODE_COMPAT_BYTES}, got ${NODE_COMPAT_ACTUAL_BYTES})"
    if [ "$NODE_SHA_TOOL" = /usr/bin/shasum ]; then
      set -- "$($NODE_SHA_TOOL -a 256 "$NODE_COMPAT_ARCHIVE")"
    else
      set -- "$($NODE_SHA_TOOL "$NODE_COMPAT_ARCHIVE")"
    fi
    NODE_COMPAT_ACTUAL_SHA="${1%% *}"
    [ "$NODE_COMPAT_ACTUAL_SHA" = "$NODE_COMPAT_SHA" ] ||
      fail "Node.js compatibility checksum mismatch"
    NODE_COMPAT_MEMBERS="$(/usr/bin/tar -tzf "$NODE_COMPAT_ARCHIVE")" ||
      fail "could not inspect pinned Node.js compatibility payload"
    [ "$NODE_COMPAT_MEMBERS" = "LICENSES/
LICENSES/COPYING.RUNTIME
LICENSES/COPYING3
lib/
lib/libatomic.so.1" ] ||
      fail "Node.js compatibility archive member contract is invalid"
    NODE_COMPAT_MODES=""
    while IFS= read -r NODE_COMPAT_ENTRY; do
      NODE_COMPAT_MODE="${NODE_COMPAT_ENTRY%% *}"
      NODE_COMPAT_MODES="${NODE_COMPAT_MODES}${NODE_COMPAT_MODE}|"
    done <<EOF
$(/usr/bin/tar -tvzf "$NODE_COMPAT_ARCHIVE")
EOF
    [ "$NODE_COMPAT_MODES" = "drwxr-xr-x|-rw-r--r--|-rw-r--r--|drwxr-xr-x|-rw-r--r--|" ] ||
      fail "Node.js compatibility archive contains an unsafe mode, link, or unsupported member"
    NODE_COMPAT_ROOT="${BOOTSTRAP_WORK}/compat"
    /bin/mkdir -m 700 "$NODE_COMPAT_ROOT" ||
      fail "could not create private Node.js compatibility root"
    /usr/bin/tar -xzf "$NODE_COMPAT_ARCHIVE" -C "$NODE_COMPAT_ROOT" ||
      fail "could not extract pinned Node.js compatibility payload"
    for NODE_COMPAT_PATH in \
      "$NODE_COMPAT_ROOT/LICENSES/COPYING.RUNTIME" \
      "$NODE_COMPAT_ROOT/LICENSES/COPYING3" \
      "$NODE_COMPAT_ROOT/lib/libatomic.so.1"; do
      [ -f "$NODE_COMPAT_PATH" ] && [ ! -L "$NODE_COMPAT_PATH" ] ||
        fail "Node.js compatibility payload is incomplete"
    done
    NODE_COMPAT_LIBRARY="$NODE_COMPAT_ROOT/lib/libatomic.so.1"
    NODE_COMPAT_LIBRARY_ACTUAL_BYTES="$(/usr/bin/wc -c < "$NODE_COMPAT_LIBRARY")"
    [ "$NODE_COMPAT_LIBRARY_ACTUAL_BYTES" -eq "$NODE_COMPAT_LIBRARY_BYTES" ] 2>/dev/null ||
      fail "Node.js compatibility library byte count mismatch"
    if [ "$NODE_SHA_TOOL" = /usr/bin/shasum ]; then
      set -- "$($NODE_SHA_TOOL -a 256 "$NODE_COMPAT_LIBRARY")"
    else
      set -- "$($NODE_SHA_TOOL "$NODE_COMPAT_LIBRARY")"
    fi
    [ "${1%% *}" = "$NODE_COMPAT_LIBRARY_SHA" ] ||
      fail "Node.js compatibility library checksum mismatch"
    /bin/chmod 700 "$NODE_COMPAT_ROOT" "$NODE_COMPAT_ROOT/LICENSES" "$NODE_COMPAT_ROOT/lib"
    /bin/chmod 600 "$NODE_COMPAT_ROOT/LICENSES/COPYING.RUNTIME" \
      "$NODE_COMPAT_ROOT/LICENSES/COPYING3" "$NODE_COMPAT_LIBRARY"
    LD_LIBRARY_PATH="$NODE_COMPAT_ROOT/lib"
    export LD_LIBRARY_PATH
  fi
  NODE_DIST_ARCHIVE="${BOOTSTRAP_WORK}/${NODE_DIST_FILE}"
  if [ -n "${AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE:-}" ]; then
    case "$AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE" in
      /*) : ;;
      *) fail "AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE must be an absolute path" ;;
    esac
    [ -f "$AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE" ] &&
      [ ! -L "$AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE" ] ||
      fail "pinned local Node bootstrap archive is not a regular file"
    /bin/cp "$AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE" "$NODE_DIST_ARCHIVE" ||
      fail "could not copy pinned local Node bootstrap archive"
  else
    [ -x /usr/bin/curl ] ||
      fail "the trusted operating-system curl executable is required to bootstrap Node.js"
    NODE_DIST_URL="https://nodejs.org/dist/v${SUPPORTED_NODE_VERSION}/${NODE_DIST_FILE}"
    /usr/bin/curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
      --max-time 120 --max-filesize "$NODE_DIST_BYTES" \
      --output "$NODE_DIST_ARCHIVE" "$NODE_DIST_URL" ||
      fail "could not download pinned Node.js ${SUPPORTED_NODE_VERSION} bootstrap"
  fi
  NODE_DIST_ACTUAL_BYTES="$(/usr/bin/wc -c < "$NODE_DIST_ARCHIVE")"
  [ "$NODE_DIST_ACTUAL_BYTES" -eq "$NODE_DIST_BYTES" ] 2>/dev/null ||
    fail "Node.js bootstrap byte count mismatch (expected ${NODE_DIST_BYTES}, got ${NODE_DIST_ACTUAL_BYTES})"
  if [ "$NODE_SHA_TOOL" = /usr/bin/shasum ]; then
    set -- "$($NODE_SHA_TOOL -a 256 "$NODE_DIST_ARCHIVE")"
  else
    set -- "$($NODE_SHA_TOOL "$NODE_DIST_ARCHIVE")"
  fi
  NODE_DIST_ACTUAL_SHA="${1%% *}"
  [ "$NODE_DIST_ACTUAL_SHA" = "$NODE_DIST_SHA" ] ||
    fail "Node.js bootstrap checksum mismatch"
  /usr/bin/tar -xzf "$NODE_DIST_ARCHIVE" -C "$BOOTSTRAP_WORK" ||
    fail "could not extract pinned Node.js bootstrap"
  BOOTSTRAP_NODE="${BOOTSTRAP_WORK}/${NODE_DIST_FILE%.tar.gz}/bin/node"
  [ -x "$BOOTSTRAP_NODE" ] || fail "pinned Node.js bootstrap executable is missing"
  "$BOOTSTRAP_NODE" -e '
    if (process.versions.node !== "26.12.1" || process.versions.modules !== "147" ||
        process.versions.napi !== "10" || process.platform !== process.argv[1] ||
        process.arch !== process.argv[2]) process.exit(1);
  ' "$OS" "$ARCH" >/dev/null 2>&1 ||
    fail "pinned Node.js bootstrap identity is invalid"
  PATH="${BOOTSTRAP_NODE%/node}:${PATH}"
  export PATH
  step "using private Node.js ${SUPPORTED_NODE_VERSION} bootstrap for ${OS}-${ARCH}" \
    "Node.js ${SUPPORTED_NODE_VERSION} bootstrap" "${OS}-${ARCH}"
}

if [ "$PIN_VERSION" = "0.7.2" ]; then
  command -v node >/dev/null 2>&1 ||
    fail "The frozen v0.7.2 bridge requires Node.js >=25.9 <26 on the host (ABI 141 / N-API 10)."
  LEGACY_NODE="$(command -v node)"
  node_contract "$LEGACY_NODE" legacy ||
    fail "The frozen v0.7.2 bridge requires Node.js >=25.9 <26 on the host (ABI 141 / N-API 10), found $("$LEGACY_NODE" -v 2>/dev/null || printf unknown)."
else
  HOST_NODE="$(command -v node 2>/dev/null || true)"
  if [ -z "$HOST_NODE" ] || ! node_contract "$HOST_NODE" modern; then
    bootstrap_modern_node
  fi
fi

NODE_BIN="$(command -v node)"
NODE_BIN="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$NODE_BIN")" ||
  fail "could not resolve bootstrap Node.js executable"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" ||
  fail "could not determine Node.js version"
NODE_MODULE_ABI="$(node -e 'process.stdout.write(String(process.versions.modules))')" ||
  fail "could not determine the Node.js native module ABI"
case "$NODE_MODULE_ABI" in
  ''|*[!0-9]*) fail "Node.js reported an invalid native module ABI: ${NODE_MODULE_ABI}" ;;
esac
resolve_system_tool() {
  # Deliberately does NOT require nlink === 1, unlike the checks covering
  # artifacts this installer downloads into its own private tree. macOS ships
  # /usr/bin/unzip and /usr/bin/zipinfo as two names for a single inode, so a
  # stock system tool legitimately reports nlink 2 and no user can change it:
  # /usr/bin is immutable under SIP. Requiring a single link therefore made
  # every macOS install fail once the pinned gh archive is a zip.
  #
  # The guarantee is preserved by the checks that remain: the file is
  # root-owned, not group/other writable, and every parent directory up to the
  # root is likewise root-owned and not group/other writable. An extra hard
  # link cannot be created inside such a tree by a non-root user, and a link
  # made elsewhere still cannot alter the root-owned inode's contents.
  node -e '
    const { lstatSync, realpathSync, statSync } = require("node:fs");
    const { dirname, isAbsolute } = require("node:path");
    for (const candidate of process.argv.slice(1)) {
      if (!candidate || !isAbsolute(candidate)) continue;
      try {
        const path = realpathSync(candidate);
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink() ||
            (file.mode & 0o111) === 0 || (file.mode & 0o022) !== 0 || file.uid !== 0) continue;
        let parent = dirname(path);
        let trusted = true;
        while (true) {
          const metadata = statSync(parent);
          if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
            trusted = false;
            break;
          }
          const next = dirname(parent);
          if (next === parent) break;
          parent = next;
        }
        if (trusted) {
          process.stdout.write(path);
          process.exit(0);
        }
      } catch { /* try the next system location */ }
    }
    process.exit(1);
  ' "$@"
}
PATH_TAR="$(command -v tar 2>/dev/null || true)"
SYSTEM_TAR="$(resolve_system_tool /usr/bin/tar /bin/tar "$PATH_TAR")" || \
  fail "a root-owned, single-link, non-writable tar executable under trusted system directories is required"
node -e '
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.argv[1]) || /[\r\n]/.test(process.argv[1])) process.exit(1);
' "$REPO" || fail "release repository must be an owner/name using URL-safe characters"
if [ -n "$PIN_VERSION" ]; then
  node -e '
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(process.argv[1]) || /[\r\n]/.test(process.argv[1])) process.exit(1);
  ' "$PIN_VERSION" || fail "--version must be a canonical semantic version"
  node -e '
    const version = process.argv[1];
    if (version === "0.7.2") process.exit(0);
    const actual = version.split("-", 1)[0].split(".").map(BigInt);
    const minimum = [0n, 11n, 2n];
    for (let index = 0; index < minimum.length; index += 1) {
      if (actual[index] > minimum[index]) process.exit(0);
      if (actual[index] < minimum[index]) process.exit(1);
    }
    process.exit(0);
  ' "$PIN_VERSION" || fail \
    "runtime ${PIN_VERSION} has no supported standalone activation contract; use the frozen 0.7.2 bridge with host Node 25.9, or 0.11.2 and newer with private Node"
fi

# --- platform ----------------------------------------------------------------

SYSTEM_UNZIP=""

# --- fetch helpers (file:// and plain paths supported for testability) -------

fetch_to() {
  # fetch_to <url> <dest> <maximum-bytes> <exact-bytes-or-empty> <trust-mode>
  node - "$1" "$2" "$3" "$4" "$5" <<'AGENC_BOUNDED_FETCH'
const {
  closeSync,
  constants: fsConstants,
  createReadStream,
  createWriteStream,
  fstatSync,
  lstatSync,
  openSync,
  rmSync,
} = require("node:fs");
const { posix, win32 } = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { fileURLToPath, pathToFileURL } = require("node:url");
const [resource, destination, maximumText, exactText, trustMode] = process.argv.slice(2);
const maximum = Number(maximumText);
const exact = exactText === "" ? undefined : Number(exactText);
if (!Number.isSafeInteger(maximum) || maximum < 1 ||
    (exact !== undefined && (!Number.isSafeInteger(exact) || exact < 1 || exact > maximum))) {
  throw new Error("invalid bounded-download byte contract");
}
// The total deadline scales with the declared artifact size so slow links can
// finish: a fixed 120s ceiling made any connection under ~1 MiB/s permanently
// unable to download a ~120 MiB runtime. A byzantine server stays bounded by
// the declared size at the minimum sustained rate (256 MiB ceiling at
// 128 KiB/s is ~34 minutes worst case), undeclared sizes (manifests, bundles)
// keep the 120s bound, and the stall detector below kills dead connections
// long before either deadline. The test overrides can only shorten.
const MINIMUM_SUSTAINED_BYTES_PER_SECOND = 131_072;
const defaultTimeoutMs = exact === undefined ? 120_000 : Math.max(
  120_000,
  Math.ceil(exact / MINIMUM_SUSTAINED_BYTES_PER_SECOND) * 1000 + 30_000,
);
const timeoutText = process.env.AGENC_INSTALL_TEST_DOWNLOAD_TIMEOUT_MS;
const timeoutMs = timeoutText === undefined ? defaultTimeoutMs : Number(timeoutText);
const stallText = process.env.AGENC_INSTALL_TEST_DOWNLOAD_STALL_MS;
const stallMs = stallText === undefined ? 60_000 : Number(stallText);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultTimeoutMs ||
    !Number.isSafeInteger(stallMs) || stallMs < 1 || stallMs > 60_000) {
  throw new Error("invalid bounded-download deadline contract");
}

function canonicalLocalFileUrlToPath(value, platform = process.platform) {
  if (typeof value !== "string" || value !== value.trim() || /[\0\r\n]/.test(value) ||
      !value.startsWith("file:///")) {
    throw new Error("local resource URL must be an authority-free file URL");
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("local resource URL is invalid"); }
  if (parsed.protocol !== "file:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.host !== "") throw new Error("local resource URL must not contain an authority");
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("local resource URL must not contain a query or fragment");
  }
  if (parsed.href !== value) throw new Error("local resource URL is not canonical");
  let decoded;
  try { decoded = decodeURIComponent(parsed.pathname); }
  catch { throw new Error("local resource URL has invalid path encoding"); }
  if (decoded.includes("\0")) throw new Error("local resource URL contains a NUL byte");
  if (decoded.startsWith("//")) throw new Error("local resource URL must not use a UNC path");
  const namespaceProbe = decoded.slice(1).replaceAll("/", "\\");
  if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(namespaceProbe)) {
    throw new Error("local resource URL must not use a device namespace");
  }
  if (/^\/[A-Za-z]:(?:$|[^/])/.test(decoded)) {
    throw new Error("local resource URL must not use a drive-relative path");
  }
  const windows = platform === "win32";
  let path;
  try { path = fileURLToPath(parsed, { windows }); }
  catch { throw new Error("local resource URL is invalid for this platform"); }
  if (windows) {
    if (!win32.isAbsolute(path) || !/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) {
      throw new Error("local resource URL must contain an absolute drive path");
    }
    if (path.slice(2).includes(":")) {
      throw new Error("local resource URL must not use an alternate data stream");
    }
  } else if (!posix.isAbsolute(path) || path.startsWith("//")) {
    throw new Error("local resource URL must contain an absolute POSIX path");
  }
  if (pathToFileURL(path, { windows }).href !== value) {
    throw new Error("local resource URL does not round-trip canonically");
  }
  return path;
}

// Progress is reported from the byte counter that already exists for the size
// contract, so the bar shows transferred bytes against the manifest's declared
// exact size -- not an estimate, and not a second measurement that could
// disagree with the one enforcement uses. It renders only when the shell saw a
// stderr TTY (AGENC_INSTALL_PROGRESS=1) and only when that exact size is known;
// a redirected stderr therefore stays byte-identical to the plain log.
const progressStyle = process.env.AGENC_INSTALL_PROGRESS ?? "";
const progressEnabled = progressStyle === "unicode" || progressStyle === "ascii";
function renderProgress(count, total, done) {
  const ratio = total > 0 ? Math.min(count / total, 1) : 0;
  const cells = 24;
  const filled = Math.round(ratio * cells);
  const [full, empty] = progressStyle === "ascii" ? ["#", "-"] : ["█", "░"];
  const bar = full.repeat(filled) + empty.repeat(cells - filled);
  const mib = (value) => (value / 1048576).toFixed(1);
  const line = `  ${progressStyle === "ascii" ? "-" : "⋯"} Downloading runtime ${bar} ${String(Math.round(ratio * 100)).padStart(3)}%` +
    `  ${mib(count)}/${mib(total)} MiB`;
  process.stderr.write(`\u001b[2K\r${line}${done ? "\n" : ""}`);
}

function byteLimiter(onChunk) {
  let count = 0;
  let lastRender = 0;
  const reportable = progressEnabled && exact !== undefined;
  return new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (onChunk !== undefined) onChunk();
      if (count > maximum) {
        callback(new Error(`download exceeds ${maximum} byte limit`));
      } else if (exact !== undefined && count > exact) {
        callback(new Error(`download exceeds declared ${exact} bytes`));
      } else {
        if (reportable) {
          // Throttled: a 60 MiB artifact arrives in thousands of chunks, and
          // redrawing on each one costs more than the download.
          const now = Date.now();
          if (now - lastRender >= 80) {
            lastRender = now;
            renderProgress(count, exact, false);
          }
        }
        callback(null, chunk);
      }
    },
    flush(callback) {
      if (exact !== undefined && count !== exact) {
        callback(new Error(`download byte count mismatch (expected ${exact}, got ${count})`));
      } else {
        // Leave the line at 100% for the shell's step() to overwrite; clearing
        // it here would flicker between the two writers.
        if (reportable) renderProgress(count, exact, false);
        callback();
      }
    },
  });
}

function contentLength(response) {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid Content-Length");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid Content-Length");
  if (parsed > maximum) throw new Error(`Content-Length exceeds ${maximum} byte limit`);
  if (exact !== undefined && parsed !== exact) {
    throw new Error(`Content-Length mismatch (expected ${exact}, got ${parsed})`);
  }
  return parsed;
}

(async () => {
  try {
    let sourcePath;
    if (trustMode === "explicitLocal") {
      if (/^file:/i.test(resource)) sourcePath = canonicalLocalFileUrlToPath(resource);
      else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(resource)) {
        throw new Error("explicit local resources must use file URLs or paths");
      } else sourcePath = resource;
    } else if (!/^https:/i.test(resource)) {
      throw new Error("remote resources must use HTTPS");
    }
    if (sourcePath !== undefined) {
      const metadata = lstatSync(sourcePath, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
        throw new Error("local resource must be a regular single-link file");
      }
      if (metadata.size > BigInt(maximum)) throw new Error(`local resource exceeds ${maximum} byte limit`);
      if (exact !== undefined && metadata.size !== BigInt(exact)) {
        throw new Error(`local resource byte count mismatch (expected ${exact}, got ${metadata.size})`);
      }
      let descriptor;
      try {
        descriptor = openSync(
          sourcePath,
          fsConstants.O_RDONLY |
            (fsConstants.O_NOFOLLOW ?? 0) |
            (fsConstants.O_NONBLOCK ?? 0),
        );
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n ||
            opened.dev !== metadata.dev || opened.ino !== metadata.ino ||
            opened.size !== metadata.size || opened.mtimeNs !== metadata.mtimeNs ||
            opened.ctimeNs !== metadata.ctimeNs) {
          throw new Error("local resource changed while it was opened");
        }
        await pipeline(
          createReadStream(sourcePath, { fd: descriptor, autoClose: false }),
          byteLimiter(),
          createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        );
        const after = fstatSync(descriptor, { bigint: true });
        const pathAfter = lstatSync(sourcePath, { bigint: true });
        if (!after.isFile() || after.nlink !== 1n ||
            after.dev !== opened.dev || after.ino !== opened.ino ||
            after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
            after.ctimeNs !== opened.ctimeNs || pathAfter.dev !== opened.dev ||
            !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
            pathAfter.ino !== opened.ino || pathAfter.size !== opened.size ||
            pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
            pathAfter.nlink !== 1n) {
          throw new Error("local resource identity changed while it was read");
        }
      } finally {
        if (descriptor !== undefined) {
          try { closeSync(descriptor); } catch { /* preserve the transfer error */ }
        }
      }
      return;
    }
    let current = new URL(resource);
    const controller = new AbortController();
    const timeoutError = new Error(`download deadline exceeded after ${timeoutMs}ms`);
    const stallError = new Error(`download stalled: no bytes received for ${stallMs}ms`);
    const abortError = () =>
      controller.signal.reason instanceof Error ? controller.signal.reason : timeoutError;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    // One stall window covers connect, TLS, headers, every redirect hop, and
    // each gap between body chunks; only delivered bytes rearm it.
    let lastProgressAt = performance.now();
    const stallTimer = setInterval(() => {
      if (performance.now() - lastProgressAt >= stallMs) controller.abort(stallError);
    }, Math.min(stallMs, 500));
    const throwIfExpired = () => {
      if (controller.signal.aborted) throw abortError();
      if (performance.now() >= deadline) {
        controller.abort(timeoutError);
        throw timeoutError;
      }
    };
    const withinDeadline = async (promise) => {
      throwIfExpired();
      let rejectOnAbort;
      const aborted = new Promise((_resolve, reject) => {
        rejectOnAbort = () => reject(abortError());
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      try { return await Promise.race([promise, aborted]); }
      finally { controller.signal.removeEventListener("abort", rejectOnAbort); }
    };
    try {
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        throwIfExpired();
        if (current.protocol !== "https:") throw new Error(`refusing non-HTTPS URL: ${current}`);
        let response;
        try {
          response = await fetch(current, {
            redirect: "manual",
            signal: controller.signal,
            headers: { "accept-encoding": "identity" },
          });
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          throw error;
        }
        throwIfExpired();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new Error(`redirect missing Location: ${current}`);
          await withinDeadline(response.body?.cancel() ?? Promise.resolve());
          throwIfExpired();
          current = new URL(location, current);
          continue;
        }
        if (!response.ok || response.body === null) {
          await withinDeadline(response.body?.cancel() ?? Promise.resolve());
          throw new Error(`download failed ${response.status} ${response.statusText}: ${current}`);
        }
        const encoding = response.headers.get("content-encoding");
        if (encoding !== null && encoding !== "identity") {
          await withinDeadline(response.body.cancel());
          throw new Error("download response must use identity encoding");
        }
        contentLength(response);
        try {
          await pipeline(
            Readable.fromWeb(response.body),
            byteLimiter(() => { lastProgressAt = performance.now(); }),
            createWriteStream(destination, { flags: "wx", mode: 0o600 }),
            { signal: controller.signal },
          );
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          throw error;
        }
        throwIfExpired();
        return;
      }
      throw new Error("too many HTTPS redirects");
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(stallTimer);
    }
  } catch (error) {
    try { rmSync(destination, { force: true }); } catch {}
    throw error;
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
AGENC_BOUNDED_FETCH
}

sha256_of() {
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

verify_official_provenance() {
  # Official modern releases are authenticated back to the hosted source
  # workflow. Mirrors and explicit local inputs intentionally retain their
  # explicit-trust contract, and the frozen v0.7.2 bridge remains unchanged.
  [ "$MANIFEST_TRUST" = "official" ] || return 0
  [ -n "$SOURCE_COMMIT" ] && [ -n "$SOURCE_REF" ] || {
    log "official manifest did not provide source provenance"
    return 1
  }

  GH_VERSION="2.96.0"
  case "${OS}-${ARCH}" in
    linux-x64)
      GH_FILE="gh_${GH_VERSION}_linux_amd64.tar.gz"
      GH_SHA="83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60"
      GH_BYTES=14652560
      GH_KIND="tar"
      ;;
    linux-arm64)
      GH_FILE="gh_${GH_VERSION}_linux_arm64.tar.gz"
      GH_SHA="06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909"
      GH_BYTES=13321232
      GH_KIND="tar"
      ;;
    darwin-x64)
      GH_FILE="gh_${GH_VERSION}_macOS_amd64.zip"
      GH_SHA="4bd449df9ad639391bc62b8032546f0fe9edcd8526e06682a4f88abd8c5d163c"
      GH_BYTES=15298430
      GH_KIND="zip"
      ;;
    darwin-arm64)
      GH_FILE="gh_${GH_VERSION}_macOS_arm64.zip"
      GH_SHA="f23a0c37d963aacc3bed703ccbd59b41c5ca22101fab7f00eb2b7cad23aba463"
      GH_BYTES=13950131
      GH_KIND="zip"
      ;;
    *) log "no pinned GitHub CLI for ${OS}-${ARCH}"; return 1 ;;
  esac

  GH_ARCHIVE="$WORK/$GH_FILE"
  GH_ROOT="$WORK/gh-verify"
  GH_CONFIG_ROOT="$WORK/gh-config"
  GH_DIR="${GH_FILE%.tar.gz}"
  GH_DIR="${GH_DIR%.zip}"
  GH_BIN="$GH_ROOT/$GH_DIR/bin/gh"
  BUNDLE="$WORK/runtime.sigstore.json"
  BUNDLE_URL="$ARTIFACT_ATTESTATION_URL"
  BUILD_BUNDLE="$WORK/runtime.build.sigstore.json"
  BUILD_BUNDLE_URL="$ARTIFACT_BUILD_PROVENANCE_URL"
  GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_FILE}"

  fetch_to "$BUNDLE_URL" "$BUNDLE" "$MAX_SIGSTORE_BUNDLE_BYTES" \
    "$ARTIFACT_ATTESTATION_BYTES" "official" || {
    log "could not fetch bounded official Sigstore bundle: ${BUNDLE_URL}"
    return 1
  }
  ACTUAL_BUNDLE_SHA="$(sha256_of "$BUNDLE")" || return 1
  if [ "$ACTUAL_BUNDLE_SHA" != "$ARTIFACT_ATTESTATION_SHA" ]; then
    log "Sigstore bundle checksum mismatch (expected ${ARTIFACT_ATTESTATION_SHA}, got ${ACTUAL_BUNDLE_SHA})"
    return 1
  fi
  ACTUAL_BUILD_BUNDLE_SHA=""
  if [ -n "$BUILD_BUNDLE_URL" ]; then
    fetch_to "$BUILD_BUNDLE_URL" "$BUILD_BUNDLE" "$MAX_SIGSTORE_BUNDLE_BYTES" \
      "$ARTIFACT_BUILD_PROVENANCE_BYTES" "official" || {
      log "could not fetch bounded native-build Sigstore bundle: ${BUILD_BUNDLE_URL}"
      return 1
    }
    ACTUAL_BUILD_BUNDLE_SHA="$(sha256_of "$BUILD_BUNDLE")" || return 1
    if [ "$ACTUAL_BUILD_BUNDLE_SHA" != "$ARTIFACT_BUILD_PROVENANCE_SHA" ]; then
      log "native-build Sigstore bundle checksum mismatch (expected ${ARTIFACT_BUILD_PROVENANCE_SHA}, got ${ACTUAL_BUILD_BUNDLE_SHA})"
      return 1
    fi
  fi
  fetch_to "$GH_URL" "$GH_ARCHIVE" "$MAX_GH_ARCHIVE_BYTES" "$GH_BYTES" "official" || {
    log "could not fetch pinned GitHub CLI: ${GH_URL}"
    return 1
  }
  ACTUAL_GH_SHA="$(sha256_of "$GH_ARCHIVE")" || return 1
  if [ "$ACTUAL_GH_SHA" != "$GH_SHA" ]; then
    log "GitHub CLI checksum mismatch (expected ${GH_SHA}, got ${ACTUAL_GH_SHA})"
    return 1
  fi
  mkdir -m 700 "$GH_ROOT" "$GH_CONFIG_ROOT" || return 1
  if [ "$GH_KIND" = "tar" ]; then
    "$SYSTEM_TAR" -xzf "$GH_ARCHIVE" -C "$GH_ROOT" "$GH_DIR/bin/gh" || return 1
  else
    PATH_UNZIP="$(command -v unzip 2>/dev/null || true)"
    SYSTEM_UNZIP="$(resolve_system_tool /usr/bin/unzip /bin/unzip "$PATH_UNZIP")" || {
      log "a root-owned, single-link, non-writable unzip executable under trusted system directories is required"
      return 1
    }
    "$SYSTEM_UNZIP" -qq "$GH_ARCHIVE" "$GH_DIR/bin/gh" -d "$GH_ROOT" || return 1
  fi
  [ -f "$GH_BIN" ] && [ ! -L "$GH_BIN" ] || {
    log "pinned GitHub CLI archive did not contain the expected regular file"
    return 1
  }
  chmod 700 "$GH_BIN" || return 1

  if [ -n "$BUILD_BUNDLE_URL" ]; then
    if [ "$UI" = 1 ]; then step_begin "Verifying native-build provenance"
    else log "verifying native-build provenance for ${ARTIFACT_URL}"; fi
    GH_CONFIG_DIR="$GH_CONFIG_ROOT" GH_TOKEN= GITHUB_TOKEN= GH_ENTERPRISE_TOKEN= \
      GITHUB_ENTERPRISE_TOKEN= GH_PROMPT_DISABLED=true GH_NO_UPDATE_NOTIFIER=1 \
      GH_TELEMETRY=0 DO_NOT_TRACK=1 GH_SPINNER_DISABLED=1 GH_DEBUG= GH_PAGER= PAGER= \
      "$GH_BIN" attestation verify "$TARBALL" \
      --bundle "$BUILD_BUNDLE" \
      --repo "$PROVENANCE_REPOSITORY" \
      --signer-workflow "$PROVENANCE_WORKFLOW" \
      --signer-digest "$SOURCE_COMMIT" \
      --source-digest "$SOURCE_COMMIT" \
      --source-ref "refs/heads/main" \
      --hostname "$PROVENANCE_HOSTNAME" \
      --cert-oidc-issuer "$PROVENANCE_OIDC_ISSUER" \
      --predicate-type "$PROVENANCE_PREDICATE_TYPE" \
      --deny-self-hosted-runners >/dev/null || return 1
  fi

  if [ "$UI" = 1 ]; then step_begin "Verifying tag-promotion provenance"
  else log "verifying tag-promotion provenance for ${ARTIFACT_URL}"; fi
  GH_CONFIG_DIR="$GH_CONFIG_ROOT" GH_TOKEN= GITHUB_TOKEN= GH_ENTERPRISE_TOKEN= \
    GITHUB_ENTERPRISE_TOKEN= GH_PROMPT_DISABLED=true GH_NO_UPDATE_NOTIFIER=1 \
    GH_TELEMETRY=0 DO_NOT_TRACK=1 GH_SPINNER_DISABLED=1 GH_DEBUG= GH_PAGER= PAGER= \
    "$GH_BIN" attestation verify "$TARBALL" \
    --bundle "$BUNDLE" \
    --repo "$PROVENANCE_REPOSITORY" \
    --signer-workflow "$PROVENANCE_WORKFLOW" \
    --signer-digest "$SOURCE_COMMIT" \
    --source-digest "$SOURCE_COMMIT" \
    --source-ref "$SOURCE_REF" \
    --hostname "$PROVENANCE_HOSTNAME" \
    --cert-oidc-issuer "$PROVENANCE_OIDC_ISSUER" \
    --predicate-type "$PROVENANCE_PREDICATE_TYPE" \
    --deny-self-hosted-runners >/dev/null || return 1

  [ "$(sha256_of "$TARBALL")" = "$ARTIFACT_SHA" ] || {
    log "runtime tarball changed during provenance verification"
    return 1
  }
  [ "$(sha256_of "$BUNDLE")" = "$ACTUAL_BUNDLE_SHA" ] || {
    log "Sigstore bundle changed during provenance verification"
    return 1
  }
  if [ -n "$BUILD_BUNDLE_URL" ] &&
     [ "$(sha256_of "$BUILD_BUNDLE")" != "$ACTUAL_BUILD_BUNDLE_SHA" ]; then
    log "native-build Sigstore bundle changed during provenance verification"
    return 1
  fi
  PROVENANCE_RECEIPT_BASE64="$PROVENANCE_EXPECTATION_BASE64"

  rm -f "$BUNDLE" "$BUILD_BUNDLE" "$GH_ARCHIVE"
  rm -rf "$GH_ROOT" "$GH_CONFIG_ROOT"
  if [ -n "$BUILD_BUNDLE_URL" ]; then
    step "native-build and tag-promotion provenance verified" \
      "Provenance verified" "native-build + tag-promotion"
  else
    step "tag-promotion provenance verified" "Provenance verified" "tag-promotion"
  fi
}

# --- resolve manifest --------------------------------------------------------

AGENC_HOME_DIR="${AGENC_HOME:-${HOME}/.agenc}"
AGENC_HOME_DIR="$(node -e '
  const { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } = require("node:fs");
  const { isAbsolute, resolve } = require("node:path");
  const requested = process.argv[1];
  if (!isAbsolute(requested)) {
    throw new Error("AGENC_HOME must be an absolute path so its identity does not change with the working directory");
  }
  const absolute = resolve(requested);
  const existed = existsSync(absolute);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const requestedStat = lstatSync(absolute);
  if (!requestedStat.isDirectory() && !requestedStat.isSymbolicLink()) {
    throw new Error(`AGENC_HOME is not a directory: ${absolute}`);
  }
  if (!existed && requestedStat.isSymbolicLink()) {
    throw new Error(`newly created AGENC_HOME became a symlink: ${absolute}`);
  }
  const canonical = realpathSync(absolute);
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error(`canonical AGENC_HOME is not a real directory: ${canonical}`);
  }
  if (typeof process.getuid === "function") {
    if (canonicalStat.uid !== process.getuid()) {
      throw new Error(`AGENC_HOME is owned by another user: ${canonical}`);
    }
    chmodSync(canonical, 0o700);
  }
  process.stdout.write(canonical);
' "$AGENC_HOME_DIR")" || fail "could not establish canonical AGENC_HOME"
PREFIX="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$PREFIX")" || \
  fail "could not resolve install prefix"
INSTALL_TMP_ROOT="${AGENC_HOME_DIR}/.installer-tmp"
mkdir -p -m 700 "$INSTALL_TMP_ROOT" || fail "could not create private installer temporary root"
node -e '
  const { chmodSync, lstatSync } = require("node:fs");
  const stat = lstatSync(process.argv[1]);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) process.exit(1);
  chmodSync(process.argv[1], 0o700);
' "$INSTALL_TMP_ROOT" || fail "could not secure private installer temporary root"
WORK="$(mktemp -d "${INSTALL_TMP_ROOT}/agenc-install.XXXXXX")" || fail "mktemp failed"

if [ -z "$MANIFEST_URL" ]; then
  if [ "$PIN_VERSION" = "0.7.2" ]; then
    MANIFEST_URL="https://github.com/${REPO}/releases/download/agenc-v0.7.2/agenc-runtime-manifest.json"
  elif [ -n "$PIN_VERSION" ]; then
    MANIFEST_URL="https://github.com/${REPO}/releases/download/agenc-v${PIN_VERSION}/agenc-runtime-manifest-v2.json"
  else
    MANIFEST_URL="https://github.com/${REPO}/releases/latest/download/agenc-runtime-manifest-v2.json"
  fi
fi
EXPECTED_MANIFEST_REPO=""
if [ "$MANIFEST_EXPLICIT" -eq 0 ]; then
  EXPECTED_MANIFEST_REPO="$REPO"
fi

MANIFEST_TRUST=""
case "$MANIFEST_URL" in
  https://*)
    if [ "$REPO" = "$OFFICIAL_REPO" ] && [ "$MANIFEST_EXPLICIT" -eq 0 ] && \
       [ "$PIN_VERSION" = "0.7.2" ] && \
         [ "$MANIFEST_URL" = "https://github.com/${OFFICIAL_REPO}/releases/download/agenc-v0.7.2/agenc-runtime-manifest.json" ]; then
      MANIFEST_TRUST="officialLegacy"
    elif [ "$REPO" = "$OFFICIAL_REPO" ] && [ "$MANIFEST_EXPLICIT" -eq 0 ]; then
      MANIFEST_TRUST="official"
    else
      MANIFEST_TRUST="explicitHttps"
    fi
    ;;
  http://*) fail "refusing non-HTTPS manifest URL: $MANIFEST_URL" ;;
  *) MANIFEST_TRUST="explicitLocal" ;;
esac

if [ "$MANIFEST_TRUST" = "official" ]; then
  if [ -n "$PIN_VERSION" ]; then
    EXPECTED_MANIFEST_URL="https://github.com/${OFFICIAL_REPO}/releases/download/agenc-v${PIN_VERSION}/agenc-runtime-manifest-v2.json"
  else
    EXPECTED_MANIFEST_URL="https://github.com/${OFFICIAL_REPO}/releases/latest/download/agenc-runtime-manifest-v2.json"
  fi
  [ "$MANIFEST_URL" = "$EXPECTED_MANIFEST_URL" ] || fail "official manifest URL is not canonical"
fi

step_begin "Fetching release manifest"
step "fetching release manifest: ${MANIFEST_URL}" "Release manifest" "${REPO}"
MANIFEST_FILE="$WORK/manifest.json"
fetch_to "$MANIFEST_URL" "$MANIFEST_FILE" "$MAX_MANIFEST_BYTES" "" "$MANIFEST_TRUST" || \
  fail "could not fetch bounded manifest: ${MANIFEST_URL}"

# Select the artifact for this platform. Mirrors the launcher's selectArtifact.
SELECTED="$(node -e '
  const { readFileSync } = require("node:fs");
  const { basename, posix, win32 } = require("node:path");
  const { fileURLToPath, pathToFileURL } = require("node:url");
  const [file, os, arch, abi, manifestUrl, pinVersion, expectedRepo,
    expectedManifestRepo, trustMode,
    maximumArtifactBytes, maximumAttestationBytes] = process.argv.slice(1);
  const reject = (message, code = 4) => { console.error(message); process.exit(code); };
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } catch { reject("runtime manifest is not valid UTF-8", 2); }
  let m;
  try { m = JSON.parse(source); } catch { reject("runtime manifest is not valid JSON", 2); }
  if (m === null || typeof m !== "object" || Array.isArray(m)) reject("runtime manifest root is invalid", 2);
  const artifactCeiling = Number(maximumArtifactBytes);
  const attestationCeiling = Number(maximumAttestationBytes);
  const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const cleanString = (value) =>
    typeof value === "string" && value === value.trim() && !/[\0\r\n]/.test(value);
  const exactKeys = (value, keys) =>
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
  const canonicalLocalFileUrlToPath = (value, platform = process.platform) => {
    if (typeof value !== "string" || value !== value.trim() || /[\0\r\n]/.test(value) ||
        !value.startsWith("file:///")) {
      throw new Error("local artifact URL must be an authority-free file URL");
    }
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("local artifact URL is invalid"); }
    if (parsed.protocol !== "file:" || parsed.username !== "" || parsed.password !== "" ||
        parsed.host !== "") throw new Error("local artifact URL must not contain an authority");
    if (parsed.search !== "" || parsed.hash !== "") {
      throw new Error("local artifact URL must not contain a query or fragment");
    }
    if (parsed.href !== value) throw new Error("local artifact URL is not canonical");
    let decoded;
    try { decoded = decodeURIComponent(parsed.pathname); }
    catch { throw new Error("local artifact URL has invalid path encoding"); }
    if (decoded.includes("\0")) throw new Error("local artifact URL contains a NUL byte");
    if (decoded.startsWith("//")) throw new Error("local artifact URL must not use a UNC path");
    const namespaceProbe = decoded.slice(1).replaceAll("/", "\\");
    if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(namespaceProbe)) {
      throw new Error("local artifact URL must not use a device namespace");
    }
    if (/^\/[A-Za-z]:(?:$|[^/])/.test(decoded)) {
      throw new Error("local artifact URL must not use a drive-relative path");
    }
    const windows = platform === "win32";
    let path;
    try { path = fileURLToPath(parsed, { windows }); }
    catch { throw new Error("local artifact URL is invalid for this platform"); }
    if (windows) {
      if (!win32.isAbsolute(path) || !/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) {
        throw new Error("local artifact URL must contain an absolute drive path");
      }
      if (path.slice(2).includes(":")) {
        throw new Error("local artifact URL must not use an alternate data stream");
      }
    } else if (!posix.isAbsolute(path) || path.startsWith("//")) {
      throw new Error("local artifact URL must contain an absolute POSIX path");
    }
    if (pathToFileURL(path, { windows }).href !== value) {
      throw new Error("local artifact URL does not round-trip canonically");
    }
    return path;
  };
  let artifacts;
  const legacy = m.manifestVersion === 1;
  if (legacy) {
    const bridgeVersion = "0.7.2";
    const bridgeTag = "agenc-v0.7.2";
    const bridgePlatforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-x64"];
    const expectedManifest =
      `https://github.com/${expectedRepo}/releases/download/${bridgeTag}/agenc-runtime-manifest.json`;
    if (trustMode !== "officialLegacy" || manifestUrl !== expectedManifest || pinVersion !== bridgeVersion ||
        !exactKeys(m, ["manifestVersion", "runtimeVersion", "releaseRepository", "releaseTag", "artifacts"]) ||
        m.runtimeVersion !== bridgeVersion || m.releaseRepository !== expectedRepo || m.releaseTag !== bridgeTag ||
        !Array.isArray(m.artifacts) || m.artifacts.length !== bridgePlatforms.length) {
      reject("legacy manifest is not the exact frozen v0.7.2 bridge", 2);
    }
    artifacts = m.artifacts.map((artifact, index) => {
      const key = `${artifact?.platform}-${artifact?.arch}`;
      const expectedUrl = `https://github.com/${expectedRepo}/releases/download/${bridgeTag}/` +
        `agenc-runtime-${bridgeVersion}-${key}-node25-abi141.tar.gz`;
      if (bridgePlatforms[index] !== key ||
          !exactKeys(artifact, ["platform", "arch", "runtimeVersion", "url", "sha256", "bytes", "bins"]) ||
          !exactKeys(artifact?.bins, ["agenc"]) || artifact.runtimeVersion !== bridgeVersion ||
          artifact.url !== expectedUrl || !cleanString(artifact.sha256) ||
          !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > artifactCeiling ||
          artifact.bins.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc") {
        reject(`legacy manifest artifact is invalid: ${key}`, 2);
      }
      return {
        ...artifact,
        nodeMajor: 25,
        nodeModuleAbi: "141",
        nodeApiVersion: "10",
        ...(artifact.platform === "linux" ? {
          libcFamily: "glibc",
          minimumGlibcVersion: "2.28",
          minimumGlibcxxVersion: "3.4.25",
          minimumCxxAbiVersion: "1.3.11",
        } : {}),
        ...(artifact.platform === "darwin" ? { minimumMacosVersion: "13.5" } : {}),
      };
    });
  } else {
    if (m.manifestVersion !== 2) {
      reject(`unsupported runtime manifest version ${m.manifestVersion ?? "missing"}`, 2);
    }
    if (trustMode === "officialLegacy") {
      reject("legacy manifest URL did not return the exact frozen v0.7.2 bridge", 2);
    }
    if (!cleanString(m.runtimeVersion) || !versionPattern.test(m.runtimeVersion) ||
        !cleanString(m.releaseTag) || !cleanString(m.releaseRepository) ||
        m.releaseTag !== `agenc-v${m.runtimeVersion}` ||
        !repositoryPattern.test(m.releaseRepository)) {
      reject("runtime manifest release identity is invalid", 2);
    }
    const actualRuntime = m.runtimeVersion
      .split("-", 1)[0]
      .split(".")
      .map(BigInt);
    const atLeast = (actual, minimum) => actual.some((part, index) =>
      part > minimum[index] &&
      actual.slice(0, index).every((prior, priorIndex) =>
        prior === minimum[priorIndex],
      ),
    ) || actual.every((part, index) => part === minimum[index]);
    const minimumRuntime = [0n, 11n, 2n];
    const runtimeSupported = atLeast(actualRuntime, minimumRuntime);
    const requiresDualProvenance = atLeast(actualRuntime, [0n, 13n, 0n]);
    if (!runtimeSupported) {
      reject(
        `runtime ${m.runtimeVersion} has no supported standalone activation contract; ` +
        "use the frozen 0.7.2 bridge with host Node 25.9, or 0.11.2 and newer with private Node",
        2,
      );
    }
    if (expectedManifestRepo !== "" && m.releaseRepository !== expectedManifestRepo) {
      reject(`runtime manifest releaseRepository ${m.releaseRepository} does not match requested ${expectedManifestRepo}`, 2);
    }
    if (!Array.isArray(m.artifacts) || m.artifacts.length < 1 || m.artifacts.length > 128) {
      reject("runtime manifest artifact collection is invalid", 2);
    }
    artifacts = m.artifacts;
    const identities = new Set();
    for (const artifact of artifacts) {
      const identity = `${artifact?.platform}-${artifact?.arch}/abi${artifact?.nodeModuleAbi ?? "?"}`;
      if (!/^(linux-(x64|arm64)|darwin-(x64|arm64)|win-x64)\/abi[0-9]+$/.test(identity)) {
        reject(`manifest artifact identity is invalid (${identity})`);
      }
      if (identities.has(identity)) reject(`duplicate runtime manifest artifact ${identity}`);
      identities.add(identity);
      if (artifact.runtimeVersion !== m.runtimeVersion ||
          !Number.isSafeInteger(artifact.nodeMajor) || artifact.nodeMajor < 1 ||
          !cleanString(artifact.nodeModuleAbi) || !/^\d+$/.test(artifact.nodeModuleAbi) ||
          !cleanString(artifact.nodeApiVersion) || !/^\d+$/.test(artifact.nodeApiVersion) ||
          !cleanString(artifact.sha256) || !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > artifactCeiling ||
          artifact.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc" ||
          artifact.bins?.node !== (
            artifact.platform === "win"
              ? "node_modules/.agenc-node/node.exe"
              : "node_modules/.agenc-node/bin/node"
          ) ||
          artifact.bins?.nodeLibrary !== (
            artifact.platform === "linux"
              ? "node_modules/.agenc-node/lib"
              : undefined
          ) ||
          !cleanString(artifact.url)) {
        reject(`manifest artifact identity is invalid (${identity})`);
      }
      let parsed;
      try { parsed = new URL(artifact.url); } catch { reject("manifest artifact URL is invalid"); }
      if (trustMode === "explicitLocal") {
        try {
          canonicalLocalFileUrlToPath(artifact.url);
        } catch (error) {
          reject(`explicit local manifests may only use canonical file artifact URLs: ${error.message}`);
        }
        if (artifact.attestationUrl !== undefined ||
            artifact.attestationSha256 !== undefined ||
            artifact.attestationBytes !== undefined ||
            artifact.buildProvenanceUrl !== undefined ||
            artifact.buildProvenanceSha256 !== undefined ||
            artifact.buildProvenanceBytes !== undefined) {
          reject("explicit local runtime artifacts must not declare remote attestations");
        }
      } else if (parsed.protocol !== "https:") {
        reject("remote manifests may only reference HTTPS artifacts");
      }
      if (trustMode !== "explicitLocal") {
        const name = `agenc-runtime-${m.runtimeVersion}-${artifact.platform}-${artifact.arch}` +
          `-node${artifact.nodeMajor}-abi${artifact.nodeModuleAbi}.tar.gz`;
        const expected = `https://github.com/${m.releaseRepository}/releases/download/${m.releaseTag}/${name}`;
        if (artifact.url !== expected) reject("manifest artifact URL is not canonical");
      }
      const hasAttestation = artifact.attestationUrl !== undefined ||
        artifact.attestationSha256 !== undefined || artifact.attestationBytes !== undefined;
      if (trustMode === "official" || hasAttestation) {
        if (artifact.attestationUrl !== `${artifact.url}.sigstore.json`) {
          reject("runtime artifact attestation URL is not canonical");
        }
        if (!/^[0-9a-f]{64}$/.test(artifact.attestationSha256 ?? "")) {
          reject("runtime artifact attestation digest is invalid");
        }
        if (!Number.isSafeInteger(artifact.attestationBytes) ||
            artifact.attestationBytes <= 0 || artifact.attestationBytes > attestationCeiling) {
          reject("runtime artifact attestation size is invalid");
        }
      }
      const hasBuildProvenance = artifact.buildProvenanceUrl !== undefined ||
        artifact.buildProvenanceSha256 !== undefined ||
        artifact.buildProvenanceBytes !== undefined;
      if ((trustMode === "official" && requiresDualProvenance) || hasBuildProvenance) {
        if (artifact.buildProvenanceUrl !== `${artifact.url}.build.sigstore.json`) {
          reject("runtime artifact build provenance URL is not canonical");
        }
        if (!/^[0-9a-f]{64}$/.test(artifact.buildProvenanceSha256 ?? "")) {
          reject("runtime artifact build provenance digest is invalid");
        }
        if (!Number.isSafeInteger(artifact.buildProvenanceBytes) ||
            artifact.buildProvenanceBytes <= 0 ||
            artifact.buildProvenanceBytes > attestationCeiling) {
          reject("runtime artifact build provenance size is invalid");
        }
      }
      if (trustMode === "official" && m.releaseRepository !== expectedRepo) {
        reject("manifest release repository is not official");
      }
    }
    if (trustMode !== "explicitLocal") {
      const b = m.build;
      if (b === null || typeof b !== "object" || Array.isArray(b) ||
          b.sourceRef !== `refs/tags/${m.releaseTag}` ||
          !cleanString(b.sourceCommit) || !/^[0-9a-f]{40,64}$/.test(b.sourceCommit) ||
          !Number.isSafeInteger(b.sourceDateEpoch) || b.sourceDateEpoch < 0 ||
          !cleanString(b.lockfileSha256) || !/^[0-9a-f]{64}$/.test(b.lockfileSha256) ||
          !cleanString(b.nodeVersion) || !/^v\d+\.\d+\.\d+$/.test(b.nodeVersion) ||
          !Number.isSafeInteger(b.nodeMajor) ||
          !cleanString(b.nodeModuleAbi) || !/^\d+$/.test(b.nodeModuleAbi) ||
          !cleanString(b.nodeApiVersion) || !/^\d+$/.test(b.nodeApiVersion) ||
          !cleanString(b.npmVersion) || !/^\d+\.\d+\.\d+$/.test(b.npmVersion) ||
          b.artifactProfile !== "release" || Number(b.nodeVersion.slice(1).split(".")[0]) !== b.nodeMajor) {
        reject("runtime manifest build provenance is invalid");
      }
      const releaseCandidate = b.releaseCandidate;
      const releaseCandidateKeys = [
        "workflow",
        "runId",
        "runAttempt",
        "runUrl",
        "phase",
        "sourceRef",
        "evidenceSha256",
      ];
      if (releaseCandidate !== undefined ||
          (trustMode === "official" && requiresDualProvenance)) {
        if (releaseCandidate === null ||
            typeof releaseCandidate !== "object" ||
            Array.isArray(releaseCandidate) ||
            Object.keys(releaseCandidate).sort().join("\0") !==
              [...releaseCandidateKeys].sort().join("\0") ||
            releaseCandidate.workflow !== "release-runtime.yml" ||
            !Number.isSafeInteger(releaseCandidate.runId) ||
            releaseCandidate.runId <= 0 ||
            !Number.isSafeInteger(releaseCandidate.runAttempt) ||
            releaseCandidate.runAttempt <= 0 ||
            releaseCandidate.runUrl !==
              `https://github.com/tetsuo-ai/agenc-core/actions/runs/${releaseCandidate.runId}` ||
            releaseCandidate.phase !== "candidate" ||
            releaseCandidate.sourceRef !== "refs/heads/main" ||
            !/^[0-9a-f]{64}$/.test(releaseCandidate.evidenceSha256 ?? "") ||
            !/^[0-9a-f]{40}$/.test(b.sourceCommit ?? "")) {
          reject("runtime release candidate identity is invalid");
        }
      }
      for (const artifact of artifacts) {
        if (artifact.nodeMajor !== b.nodeMajor || artifact.nodeModuleAbi !== b.nodeModuleAbi ||
            artifact.nodeApiVersion !== b.nodeApiVersion) {
          reject("runtime manifest artifact disagrees with build provenance");
        }
      }
    }
  }
  const matches = artifacts.filter((x) => x.platform === os && x.arch === arch);
  if (matches.length !== 1) {
    const have = artifacts
      .map((x) => `${x.platform}-${x.arch}/abi${x.nodeModuleAbi ?? "?"}`)
      .join(", ");
    console.error(matches.length === 0
      ? `no runtime build for ${os}-${arch} (available: ${have || "none"})`
      : `duplicate runtime builds for ${os}-${arch}`);
    process.exit(3);
  }
  const a = matches[0];
  if (!versionPattern.test(m.runtimeVersion || "") ||
      a.runtimeVersion !== m.runtimeVersion ||
      !/^[0-9a-f]{64}$/.test(a.sha256 || "") ||
      !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > artifactCeiling ||
      !/^\d+$/.test(a.nodeApiVersion || "") || a.nodeApiVersion !== process.versions.napi ||
      a.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc" ||
      (!legacy && (
        a.nodeMajor !== 26 || a.nodeModuleAbi !== "147" || a.nodeApiVersion !== "10" ||
        a.bins.node !== (
          a.platform === "win"
            ? "node_modules/.agenc-node/node.exe"
            : "node_modules/.agenc-node/bin/node"
        ) ||
        a.bins.nodeLibrary !== (
          a.platform === "linux" ? "node_modules/.agenc-node/lib" : undefined
        )
      ))) {
    console.error("manifest artifact identity is invalid");
    process.exit(4);
  }
  if (pinVersion && m.runtimeVersion !== pinVersion) {
    console.error(`manifest runtime ${m.runtimeVersion} does not match pinned version ${pinVersion}`);
    process.exit(4);
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (a.nodeMajor !== nodeMajor) {
    console.error(`runtime requires Node ${a.nodeMajor}.x; current Node is ${nodeMajor}.x`);
    process.exit(5);
  }
  if (os === "linux") {
    const dotted = /^\d+\.\d+(?:\.\d+)?$/;
    const compare = (left, right) => {
      const l = left.split(".").map(Number), r = right.split(".").map(Number);
      for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
        const d = (l[i] || 0) - (r[i] || 0);
        if (d) return Math.sign(d);
      }
      return 0;
    };
    const report = process.report.getReport();
    const libcFamily = process.env.AGENC_INSTALL_LIBC_FAMILY ||
      (report.header.glibcVersionRuntime ? "glibc" : "unknown");
    const libstdcxx = report.sharedObjects.find((path) => basename(path).startsWith("libstdc++.so.6"));
    const maximum = (namespace) => {
      if (!libstdcxx) return undefined;
      const raw = readFileSync(libstdcxx).toString("latin1");
      const values = [...raw.matchAll(new RegExp(`\\b${namespace}_(\\d+\\.\\d+(?:\\.\\d+)?)\\b`, "g"))]
        .map((match) => match[1]);
      return values.sort(compare).at(-1);
    };
    const host = {
      libcFamily,
      glibc: process.env.AGENC_INSTALL_GLIBC_VERSION || report.header.glibcVersionRuntime,
      glibcxx: process.env.AGENC_INSTALL_GLIBCXX_VERSION || maximum("GLIBCXX"),
      cxxabi: process.env.AGENC_INSTALL_CXXABI_VERSION || maximum("CXXABI"),
    };
    const required = [
      [a.minimumGlibcVersion, host.glibc, "glibc"],
      [a.minimumGlibcxxVersion, host.glibcxx, "GLIBCXX"],
      [a.minimumCxxAbiVersion, host.cxxabi, "CXXABI"],
    ];
    if (a.libcFamily !== "glibc" || host.libcFamily !== "glibc") {
      console.error("Linux runtime requires glibc; musl/unknown libc is unsupported");
      process.exit(6);
    }
    for (const [minimum, current, label] of required) {
      if (!dotted.test(minimum || "") || !dotted.test(current || "")) {
        console.error(`could not validate ${label} compatibility`);
        process.exit(7);
      }
      if (compare(current, minimum) < 0) {
        console.error(`Linux runtime requires ${label} ${minimum} or newer; host provides ${current}`);
        process.exit(8);
      }
    }
  } else if (os === "darwin") {
    const { execFileSync } = require("node:child_process");
    const dotted = /^\d+\.\d+(?:\.\d+)?$/;
    const compare = (left, right) => {
      const l = left.split(".").map(Number), r = right.split(".").map(Number);
      for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
        const d = (l[i] || 0) - (r[i] || 0);
        if (d) return Math.sign(d);
      }
      return 0;
    };
    let current;
    try {
      current = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    } catch {
      console.error("could not determine host macOS compatibility");
      process.exit(9);
    }
    if (!dotted.test(a.minimumMacosVersion || "") || !dotted.test(current)) {
      console.error("could not validate macOS compatibility");
      process.exit(9);
    }
    if (compare(current, a.minimumMacosVersion) < 0) {
      console.error(`runtime requires macOS ${a.minimumMacosVersion} or newer; host provides ${current}`);
      process.exit(10);
    }
  }
  const bin = a.bins.agenc;
  const libc = a.platform === "linux" ? a.libcFamily : "native";
  const key = `${a.platform}-${a.arch}-${libc}-node-abi-${a.nodeModuleAbi}`;
  process.stdout.write([
    m.runtimeVersion,
    a.url,
    a.sha256,
    a.bytes,
    bin,
    a.nodeModuleAbi,
    key,
    legacy ? "" : m.build?.sourceCommit ?? "",
    legacy ? "" : m.build?.sourceRef ?? "",
    legacy ? "" : a.attestationUrl ?? "",
    legacy ? "" : a.attestationSha256 ?? "",
    legacy ? "" : a.attestationBytes ?? "",
    legacy ? "" : a.buildProvenanceUrl ?? "",
    legacy ? "" : a.buildProvenanceSha256 ?? "",
    legacy ? "" : a.buildProvenanceBytes ?? "",
    legacy ? "" : a.bins.node,
    legacy ? "" : a.bins.nodeLibrary ?? "",
    legacy || trustMode === "explicitLocal" ? "" : m.build?.nodeVersion ?? "",
  ].join("\n"));
' "$MANIFEST_FILE" "$OS" "$ARCH" "$NODE_MODULE_ABI" "$MANIFEST_URL" "$PIN_VERSION" "$OFFICIAL_REPO" "$EXPECTED_MANIFEST_REPO" "$MANIFEST_TRUST" "$MAX_ARTIFACT_BYTES" "$MAX_SIGSTORE_BUNDLE_BYTES")" || \
  fail "manifest rejected (${OS}-${ARCH})"

VERSION="$(printf '%s\n' "$SELECTED" | sed -n 1p)"
ARTIFACT_URL="$(printf '%s\n' "$SELECTED" | sed -n 2p)"
ARTIFACT_SHA="$(printf '%s\n' "$SELECTED" | sed -n 3p)"
ARTIFACT_BYTES="$(printf '%s\n' "$SELECTED" | sed -n 4p)"
BIN_REL="$(printf '%s\n' "$SELECTED" | sed -n 5p)"
ARTIFACT_ABI="$(printf '%s\n' "$SELECTED" | sed -n 6p)"
ARTIFACT_KEY="$(printf '%s\n' "$SELECTED" | sed -n 7p)"
SOURCE_COMMIT="$(printf '%s\n' "$SELECTED" | sed -n 8p)"
SOURCE_REF="$(printf '%s\n' "$SELECTED" | sed -n 9p)"
ARTIFACT_ATTESTATION_URL="$(printf '%s\n' "$SELECTED" | sed -n 10p)"
ARTIFACT_ATTESTATION_SHA="$(printf '%s\n' "$SELECTED" | sed -n 11p)"
ARTIFACT_ATTESTATION_BYTES="$(printf '%s\n' "$SELECTED" | sed -n 12p)"
ARTIFACT_BUILD_PROVENANCE_URL="$(printf '%s\n' "$SELECTED" | sed -n 13p)"
ARTIFACT_BUILD_PROVENANCE_SHA="$(printf '%s\n' "$SELECTED" | sed -n 14p)"
ARTIFACT_BUILD_PROVENANCE_BYTES="$(printf '%s\n' "$SELECTED" | sed -n 15p)"
NODE_BIN_REL="$(printf '%s\n' "$SELECTED" | sed -n 16p)"
NODE_LIBRARY_REL="$(printf '%s\n' "$SELECTED" | sed -n 17p)"
MANIFEST_NODE_VERSION="$(printf '%s\n' "$SELECTED" | sed -n 18p)"

PROVENANCE_EXPECTATION_BASE64=""
PROVENANCE_RECEIPT_BASE64=""
if [ "$MANIFEST_TRUST" = "official" ]; then
  PROVENANCE_EXPECTATION_BASE64="$(node -e '
    const hasBuildProvenance = process.argv[15] !== "";
    const value = {
      schema: hasBuildProvenance ? process.argv[2] : process.argv[1],
      artifactSha256: process.argv[3],
      artifactUrl: process.argv[11],
      sourceRepository: process.argv[4],
      sourceWorkflow: process.argv[5],
      sourceCommit: process.argv[6],
      sourceRef: process.argv[7],
      attestationUrl: process.argv[12],
      attestationSha256: process.argv[13],
      attestationBytes: Number(process.argv[14]),
      ...(hasBuildProvenance ? {
        buildProvenanceUrl: process.argv[15],
        buildProvenanceSha256: process.argv[16],
        buildProvenanceBytes: Number(process.argv[17]),
        buildSourceRef: "refs/heads/main",
      } : {}),
      verificationPolicy: {
        hostname: process.argv[8],
        certOidcIssuer: process.argv[9],
        predicateType: process.argv[10],
        denySelfHostedRunners: true,
      },
    };
    process.stdout.write(Buffer.from(JSON.stringify(value)).toString("base64"));
  ' "$PROVENANCE_SCHEMA" "$DUAL_PROVENANCE_SCHEMA" "$ARTIFACT_SHA" "$PROVENANCE_REPOSITORY" \
    "$PROVENANCE_WORKFLOW" "$SOURCE_COMMIT" "$SOURCE_REF" \
    "$PROVENANCE_HOSTNAME" "$PROVENANCE_OIDC_ISSUER" "$PROVENANCE_PREDICATE_TYPE" \
    "$ARTIFACT_URL" "$ARTIFACT_ATTESTATION_URL" "$ARTIFACT_ATTESTATION_SHA" \
    "$ARTIFACT_ATTESTATION_BYTES" "$ARTIFACT_BUILD_PROVENANCE_URL" \
    "$ARTIFACT_BUILD_PROVENANCE_SHA" "$ARTIFACT_BUILD_PROVENANCE_BYTES")" || \
    fail "could not construct official provenance expectation"
fi

INSTALL_DIR="${AGENC_HOME_DIR}/runtime/${VERSION}/${ARTIFACT_KEY}-sha256-${ARTIFACT_SHA}"
MARKER="${INSTALL_DIR}/.agenc-runtime-ok"
RUNTIME_BIN="${INSTALL_DIR}/${BIN_REL}"
if [ -n "$NODE_BIN_REL" ]; then
  PRIVATE_NODE_BIN="${INSTALL_DIR}/${NODE_BIN_REL}"
else
  PRIVATE_NODE_BIN="$NODE_BIN"
fi
if [ -n "$NODE_LIBRARY_REL" ]; then
  PRIVATE_NODE_LIBRARY="${INSTALL_DIR}/${NODE_LIBRARY_REL}"
else
  PRIVATE_NODE_LIBRARY=""
fi

# --- download + verify + extract (idempotent via the marker contract) --------

RUNTIME_INSTALLER_JS="$WORK/runtime-installer.cjs"
cat > "$RUNTIME_INSTALLER_JS" <<'AGENC_RUNTIME_INSTALLER'
// BEGIN GENERATED AGENC RUNTIME INSTALLER PROGRAM
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
  chmodSync: chmodLockSync, closeSync, constants: fsConstants, existsSync,
  fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync,
  openSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} = require("node:fs");
const {
  basename, dirname, isAbsolute, join, posix, relative, resolve, win32,
  sep: pathSeparator,
} = require("node:path");
const { TextDecoder } = require("node:util");
const { gunzipSync } = require("node:zlib");

const [
  mode, archivePath, installDir, binRel, expectedSha, artifactPlatform,
  provenanceExpectationBase64 = "", provenanceReceiptBase64 = "", extractionTool = "",
  embeddedNodeRel = "", embeddedNodeLibraryRel = "",
] = process.argv.slice(2);
if (!["recover", "install", "activate", "render-wrapper", "prepare-wrapper-directories", "begin-update", "end-update", "prune"].includes(mode)) {
  throw new Error(`invalid runtime installer mode: ${mode}`);
}
const BLOCK_SIZE = 512;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_SYMLINK_EXPANSIONS = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const collisionPaths = new Map();

const WINDOWS_SYSTEM_ROOT_NAMESPACE = String.raw`\\?\GLOBALROOT\SystemRoot`;
const WINDOWS_INVALID_FILE_ID = 0xffff_ffff_ffff_ffffn;
const WINDOWS_EXECUTABLE_FILESYSTEM = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path) => openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  ),
  fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
  close: closeSync,
};

function trustedWindowsTarExecutable(
  filesystem = WINDOWS_EXECUTABLE_FILESYSTEM,
  canonicalize = realpathSync.native,
) {
  const systemRoot = canonicalize(WINDOWS_SYSTEM_ROOT_NAMESPACE);
  if (!/^[a-z]:\\/iu.test(systemRoot) || win32.normalize(systemRoot) !== systemRoot) {
    throw new Error(
      "trusted Windows SystemRoot did not resolve to a canonical local DOS path",
    );
  }
  const namespaceExecutable = win32.join(
    WINDOWS_SYSTEM_ROOT_NAMESPACE,
    "System32",
    "tar.exe",
  );
  const executable = win32.join(systemRoot, "System32", "tar.exe");
  verifyWindowsExecutableAliases(namespaceExecutable, executable, filesystem);
  return executable;
}

function verifyWindowsExecutableAliases(namespaceExecutable, executable, filesystem) {
  let namespaceDescriptor;
  let candidateDescriptor;
  let operationError;
  try {
    const namespaceBefore = filesystem.lstat(namespaceExecutable);
    const candidateBefore = filesystem.lstat(executable);
    assertRegularWindowsExecutable(namespaceBefore, "GLOBALROOT path");
    assertRegularWindowsExecutable(candidateBefore, "DOS path");
    namespaceDescriptor = filesystem.open(namespaceExecutable);
    candidateDescriptor = filesystem.open(executable);
    const namespaceOpened = filesystem.fstat(namespaceDescriptor);
    const candidateOpened = filesystem.fstat(candidateDescriptor);
    const namespaceAfter = filesystem.lstat(namespaceExecutable);
    const candidateAfter = filesystem.lstat(executable);
    assertRegularWindowsExecutable(namespaceOpened, "GLOBALROOT descriptor");
    assertRegularWindowsExecutable(candidateOpened, "DOS descriptor");
    assertRegularWindowsExecutable(namespaceAfter, "GLOBALROOT path");
    assertRegularWindowsExecutable(candidateAfter, "DOS path");
    for (const identity of [
      namespaceBefore,
      candidateBefore,
      namespaceOpened,
      candidateOpened,
      namespaceAfter,
      candidateAfter,
    ]) {
      if (
        identity.dev <= 0n || identity.ino <= 0n ||
        identity.dev === WINDOWS_INVALID_FILE_ID ||
        identity.ino === WINDOWS_INVALID_FILE_ID
      ) {
        throw new Error("trusted Windows system executable identity is unavailable");
      }
    }
    if (
      !sameWindowsExecutableIdentity(namespaceBefore, namespaceOpened) ||
      !sameWindowsExecutableIdentity(namespaceOpened, namespaceAfter) ||
      !sameWindowsExecutableIdentity(candidateBefore, candidateOpened) ||
      !sameWindowsExecutableIdentity(candidateOpened, candidateAfter) ||
      !sameWindowsExecutableIdentity(namespaceOpened, candidateOpened)
    ) {
      throw new Error("trusted Windows system executable identity mismatch");
    }
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  for (const descriptor of [candidateDescriptor, namespaceDescriptor]) {
    if (descriptor === undefined) continue;
    try { filesystem.close(descriptor); } catch (error) { closeErrors.push(error); }
  }
  if (operationError !== undefined) {
    if (closeErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...closeErrors],
        "trusted Windows executable validation and cleanup both failed",
      );
    }
    throw operationError;
  }
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw new AggregateError(
      closeErrors,
      "trusted Windows executable descriptor cleanup failed",
    );
  }
}

function assertRegularWindowsExecutable(identity, spelling) {
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new Error(
      `trusted Windows ${spelling} executable is not a regular non-link file`,
    );
  }
}

function sameWindowsExecutableIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncFile(path) {
  // fsyncSync maps to FlushFileBuffers on Windows, the same durability
  // boundary as FileStream.Flush(true). It needs a handle with write access
  // there; a read-only handle fails with EPERM.
  const windows = process.platform === "win32";
  let descriptor;
  try {
    descriptor = openSync(path, windows ? fsConstants.O_RDWR : fsConstants.O_RDONLY);
  } catch (error) {
    // Windows cannot flush a file tar extracted read-only. The marker written
    // after this tree is still flushed.
    if (windows && (error?.code === "EPERM" || error?.code === "EACCES")) return;
    throw error;
  }
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function syncDirectory(path) {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function secureOwnerDirectory(path, { repairWritable, ownerOnly }) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`wrapper directory is not a real directory: ${path}`);
  }
  if (process.platform === "win32") return false;
  const currentUid = process.getuid?.();
  if (currentUid === undefined || before.uid !== BigInt(currentUid)) {
    throw new Error(`wrapper directory is not owned by the current user: ${path}`);
  }
  const shouldRepair = ownerOnly ||
    (repairWritable && (before.mode & 0o022n) !== 0n);
  if (!shouldRepair) return false;
  if (
    !Number.isInteger(fsConstants.O_DIRECTORY) ||
    !Number.isInteger(fsConstants.O_NOFOLLOW)
  ) {
    throw new Error("secure wrapper directory repair is unsupported on this platform");
  }
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid
    ) {
      throw new Error(`wrapper directory identity changed during repair: ${path}`);
    }
    const targetMode = ownerOnly
      ? 0o700
      : Number((opened.mode & 0o7777n) & ~0o022n);
    fchmodSync(descriptor, targetMode);
    const secured = fstatSync(descriptor, { bigint: true });
    if (
      !secured.isDirectory() ||
      secured.dev !== before.dev ||
      secured.ino !== before.ino ||
      secured.uid !== before.uid ||
      (secured.mode & 0o022n) !== 0n
    ) {
      throw new Error(`wrapper directory could not be secured: ${path}`);
    }
  } finally {
    closeSync(descriptor);
  }
  return true;
}
function writeFileDurably(path, content, { flag = "w", mode = 0o600 } = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const descriptor = openSync(path, flag, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (written === 0) throw new Error(`write made no progress: ${path}`);
      offset += written;
    }
    try { fchmodSync(descriptor, mode); } catch { /* Windows mode is advisory */ }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function syncTree(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const name of readdirSync(path)) syncTree(join(path, name));
    syncDirectory(path);
  } else if (metadata.isFile()) {
    syncFile(path);
  }
}
function removeDurably(path, options = { force: true }) {
  rmSync(path, options);
  syncDirectory(dirname(path));
}

function field(block, start, length) {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}
function octal(block, start, length, label) {
  const raw = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`);
  return value;
}
function validateChecksum(block) {
  const expected = octal(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (actual !== expected) throw new Error("invalid tar header checksum");
}
function parsePax(data) {
  const values = {};
  const seenKeys = new Set();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error("invalid PAX record length");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("invalid PAX record length");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("invalid PAX record boundary");
    }
    const record = decoder.decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("invalid PAX record");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (seenKeys.has(key)) throw new Error(`duplicate PAX key: ${key}`);
    seenKeys.add(key);
    if (key === "path" || key === "linkpath") values[key] = value;
    else if (key === "size") {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid PAX size");
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size > MAX_UNCOMPRESSED_BYTES) throw new Error("invalid PAX size");
      values.size = size;
    } else if (["mtime", "atime", "ctime"].includes(key)) {
      if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error(`invalid PAX ${key}`);
    } else throw new Error(`unsupported PAX key: ${key}`);
    offset = end;
  }
  return values;
}
function validateMemberPath(path) {
  if (!path || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`unsafe runtime archive path: ${path || "(empty)"}`);
  }
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe runtime archive path: ${path}`);
  }
  if (trimmed !== "node_modules" && !trimmed.startsWith("node_modules/")) {
    throw new Error(`runtime archive member is outside node_modules: ${path}`);
  }
  if (artifactPlatform === "win" || artifactPlatform === "darwin") {
    let prefix = "";
    for (const part of parts) {
      if (/[. ]$/.test(part) ||
          (artifactPlatform === "win" && (part.includes(":") || /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part)))) {
        throw new Error(`unsafe runtime archive path for ${artifactPlatform}: ${path}`);
      }
      prefix = prefix ? `${prefix}/${part}` : part;
      const collisionKey = prefix.normalize("NFC").toLowerCase();
      const prior = collisionPaths.get(collisionKey);
      if (prior !== undefined && prior !== prefix) {
        throw new Error(`runtime archive has a case/Unicode path collision: ${prior} and ${prefix}`);
      }
      collisionPaths.set(collisionKey, prefix);
    }
  }
  return trimmed;
}
function validateLink(memberPath, linkPath) {
  if (!linkPath || /[\\\x00-\x1f\x7f]/.test(linkPath) || linkPath.startsWith("/") || /^[A-Za-z]:/.test(linkPath)) {
    throw new Error(`unsafe runtime archive link target: ${linkPath || "(empty)"}`);
  }
  if ((artifactPlatform === "win" || artifactPlatform === "darwin") &&
      linkPath.split("/").some((part) => part !== "." && part !== ".." &&
        (/[. ]$/.test(part) ||
          (artifactPlatform === "win" && (part.includes(":") || /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part)))))) {
    throw new Error(`unsafe runtime archive link target for ${artifactPlatform}: ${linkPath}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(memberPath), linkPath));
  if (resolved !== "node_modules" && !resolved.startsWith("node_modules/")) {
    throw new Error(`runtime archive link escapes node_modules: ${memberPath} -> ${linkPath}`);
  }
}
function resolveArchiveGraphPath(components, links) {
  const pending = [...components];
  const resolved = [];
  let expansions = 0;
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > MAX_ENTRIES + MAX_SYMLINK_EXPANSIONS) throw new Error("runtime archive symlink resolution is too complex");
    const part = pending.shift() ?? "";
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) throw new Error("runtime archive symlink graph escapes the extraction root");
      resolved.pop();
      continue;
    }
    resolved.push(part);
    const target = links.get(resolved.join("/"));
    if (target === undefined) continue;
    if (++expansions > MAX_SYMLINK_EXPANSIONS) throw new Error("runtime archive symlink graph contains a cycle or excessive depth");
    resolved.pop();
    pending.unshift(...target.split("/"));
  }
  return resolved.join("/");
}
function assertGraphResultWithinNodeModules(path) {
  if (path !== "node_modules" && !path.startsWith("node_modules/")) {
    throw new Error(`runtime archive symlink graph escapes node_modules: ${path || "(root)"}`);
  }
}
function validateSymlinkGraph(members, links) {
  for (const member of members) {
    if (member.type === "2") {
      const parent = posix.dirname(member.path);
      if (parent !== ".") assertGraphResultWithinNodeModules(resolveArchiveGraphPath(parent.split("/"), links));
      const target = links.get(member.path);
      if (target === undefined) throw new Error(`missing runtime archive link target: ${member.path}`);
      assertGraphResultWithinNodeModules(resolveArchiveGraphPath([
        ...(parent === "." ? [] : parent.split("/")),
        ...target.split("/"),
      ], links));
    } else {
      assertGraphResultWithinNodeModules(resolveArchiveGraphPath(member.path.split("/"), links));
    }
  }
}
function validateArchive(path) {
  const compressed = readFileSync(path);
  const archiveSha = createHash("sha256").update(compressed).digest("hex");
  if (archiveSha !== expectedSha) throw new Error("runtime archive changed after checksum verification");
  const archive = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  let offset = 0;
  let entries = 0;
  let pendingPax;
  const seen = new Set();
  const members = [];
  const links = new Map();
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    validateChecksum(header);
    const size = octal(header, 124, 12, "entry size");
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error("truncated tar entry");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(header, 345, 155);
    const headerPath = [prefix, field(header, 0, 100)].filter(Boolean).join("/");
    const headerLink = field(header, 157, 100);
    if (type === "x") {
      if (pendingPax !== undefined) throw new Error("stacked PAX headers are not allowed");
      pendingPax = parsePax(archive.subarray(dataStart, dataEnd));
    } else {
      if (pendingPax?.size !== undefined && pendingPax.size !== size) throw new Error("PAX size does not match tar header size");
      if (!["0", "5", "2"].includes(type)) throw new Error(`unsupported runtime archive member type: ${type}`);
      const memberPath = validateMemberPath(pendingPax?.path ?? headerPath);
      if (seen.has(memberPath)) throw new Error(`duplicate runtime archive member: ${memberPath}`);
      seen.add(memberPath);
      if (type === "2") {
        const linkPath = pendingPax?.linkpath ?? headerLink;
        validateLink(memberPath, linkPath);
        links.set(memberPath, linkPath);
      }
      members.push({ path: memberPath, type });
      pendingPax = undefined;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("runtime archive has too many entries");
    }
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  if (pendingPax !== undefined) throw new Error("orphaned PAX header");
  if (entries === 0 || !seen.has("node_modules")) throw new Error("runtime archive is empty or missing node_modules");
  validateSymlinkGraph(members, links);
}
// BEGIN GENERATED AGENC SQLITE LOCK MODULE
// Generated by scripts/sync-installer-sqlite-lock.mjs from the canonical
// launcher module. Do not edit this embedded payload by hand.
const AGENC_SQLITE_LOCK_SOURCE_BASE64 = "Ly8gQ3Jvc3MtcHJvY2VzcyBsb2NhbCBmaWxlc3lzdGVtIGxvY2tzIGJhY2tlZCBieSBTUUxpdGUncyBPUyBsb2NraW5nIGxheWVyLgovLwovLyBCRUdJTiBJTU1FRElBVEUgb3ducyB0aGUgd3JpdGVyIHJlc2VydmF0aW9uIGZvciB0aGUgY2FsbGVyJ3MgY3JpdGljYWwKLy8gc2VjdGlvbi4gU1FMaXRlIHJlbGVhc2VzIGl0IG9uIGNsb3NlIG9yIHByb2Nlc3MgZGVhdGgsIGluY2x1ZGluZyBTSUdLSUxMLgovLyBBIHByb2Nlc3Mtd2lkZSBGSUZPIHJlZ2lzdHJ5IHByZXZlbnRzIGR1cGxpY2F0ZSBtb2R1bGUgaW5zdGFuY2VzIGZyb20KLy8gYmxvY2tpbmcgb25lIGFub3RoZXIgaW5zaWRlIHN5bmNocm9ub3VzIFNRTGl0ZSBjYWxsczsgY3Jvc3MtcHJvY2VzcyBidXN5Ci8vIGNvbnRlbnRpb24gaXMgcmV0cmllZCBhc3luY2hyb25vdXNseSBhZ2FpbnN0IG9uZSBtb25vdG9uaWMgZGVhZGxpbmUuCgppbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gIm5vZGU6Y2hpbGRfcHJvY2VzcyI7CmltcG9ydCB7CiAgY2xvc2VTeW5jLAogIGNvbnN0YW50cyBhcyBmc0NvbnN0YW50cywKICBmc3RhdFN5bmMsCiAgbHN0YXRTeW5jLAogIG9wZW5TeW5jLAogIHJlYWxwYXRoU3luYywKfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsKICBjaG1vZCwKICBsc3RhdCwKICBta2RpciwKICBvcGVuLAogIHJlYWRGaWxlLAogIHJlYWxwYXRoLAp9IGZyb20gIm5vZGU6ZnMvcHJvbWlzZXMiOwppbXBvcnQgewogIGJhc2VuYW1lLAogIGRpcm5hbWUsCiAgam9pbiwKICByZXNvbHZlLAogIHNlcCwKICB3aW4zMiwKfSBmcm9tICJub2RlOnBhdGgiOwppbXBvcnQgeyBzZXRUaW1lb3V0IGFzIGRlbGF5IH0gZnJvbSAibm9kZTp0aW1lcnMvcHJvbWlzZXMiOwoKY29uc3QgTE9DS19BUFBMSUNBVElPTl9JRCA9IDB4NDE0NzRlNDM7IC8vICJBR05DIgpjb25zdCBMT0NLX0ZPUk1BVF9WRVJTSU9OID0gMTsKY29uc3QgU1FMSVRFX0JVU1kgPSA1Owpjb25zdCBSRUdJU1RSWV9WRVJTSU9OID0gMTsKY29uc3QgUkVHSVNUUllfU1lNQk9MID0gU3ltYm9sLmZvcigiQHRldHN1by1haS9hZ2VuYy5zcWxpdGUtbG9jay1yZWdpc3RyeSIpOwpjb25zdCBNQVhfQlVTWV9SRVRSWV9NUyA9IDUwOwpjb25zdCBNQVhfVElNRVJfREVMQVlfTVMgPSAyXzE0N180ODNfNjQ3Owpjb25zdCBEQVJXSU5fRklMRVNZU1RFTV9QUk9CRV9USU1FT1VUX01TID0gMl8wMDA7CmNvbnN0IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQgPSAweGZmZmZfZmZmZl9mZmZmX2ZmZmZuOwpjb25zdCBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSUyA9IDE2XzM4NDsKY29uc3QgV0lORE9XU19QQVRIX1RSQU5TUE9SVF9NQVhfRU5UUklFUyA9IDEyODsKY29uc3QgV0lORE9XU19TWVNURU1fUk9PVCA9IFN0cmluZy5yYXdgXFw/XEdMT0JBTFJPT1RcU3lzdGVtUm9vdGA7CmNvbnN0IFdJTkRPV1NfRVhFQ1VUQUJMRV9GSUxFU1lTVEVNID0gewogIGxzdGF0OiAocGF0aCkgPT4gbHN0YXRTeW5jKHBhdGgsIHsgYmlnaW50OiB0cnVlIH0pLAogIG9wZW46IChwYXRoKSA9PiBvcGVuU3luYygKICAgIHBhdGgsCiAgICBmc0NvbnN0YW50cy5PX1JET05MWSB8IChmc0NvbnN0YW50cy5PX05PRk9MTE9XID8/IDApLAogICksCiAgZnN0YXQ6IChkZXNjcmlwdG9yKSA9PiBmc3RhdFN5bmMoZGVzY3JpcHRvciwgeyBiaWdpbnQ6IHRydWUgfSksCiAgY2xvc2U6IGNsb3NlU3luYywKfTsKY29uc3QgTE9DQUxfRklMRVNZU1RFTV9UWVBFUyA9IG5ldyBTZXQoWwogICJhcGZzIiwgImJjYWNoZWZzIiwgImJ0cmZzIiwgImV4ZmF0IiwgImV4dDIiLCAiZXh0MyIsICJleHQ0IiwgImYyZnMiLAogICJoZnMiLCAiaGZzcGx1cyIsICJqZnMiLCAibXNkb3MiLCAibmlsZnMyIiwgIm50ZnMiLCAibnRmczMiLCAib3ZlcmxheSIsCiAgInJhbWZzIiwgInJlaXNlcmZzIiwgInRtcGZzIiwgInViaWZzIiwgInVmcyIsICJ2ZmF0IiwgInhmcyIsICJ6ZnMiLApdKTsKY29uc3QgREFSV0lOX0FDTF9SRUFEX1JJR0hUUyA9IG5ldyBTZXQoWwogICJyZWFkIiwgImxpc3QiLCAic2VhcmNoIiwgImV4ZWN1dGUiLCAicmVhZGF0dHIiLCAicmVhZGV4dGF0dHIiLCAicmVhZHNlY3VyaXR5IiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfSU5IRVJJVEFOQ0VfRkxBR1MgPSBuZXcgU2V0KFsKICAiZmlsZV9pbmhlcml0IiwgImRpcmVjdG9yeV9pbmhlcml0IiwgImxpbWl0X2luaGVyaXQiLCAib25seV9pbmhlcml0IiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfTVVUQVRJT05fUklHSFRTID0gbmV3IFNldChbCiAgIndyaXRlIiwgImFwcGVuZCIsICJhZGRfZmlsZSIsICJhZGRfc3ViZGlyZWN0b3J5IiwgImRlbGV0ZSIsICJkZWxldGVfY2hpbGQiLAogICJ3cml0ZWF0dHIiLCAid3JpdGVleHRhdHRyIiwgIndyaXRlc2VjdXJpdHkiLCAiY2hvd24iLApdKTsKY29uc3QgREFSV0lOX0FDTF9LTk9XTl9UT0tFTlMgPSBuZXcgU2V0KFsKICAuLi5EQVJXSU5fQUNMX1JFQURfUklHSFRTLAogIC4uLkRBUldJTl9BQ0xfSU5IRVJJVEFOQ0VfRkxBR1MsCiAgLi4uREFSV0lOX0FDTF9NVVRBVElPTl9SSUdIVFMsCl0pOwpjb25zdCBEQVJXSU5fQUNMX1ZFUkRJQ1RfQ0FDSEVfTElNSVQgPSA1MTI7CmNvbnN0IGRhcndpbkFjbFZlcmRpY3RzID0gbmV3IE1hcCgpOwoKY29uc3QgV0lORE9XU19TRUNVUklUWV9TQ1JJUFQgPSBTdHJpbmcucmF3YAokRXJyb3JBY3Rpb25QcmVmZXJlbmNlID0gJ1N0b3AnCiMgS2VlcCB0aGlzIGRpcmVjdC0uTkVUIG9ubHk6IG1vZHVsZSBhdXRvbG9hZCBjYW4gZXhoYXVzdCB0aGUgc2hhcmVkIGxvY2sgZGVhZGxpbmUuCiR0cmFuc3BvcnQgPSBbc3RyaW5nXSRlbnY6QUdFTkNfTE9DS19QQVRIUwppZiAoW3N0cmluZ106OklzTnVsbE9yRW1wdHkoJHRyYW5zcG9ydCkgLW9yICR0cmFuc3BvcnQuTGVuZ3RoIC1ndCAke1dJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0NIQVJTfSkgewogIHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcKfQokZW50cmllcyA9IFtzdHJpbmdbXV0kdHJhbnNwb3J0LlNwbGl0KFtjaGFyXTEwKQppZiAoJGVudHJpZXMuQ291bnQgLWx0IDEgLW9yICRlbnRyaWVzLkNvdW50IC1ndCAke1dJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0VOVFJJRVN9KSB7CiAgdGhyb3cgJ2ludmFsaWQgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0Jwp9CiRjdXJyZW50U2lkID0gW1N5c3RlbS5TZWN1cml0eS5QcmluY2lwYWwuV2luZG93c0lkZW50aXR5XTo6R2V0Q3VycmVudCgpLlVzZXIuVmFsdWUKJHRydXN0ZWQgPSBAKAogICRjdXJyZW50U2lkLAogICdTLTEtNS0xOCcsCiAgJ1MtMS01LTMyLTU0NCcsCiAgJ1MtMS01LTgwLTk1NjAwODg4NS0zNDE4NTIyNjQ5LTE4MzEwMzgwNDQtMTg1MzI5MjYzMS0yMjcxNDc4NDY0JwopCiMgU3BlY2lmaWMgbXV0YXRpb24gcmlnaHRzIHBsdXMgR0VORVJJQ19XUklURSBhbmQgR0VORVJJQ19BTEwuCiRsZWFmTXV0YXRpb25NYXNrID0gW2ludDY0XTEzNDMwMjk1OTAKJGFuY2VzdG9yTXV0YXRpb25NYXNrID0gW2ludDY0XTEzNDMwMjk1ODYKZm9yZWFjaCAoJGVudHJ5IGluICRlbnRyaWVzKSB7CiAgJHNlcGFyYXRvciA9ICRlbnRyeS5JbmRleE9mKFtjaGFyXTU4KQogIGlmICgkc2VwYXJhdG9yIC1sdCAxIC1vciAkc2VwYXJhdG9yIC1lcSAoJGVudHJ5Lkxlbmd0aCAtIDEpKSB7CiAgICB0aHJvdyAnaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnCiAgfQogICRyb2xlID0gJGVudHJ5LlN1YnN0cmluZygwLCAkc2VwYXJhdG9yKQogIGlmIChAKCdsZWFmRGlyZWN0b3J5JywgJ2FuY2VzdG9yRGlyZWN0b3J5JywgJ2ZpbGUnKSAtbm90Y29udGFpbnMgJHJvbGUpIHsKICAgIHRocm93ICJpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHJvbGU6ICRyb2xlIgogIH0KICAkZW5jb2RlZFBhdGggPSAkZW50cnkuU3Vic3RyaW5nKCRzZXBhcmF0b3IgKyAxKQogIGlmICgoJGVuY29kZWRQYXRoLkxlbmd0aCAlIDQpIC1uZSAwKSB7IHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcgfQogICRwYXRoQnl0ZXMgPSBbU3lzdGVtLkNvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCRlbmNvZGVkUGF0aCkKICBpZiAoKCRwYXRoQnl0ZXMuTGVuZ3RoICUgMikgLW5lIDApIHsgdGhyb3cgJ2ludmFsaWQgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0JyB9CiAgaWYgKFtTeXN0ZW0uQ29udmVydF06OlRvQmFzZTY0U3RyaW5nKCRwYXRoQnl0ZXMpIC1jbmUgJGVuY29kZWRQYXRoKSB7CiAgICB0aHJvdyAnbm9uLWNhbm9uaWNhbCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnCiAgfQogICRwYXRoQ2hhcmFjdGVycyA9IFtjaGFyW11dOjpuZXcoW2ludF0oJHBhdGhCeXRlcy5MZW5ndGggLyAyKSkKICBmb3IgKCRpbmRleCA9IDA7ICRpbmRleCAtbHQgJHBhdGhDaGFyYWN0ZXJzLkxlbmd0aDsgJGluZGV4ICs9IDEpIHsKICAgICRieXRlT2Zmc2V0ID0gJGluZGV4ICogMgogICAgJGxvd0J5dGUgPSBbaW50XSRwYXRoQnl0ZXNbJGJ5dGVPZmZzZXRdCiAgICAkaGlnaEJ5dGUgPSBbaW50XSRwYXRoQnl0ZXNbJGJ5dGVPZmZzZXQgKyAxXQogICAgJHBhdGhDaGFyYWN0ZXJzWyRpbmRleF0gPSBbY2hhcl0oJGxvd0J5dGUgLWJvciAoJGhpZ2hCeXRlIC1zaGwgOCkpCiAgfQogICRyZXF1ZXN0ZWQgPSBbc3RyaW5nXTo6bmV3KCRwYXRoQ2hhcmFjdGVycykKICAkbXV0YXRpb25NYXNrID0gaWYgKCRyb2xlIC1lcSAnYW5jZXN0b3JEaXJlY3RvcnknKSB7CiAgICAkYW5jZXN0b3JNdXRhdGlvbk1hc2sKICB9IGVsc2UgewogICAgJGxlYWZNdXRhdGlvbk1hc2sKICB9CiAgJGZ1bGwgPSBbU3lzdGVtLklPLlBhdGhdOjpHZXRGdWxsUGF0aCgkcmVxdWVzdGVkKQogIGlmICgkZnVsbC5TdGFydHNXaXRoKCdcXCcpIC1vciAkZnVsbC5TdGFydHNXaXRoKCdcXD9cJykgLW9yICRmdWxsLlN0YXJ0c1dpdGgoJ1xcLlwnKSkgewogICAgdGhyb3cgIm5ldHdvcmsgYW5kIGRldmljZSBwYXRocyBhcmUgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICAkYXR0cmlidXRlcyA9IFtTeXN0ZW0uSU8uRmlsZV06OkdldEF0dHJpYnV0ZXMoJGZ1bGwpCiAgaWYgKCgkYXR0cmlidXRlcyAtYmFuZCBbU3lzdGVtLklPLkZpbGVBdHRyaWJ1dGVzXTo6UmVwYXJzZVBvaW50KSAtbmUgMCkgewogICAgdGhyb3cgInJlcGFyc2UgcG9pbnRzIGFyZSB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRpc0RpcmVjdG9yeSA9ICgkYXR0cmlidXRlcyAtYmFuZCBbU3lzdGVtLklPLkZpbGVBdHRyaWJ1dGVzXTo6RGlyZWN0b3J5KSAtbmUgMAogIGlmICgkaXNEaXJlY3RvcnkgLW5lICgkcm9sZSAtbmUgJ2ZpbGUnKSkgewogICAgdGhyb3cgInByb3RlY3RlZC1wYXRoIHJvbGUgZG9lcyBub3QgbWF0Y2ggaXRzIHR5cGU6ICRmdWxsIgogIH0KICAkZHJpdmUgPSBbU3lzdGVtLklPLkRyaXZlSW5mb106Om5ldyhbU3lzdGVtLklPLlBhdGhdOjpHZXRQYXRoUm9vdCgkZnVsbCkpCiAgaWYgKEAoMiwgMywgNikgLW5vdGNvbnRhaW5zIFtpbnRdJGRyaXZlLkRyaXZlVHlwZSkgewogICAgdGhyb3cgIm5vbi1sb2NhbCBkcml2ZSBpcyB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogIGlmICgkZHJpdmUuRHJpdmVGb3JtYXQgLW5lICdOVEZTJykgewogICAgdGhyb3cgImZpbGVzeXN0ZW0gY2Fubm90IGVuZm9yY2UgdGhlIHJlcXVpcmVkIEFDTCBjb250cmFjdDogJGZ1bGwiCiAgfQogICRhY2xTZWN0aW9ucyA9IFtTeXN0ZW0uU2VjdXJpdHkuQWNjZXNzQ29udHJvbC5BY2Nlc3NDb250cm9sU2VjdGlvbnNdOjpPd25lciAtYm9yIFtTeXN0ZW0uU2VjdXJpdHkuQWNjZXNzQ29udHJvbC5BY2Nlc3NDb250cm9sU2VjdGlvbnNdOjpBY2Nlc3MKICBpZiAoJGlzRGlyZWN0b3J5KSB7CiAgICAkYWNsID0gW1N5c3RlbS5JTy5EaXJlY3RvcnldOjpHZXRBY2Nlc3NDb250cm9sKCRmdWxsLCAkYWNsU2VjdGlvbnMpCiAgfSBlbHNlIHsKICAgICRhY2wgPSBbU3lzdGVtLklPLkZpbGVdOjpHZXRBY2Nlc3NDb250cm9sKCRmdWxsLCAkYWNsU2VjdGlvbnMpCiAgfQogIGlmICgtbm90ICRhY2wuQXJlQWNjZXNzUnVsZXNDYW5vbmljYWwpIHsKICAgIHRocm93ICJub24tY2Fub25pY2FsIEFDTCBpcyB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRieXRlcyA9ICRhY2wuR2V0U2VjdXJpdHlEZXNjcmlwdG9yQmluYXJ5Rm9ybSgpCiAgJHJhdyA9IFtTeXN0ZW0uU2VjdXJpdHkuQWNjZXNzQ29udHJvbC5SYXdTZWN1cml0eURlc2NyaXB0b3JdOjpuZXcoJGJ5dGVzLCAwKQogIGlmICgkbnVsbCAtZXEgJHJhdy5EaXNjcmV0aW9uYXJ5QWNsKSB7CiAgICB0aHJvdyAibnVsbCBEQUNMIGlzIHVuc3VwcG9ydGVkOiAkZnVsbCIKICB9CiAgJG93bmVyID0gJGFjbC5HZXRPd25lcihbU3lzdGVtLlNlY3VyaXR5LlByaW5jaXBhbC5TZWN1cml0eUlkZW50aWZpZXJdKS5WYWx1ZQogIGlmICgkdHJ1c3RlZCAtbm90Y29udGFpbnMgJG93bmVyKSB7CiAgICB0aHJvdyAidW50cnVzdGVkIG93bmVyIFNJRCBvbiBsb2NrIHBhdGg6ICRmdWxsIgogIH0KICAkcnVsZXMgPSAkYWNsLkdldEFjY2Vzc1J1bGVzKAogICAgJHRydWUsCiAgICAkdHJ1ZSwKICAgIFtTeXN0ZW0uU2VjdXJpdHkuUHJpbmNpcGFsLlNlY3VyaXR5SWRlbnRpZmllcl0KICApCiAgZm9yZWFjaCAoJHJ1bGUgaW4gJHJ1bGVzKSB7CiAgICBpZiAoJHJ1bGUuQWNjZXNzQ29udHJvbFR5cGUgLW5lIFtTeXN0ZW0uU2VjdXJpdHkuQWNjZXNzQ29udHJvbC5BY2Nlc3NDb250cm9sVHlwZV06OkFsbG93KSB7CiAgICAgIGNvbnRpbnVlCiAgICB9CiAgICAkaW5oZXJpdE9ubHkgPSAoJHJ1bGUuUHJvcGFnYXRpb25GbGFncyAtYmFuZCBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuUHJvcGFnYXRpb25GbGFnc106OkluaGVyaXRPbmx5KSAtbmUgMAogICAgaWYgKCRpbmhlcml0T25seSkgewogICAgICAkY2hpbGRJbmhlcml0YW5jZSA9IFtTeXN0ZW0uU2VjdXJpdHkuQWNjZXNzQ29udHJvbC5Jbmhlcml0YW5jZUZsYWdzXTo6T2JqZWN0SW5oZXJpdCAtYm9yIFtTeXN0ZW0uU2VjdXJpdHkuQWNjZXNzQ29udHJvbC5Jbmhlcml0YW5jZUZsYWdzXTo6Q29udGFpbmVySW5oZXJpdAogICAgICAkcmVhY2hlc05ld0NoaWxkID0gKCRydWxlLkluaGVyaXRhbmNlRmxhZ3MgLWJhbmQgJGNoaWxkSW5oZXJpdGFuY2UpIC1uZSAwCiAgICAgIGlmICgkcm9sZSAtbmUgJ2xlYWZEaXJlY3RvcnknIC1vciAtbm90ICRyZWFjaGVzTmV3Q2hpbGQpIHsKICAgICAgICBjb250aW51ZQogICAgICB9CiAgICB9CiAgICAkc2lkID0gJHJ1bGUuSWRlbnRpdHlSZWZlcmVuY2UuVmFsdWUKICAgICRyaWdodHMgPSAoW2ludDY0XSRydWxlLkZpbGVTeXN0ZW1SaWdodHMpIC1iYW5kIFtpbnQ2NF00Mjk0OTY3Mjk1CiAgICBpZiAoJHRydXN0ZWQgLW5vdGNvbnRhaW5zICRzaWQgLWFuZCAoKCRyaWdodHMgLWJhbmQgJG11dGF0aW9uTWFzaykgLW5lIDApKSB7CiAgICAgIHRocm93ICJ1bnRydXN0ZWQgbXV0YXRpb24gQUNFIG9uIGxvY2sgcGF0aDogJGZ1bGwiCiAgICB9CiAgfQp9CltDb25zb2xlXTo6T3V0LldyaXRlKCdPSycpCmA7CmNvbnN0IFdJTkRPV1NfU0VDVVJJVFlfU0NSSVBUX0JBU0U2NCA9IEJ1ZmZlci5mcm9tKAogIFdJTkRPV1NfU0VDVVJJVFlfU0NSSVBULAogICJ1dGYxNmxlIiwKKS50b1N0cmluZygiYmFzZTY0Iik7CgpleHBvcnQgY2xhc3MgTG9jYWxTcWxpdGVMb2NrVGltZW91dEVycm9yIGV4dGVuZHMgRXJyb3IgewogIGNvbnN0cnVjdG9yKHsgcGF0aCwgbGFiZWwsIHRpbWVvdXRNcywgY2F1c2UgfSkgewogICAgc3VwZXIoCiAgICAgIGBhZ2VuYzogJHtsYWJlbH0gdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zIHdhaXRpbmcgZm9yIGxvY2FsIHByb2Nlc3MgbG9jayAke3BhdGh9YCwKICAgICAgY2F1c2UgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHsgY2F1c2UgfSwKICAgICk7CiAgICB0aGlzLm5hbWUgPSAiTG9jYWxTcWxpdGVMb2NrVGltZW91dEVycm9yIjsKICAgIHRoaXMuY29kZSA9ICJBR0VOQ19MT0NLX1RJTUVPVVQiOwogICAgdGhpcy5wYXRoID0gcGF0aDsKICAgIHRoaXMubGFiZWwgPSBsYWJlbDsKICAgIHRoaXMudGltZW91dE1zID0gdGltZW91dE1zOwogIH0KfQoKZnVuY3Rpb24gdGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgsIGNhdXNlKSB7CiAgcmV0dXJuIG5ldyBMb2NhbFNxbGl0ZUxvY2tUaW1lb3V0RXJyb3IoewogICAgcGF0aCwKICAgIGxhYmVsOiBjb250ZXh0LmxhYmVsLAogICAgdGltZW91dE1zOiBjb250ZXh0LnRpbWVvdXRNcywKICAgIGNhdXNlLAogIH0pOwp9CgpmdW5jdGlvbiByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCkgewogIHJldHVybiBNYXRoLmZsb29yKGNvbnRleHQuZGVhZGxpbmUgLSBwZXJmb3JtYW5jZS5ub3coKSk7Cn0KCmZ1bmN0aW9uIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgsIGNhdXNlKSB7CiAgaWYgKHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KSA8PSAwKSB7CiAgICB0aHJvdyB0aW1lb3V0RXJyb3IoY29udGV4dCwgcGF0aCwgY2F1c2UpOwogIH0KfQoKZnVuY3Rpb24gcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgcGhhc2UpIHsKICB0cnkgewogICAgY29uc3QgcmVzdWx0ID0gY29udGV4dC5vblByb2dyZXNzPy4ocGhhc2UpOwogICAgaWYgKHJlc3VsdCAhPT0gdW5kZWZpbmVkKSB7CiAgICAgIHZvaWQgUHJvbWlzZS5yZXNvbHZlKHJlc3VsdCkuY2F0Y2goKCkgPT4ge30pOwogICAgfQogIH0gY2F0Y2ggewogICAgLy8gRGlhZ25vc3RpY3MgbXVzdCBuZXZlciBjaGFuZ2UgbG9jayBhY3F1aXNpdGlvbiBvciByZWxlYXNlIHNlbWFudGljcy4KICB9Cn0KCmZ1bmN0aW9uIHByb2Nlc3NMb2NrUmVnaXN0cnkoKSB7CiAgY29uc3QgY3VycmVudCA9IHByb2Nlc3NbUkVHSVNUUllfU1lNQk9MXTsKICBpZiAoY3VycmVudCAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAoCiAgICAgIGN1cnJlbnQgPT09IG51bGwgfHwKICAgICAgdHlwZW9mIGN1cnJlbnQgIT09ICJvYmplY3QiIHx8CiAgICAgIGN1cnJlbnQudmVyc2lvbiAhPT0gUkVHSVNUUllfVkVSU0lPTiB8fAogICAgICAhKGN1cnJlbnQubG9ja3MgaW5zdGFuY2VvZiBNYXApCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKAogICAgICAgICJhZ2VuYzogaW5jb21wYXRpYmxlIHByb2Nlc3Mtd2lkZSBTUUxpdGUgbG9jayByZWdpc3RyeSBpcyBhbHJlYWR5IGluc3RhbGxlZCIsCiAgICAgICk7CiAgICB9CiAgICByZXR1cm4gY3VycmVudDsKICB9CiAgY29uc3QgY3JlYXRlZCA9IHsgdmVyc2lvbjogUkVHSVNUUllfVkVSU0lPTiwgbG9ja3M6IG5ldyBNYXAoKSB9OwogIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShwcm9jZXNzLCBSRUdJU1RSWV9TWU1CT0wsIHsKICAgIHZhbHVlOiBjcmVhdGVkLAogICAgY29uZmlndXJhYmxlOiBmYWxzZSwKICAgIGVudW1lcmFibGU6IGZhbHNlLAogICAgd3JpdGFibGU6IGZhbHNlLAogIH0pOwogIHJldHVybiBjcmVhdGVkOwp9CgpmdW5jdGlvbiBhY3F1aXJlSW5Qcm9jZXNzTG9jayhwcmVwYXJlZCwgY29udGV4dCkgewogIGNvbnN0IHJlZ2lzdHJ5ID0gcHJvY2Vzc0xvY2tSZWdpc3RyeSgpOwogIGNvbnN0IGtleSA9IHByZXBhcmVkLmlkZW50aXR5S2V5OwogIGxldCBzdGF0ZSA9IHJlZ2lzdHJ5LmxvY2tzLmdldChrZXkpOwogIGlmIChzdGF0ZSA9PT0gdW5kZWZpbmVkKSB7CiAgICBzdGF0ZSA9IHsgbG9ja2VkOiBmYWxzZSwgd2FpdGVyczogW10gfTsKICAgIHJlZ2lzdHJ5LmxvY2tzLnNldChrZXksIHN0YXRlKTsKICB9CgogIGNvbnN0IG1ha2VSZWxlYXNlID0gKCkgPT4gewogICAgbGV0IHJlbGVhc2VkID0gZmFsc2U7CiAgICByZXR1cm4gKCkgPT4gewogICAgICBpZiAocmVsZWFzZWQpIHJldHVybjsKICAgICAgcmVsZWFzZWQgPSB0cnVlOwogICAgICBjb25zdCBuZXh0ID0gc3RhdGUud2FpdGVycy5zaGlmdCgpOwogICAgICBpZiAobmV4dCA9PT0gdW5kZWZpbmVkKSB7CiAgICAgICAgc3RhdGUubG9ja2VkID0gZmFsc2U7CiAgICAgICAgcmVnaXN0cnkubG9ja3MuZGVsZXRlKGtleSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY2xlYXJUaW1lb3V0KG5leHQudGltZXIpOwogICAgICAgIG5leHQucmVzb2x2ZShtYWtlUmVsZWFzZSgpKTsKICAgICAgfQogICAgfTsKICB9OwoKICBpZiAoIXN0YXRlLmxvY2tlZCkgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCk7CiAgICBzdGF0ZS5sb2NrZWQgPSB0cnVlOwogICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShtYWtlUmVsZWFzZSgpKTsKICB9CgogIGNvbnN0IHJlbWFpbmluZyA9IHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KTsKICBpZiAocmVtYWluaW5nIDw9IDApIHsKICAgIHJldHVybiBQcm9taXNlLnJlamVjdCh0aW1lb3V0RXJyb3IoY29udGV4dCwgcHJlcGFyZWQucGF0aCkpOwogIH0KICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmVXYWl0LCByZWplY3RXYWl0KSA9PiB7CiAgICBjb25zdCB3YWl0ZXIgPSB7CiAgICAgIHJlc29sdmU6IHJlc29sdmVXYWl0LAogICAgICB0aW1lcjogdW5kZWZpbmVkLAogICAgfTsKICAgIGNvbnN0IGFybVRpbWVvdXQgPSAoKSA9PiB7CiAgICAgIGNvbnN0IGRlbGF5TXMgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgICAgIGlmIChkZWxheU1zIDw9IDApIHsKICAgICAgICBjb25zdCBpbmRleCA9IHN0YXRlLndhaXRlcnMuaW5kZXhPZih3YWl0ZXIpOwogICAgICAgIGlmIChpbmRleCAhPT0gLTEpIHN0YXRlLndhaXRlcnMuc3BsaWNlKGluZGV4LCAxKTsKICAgICAgICByZWplY3RXYWl0KHRpbWVvdXRFcnJvcihjb250ZXh0LCBwcmVwYXJlZC5wYXRoKSk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIHdhaXRlci50aW1lciA9IHNldFRpbWVvdXQoYXJtVGltZW91dCwgTWF0aC5taW4oZGVsYXlNcywgTUFYX1RJTUVSX0RFTEFZX01TKSk7CiAgICB9OwogICAgc3RhdGUud2FpdGVycy5wdXNoKHdhaXRlcik7CiAgICBhcm1UaW1lb3V0KCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGRlY29kZU1vdW50UGF0aCh2YWx1ZSkgewogIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXChbMC03XXszfSkvZywgKF9tYXRjaCwgb2N0YWwpID0+CiAgICBTdHJpbmcuZnJvbUNoYXJDb2RlKE51bWJlci5wYXJzZUludChvY3RhbCwgOCkpKTsKfQoKZnVuY3Rpb24gcGF0aElzV2l0aGluKHBhdGgsIG1vdW50UG9pbnQpIHsKICByZXR1cm4gcGF0aCA9PT0gbW91bnRQb2ludCB8fAogICAgcGF0aC5zdGFydHNXaXRoKG1vdW50UG9pbnQgPT09IHNlcCA/IG1vdW50UG9pbnQgOiBgJHttb3VudFBvaW50fSR7c2VwfWApOwp9CgpmdW5jdGlvbiBleGVjRmlsZVV0ZjgoZmlsZSwgYXJncywgb3B0aW9ucywgY29udGV4dCwgcGF0aCkgewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZVJ1biwgcmVqZWN0UnVuKSA9PiB7CiAgICBsZXQgZGVhZGxpbmVUaW1lcjsKICAgIGxldCBleHBpcmVkID0gZmFsc2U7CiAgICBjb25zdCBjaGlsZCA9IGV4ZWNGaWxlKAogICAgICBmaWxlLAogICAgICBhcmdzLAogICAgICB7IC4uLm9wdGlvbnMsIGVuY29kaW5nOiAidXRmOCIgfSwKICAgICAgKGVycm9yLCBzdGRvdXQsIHN0ZGVycikgPT4gewogICAgICAgIGlmIChkZWFkbGluZVRpbWVyICE9PSB1bmRlZmluZWQpIGNsZWFyVGltZW91dChkZWFkbGluZVRpbWVyKTsKICAgICAgICBpZiAoZXhwaXJlZCkgcmV0dXJuOwogICAgICAgIGlmIChlcnJvciAhPT0gbnVsbCkgewogICAgICAgICAgT2JqZWN0LmFzc2lnbihlcnJvciwgeyBzdGRvdXQsIHN0ZGVyciB9KTsKICAgICAgICAgIHJlamVjdFJ1bihlcnJvcik7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIHJlc29sdmVSdW4oeyBzdGRvdXQsIHN0ZGVyciB9KTsKICAgICAgfSwKICAgICk7CiAgICBjb25zdCBhcm1EZWFkbGluZSA9ICgpID0+IHsKICAgICAgY29uc3QgcmVtYWluaW5nID0gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpOwogICAgICBpZiAocmVtYWluaW5nIDw9IDApIHsKICAgICAgICBleHBpcmVkID0gdHJ1ZTsKICAgICAgICAvLyBBIGhlbHBlciBzdHVjayBpbiBrZXJuZWwgSS9PIG1heSBuZXZlciBleGl0LCBldmVuIGFmdGVyIFNJR0tJTEwuCiAgICAgICAgLy8gU2V0dGxlIGF0IG91ciBkZWFkbGluZSBhbmQgcmVsZWFzZSBldmVyeSBldmVudC1sb29wIHJlZmVyZW5jZSByYXRoZXIKICAgICAgICAvLyB0aGFuIHdhaXRpbmcgZm9yIGV4ZWNGaWxlJ3MgZXhpdC9zdGRpby1jbG9zZSBjYWxsYmFjay4KICAgICAgICByZWplY3RSdW4odGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgpKTsKICAgICAgICBjaGlsZC5raWxsKCJTSUdLSUxMIik7CiAgICAgICAgY2hpbGQuc3RkaW4/LmRlc3Ryb3koKTsKICAgICAgICBjaGlsZC5zdGRvdXQ/LmRlc3Ryb3koKTsKICAgICAgICBjaGlsZC5zdGRlcnI/LmRlc3Ryb3koKTsKICAgICAgICBjaGlsZC51bnJlZigpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBkZWFkbGluZVRpbWVyID0gc2V0VGltZW91dCgKICAgICAgICBhcm1EZWFkbGluZSwKICAgICAgICBNYXRoLm1pbihyZW1haW5pbmcsIE1BWF9USU1FUl9ERUxBWV9NUyksCiAgICAgICk7CiAgICB9OwogICAgYXJtRGVhZGxpbmUoKTsKICB9KTsKfQoKZnVuY3Rpb24gbm9ybWFsaXplVGltZWRDb21tYW5kRXJyb3IoZXJyb3IsIGNvbnRleHQsIHBhdGgpIHsKICBpZiAoCiAgICByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCkgPD0gMCB8fAogICAgZXJyb3I/LmNvZGUgPT09ICJFVElNRURPVVQiIHx8CiAgICBlcnJvcj8ua2lsbGVkID09PSB0cnVlCiAgKSB7CiAgICByZXR1cm4gdGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgsIGVycm9yKTsKICB9CiAgcmV0dXJuIGVycm9yOwp9CgpmdW5jdGlvbiB2YWxpZGF0ZURhcndpbkFjbExpc3Rpbmcoc3Rkb3V0LCBwYXRoLCByb2xlKSB7CiAgaWYgKHN0ZG91dC5pbmNsdWRlcygiXHIiKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgbm9uLWNhbm9uaWNhbCBvdXRwdXQgZm9yICR7cGF0aH1gKTsKICB9CiAgY29uc3QgbGluZXMgPSBzdGRvdXQuc3BsaXQoIlxuIik7CiAgaWYgKGxpbmVzLmF0KC0xKSA9PT0gIiIpIGxpbmVzLnBvcCgpOwogIGlmIChsaW5lcy5sZW5ndGggPT09IDAgfHwgbGluZXNbMF0ubGVuZ3RoID09PSAwKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCBubyBtZXRhZGF0YSBmb3IgJHtwYXRofWApOwogIH0KICBsZXQgcHJldmlvdXNPcmRpbmFsID0gLTE7CiAgbGV0IHNhd0xlZ2FjeU93bmVyID0gZmFsc2U7CiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzLnNsaWNlKDEpKSB7CiAgICBpZiAoL15ccypvd25lcjpccytcUy4qJC91LnRlc3QobGluZSkgJiYgIXNhd0xlZ2FjeU93bmVyICYmIHByZXZpb3VzT3JkaW5hbCA9PT0gLTEpIHsKICAgICAgc2F3TGVnYWN5T3duZXIgPSB0cnVlOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgKICAgICAgL15ccyooXGQrKTpccysoLis/KVxzKyg/Oihpbmhlcml0ZWQpXHMrKT8oYWxsb3d8ZGVueSlccysoW2Etel9dKyg/OixbYS16X10rKSopXHMqJC91LAogICAgKTsKICAgIGlmIChtYXRjaCA9PT0gbnVsbCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCB1bnJlY29nbml6ZWQgb3V0cHV0IGZvciAke3BhdGh9YCk7CiAgICB9CiAgICBjb25zdCBvcmRpbmFsID0gTnVtYmVyKG1hdGNoWzFdKTsKICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIob3JkaW5hbCkgfHwgb3JkaW5hbCA8PSBwcmV2aW91c09yZGluYWwpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgaW52YWxpZCBBQ0Ugb3JkZXJpbmcgZm9yICR7cGF0aH1gKTsKICAgIH0KICAgIHByZXZpb3VzT3JkaW5hbCA9IG9yZGluYWw7CiAgICBjb25zdCBhc3NvY2lhdGlvbiA9IG1hdGNoWzRdOwogICAgY29uc3QgdG9rZW5zID0gbWF0Y2hbNV0uc3BsaXQoIiwiKTsKICAgIGZvciAoY29uc3QgdG9rZW4gb2YgdG9rZW5zKSB7CiAgICAgIGlmICghREFSV0lOX0FDTF9LTk9XTl9UT0tFTlMuaGFzKHRva2VuKSkgewogICAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIHVua25vd24gcmlnaHQgJHt0b2tlbn06ICR7cGF0aH1gKTsKICAgICAgfQogICAgfQogICAgaWYgKAogICAgICBhc3NvY2lhdGlvbiA9PT0gImFsbG93IiAmJgogICAgICB0b2tlbnMuc29tZSgodG9rZW4pID0+IERBUldJTl9BQ0xfTVVUQVRJT05fUklHSFRTLmhhcyh0b2tlbikpCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKAogICAgICAgIGBhZ2VuYzogcHJvdGVjdGVkICR7cm9sZX0gaGFzIGEgbXV0YXRpb24tY2FwYWJsZSBEYXJ3aW4gQUNMOiAke3BhdGh9YCwKICAgICAgKTsKICAgIH0KICB9Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydERhcndpblBhdGhTZWN1cml0eShwYXRoLCByb2xlLCBjb250ZXh0KSB7CiAgcmV0dXJuIGFzc2VydERhcndpblBhdGhTZWN1cml0eVdpdGhJTygKICAgIHBhdGgsCiAgICByb2xlLAogICAgY29udGV4dCwKICAgIGV4ZWNGaWxlVXRmOCwKICAgIChjYW5kaWRhdGUpID0+IGxzdGF0KGNhbmRpZGF0ZSwgeyBiaWdpbnQ6IHRydWUgfSksCiAgKTsKfQoKLy8gSEZTKyByZXBvcnRzIGNoYW5nZSB0aW1lIGluIHdob2xlIHNlY29uZHMsIHNvIGFuIEFDTCBlZGl0IHdpdGhpbiB0aGUgc2FtZQovLyBzZWNvbmQgY2FuIGxlYXZlIHRoZSBpZGVudGl0eSB1bmNoYW5nZWQuIE9ubHkgc3ViLXNlY29uZCBjaGFuZ2UgdGltZXMgYXJlCi8vIHByZWNpc2UgZW5vdWdoIHRvIGNhY2hlIGEgdmVyZGljdC4KZnVuY3Rpb24gaGFzU3Vic2Vjb25kQ2hhbmdlVGltZShzdGF0cykgewogIGlmICh0eXBlb2Ygc3RhdHMuY3RpbWVOcyA9PT0gImJpZ2ludCIpIHJldHVybiBzdGF0cy5jdGltZU5zICUgMV8wMDBfMDAwXzAwMG4gIT09IDBuOwogIHJldHVybiBOdW1iZXIuaXNGaW5pdGUoc3RhdHMuY3RpbWVNcykgJiYgc3RhdHMuY3RpbWVNcyAlIDEwMDAgIT09IDA7Cn0KCmZ1bmN0aW9uIGRhcndpbkFjbElkZW50aXR5KHN0YXRzKSB7CiAgcmV0dXJuIFsKICAgIHN0YXRzLmRldiwgc3RhdHMuaW5vLCBzdGF0cy5jdGltZU5zID8/IHN0YXRzLmN0aW1lTXMsCiAgICBzdGF0cy5tb2RlLCBzdGF0cy51aWQsIHN0YXRzLmdpZCwKICAgIHByb2Nlc3MuZ2V0dWlkPy4oKSwgcHJvY2Vzcy5nZXRldWlkPy4oKSwKICBdLmpvaW4oIjoiKTsKfQoKYXN5bmMgZnVuY3Rpb24gYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5V2l0aElPKHBhdGgsIHJvbGUsIGNvbnRleHQsIGxpc3Rlciwgc3RhdFBhdGgpIHsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoKTsKICAvLyBBIERhcndpbiBBQ0wgZWRpdCBhZHZhbmNlcyBjdGltZS4gUmUtc3RhdCBvbiBldmVyeSBsb29rdXAgc28gYW4gb2xkCiAgLy8gc3VjY2Vzc2Z1bCB2ZXJkaWN0IGNhbm5vdCBhdXRob3JpemUgYSBjaGFuZ2VkIGlub2RlLCBvd25lciwgb3IgQUNMLgogIGNvbnN0IGJlZm9yZSA9IGRhcndpbkFjbElkZW50aXR5KGF3YWl0IHN0YXRQYXRoKHBhdGgpKTsKICBjb25zdCBjYWNoZUtleSA9IGAke3JvbGV9XDAke3BhdGh9YDsKICBpZiAoZGFyd2luQWNsVmVyZGljdHMuZ2V0KGNhY2hlS2V5KSA9PT0gYmVmb3JlKSB7CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoKTsKICAgIHJldHVybjsKICB9CiAgZGFyd2luQWNsVmVyZGljdHMuZGVsZXRlKGNhY2hlS2V5KTsKICBsZXQgcmVzdWx0OwogIHRyeSB7CiAgICByZXN1bHQgPSBhd2FpdCBsaXN0ZXIoCiAgICAgICIvYmluL2xzIiwKICAgICAgWyItbGRlcSIsIHBhdGhdLAogICAgICB7CiAgICAgICAgZW52OiB7IExDX0FMTDogIkMiIH0sCiAgICAgICAgbWF4QnVmZmVyOiAyNTYgKiAxMDI0LAogICAgICB9LAogICAgICBjb250ZXh0LAogICAgICBwYXRoLAogICAgKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgdGhyb3cgbm9ybWFsaXplVGltZWRDb21tYW5kRXJyb3IoZXJyb3IsIGNvbnRleHQsIHBhdGgpOwogIH0KICBpZiAocmVzdWx0LnN0ZGVyciAhPT0gIiIpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIHVuZXhwZWN0ZWQgZGlhZ25vc3RpY3MgZm9yICR7cGF0aH1gKTsKICB9CiAgdmFsaWRhdGVEYXJ3aW5BY2xMaXN0aW5nKHJlc3VsdC5zdGRvdXQsIHBhdGgsIHJvbGUpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIC8vIEEgcGF0aCBjaGFuZ2VkIHdoaWxlIGxzIHJhbiBtdXN0IG5ldmVyIHNlZWQgYSB2ZXJkaWN0IGZvciBpdHMgbmV3IHN0YXRlLgogIGNvbnN0IGFmdGVyU3RhdHMgPSBhd2FpdCBzdGF0UGF0aChwYXRoKTsKICBjb25zdCBhZnRlciA9IGRhcndpbkFjbElkZW50aXR5KGFmdGVyU3RhdHMpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIGlmIChhZnRlciA9PT0gYmVmb3JlICYmIGhhc1N1YnNlY29uZENoYW5nZVRpbWUoYWZ0ZXJTdGF0cykpIHsKICAgIGlmIChkYXJ3aW5BY2xWZXJkaWN0cy5zaXplID49IERBUldJTl9BQ0xfVkVSRElDVF9DQUNIRV9MSU1JVCkgewogICAgICBkYXJ3aW5BY2xWZXJkaWN0cy5kZWxldGUoZGFyd2luQWNsVmVyZGljdHMua2V5cygpLm5leHQoKS52YWx1ZSk7CiAgICB9CiAgICBkYXJ3aW5BY2xWZXJkaWN0cy5zZXQoY2FjaGVLZXksIGJlZm9yZSk7CiAgfQp9CgpmdW5jdGlvbiB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKAogIGNhbm9uaWNhbGl6ZSA9IHJlYWxwYXRoU3luYy5uYXRpdmUsCiAgZmlsZXN5c3RlbSA9IFdJTkRPV1NfRVhFQ1VUQUJMRV9GSUxFU1lTVEVNLAopIHsKICAvLyBEZXJpdmUgYSBDcmVhdGVQcm9jZXNzLWNvbXBhdGlibGUgRE9TIHNwZWxsaW5nIGZyb20gR0xPQkFMUk9PVCwgdGhlbiBwcm92ZQogIC8vIGJvdGggc3BlbGxpbmdzIHN0aWxsIG5hbWUgdGhlIHNhbWUgcmVndWxhciBzeXN0ZW0gZmlsZSBiZWZvcmUgbGF1bmNoLgogIGNvbnN0IHN5c3RlbVJvb3QgPSBjYW5vbmljYWxpemUoV0lORE9XU19TWVNURU1fUk9PVCk7CiAgaWYgKCEvXlthLXpdOlxcL2l1LnRlc3Qoc3lzdGVtUm9vdCkgfHwgd2luMzIubm9ybWFsaXplKHN5c3RlbVJvb3QpICE9PSBzeXN0ZW1Sb290KSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoInRydXN0ZWQgV2luZG93cyBTeXN0ZW1Sb290IGRpZCBub3QgcmVzb2x2ZSB0byBhIGNhbm9uaWNhbCBsb2NhbCBET1MgcGF0aCIpOwogIH0KICBjb25zdCB3b3JraW5nRGlyZWN0b3J5ID0gd2luMzIuam9pbihzeXN0ZW1Sb290LCAiU3lzdGVtMzIiKTsKICBjb25zdCBleGVjdXRhYmxlID0gd2luMzIuam9pbigKICAgIHdvcmtpbmdEaXJlY3RvcnksCiAgICAiV2luZG93c1Bvd2VyU2hlbGwiLAogICAgInYxLjAiLAogICAgInBvd2Vyc2hlbGwuZXhlIiwKICApOwogIGNvbnN0IG5hbWVzcGFjZUV4ZWN1dGFibGUgPSB3aW4zMi5qb2luKAogICAgV0lORE9XU19TWVNURU1fUk9PVCwKICAgICJTeXN0ZW0zMiIsCiAgICAiV2luZG93c1Bvd2VyU2hlbGwiLAogICAgInYxLjAiLAogICAgInBvd2Vyc2hlbGwuZXhlIiwKICApOwogIHZlcmlmeVdpbmRvd3NFeGVjdXRhYmxlQWxpYXNlcyhuYW1lc3BhY2VFeGVjdXRhYmxlLCBleGVjdXRhYmxlLCBmaWxlc3lzdGVtKTsKICByZXR1cm4gewogICAgc3lzdGVtUm9vdCwKICAgIHdvcmtpbmdEaXJlY3RvcnksCiAgICBleGVjdXRhYmxlLAogIH07Cn0KCmZ1bmN0aW9uIHZlcmlmeVdpbmRvd3NFeGVjdXRhYmxlQWxpYXNlcyhuYW1lc3BhY2VFeGVjdXRhYmxlLCBleGVjdXRhYmxlLCBmaWxlc3lzdGVtKSB7CiAgbGV0IG5hbWVzcGFjZURlc2NyaXB0b3I7CiAgbGV0IGNhbmRpZGF0ZURlc2NyaXB0b3I7CiAgbGV0IG9wZXJhdGlvbkVycm9yOwogIHRyeSB7CiAgICBjb25zdCBuYW1lc3BhY2VCZWZvcmUgPSBmaWxlc3lzdGVtLmxzdGF0KG5hbWVzcGFjZUV4ZWN1dGFibGUpOwogICAgY29uc3QgY2FuZGlkYXRlQmVmb3JlID0gZmlsZXN5c3RlbS5sc3RhdChleGVjdXRhYmxlKTsKICAgIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShuYW1lc3BhY2VCZWZvcmUsICJHTE9CQUxST09UIHBhdGgiKTsKICAgIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShjYW5kaWRhdGVCZWZvcmUsICJET1MgcGF0aCIpOwogICAgbmFtZXNwYWNlRGVzY3JpcHRvciA9IGZpbGVzeXN0ZW0ub3BlbihuYW1lc3BhY2VFeGVjdXRhYmxlKTsKICAgIGNhbmRpZGF0ZURlc2NyaXB0b3IgPSBmaWxlc3lzdGVtLm9wZW4oZXhlY3V0YWJsZSk7CiAgICBjb25zdCBuYW1lc3BhY2VPcGVuZWQgPSBmaWxlc3lzdGVtLmZzdGF0KG5hbWVzcGFjZURlc2NyaXB0b3IpOwogICAgY29uc3QgY2FuZGlkYXRlT3BlbmVkID0gZmlsZXN5c3RlbS5mc3RhdChjYW5kaWRhdGVEZXNjcmlwdG9yKTsKICAgIGNvbnN0IG5hbWVzcGFjZUFmdGVyID0gZmlsZXN5c3RlbS5sc3RhdChuYW1lc3BhY2VFeGVjdXRhYmxlKTsKICAgIGNvbnN0IGNhbmRpZGF0ZUFmdGVyID0gZmlsZXN5c3RlbS5sc3RhdChleGVjdXRhYmxlKTsKICAgIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShuYW1lc3BhY2VPcGVuZWQsICJHTE9CQUxST09UIGRlc2NyaXB0b3IiKTsKICAgIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShjYW5kaWRhdGVPcGVuZWQsICJET1MgZGVzY3JpcHRvciIpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKG5hbWVzcGFjZUFmdGVyLCAiR0xPQkFMUk9PVCBwYXRoIik7CiAgICBhc3NlcnRSZWd1bGFyV2luZG93c0V4ZWN1dGFibGUoY2FuZGlkYXRlQWZ0ZXIsICJET1MgcGF0aCIpOwogICAgZm9yIChjb25zdCBpZGVudGl0eSBvZiBbCiAgICAgIG5hbWVzcGFjZUJlZm9yZSwKICAgICAgY2FuZGlkYXRlQmVmb3JlLAogICAgICBuYW1lc3BhY2VPcGVuZWQsCiAgICAgIGNhbmRpZGF0ZU9wZW5lZCwKICAgICAgbmFtZXNwYWNlQWZ0ZXIsCiAgICAgIGNhbmRpZGF0ZUFmdGVyLAogICAgXSkgewogICAgICBpZiAoCiAgICAgICAgaWRlbnRpdHkuZGV2IDw9IDBuIHx8IGlkZW50aXR5LmlubyA8PSAwbiB8fAogICAgICAgIGlkZW50aXR5LmRldiA9PT0gVU5TVVBQT1JURURfRklMRV9JRF82NCB8fCBpZGVudGl0eS5pbm8gPT09IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQKICAgICAgKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCJ0cnVzdGVkIFdpbmRvd3Mgc3lzdGVtIGV4ZWN1dGFibGUgaWRlbnRpdHkgaXMgdW5hdmFpbGFibGUiKTsKICAgICAgfQogICAgfQogICAgaWYgKAogICAgICAhc2FtZUZpbGVJZGVudGl0eShuYW1lc3BhY2VCZWZvcmUsIG5hbWVzcGFjZU9wZW5lZCkgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkobmFtZXNwYWNlT3BlbmVkLCBuYW1lc3BhY2VBZnRlcikgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkoY2FuZGlkYXRlQmVmb3JlLCBjYW5kaWRhdGVPcGVuZWQpIHx8CiAgICAgICFzYW1lRmlsZUlkZW50aXR5KGNhbmRpZGF0ZU9wZW5lZCwgY2FuZGlkYXRlQWZ0ZXIpIHx8CiAgICAgICFzYW1lRmlsZUlkZW50aXR5KG5hbWVzcGFjZU9wZW5lZCwgY2FuZGlkYXRlT3BlbmVkKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigidHJ1c3RlZCBXaW5kb3dzIHN5c3RlbSBleGVjdXRhYmxlIGlkZW50aXR5IG1pc21hdGNoIik7CiAgICB9CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIG9wZXJhdGlvbkVycm9yID0gZXJyb3I7CiAgfQogIGNvbnN0IGNsb3NlRXJyb3JzID0gW107CiAgZm9yIChjb25zdCBkZXNjcmlwdG9yIG9mIFtjYW5kaWRhdGVEZXNjcmlwdG9yLCBuYW1lc3BhY2VEZXNjcmlwdG9yXSkgewogICAgaWYgKGRlc2NyaXB0b3IgPT09IHVuZGVmaW5lZCkgY29udGludWU7CiAgICB0cnkgeyBmaWxlc3lzdGVtLmNsb3NlKGRlc2NyaXB0b3IpOyB9IGNhdGNoIChlcnJvcikgeyBjbG9zZUVycm9ycy5wdXNoKGVycm9yKTsgfQogIH0KICBpZiAob3BlcmF0aW9uRXJyb3IgIT09IHVuZGVmaW5lZCkgewogICAgaWYgKGNsb3NlRXJyb3JzLmxlbmd0aCA+IDApIHsKICAgICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKAogICAgICAgIFtvcGVyYXRpb25FcnJvciwgLi4uY2xvc2VFcnJvcnNdLAogICAgICAgICJ0cnVzdGVkIFdpbmRvd3MgZXhlY3V0YWJsZSB2YWxpZGF0aW9uIGFuZCBjbGVhbnVwIGJvdGggZmFpbGVkIiwKICAgICAgKTsKICAgIH0KICAgIHRocm93IG9wZXJhdGlvbkVycm9yOwogIH0KICBpZiAoY2xvc2VFcnJvcnMubGVuZ3RoID09PSAxKSB0aHJvdyBjbG9zZUVycm9yc1swXTsKICBpZiAoY2xvc2VFcnJvcnMubGVuZ3RoID4gMSkgewogICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKAogICAgICBjbG9zZUVycm9ycywKICAgICAgInRydXN0ZWQgV2luZG93cyBleGVjdXRhYmxlIGRlc2NyaXB0b3IgY2xlYW51cCBmYWlsZWQiLAogICAgKTsKICB9Cn0KCmZ1bmN0aW9uIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShpZGVudGl0eSwgc3BlbGxpbmcpIHsKICBpZiAoIWlkZW50aXR5LmlzRmlsZSgpIHx8IGlkZW50aXR5LmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgdHJ1c3RlZCBXaW5kb3dzICR7c3BlbGxpbmd9IGV4ZWN1dGFibGUgaXMgbm90IGEgcmVndWxhciBub24tbGluayBmaWxlYCk7CiAgfQp9CgpmdW5jdGlvbiBzYW1lRmlsZUlkZW50aXR5KGxlZnQsIHJpZ2h0KSB7CiAgcmV0dXJuIGxlZnQuZGV2ID09PSByaWdodC5kZXYgJiYgbGVmdC5pbm8gPT09IHJpZ2h0LmlubzsKfQoKZnVuY3Rpb24gd2luZG93c1Bvd2VyU2hlbGxFbnZpcm9ubWVudChwYXRocywgdHJ1c3RlZFBhdGhzID0gdHJ1c3RlZFdpbmRvd3NQb3dlclNoZWxsUGF0aCgpKSB7CiAgY29uc3QgeyBzeXN0ZW1Sb290LCB3b3JraW5nRGlyZWN0b3J5IH0gPSB0cnVzdGVkUGF0aHM7CiAgLy8gbGlidXYgZmlsbHMgYSBmaXhlZCBzZXQgb2YgInJlcXVpcmVkIiBXaW5kb3dzIHZhcmlhYmxlcyBmcm9tIHRoZSBwYXJlbnQKICAvLyB3aGVuIHRoZXkgYXJlIGFic2VudC4gRGVmaW5lIGV2ZXJ5IG9uZSBzbyBwb2lzb25lZCBjYWxsZXIgc3RhdGUgY2Fubm90IGJlCiAgLy8gc2lsZW50bHkgaW5oZXJpdGVkIGludG8gdGhlIHZhbGlkYXRpb24gaGVscGVyLgogIHJldHVybiB7CiAgICBBR0VOQ19MT0NLX1BBVEhTOiB3aW5kb3dzUGF0aFRyYW5zcG9ydChwYXRocyksCiAgICBBUFBEQVRBOiAiIiwKICAgIENPTVNQRUM6ICIiLAogICAgSE9NRURSSVZFOiAiIiwKICAgIEhPTUVQQVRIOiAiIiwKICAgIExPQ0FMQVBQREFUQTogIiIsCiAgICBMT0dPTlNFUlZFUjogIiIsCiAgICBQQVRIOiB3b3JraW5nRGlyZWN0b3J5LAogICAgUEFUSEVYVDogIi5FWEUiLAogICAgUFNNT0RVTEVQQVRIOiAiIiwKICAgIFNZU1RFTURSSVZFOiAiIiwKICAgIFNZU1RFTVJPT1Q6IHN5c3RlbVJvb3QsCiAgICBURU1QOiB3b3JraW5nRGlyZWN0b3J5LAogICAgVE1QOiB3b3JraW5nRGlyZWN0b3J5LAogICAgVVNFUkRPTUFJTjogIiIsCiAgICBVU0VSTkFNRTogIiIsCiAgICBVU0VSUFJPRklMRTogd29ya2luZ0RpcmVjdG9yeSwKICAgIFdJTkRJUjogc3lzdGVtUm9vdCwKICB9Owp9CgpmdW5jdGlvbiB3aW5kb3dzUGF0aFRyYW5zcG9ydChlbnRyaWVzKSB7CiAgaWYgKAogICAgIUFycmF5LmlzQXJyYXkoZW50cmllcykgfHwKICAgIGVudHJpZXMubGVuZ3RoIDwgMSB8fAogICAgZW50cmllcy5sZW5ndGggPiBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9FTlRSSUVTCiAgKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoImFnZW5jOiBXaW5kb3dzIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCBoYXMgYW4gaW52YWxpZCBlbnRyeSBjb3VudCIpOwogIH0KICBjb25zdCByZWNvcmRzID0gW107CiAgbGV0IHRyYW5zcG9ydENoYXJzID0gMDsKICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHsKICAgIGNvbnN0IHBhdGggPSBlbnRyeT8ucGF0aDsKICAgIGNvbnN0IHJvbGUgPSBlbnRyeT8ucm9sZTsKICAgIGlmICgKICAgICAgdHlwZW9mIHBhdGggIT09ICJzdHJpbmciIHx8CiAgICAgIHBhdGgubGVuZ3RoID09PSAwIHx8CiAgICAgIHBhdGgubGVuZ3RoID4gV0lORE9XU19QQVRIX1RSQU5TUE9SVF9NQVhfQ0hBUlMgfHwKICAgICAgKHJvbGUgIT09ICJsZWFmRGlyZWN0b3J5IiAmJiByb2xlICE9PSAiYW5jZXN0b3JEaXJlY3RvcnkiICYmIHJvbGUgIT09ICJmaWxlIikKICAgICkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoImFnZW5jOiBXaW5kb3dzIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCBlbnRyeSBpcyBpbnZhbGlkIik7CiAgICB9CiAgICBjb25zdCByZWNvcmQgPSBgJHtyb2xlfToke0J1ZmZlci5mcm9tKHBhdGgsICJ1dGYxNmxlIikudG9TdHJpbmcoImJhc2U2NCIpfWA7CiAgICB0cmFuc3BvcnRDaGFycyArPSByZWNvcmQubGVuZ3RoICsgKHJlY29yZHMubGVuZ3RoID09PSAwID8gMCA6IDEpOwogICAgaWYgKHRyYW5zcG9ydENoYXJzID4gV0lORE9XU19QQVRIX1RSQU5TUE9SVF9NQVhfQ0hBUlMpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJhZ2VuYzogV2luZG93cyBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQgZXhjZWVkcyBpdHMgbGltaXQiKTsKICAgIH0KICAgIHJlY29yZHMucHVzaChyZWNvcmQpOwogIH0KICByZXR1cm4gcmVjb3Jkcy5qb2luKCJcbiIpOwp9Cgphc3luYyBmdW5jdGlvbiBhc3NlcnRXaW5kb3dzUGF0aFNlY3VyaXR5KGVudHJpZXMsIGNvbnRleHQpIHsKICBjb25zdCBkaXNwbGF5UGF0aCA9IGVudHJpZXMuYXQoLTEpPy5wYXRoID8/ICJ1bmtub3duIjsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBkaXNwbGF5UGF0aCk7CiAgY29uc3QgdHJ1c3RlZFBhdGhzID0gdHJ1c3RlZFdpbmRvd3NQb3dlclNoZWxsUGF0aCgpOwogIGNvbnN0IHsgd29ya2luZ0RpcmVjdG9yeSwgZXhlY3V0YWJsZSB9ID0gdHJ1c3RlZFBhdGhzOwogIGxldCByZXN1bHQ7CiAgdHJ5IHsKICAgIHJlc3VsdCA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgKICAgICAgZXhlY3V0YWJsZSwKICAgICAgWwogICAgICAgICItTm9Mb2dvIiwKICAgICAgICAiLU5vUHJvZmlsZSIsCiAgICAgICAgIi1Ob25JbnRlcmFjdGl2ZSIsCiAgICAgICAgIi1FbmNvZGVkQ29tbWFuZCIsCiAgICAgICAgV0lORE9XU19TRUNVUklUWV9TQ1JJUFRfQkFTRTY0LAogICAgICBdLAogICAgICB7CiAgICAgICAgY3dkOiB3b3JraW5nRGlyZWN0b3J5LAogICAgICAgIGVudjogd2luZG93c1Bvd2VyU2hlbGxFbnZpcm9ubWVudChlbnRyaWVzLCB0cnVzdGVkUGF0aHMpLAogICAgICAgIG1heEJ1ZmZlcjogMTAyNCAqIDEwMjQsCiAgICAgICAgd2luZG93c0hpZGU6IHRydWUsCiAgICAgIH0sCiAgICAgIGNvbnRleHQsCiAgICAgIGRpc3BsYXlQYXRoLAogICAgKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgdGhyb3cgbm9ybWFsaXplVGltZWRDb21tYW5kRXJyb3IoZXJyb3IsIGNvbnRleHQsIGRpc3BsYXlQYXRoKTsKICB9CiAgaWYgKHJlc3VsdC5zdGRvdXQgIT09ICJPSyIpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IFdpbmRvd3MgbG9jay1wYXRoIHZhbGlkYXRpb24gcmV0dXJuZWQgYW4gaW52YWxpZCByZXNwb25zZSBmb3IgJHtkaXNwbGF5UGF0aH1gKTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgZGlzcGxheVBhdGgpOwp9CgpmdW5jdGlvbiB1bnN1cHBvcnRlZExvY2tGaWxlc3lzdGVtKHBhcmVudCwgZmlsZXN5c3RlbVR5cGUsIGNhdXNlKSB7CiAgcmV0dXJuIG5ldyBFcnJvcigKICAgIGBhZ2VuYzogbm9uLWxvY2FsIG9yIHVua25vd24gbG9jayBmaWxlc3lzdGVtIGlzIHVuc3VwcG9ydGVkICgke2ZpbGVzeXN0ZW1UeXBlID8/ICJ1bmtub3duIn0pOiAke3BhcmVudH1gLAogICAgY2F1c2UgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHsgY2F1c2UgfSwKICApOwp9Cgphc3luYyBmdW5jdGlvbiBhc3NlcnRMb2NhbEZpbGVzeXN0ZW0ocGFyZW50LCBjb250ZXh0KSB7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGFyZW50KTsKICBsZXQgZmlsZXN5c3RlbVR5cGU7CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJsaW51eCIpIHsKICAgIGNvbnN0IG1vdW50cyA9IGF3YWl0IHJlYWRGaWxlKCIvcHJvYy9zZWxmL21vdW50aW5mbyIsICJ1dGY4Iik7CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXJlbnQpOwogICAgbGV0IGxvbmdlc3QgPSAtMTsKICAgIGZvciAoY29uc3QgbGluZSBvZiBtb3VudHMuc3BsaXQoIlxuIikpIHsKICAgICAgY29uc3QgZmllbGRzID0gbGluZS5zcGxpdCgiICIpOwogICAgICBjb25zdCBzZXBhcmF0b3JJbmRleCA9IGZpZWxkcy5pbmRleE9mKCItIik7CiAgICAgIGlmICgKICAgICAgICBzZXBhcmF0b3JJbmRleCA8IDYgfHwKICAgICAgICBmaWVsZHNbNF0gPT09IHVuZGVmaW5lZCB8fAogICAgICAgIGZpZWxkc1tzZXBhcmF0b3JJbmRleCArIDFdID09PSB1bmRlZmluZWQKICAgICAgKSBjb250aW51ZTsKICAgICAgY29uc3QgbW91bnRQb2ludCA9IGRlY29kZU1vdW50UGF0aChmaWVsZHNbNF0pOwogICAgICBpZiAocGF0aElzV2l0aGluKHBhcmVudCwgbW91bnRQb2ludCkgJiYgbW91bnRQb2ludC5sZW5ndGggPiBsb25nZXN0KSB7CiAgICAgICAgbG9uZ2VzdCA9IG1vdW50UG9pbnQubGVuZ3RoOwogICAgICAgIGZpbGVzeXN0ZW1UeXBlID0gZmllbGRzW3NlcGFyYXRvckluZGV4ICsgMV07CiAgICAgIH0KICAgIH0KICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJkYXJ3aW4iKSB7CiAgICBjb25zdCBwcm9iZVN0YXJ0ZWRBdCA9IHBlcmZvcm1hbmNlLm5vdygpOwogICAgY29uc3QgcHJvYmVEZWFkbGluZSA9IE1hdGgubWluKAogICAgICBjb250ZXh0LmRlYWRsaW5lLAogICAgICBwcm9iZVN0YXJ0ZWRBdCArIERBUldJTl9GSUxFU1lTVEVNX1BST0JFX1RJTUVPVVRfTVMsCiAgICApOwogICAgY29uc3QgcHJvYmVDb250ZXh0ID0gewogICAgICAuLi5jb250ZXh0LAogICAgICBkZWFkbGluZTogcHJvYmVEZWFkbGluZSwKICAgICAgdGltZW91dE1zOiBNYXRoLm1pbigKICAgICAgICBEQVJXSU5fRklMRVNZU1RFTV9QUk9CRV9USU1FT1VUX01TLAogICAgICAgIE1hdGgubWF4KDEsIE1hdGguY2VpbChwcm9iZURlYWRsaW5lIC0gcHJvYmVTdGFydGVkQXQpKSwKICAgICAgKSwKICAgICAgbGFiZWw6IGAke2NvbnRleHQubGFiZWx9IChtYWNPUyBsb2NrIGZpbGVzeXN0ZW0gcHJvYmUgdmlhIC9iaW4vZGYpYCwKICAgIH07CiAgICBsZXQgcmVzdWx0OwogICAgdHJ5IHsKICAgICAgLy8gV2l0aCBhbiBleGlzdGluZyBkaXJlY3Rvcnkgb3BlcmFuZCwgZGYgY2FsbHMgc3RhdGZzIG9uIHRoYXQgcGF0aC4KICAgICAgLy8gLVQgZmlsdGVycyBmX2ZzdHlwZW5hbWUgYWdhaW5zdCBvdXIgZXhhY3QgYWxsb3dsaXN0LCBpbmNsdWRpbmcgb24KICAgICAgLy8gc3VwcG9ydGVkIG1hY09TIHZlcnNpb25zIHRoYXQgY2Fubm90IHByaW50IHRoZSB0eXBlIHdpdGggZGYgLVkuCiAgICAgIC8vIE5ldmVyIHVzZSBhIGJhcmUgbW91bnQvZGYgb3IgZGYgLWw6IHVucmVsYXRlZCBmaWxlc3lzdGVtcyBtYXkgYmUgc3R1Y2suCiAgICAgIHJlc3VsdCA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgKICAgICAgICAiL2Jpbi9kZiIsCiAgICAgICAgWyItUCIsICItVCIsIFsuLi5MT0NBTF9GSUxFU1lTVEVNX1RZUEVTXS5qb2luKCIsIiksIHBhcmVudF0sCiAgICAgICAgeyBlbnY6IHsgTENfQUxMOiAiQyIgfSwgbWF4QnVmZmVyOiA2NCAqIDEwMjQgfSwKICAgICAgICBwcm9iZUNvbnRleHQsCiAgICAgICAgcGFyZW50LAogICAgICApOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBwcm9iZUNvbnRleHQsIHBhcmVudCk7CiAgICAgIGlmIChub3JtYWxpemVkIGluc3RhbmNlb2YgTG9jYWxTcWxpdGVMb2NrVGltZW91dEVycm9yKSB0aHJvdyBub3JtYWxpemVkOwogICAgICB0aHJvdyB1bnN1cHBvcnRlZExvY2tGaWxlc3lzdGVtKHBhcmVudCwgdW5kZWZpbmVkLCBub3JtYWxpemVkKTsKICAgIH0KICAgIHRocm93SWZFeHBpcmVkKHByb2JlQ29udGV4dCwgcGFyZW50KTsKICAgIGNvbnN0IGxpbmVzID0gcmVzdWx0LnN0ZG91dC5zcGxpdCgiXG4iKTsKICAgIGlmIChsaW5lcy5hdCgtMSkgPT09ICIiKSBsaW5lcy5wb3AoKTsKICAgIGNvbnN0IHJvdyA9IGxpbmVzWzFdPy5tYXRjaCgvXi4rW1x0IF0rXGQrW1x0IF0rXGQrW1x0IF0rLT9cZCtbXHQgXStcZCslW1x0IF0rKFwvLiopJC91KTsKICAgIC8vIFRoZSB0eXBlIHdhcyBjaGVja2VkIGJ5IGRmIG9uIHRoZSBvcGVyYW5kIGl0c2VsZi4gRG8gbm90IGluZmVyIGl0IGZyb20KICAgIC8vIHRoZSBwcmludGVkIG1vdW50IHBvaW50OiBBUEZTIGZpcm1saW5rcyBjYW4gbWFwIC9Vc2VycyB0byB0aGUgRGF0YSB2b2x1bWUKICAgIC8vIG1vdW50ZWQgYXQgL1N5c3RlbS9Wb2x1bWVzL0RhdGEgd2l0aG91dCBjaGFuZ2luZyByZWFscGF0aCgvVXNlcnMvLi4uKS4KICAgIGlmICgKICAgICAgcmVzdWx0LnN0ZGVyciAhPT0gIiIgfHwgbGluZXMubGVuZ3RoICE9PSAyIHx8CiAgICAgICEvXkZpbGVzeXN0ZW1bXHQgXSs1MTItYmxvY2tzW1x0IF0rVXNlZFtcdCBdK0F2YWlsKD86YWJsZSk/W1x0IF0rQ2FwYWNpdHlbXHQgXStNb3VudGVkIG9uJC91LnRlc3QobGluZXNbMF0pIHx8CiAgICAgIHJvdyA9PSBudWxsCiAgICApIHsKICAgICAgdGhyb3cgdW5zdXBwb3J0ZWRMb2NrRmlsZXN5c3RlbShwYXJlbnQpOwogICAgfQogICAgcmV0dXJuOwogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gIndpbjMyIikgewogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eShbeyBwYXRoOiBwYXJlbnQsIHJvbGU6ICJsZWFmRGlyZWN0b3J5IiB9XSwgY29udGV4dCk7CiAgICByZXR1cm47CiAgfSBlbHNlIHsKICAgIHRocm93IG5ldyBFcnJvcigKICAgICAgYGFnZW5jOiBjYW5ub3QgZXN0YWJsaXNoIGxvY2sgZmlsZXN5c3RlbSBsb2NhbGl0eSBvbiAke3Byb2Nlc3MucGxhdGZvcm19YCwKICAgICk7CiAgfQogIGlmIChmaWxlc3lzdGVtVHlwZSA9PT0gdW5kZWZpbmVkIHx8ICFMT0NBTF9GSUxFU1lTVEVNX1RZUEVTLmhhcyhmaWxlc3lzdGVtVHlwZSkpIHsKICAgIHRocm93IHVuc3VwcG9ydGVkTG9ja0ZpbGVzeXN0ZW0ocGFyZW50LCBmaWxlc3lzdGVtVHlwZSk7CiAgfQp9CgovKioKICogRXN0YWJsaXNoIHRoYXQgYW4gZXhpc3RpbmcgZGlyZWN0b3J5IGlzIGEgbG9jYWwsIHByaXZhdGVseSBtdXRhYmxlCiAqIGNvb3JkaW5hdGlvbiBib3VuZGFyeS4gV3JhcHBlciByZXBsYWNlbWVudCB1c2VzIGEgcmVnaXN0cnktaG9zdGVkIFNRTGl0ZQogKiBsb2NrLCBzbyBhIHNoYXJlZCBvciBhdHRhY2tlci13cml0YWJsZSB3cmFwcGVyIGRpcmVjdG9yeSB3b3VsZCBvdGhlcndpc2UKICogcGVybWl0IGNyb3NzLWhvc3QgcmFjZXMgb3IgcGF0aCBzdWJzdGl0dXRpb24gb3V0c2lkZSB0aGF0IGxvY2suCiAqLwpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYXNzZXJ0TG9jYWxQcml2YXRlRGlyZWN0b3J5KAogIHJlcXVlc3RlZFBhdGgsCiAgewogICAgdGltZW91dE1zID0gNjBfMDAwLAogICAgbGFiZWwgPSAiQWdlbkMgb3BlcmF0aW9uIiwKICAgIGRlYWRsaW5lOiBzdXBwbGllZERlYWRsaW5lLAogICAgYWxsb3dUcnVzdGVkU3RpY2t5TGVhZiA9IGZhbHNlLAogICAgb25Qcm9ncmVzcywKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgaWYgKHR5cGVvZiBhbGxvd1RydXN0ZWRTdGlja3lMZWFmICE9PSAiYm9vbGVhbiIpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImFsbG93VHJ1c3RlZFN0aWNreUxlYWYgbXVzdCBiZSBib29sZWFuIik7CiAgfQogIGlmIChvblByb2dyZXNzICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIG9uUHJvZ3Jlc3MgIT09ICJmdW5jdGlvbiIpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgb25Qcm9ncmVzcyBtdXN0IGJlIGEgZnVuY3Rpb24iKTsKICB9CiAgY29uc3QgY29udGV4dCA9IHsKICAgIGRlYWRsaW5lOiBNYXRoLm1pbigKICAgICAgc3VwcGxpZWREZWFkbGluZSA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksCiAgICAgIHBlcmZvcm1hbmNlLm5vdygpICsgdGltZW91dE1zLAogICAgKSwKICAgIGxhYmVsLAogICAgdGltZW91dE1zLAogICAgb25Qcm9ncmVzcywKICB9OwogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJwcml2YXRlIGRpcmVjdG9yeSB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUocmVxdWVzdGVkUGF0aCk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKGFic29sdXRlKTsKICBjb25zdCBhbmNlc3RvcnMgPSBbXTsKICBmb3IgKGxldCBjdXJyZW50ID0gY2Fub25pY2FsOyA7IGN1cnJlbnQgPSBkaXJuYW1lKGN1cnJlbnQpKSB7CiAgICBhbmNlc3RvcnMucHVzaChjdXJyZW50KTsKICAgIGlmIChkaXJuYW1lKGN1cnJlbnQpID09PSBjdXJyZW50KSBicmVhazsKICB9CiAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICBjb25zdCBiZWZvcmVJZGVudGl0aWVzID0gbmV3IE1hcCgpOwogIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBhbmNlc3RvcnMubGVuZ3RoOyBpbmRleCArPSAxKSB7CiAgICBjb25zdCBwYXRoID0gYW5jZXN0b3JzW2luZGV4XTsKICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBpZiAoIXN0YXRzLmlzRGlyZWN0b3J5KCkgfHwgc3RhdHMuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgcGF0aCBhbmNlc3RvciBpcyBub3QgYSByZWFsIGRpcmVjdG9yeTogJHtwYXRofWApOwogICAgfQogICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICJ3aW4zMiIpIHsKICAgICAgY29uc3QgbGVhZiA9IGluZGV4ID09PSAwOwogICAgICBjb25zdCB0cnVzdGVkT3duZXIgPSBzdGF0cy51aWQgPT09IDBuIHx8CiAgICAgICAgKGN1cnJlbnRVaWQgIT09IHVuZGVmaW5lZCAmJiBzdGF0cy51aWQgPT09IEJpZ0ludChjdXJyZW50VWlkKSk7CiAgICAgIGNvbnN0IHN0aWNreUJvdW5kYXJ5ID0gKCFsZWFmIHx8IGFsbG93VHJ1c3RlZFN0aWNreUxlYWYpICYmCiAgICAgICAgKHN0YXRzLm1vZGUgJiAwbzEwMDBuKSAhPT0gMG4gJiYgdHJ1c3RlZE93bmVyOwogICAgICBpZiAoIXRydXN0ZWRPd25lciB8fCAoKHN0YXRzLm1vZGUgJiAwbzAyMm4pICE9PSAwbiAmJiAhc3RpY2t5Qm91bmRhcnkpKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKAogICAgICAgICAgYGFnZW5jOiBwcm90ZWN0ZWQgZGlyZWN0b3J5IGNoYWluIHBlcm1pdHMgdW50cnVzdGVkIG11dGF0aW9uOiAke3BhdGh9OyBgICsKICAgICAgICAgICJyZW1vdmUgZ3JvdXAvd29ybGQgd3JpdGUgYWNjZXNzIGJlZm9yZSByZXRyeWluZyIsCiAgICAgICAgKTsKICAgICAgfQogICAgICBpZiAoCiAgICAgICAgbGVhZiAmJiAhc3RpY2t5Qm91bmRhcnkgJiYgY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmCiAgICAgICAgc3RhdHMudWlkICE9PSBCaWdJbnQoY3VycmVudFVpZCkKICAgICAgKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGRpcmVjdG9yeSBpcyBub3Qgb3duZWQgYnkgdGhlIGN1cnJlbnQgdXNlcjogJHtwYXRofWApOwogICAgICB9CiAgICB9CiAgICBiZWZvcmVJZGVudGl0aWVzLnNldChwYXRoLCB7IGRldjogc3RhdHMuZGV2LCBpbm86IHN0YXRzLmlubyB9KTsKICAgIGlkZW50aXR5RnJvbVN0YXRzKHN0YXRzLCBwYXRoKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJXaW5kb3dzIGFuY2VzdG9yIEFDTCB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoCiAgICAgIGFuY2VzdG9ycy5tYXAoKHBhdGgsIGluZGV4KSA9PiAoewogICAgICAgIHBhdGgsCiAgICAgICAgcm9sZTogaW5kZXggPT09IDAgPyAibGVhZkRpcmVjdG9yeSIgOiAiYW5jZXN0b3JEaXJlY3RvcnkiLAogICAgICB9KSksCiAgICAgIGNvbnRleHQsCiAgICApOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIldpbmRvd3MgYW5jZXN0b3IgQUNMIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICB9IGVsc2UgewogICAgYXdhaXQgYXNzZXJ0TG9jYWxGaWxlc3lzdGVtKGNhbm9uaWNhbCwgY29udGV4dCk7CiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGFuY2VzdG9ycy5sZW5ndGg7IGluZGV4ICs9IDEpIHsKICAgICAgICBhd2FpdCBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkoCiAgICAgICAgICBhbmNlc3RvcnNbaW5kZXhdLAogICAgICAgICAgaW5kZXggPT09IDAgPyAibGVhZiBkaXJlY3RvcnkiIDogImFuY2VzdG9yIGRpcmVjdG9yeSIsCiAgICAgICAgICBjb250ZXh0LAogICAgICAgICk7CiAgICAgIH0KICAgIH0KICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgY2Fub25pY2FsKTsKICBmb3IgKGNvbnN0IHBhdGggb2YgYW5jZXN0b3JzKSB7CiAgICBjb25zdCBhZnRlciA9IGF3YWl0IGxzdGF0KHBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogICAgY29uc3QgYmVmb3JlID0gYmVmb3JlSWRlbnRpdGllcy5nZXQocGF0aCk7CiAgICBpZiAoCiAgICAgICFhZnRlci5pc0RpcmVjdG9yeSgpIHx8IGFmdGVyLmlzU3ltYm9saWNMaW5rKCkgfHwgYmVmb3JlID09PSB1bmRlZmluZWQgfHwKICAgICAgYWZ0ZXIuZGV2ICE9PSBiZWZvcmUuZGV2IHx8IGFmdGVyLmlubyAhPT0gYmVmb3JlLmlubwogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBkaXJlY3RvcnkgaWRlbnRpdHkgY2hhbmdlZCBkdXJpbmcgdmFsaWRhdGlvbjogJHtwYXRofWApOwogICAgfQogIH0KICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAicHJpdmF0ZSBkaXJlY3RvcnkgdmFsaWRhdGlvbiBjb21wbGV0ZSIpOwogIHJldHVybiBjYW5vbmljYWw7Cn0KCmZ1bmN0aW9uIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHN0YXRzLCBwYXRoKSB7CiAgaWYgKCFzdGF0cy5pc0ZpbGUoKSB8fCBzdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGlzIG5vdCBhIHJlZ3VsYXIgZmlsZTogJHtwYXRofWApOwogIH0KICBpZiAoc3RhdHMubmxpbmsgIT09IDFuKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIG11c3Qgbm90IGhhdmUgaGFyZC1saW5rIGFsaWFzZXM6ICR7cGF0aH1gKTsKICB9Cn0KCmZ1bmN0aW9uIGlkZW50aXR5RnJvbVN0YXRzKHN0YXRzLCBwYXRoKSB7CiAgaWYgKAogICAgc3RhdHMuZGV2ID09PSAwbiB8fAogICAgc3RhdHMuaW5vID09PSAwbiB8fAogICAgc3RhdHMuaW5vID09PSAtMW4gfHwKICAgIEJpZ0ludC5hc1VpbnROKDY0LCBzdGF0cy5pbm8pID09PSBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0CiAgKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGhhcyBubyBzdGFibGUgZmlsZXN5c3RlbSBpZGVudGl0eTogJHtwYXRofWApOwogIH0KICByZXR1cm4gYCR7c3RhdHMuZGV2fToke3N0YXRzLmlub31gOwp9CgpmdW5jdGlvbiBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgcGF0aCwga2luZCkgewogIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAid2luMzIiKSByZXR1cm47CiAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICBpZiAoY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmIHN0YXRzLnVpZCAhPT0gQmlnSW50KGN1cnJlbnRVaWQpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlICR7a2luZH0gaXMgbm90IG93bmVkIGJ5IHRoZSBjdXJyZW50IHVzZXI6ICR7cGF0aH1gKTsKICB9CiAgaWYgKChzdGF0cy5tb2RlICYgMG8wMjJuKSAhPT0gMG4pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgJHtraW5kfSBpcyBncm91cC93b3JsZC13cml0YWJsZTogJHtwYXRofWApOwogIH0KfQoKLyoqCiAqIFZhbGlkYXRlIGEgcmVndWxhciBmaWxlIGFuZCBpdHMgY29tcGxldGUgZGlyZWN0b3J5IGNoYWluIGJlZm9yZSBhIGNhbGxlcgogKiB0cnVzdHMgaXRzIGNvbnRlbnRzLiBUaGlzIGlzIGludGVudGlvbmFsbHkgbm9uLW11dGF0aW5nOiB1bnNhZmUgb3duZXJzaGlwLAogKiBtb2RlIGJpdHMsIEFDTHMsIGFsaWFzZXMsIG9yIGlkZW50aXR5IGNoYW5nZXMgZmFpbCBjbG9zZWQuCiAqLwpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYXNzZXJ0TG9jYWxQcml2YXRlRmlsZSgKICByZXF1ZXN0ZWRQYXRoLAogIHsKICAgIHRpbWVvdXRNcyA9IDYwXzAwMCwKICAgIGxhYmVsID0gIkFnZW5DIG9wZXJhdGlvbiIsCiAgICBkZWFkbGluZTogc3VwcGxpZWREZWFkbGluZSwKICAgIG9uUHJvZ3Jlc3MsCiAgfSA9IHt9LAopIHsKICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRpbWVvdXRNcykgfHwgdGltZW91dE1zIDw9IDApIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgdGltZW91dE1zIG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXIiKTsKICB9CiAgaWYgKHN1cHBsaWVkRGVhZGxpbmUgIT09IHVuZGVmaW5lZCAmJiAhTnVtYmVyLmlzRmluaXRlKHN1cHBsaWVkRGVhZGxpbmUpKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIGRlYWRsaW5lIG11c3QgYmUgZmluaXRlIik7CiAgfQogIGlmIChvblByb2dyZXNzICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIG9uUHJvZ3Jlc3MgIT09ICJmdW5jdGlvbiIpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgb25Qcm9ncmVzcyBtdXN0IGJlIGEgZnVuY3Rpb24iKTsKICB9CiAgY29uc3QgY29udGV4dCA9IHsKICAgIGRlYWRsaW5lOiBNYXRoLm1pbigKICAgICAgc3VwcGxpZWREZWFkbGluZSA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksCiAgICAgIHBlcmZvcm1hbmNlLm5vdygpICsgdGltZW91dE1zLAogICAgKSwKICAgIGxhYmVsLAogICAgdGltZW91dE1zLAogICAgb25Qcm9ncmVzcywKICB9OwogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJwcml2YXRlIGZpbGUgdmFsaWRhdGlvbiBzdGFydGVkIik7CiAgY29uc3QgYWJzb2x1dGUgPSByZXNvbHZlKHJlcXVlc3RlZFBhdGgpOwogIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoYWJzb2x1dGUpOwogIGNvbnN0IGNhbm9uaWNhbFBhcmVudCA9IGF3YWl0IGFzc2VydExvY2FsUHJpdmF0ZURpcmVjdG9yeShwYXJlbnQsIHsKICAgIHRpbWVvdXRNcywKICAgIGxhYmVsLAogICAgZGVhZGxpbmU6IGNvbnRleHQuZGVhZGxpbmUsCiAgICAuLi4ob25Qcm9ncmVzcyA9PT0gdW5kZWZpbmVkID8ge30gOiB7IG9uUHJvZ3Jlc3MgfSksCiAgfSk7CiAgaWYgKGNhbm9uaWNhbFBhcmVudCAhPT0gcGFyZW50KSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZmlsZSBwYXJlbnQgbXVzdCB1c2UgaXRzIGNhbm9uaWNhbCBwYXRoOiAke3BhcmVudH1gKTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IGJlZm9yZSA9IGF3YWl0IGxzdGF0KGFic29sdXRlLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoIWJlZm9yZS5pc0ZpbGUoKSB8fCBiZWZvcmUuaXNTeW1ib2xpY0xpbmsoKSB8fCBiZWZvcmUubmxpbmsgIT09IDFuKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZmlsZSBtdXN0IGJlIGEgcmVndWxhciBzaW5nbGUtbGluayBmaWxlOiAke2Fic29sdXRlfWApOwogIH0KICBpZGVudGl0eUZyb21TdGF0cyhiZWZvcmUsIGFic29sdXRlKTsKICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gIndpbjMyIikgewogICAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICAgIGlmIChjdXJyZW50VWlkICE9PSB1bmRlZmluZWQgJiYgYmVmb3JlLnVpZCAhPT0gQmlnSW50KGN1cnJlbnRVaWQpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlzIG5vdCBvd25lZCBieSB0aGUgY3VycmVudCB1c2VyOiAke2Fic29sdXRlfWApOwogICAgfQogICAgaWYgKChiZWZvcmUubW9kZSAmIDBvMDIybikgIT09IDBuKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlzIGdyb3VwL3dvcmxkLXdyaXRhYmxlOiAke2Fic29sdXRlfWApOwogICAgfQogIH0KICBjb25zdCBjYW5vbmljYWwgPSBhd2FpdCByZWFscGF0aChhYnNvbHV0ZSk7CiAgaWYgKGNhbm9uaWNhbCAhPT0gYWJzb2x1dGUpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIG11c3QgdXNlIGl0cyBjYW5vbmljYWwgcGF0aDogJHthYnNvbHV0ZX1gKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJXaW5kb3dzIGZpbGUgQUNMIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eShbeyBwYXRoOiBjYW5vbmljYWwsIHJvbGU6ICJmaWxlIiB9XSwgY29udGV4dCk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiV2luZG93cyBmaWxlIEFDTCB2YWxpZGF0aW9uIGNvbXBsZXRlIik7CiAgfSBlbHNlIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgYXdhaXQgYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5KGNhbm9uaWNhbCwgImZpbGUiLCBjb250ZXh0KTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgY2Fub25pY2FsKTsKICBjb25zdCBhZnRlciA9IGF3YWl0IGxzdGF0KGNhbm9uaWNhbCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgaWYgKAogICAgIWFmdGVyLmlzRmlsZSgpIHx8IGFmdGVyLmlzU3ltYm9saWNMaW5rKCkgfHwgYWZ0ZXIubmxpbmsgIT09IDFuIHx8CiAgICBhZnRlci5kZXYgIT09IGJlZm9yZS5kZXYgfHwgYWZ0ZXIuaW5vICE9PSBiZWZvcmUuaW5vCiAgKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZmlsZSBpZGVudGl0eSBjaGFuZ2VkIGR1cmluZyB2YWxpZGF0aW9uOiAke2Nhbm9uaWNhbH1gKTsKICB9CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgInByaXZhdGUgZmlsZSB2YWxpZGF0aW9uIGNvbXBsZXRlIik7CiAgcmV0dXJuIGNhbm9uaWNhbDsKfQoKYXN5bmMgZnVuY3Rpb24gcHJlcGFyZUxvY2tQYXRoKHJlcXVlc3RlZFBhdGgsIGNvbnRleHQpIHsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUocmVxdWVzdGVkUGF0aCk7CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgcGF0aCBwcmVwYXJhdGlvbiBzdGFydGVkIik7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGF3YWl0IG1rZGlyKGRpcm5hbWUoYWJzb2x1dGUpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgbW9kZTogMG83MDAgfSk7CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgcGFyZW50IGNyZWF0aW9uIGNvbXBsZXRlIik7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IHBhcmVudCA9IGF3YWl0IHJlYWxwYXRoKGRpcm5hbWUoYWJzb2x1dGUpKTsKICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBwYXJlbnQgY2Fub25pY2FsaXphdGlvbiBjb21wbGV0ZSIpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGFic29sdXRlKTsKICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBwYXJlbnQgc2VjdXJpdHkgdmFsaWRhdGlvbiBzdGFydGVkIik7CiAgY29uc3QgdmFsaWRhdGVkUGFyZW50ID0gYXdhaXQgYXNzZXJ0TG9jYWxQcml2YXRlRGlyZWN0b3J5KHBhcmVudCwgewogICAgdGltZW91dE1zOiBjb250ZXh0LnRpbWVvdXRNcywKICAgIGxhYmVsOiBjb250ZXh0LmxhYmVsLAogICAgZGVhZGxpbmU6IGNvbnRleHQuZGVhZGxpbmUsCiAgICAuLi4oY29udGV4dC5vblByb2dyZXNzID09PSB1bmRlZmluZWQKICAgICAgPyB7fQogICAgICA6IHsgb25Qcm9ncmVzczogY29udGV4dC5vblByb2dyZXNzIH0pLAogIH0pOwogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJsb2NrIHBhcmVudCBzZWN1cml0eSB2YWxpZGF0aW9uIGNvbXBsZXRlIik7CiAgaWYgKHZhbGlkYXRlZFBhcmVudCAhPT0gcGFyZW50KSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIHBhcmVudCBtdXN0IHVzZSBpdHMgY2Fub25pY2FsIHBhdGg6ICR7cGFyZW50fWApOwogIH0KICBjb25zdCBwYXJlbnRTdGF0cyA9IGF3YWl0IGxzdGF0KHBhcmVudCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgaWYgKCFwYXJlbnRTdGF0cy5pc0RpcmVjdG9yeSgpIHx8IHBhcmVudFN0YXRzLmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgcGFyZW50IGlzIG5vdCBhIHJlYWwgZGlyZWN0b3J5OiAke3BhcmVudH1gKTsKICB9CiAgYXNzZXJ0UG9zaXhPd25lcnNoaXAocGFyZW50U3RhdHMsIHBhcmVudCwgInBhcmVudCIpOwoKICBjb25zdCBwYXRoID0gam9pbihwYXJlbnQsIGJhc2VuYW1lKGFic29sdXRlKSk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7CiAgdHJ5IHsKICAgIGNvbnN0IGhhbmRsZSA9IGF3YWl0IG9wZW4ocGF0aCwgInd4IiwgMG82MDApOwogICAgdHJ5IHsKICAgICAgYXdhaXQgaGFuZGxlLmNsb3NlKCk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBhd2FpdCBoYW5kbGUuY2xvc2UoKS5jYXRjaCgoKSA9PiB7fSk7CiAgICAgIHRocm93IGVycm9yOwogICAgfQogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBpZiAoZXJyb3I/LmNvZGUgIT09ICJFRVhJU1QiKSB0aHJvdyBlcnJvcjsKICB9CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgZGF0YWJhc2UgZmlsZSBjcmVhdGlvbiBjb21wbGV0ZSIpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIGNvbnN0IHBhdGhTdGF0cyA9IGF3YWl0IGxzdGF0KHBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHBhdGhTdGF0cywgcGF0aCk7CiAgYXNzZXJ0UG9zaXhPd25lcnNoaXAocGF0aFN0YXRzLCBwYXRoLCAiZmlsZSIpOwogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKHBhdGgpOwogIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQoY2Fub25pY2FsLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBhc3NlcnRSZWd1bGFyU2luZ2xlTGluayhzdGF0cywgY2Fub25pY2FsKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgY2Fub25pY2FsLCAiZmlsZSIpOwogIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAid2luMzIiKSB7CiAgICBhd2FpdCBjaG1vZChjYW5vbmljYWwsIDBvNjAwKTsKICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgICBhd2FpdCBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkoY2Fub25pY2FsLCAibG9jayBkYXRhYmFzZSBmaWxlIiwgY29udGV4dCk7CiAgICB9CiAgfSBlbHNlIHsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJsb2NrIGRhdGFiYXNlIEFDTCB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoWwogICAgICB7IHBhdGg6IHBhcmVudCwgcm9sZTogImxlYWZEaXJlY3RvcnkiIH0sCiAgICAgIHsgcGF0aDogY2Fub25pY2FsLCByb2xlOiAiZmlsZSIgfSwKICAgIF0sIGNvbnRleHQpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgZGF0YWJhc2UgQUNMIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgY2Fub25pY2FsKTsKICBjb25zdCBzZWN1cmVkU3RhdHMgPSBhd2FpdCBsc3RhdChjYW5vbmljYWwsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHNlY3VyZWRTdGF0cywgY2Fub25pY2FsKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChzZWN1cmVkU3RhdHMsIGNhbm9uaWNhbCwgImZpbGUiKTsKICByZXR1cm4gewogICAgcGF0aDogY2Fub25pY2FsLAogICAgcGFyZW50LAogICAgZGV2OiBzZWN1cmVkU3RhdHMuZGV2LAogICAgaW5vOiBzZWN1cmVkU3RhdHMuaW5vLAogICAgaWRlbnRpdHlLZXk6IGlkZW50aXR5RnJvbVN0YXRzKHNlY3VyZWRTdGF0cywgY2Fub25pY2FsKSwKICB9Owp9Cgphc3luYyBmdW5jdGlvbiByZXZhbGlkYXRlUHJlcGFyZWRMb2NrKAogIHByZXBhcmVkLAogIGNvbnRleHQsCiAgeyB2YWxpZGF0ZVdpbmRvd3NBY2wgPSBmYWxzZSB9ID0ge30sCikgewogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpOwogIGNvbnN0IHBhcmVudFN0YXRzID0gYXdhaXQgbHN0YXQocHJlcGFyZWQucGFyZW50LCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoIXBhcmVudFN0YXRzLmlzRGlyZWN0b3J5KCkgfHwgcGFyZW50U3RhdHMuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBwYXJlbnQgaXMgbm8gbG9uZ2VyIGEgcmVhbCBkaXJlY3Rvcnk6ICR7cHJlcGFyZWQucGFyZW50fWApOwogIH0KICBhc3NlcnRQb3NpeE93bmVyc2hpcChwYXJlbnRTdGF0cywgcHJlcGFyZWQucGFyZW50LCAicGFyZW50Iik7CiAgY29uc3Qgc3RhdHMgPSBhd2FpdCBsc3RhdChwcmVwYXJlZC5wYXRoLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBhc3NlcnRSZWd1bGFyU2luZ2xlTGluayhzdGF0cywgcHJlcGFyZWQucGF0aCk7CiAgYXNzZXJ0UG9zaXhPd25lcnNoaXAoc3RhdHMsIHByZXBhcmVkLnBhdGgsICJmaWxlIik7CiAgaWYgKHN0YXRzLmRldiAhPT0gcHJlcGFyZWQuZGV2IHx8IHN0YXRzLmlubyAhPT0gcHJlcGFyZWQuaW5vKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGlkZW50aXR5IGNoYW5nZWQgZHVyaW5nIGFjcXVpc2l0aW9uOiAke3ByZXBhcmVkLnBhdGh9YCk7CiAgfQogIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAid2luMzIiICYmIHZhbGlkYXRlV2luZG93c0FjbCkgewogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eShbCiAgICAgIHsgcGF0aDogcHJlcGFyZWQucGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfSwKICAgICAgeyBwYXRoOiBwcmVwYXJlZC5wYXRoLCByb2xlOiAiZmlsZSIgfSwKICAgIF0sIGNvbnRleHQpOwogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eShwcmVwYXJlZC5wYXRoLCAibG9jayBkYXRhYmFzZSBmaWxlIiwgY29udGV4dCk7CiAgfQogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpOwp9CgpmdW5jdGlvbiBwcmFnbWFWYWx1ZShkYXRhYmFzZSwgcHJhZ21hKSB7CiAgY29uc3Qgcm93ID0gZGF0YWJhc2UucHJlcGFyZShgUFJBR01BICR7cHJhZ21hfWApLmdldCgpOwogIHJldHVybiByb3cgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IE9iamVjdC52YWx1ZXMocm93KVswXTsKfQoKZnVuY3Rpb24gcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCBwcmFnbWEpIHsKICBjb25zdCB2YWx1ZSA9IHByYWdtYVZhbHVlKGRhdGFiYXNlLCBwcmFnbWEpOwogIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICJudW1iZXIiID8gdmFsdWUgOiB1bmRlZmluZWQ7Cn0KCmZ1bmN0aW9uIHByYWdtYVRleHQoZGF0YWJhc2UsIHByYWdtYSkgewogIGNvbnN0IHZhbHVlID0gcHJhZ21hVmFsdWUoZGF0YWJhc2UsIHByYWdtYSk7CiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gInN0cmluZyIgPyB2YWx1ZS50b0xvd2VyQ2FzZSgpIDogdW5kZWZpbmVkOwp9CgpleHBvcnQgZnVuY3Rpb24gY29uZmlndXJlTG9jYWxTcWxpdGVMb2NrQ29ubmVjdGlvbihkYXRhYmFzZSkgewogIGRhdGFiYXNlLmV4ZWMoIlBSQUdNQSBidXN5X3RpbWVvdXQgPSAwIik7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIHRydXN0ZWRfc2NoZW1hID0gT0ZGIik7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIHN5bmNocm9ub3VzID0gRVhUUkEiKTsKICBkYXRhYmFzZS5lbmFibGVEZWZlbnNpdmUodHJ1ZSk7CiAgZGF0YWJhc2UuZW5hYmxlTG9hZEV4dGVuc2lvbihmYWxzZSk7CiAgaWYgKAogICAgcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAiYnVzeV90aW1lb3V0IikgIT09IDAgfHwKICAgIHByYWdtYU51bWJlcihkYXRhYmFzZSwgInRydXN0ZWRfc2NoZW1hIikgIT09IDAgfHwKICAgIHByYWdtYU51bWJlcihkYXRhYmFzZSwgInN5bmNocm9ub3VzIikgIT09IDMKICApIHsKICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFNRTGl0ZSBsb2NrIGNvbm5lY3Rpb24gaGFyZGVuaW5nIGRpZCBub3QgdGFrZSBlZmZlY3QiKTsKICB9Cn0KCmZ1bmN0aW9uIGluc3BlY3RMb2NrRGF0YWJhc2UoZGF0YWJhc2UsIHBhdGgpIHsKICBjb25zdCBhcHBsaWNhdGlvbklkID0gcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAiYXBwbGljYXRpb25faWQiKTsKICBpZiAoYXBwbGljYXRpb25JZCA9PT0gMCkgewogICAgY29uc3Qgcm93ID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCBjb3VudCgqKSBBUyBjb3VudCBGUk9NIHNxbGl0ZV9zY2hlbWEgV0hFUkUgbmFtZSBOT1QgTElLRSAnc3FsaXRlXyUnIiwKICAgICkuZ2V0KCk7CiAgICBpZiAocm93Py5jb3VudCAhPT0gMCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgICAgYGFnZW5jOiByZWZ1c2luZyB0byByZXVzZSBhbiB1bnJlbGF0ZWQgU1FMaXRlIGRhdGFiYXNlIGFzIGEgbG9jazogJHtwYXRofWAsCiAgICAgICk7CiAgICB9CiAgICByZXR1cm4gImVtcHR5IjsKICB9CiAgaWYgKGFwcGxpY2F0aW9uSWQgIT09IExPQ0tfQVBQTElDQVRJT05fSUQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaGFzIGFuIGluY29tcGF0aWJsZSBhcHBsaWNhdGlvbiBpZDogJHtwYXRofWApOwogIH0KICB0cnkgewogICAgY29uc3Qgc2NoZW1hID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCB0eXBlLCBzcWwgRlJPTSBzcWxpdGVfc2NoZW1hIFdIRVJFIG5hbWUgPSAnYWdlbmNfbG9jYWxfcHJvY2Vzc19sb2NrJyIsCiAgICApLmdldCgpOwogICAgY29uc3Qgb2JqZWN0cyA9IGRhdGFiYXNlLnByZXBhcmUoCiAgICAgICJTRUxFQ1QgY291bnQoKikgQVMgY291bnQgRlJPTSBzcWxpdGVfc2NoZW1hIFdIRVJFIG5hbWUgTk9UIExJS0UgJ3NxbGl0ZV8lJyIsCiAgICApLmdldCgpOwogICAgY29uc3Qgcm93cyA9IGRhdGFiYXNlLnByZXBhcmUoCiAgICAgICJTRUxFQ1Qgc2luZ2xldG9uLCBmb3JtYXRfdmVyc2lvbiBGUk9NIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayIsCiAgICApLmFsbCgpOwogICAgY29uc3Qgbm9ybWFsaXplZFNjaGVtYSA9IHR5cGVvZiBzY2hlbWE/LnNxbCA9PT0gInN0cmluZyIKICAgICAgPyBzY2hlbWEuc3FsLnJlcGxhY2UoL1xzKy9nLCAiICIpLnRyaW0oKQogICAgICA6IHVuZGVmaW5lZDsKICAgIGlmICgKICAgICAgc2NoZW1hPy50eXBlICE9PSAidGFibGUiIHx8CiAgICAgIG5vcm1hbGl6ZWRTY2hlbWEgIT09CiAgICAgICAgIkNSRUFURSBUQUJMRSBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKCBzaW5nbGV0b24gSU5URUdFUiBQUklNQVJZIEtFWSBDSEVDSyAoc2luZ2xldG9uID0gMSksIGZvcm1hdF92ZXJzaW9uIElOVEVHRVIgTk9UIE5VTEwgKSBTVFJJQ1QiIHx8CiAgICAgIG9iamVjdHM/LmNvdW50ICE9PSAxIHx8CiAgICAgIHJvd3MubGVuZ3RoICE9PSAxIHx8CiAgICAgIHJvd3NbMF0/LnNpbmdsZXRvbiAhPT0gMSB8fAogICAgICByb3dzWzBdPy5mb3JtYXRfdmVyc2lvbiAhPT0gTE9DS19GT1JNQVRfVkVSU0lPTgogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigiaW52YWxpZCBzZW50aW5lbCBzY2hlbWEiKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBoYXMgYW4gaW5jb21wYXRpYmxlIGZvcm1hdDogJHtwYXRofWAsIHsKICAgICAgY2F1c2U6IGVycm9yLAogICAgfSk7CiAgfQogIHJldHVybiAidmFsaWQiOwp9CgpmdW5jdGlvbiBidXN5VHJhbnNpdGlvbkVycm9yKHBhdGgsIG1vZGUpIHsKICByZXR1cm4gT2JqZWN0LmFzc2lnbigKICAgIG5ldyBFcnJvcihgYWdlbmM6IFNRTGl0ZSBsb2NrIGpvdXJuYWwgbW9kZSByZW1haW5lZCAke21vZGUgPz8gInVua25vd24ifTogJHtwYXRofWApLAogICAgeyBlcnJjb2RlOiBTUUxJVEVfQlVTWSB9LAogICk7Cn0KCmZ1bmN0aW9uIGJlZ2luQW5kVmFsaWRhdGVMb2NrKGRhdGFiYXNlLCBwYXRoLCBjb250ZXh0KSB7CiAgZm9yIChsZXQgcGhhc2UgPSAwOyBwaGFzZSA8IDg7IHBoYXNlICs9IDEpIHsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgdHJhbnNhY3Rpb24gYmVnaW4gc3RhcnRlZCIpOwogICAgZGF0YWJhc2UuZXhlYygiQkVHSU4gSU1NRURJQVRFIik7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIHRyYW5zYWN0aW9uIGJlZ2luIGNvbXBsZXRlIik7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGxvY2sgZGF0YWJhc2UgaW5zcGVjdGlvbiBzdGFydGVkIik7CiAgICBjb25zdCBzdGF0ZSA9IGluc3BlY3RMb2NrRGF0YWJhc2UoZGF0YWJhc2UsIHBhdGgpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBsb2NrIGRhdGFiYXNlIGluc3BlY3Rpb24gY29tcGxldGUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgam91cm5hbCBtb2RlIGluc3BlY3Rpb24gc3RhcnRlZCIpOwogICAgY29uc3Qgam91cm5hbE1vZGUgPSBwcmFnbWFUZXh0KGRhdGFiYXNlLCAiam91cm5hbF9tb2RlIik7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGpvdXJuYWwgbW9kZSBpbnNwZWN0aW9uIGNvbXBsZXRlIik7CiAgICBpZiAoam91cm5hbE1vZGUgIT09ICJkZWxldGUiKSB7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgam91cm5hbCBtb2RlIHJlc2V0IHN0YXJ0ZWQiKTsKICAgICAgZGF0YWJhc2UuZXhlYygiUk9MTEJBQ0siKTsKICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBwcmFnbWFUZXh0KGRhdGFiYXNlLCAiam91cm5hbF9tb2RlPURFTEVURSIpOwogICAgICBpZiAoc2VsZWN0ZWQgIT09ICJkZWxldGUiKSB0aHJvdyBidXN5VHJhbnNpdGlvbkVycm9yKHBhdGgsIHNlbGVjdGVkKTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBqb3VybmFsIG1vZGUgcmVzZXQgY29tcGxldGUiKTsKICAgICAgY29udGludWU7CiAgICB9CiAgICBpZiAoc3RhdGUgPT09ICJlbXB0eSIpIHsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBsb2NrIGRhdGFiYXNlIGluaXRpYWxpemF0aW9uIHN0YXJ0ZWQiKTsKICAgICAgZGF0YWJhc2UuZXhlYyhgCiAgICAgICAgUFJBR01BIGFwcGxpY2F0aW9uX2lkID0gJHtMT0NLX0FQUExJQ0FUSU9OX0lEfTsKICAgICAgICBDUkVBVEUgVEFCTEUgYWdlbmNfbG9jYWxfcHJvY2Vzc19sb2NrICgKICAgICAgICAgIHNpbmdsZXRvbiBJTlRFR0VSIFBSSU1BUlkgS0VZIENIRUNLIChzaW5nbGV0b24gPSAxKSwKICAgICAgICAgIGZvcm1hdF92ZXJzaW9uIElOVEVHRVIgTk9UIE5VTEwKICAgICAgICApIFNUUklDVDsKICAgICAgICBJTlNFUlQgSU5UTyBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKHNpbmdsZXRvbiwgZm9ybWF0X3ZlcnNpb24pCiAgICAgICAgVkFMVUVTICgxLCAke0xPQ0tfRk9STUFUX1ZFUlNJT059KTsKICAgICAgICBDT01NSVQ7CiAgICAgIGApOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGxvY2sgZGF0YWJhc2UgaW5pdGlhbGl6YXRpb24gY29tcGxldGUiKTsKICAgICAgY29udGludWU7CiAgICB9CiAgICByZXR1cm47CiAgfQogIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaW5pdGlhbGl6YXRpb24gZGlkIG5vdCBjb252ZXJnZTogJHtwYXRofWApOwp9CgpmdW5jdGlvbiBjbG9zZURhdGFiYXNlKGRhdGFiYXNlKSB7CiAgaWYgKCFkYXRhYmFzZT8uaXNPcGVuKSByZXR1cm47CiAgY29uc3QgZXJyb3JzID0gW107CiAgdHJ5IHsKICAgIGlmIChkYXRhYmFzZS5pc1RyYW5zYWN0aW9uKSBkYXRhYmFzZS5leGVjKCJST0xMQkFDSyIpOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgfQogIHRyeSB7CiAgICBkYXRhYmFzZS5jbG9zZSgpOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgfQogIGlmIChlcnJvcnMubGVuZ3RoID09PSAxKSB0aHJvdyBlcnJvcnNbMF07CiAgaWYgKGVycm9ycy5sZW5ndGggPiAxKSB7CiAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoZXJyb3JzLCAiYWdlbmM6IGZhaWxlZCB0byBjbG9zZSBhIGxvY2FsIHByb2Nlc3MgbG9jayBkYXRhYmFzZSIpOwogIH0KfQoKZXhwb3J0IGZ1bmN0aW9uIGlzU3FsaXRlQnVzeUVycm9yKGVycm9yKSB7CiAgcmV0dXJuIHR5cGVvZiBlcnJvcj8uZXJyY29kZSA9PT0gIm51bWJlciIgJiYKICAgIChlcnJvci5lcnJjb2RlICYgMHhmZikgPT09IFNRTElURV9CVVNZOwp9Cgphc3luYyBmdW5jdGlvbiB3YWl0Rm9yQnVzeVJldHJ5KGNvbnRleHQsIHBhdGgsIGF0dGVtcHQsIGNhdXNlKSB7CiAgY29uc3QgcmVtYWluaW5nID0gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpOwogIGlmIChyZW1haW5pbmcgPD0gMCkgdGhyb3cgdGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgsIGNhdXNlKTsKICBjb25zdCBleHBvbmVudGlhbENhcCA9IE1hdGgubWluKE1BWF9CVVNZX1JFVFJZX01TLCAyICoqIE1hdGgubWluKGF0dGVtcHQsIDYpKTsKICBjb25zdCBqaXR0ZXIgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoZXhwb25lbnRpYWxDYXAgKyAxKSkpOwogIGNvbnN0IHdhaXRNcyA9IE1hdGgubWluKHJlbWFpbmluZywgaml0dGVyKTsKICBjb25zdCBzaWduYWwgPSBjb250ZXh0LnJldHJ5V2FrZVNpZ25hbDsKICBpZiAoc2lnbmFsID09PSB1bmRlZmluZWQgfHwgY29udGV4dC5yZXRyeVdha2VDb25zdW1lZCkgewogICAgYXdhaXQgZGVsYXkod2FpdE1zKTsKICB9IGVsc2UgewogICAgLy8gQSBoaW50IG9ubHkgc2hvcnRlbnMgb25lIHNsZWVwLiBUaGUgbmV4dCBhdHRlbXB0IG11c3Qgc3RpbGwgdmFsaWRhdGUKICAgIC8vIHRoZSBwYXRoIGFuZCBhY3F1aXJlIHRoZSBTUUxpdGUgdHJhbnNhY3Rpb24gYWdhaW5zdCB0aGUgc2FtZSBkZWFkbGluZS4KICAgIGxldCB0aW1lcjsKICAgIGxldCB3YWtlOwogICAgdHJ5IHsKICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHsKICAgICAgICB3YWtlID0gKCkgPT4gewogICAgICAgICAgY29udGV4dC5yZXRyeVdha2VDb25zdW1lZCA9IHRydWU7CiAgICAgICAgICByZXNvbHZlKCk7CiAgICAgICAgfTsKICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQocmVzb2x2ZSwgd2FpdE1zKTsKICAgICAgICBzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcigiYWJvcnQiLCB3YWtlLCB7IG9uY2U6IHRydWUgfSk7CiAgICAgICAgLy8gQ292ZXJzIHJlYWRpbmVzcyBiZWZvcmUgc3Vic2NyaXB0aW9uIGFzIHdlbGwgYXMgYmVmb3JlIGFjcXVpc2l0aW9uLgogICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgd2FrZSgpOwogICAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgYnVzeSByZXRyeSB3YWl0IHN0YXJ0ZWQiKTsKICAgICAgfSk7CiAgICB9IGZpbmFsbHkgewogICAgICBjbGVhclRpbWVvdXQodGltZXIpOwogICAgICBpZiAod2FrZSAhPT0gdW5kZWZpbmVkKSBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcigiYWJvcnQiLCB3YWtlKTsKICAgIH0KICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCwgY2F1c2UpOwp9Cgphc3luYyBmdW5jdGlvbiBhY3F1aXJlU3FsaXRlRGF0YWJhc2UoRGF0YWJhc2VTeW5jLCBwcmVwYXJlZCwgY29udGV4dCkgewogIGxldCBhdHRlbXB0ID0gMDsKICBsZXQgbGFzdEJ1c3k7CiAgd2hpbGUgKHRydWUpIHsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHByZXBhcmVkLnBhdGgsIGxhc3RCdXN5KTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgcHJlLW9wZW4gbG9jayB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICAgIGF3YWl0IHJldmFsaWRhdGVQcmVwYXJlZExvY2socHJlcGFyZWQsIGNvbnRleHQsIHsKICAgICAgLy8gVGhlIGNyZWF0aW9uIHBhdGggYWxyZWFkeSB2YWxpZGF0ZWQgdGhlIGNvbXBsZXRlIGFuY2VzdG9yIGNoYWluIGFuZAogICAgICAvLyB0aGUgZXhhY3QgcGFyZW50L2ZpbGUgQUNMcy4gUmV2YWxpZGF0ZSBBQ0xzIGFmdGVyIGNvbnRlbnRpb24gYmVjYXVzZQogICAgICAvLyBhbm90aGVyIGhvbGRlciBhbmQgYW4gdW5ib3VuZGVkIGludGVydmFsIGhhdmUgY3Jvc3NlZCB0aGlzIGF0dGVtcHQuCiAgICAgIHZhbGlkYXRlV2luZG93c0FjbDogYXR0ZW1wdCA+IDAsCiAgICB9KTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgcHJlLW9wZW4gbG9jayB2YWxpZGF0aW9uIGNvbXBsZXRlIik7CiAgICBsZXQgZGF0YWJhc2U7CiAgICB0cnkgewogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGRhdGFiYXNlIG9wZW4gc3RhcnRlZCIpOwogICAgICBkYXRhYmFzZSA9IG5ldyBEYXRhYmFzZVN5bmMocHJlcGFyZWQucGF0aCwgewogICAgICAgIGFsbG93RXh0ZW5zaW9uOiBmYWxzZSwKICAgICAgICB0aW1lb3V0OiAwLAogICAgICB9KTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBkYXRhYmFzZSBvcGVuIGNvbXBsZXRlIik7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgY29ubmVjdGlvbiBoYXJkZW5pbmcgc3RhcnRlZCIpOwogICAgICBjb25maWd1cmVMb2NhbFNxbGl0ZUxvY2tDb25uZWN0aW9uKGRhdGFiYXNlKTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBjb25uZWN0aW9uIGhhcmRlbmluZyBjb21wbGV0ZSIpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIHBvc3Qtb3BlbiBsb2NrIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgICBhd2FpdCByZXZhbGlkYXRlUHJlcGFyZWRMb2NrKHByZXBhcmVkLCBjb250ZXh0KTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBwb3N0LW9wZW4gbG9jayB2YWxpZGF0aW9uIGNvbXBsZXRlIik7CiAgICAgIGJlZ2luQW5kVmFsaWRhdGVMb2NrKGRhdGFiYXNlLCBwcmVwYXJlZC5wYXRoLCBjb250ZXh0KTsKICAgICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgbGFzdEJ1c3kpOwogICAgICByZXR1cm4gZGF0YWJhc2U7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBjb25zdCBjbGVhbnVwRXJyb3JzID0gW107CiAgICAgIGlmIChkYXRhYmFzZSAhPT0gdW5kZWZpbmVkKSB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGNsb3NlRGF0YWJhc2UoZGF0YWJhc2UpOwogICAgICAgIH0gY2F0Y2ggKGNsZWFudXBFcnJvcikgewogICAgICAgICAgY2xlYW51cEVycm9ycy5wdXNoKGNsZWFudXBFcnJvcik7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChjbGVhbnVwRXJyb3JzLmxlbmd0aCA+IDApIHsKICAgICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgICAgICBbZXJyb3IsIC4uLmNsZWFudXBFcnJvcnNdLAogICAgICAgICAgYGFnZW5jOiBsb2NrIGF0dGVtcHQgYW5kIGNsZWFudXAgYm90aCBmYWlsZWQgZm9yICR7cHJlcGFyZWQucGF0aH1gLAogICAgICAgICk7CiAgICAgIH0KICAgICAgaWYgKCFpc1NxbGl0ZUJ1c3lFcnJvcihlcnJvcikpIHRocm93IGVycm9yOwogICAgICBsYXN0QnVzeSA9IGVycm9yOwogICAgICBhdHRlbXB0ICs9IDE7CiAgICAgIGF3YWl0IHdhaXRGb3JCdXN5UmV0cnkoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgYXR0ZW1wdCwgbGFzdEJ1c3kpOwogICAgfQogIH0KfQoKZnVuY3Rpb24gcmVsZWFzZUFjcXVpcmVkKGFjcXVpcmVkLCBsYWJlbCkgewogIGNvbnN0IGVycm9ycyA9IFtdOwogIGZvciAoY29uc3QgaXRlbSBvZiBhY3F1aXJlZC50b1JldmVyc2VkKCkpIHsKICAgIHRyeSB7CiAgICAgIGNsb3NlRGF0YWJhc2UoaXRlbS5kYXRhYmFzZSk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgICB9CiAgICBpZiAoKCFpdGVtLmRhdGFiYXNlIHx8ICFpdGVtLmRhdGFiYXNlLmlzT3BlbikgJiYgIWl0ZW0uaW5Qcm9jZXNzUmVsZWFzZWQpIHsKICAgICAgdHJ5IHsKICAgICAgICBpdGVtLnJlbGVhc2VJblByb2Nlc3MoKTsKICAgICAgICBpdGVtLmluUHJvY2Vzc1JlbGVhc2VkID0gdHJ1ZTsKICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgICAgIH0KICAgIH0KICB9CiAgaWYgKGVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGVycm9yc1swXTsKICBpZiAoZXJyb3JzLmxlbmd0aCA+IDEpIHsKICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihlcnJvcnMsIGBhZ2VuYzogJHtsYWJlbH0gbG9jayByZWxlYXNlIGZhaWxlZGApOwogIH0KfQoKZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2tzKAogIHJlcXVlc3RlZFBhdGhzLAogIHsKICAgIHRpbWVvdXRNcyA9IDYwXzAwMCwKICAgIGxhYmVsID0gIkFnZW5DIG9wZXJhdGlvbiIsCiAgICBkZWFkbGluZTogc3VwcGxpZWREZWFkbGluZSwKICAgIG9uUHJvZ3Jlc3MsCiAgICByZXRyeVdha2VTaWduYWwsCiAgfSA9IHt9LAopIHsKICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRpbWVvdXRNcykgfHwgdGltZW91dE1zIDw9IDApIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgdGltZW91dE1zIG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXIiKTsKICB9CiAgaWYgKHN1cHBsaWVkRGVhZGxpbmUgIT09IHVuZGVmaW5lZCAmJiAhTnVtYmVyLmlzRmluaXRlKHN1cHBsaWVkRGVhZGxpbmUpKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIGRlYWRsaW5lIG11c3QgYmUgZmluaXRlIik7CiAgfQogIGlmICghQXJyYXkuaXNBcnJheShyZXF1ZXN0ZWRQYXRocykpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgcGF0aHMgbXVzdCBiZSBhbiBhcnJheSIpOwogIH0KICBpZiAob25Qcm9ncmVzcyAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBvblByb2dyZXNzICE9PSAiZnVuY3Rpb24iKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIG9uUHJvZ3Jlc3MgbXVzdCBiZSBhIGZ1bmN0aW9uIik7CiAgfQogIGlmIChyZXRyeVdha2VTaWduYWwgIT09IHVuZGVmaW5lZCAmJiAhKHJldHJ5V2FrZVNpZ25hbCBpbnN0YW5jZW9mIEFib3J0U2lnbmFsKSkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayByZXRyeVdha2VTaWduYWwgbXVzdCBiZSBhbiBBYm9ydFNpZ25hbCIpOwogIH0KICBpZiAocmVxdWVzdGVkUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4gKCkgPT4ge307CgogIGNvbnN0IHN0YXJ0ZWRBdCA9IHBlcmZvcm1hbmNlLm5vdygpOwogIGNvbnN0IGNvbnRleHQgPSB7CiAgICBkZWFkbGluZTogTWF0aC5taW4oCiAgICAgIHN1cHBsaWVkRGVhZGxpbmUgPz8gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZLAogICAgICBzdGFydGVkQXQgKyB0aW1lb3V0TXMsCiAgICApLAogICAgbGFiZWwsCiAgICB0aW1lb3V0TXMsCiAgICBvblByb2dyZXNzLAogICAgcmV0cnlXYWtlU2lnbmFsLAogICAgcmV0cnlXYWtlQ29uc3VtZWQ6IGZhbHNlLAogIH07CiAgY29uc3QgZmlyc3REaXNwbGF5UGF0aCA9IHJlc29sdmUocmVxdWVzdGVkUGF0aHNbMF0pOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGZpcnN0RGlzcGxheVBhdGgpOwoKICBjb25zdCBwcmVwYXJlZEJ5SWRlbnRpdHkgPSBuZXcgTWFwKCk7CiAgZm9yIChjb25zdCByZXF1ZXN0ZWRQYXRoIG9mIHJlcXVlc3RlZFBhdGhzKSB7CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCByZXNvbHZlKHJlcXVlc3RlZFBhdGgpKTsKICAgIGNvbnN0IHByZXBhcmVkID0gYXdhaXQgcHJlcGFyZUxvY2tQYXRoKHJlcXVlc3RlZFBhdGgsIGNvbnRleHQpOwogICAgcHJlcGFyZWRCeUlkZW50aXR5LnNldChwcmVwYXJlZC5pZGVudGl0eUtleSwgcHJlcGFyZWQpOwogIH0KICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBwYXRoIHByZXBhcmF0aW9uIGNvbXBsZXRlIik7CiAgY29uc3QgcHJlcGFyZWRMb2NrcyA9IFsuLi5wcmVwYXJlZEJ5SWRlbnRpdHkudmFsdWVzKCldLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PgogICAgbGVmdC5pZGVudGl0eUtleSA8IHJpZ2h0LmlkZW50aXR5S2V5ID8gLTEgOiBsZWZ0LmlkZW50aXR5S2V5ID4gcmlnaHQuaWRlbnRpdHlLZXkgPyAxIDogMCk7CiAgY29uc3QgcGVuZGluZ0xvY2FsID0gW107CiAgY29uc3QgYWNxdWlyZWQgPSBbXTsKICBsZXQgY3VycmVudFBhdGggPSBwcmVwYXJlZExvY2tzWzBdPy5wYXRoID8/IGZpcnN0RGlzcGxheVBhdGg7CiAgdHJ5IHsKICAgIGZvciAoY29uc3QgcHJlcGFyZWQgb2YgcHJlcGFyZWRMb2NrcykgewogICAgICBjdXJyZW50UGF0aCA9IHByZXBhcmVkLnBhdGg7CiAgICAgIGNvbnN0IHJlbGVhc2UgPSBhd2FpdCBhY3F1aXJlSW5Qcm9jZXNzTG9jayhwcmVwYXJlZCwgY29udGV4dCk7CiAgICAgIHBlbmRpbmdMb2NhbC5wdXNoKHsgcHJlcGFyZWQsIHJlbGVhc2UgfSk7CiAgICB9CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiaW4tcHJvY2VzcyBsb2NrIGFjcXVpc2l0aW9uIGNvbXBsZXRlIik7CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjdXJyZW50UGF0aCk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIG1vZHVsZSBpbXBvcnQgc3RhcnRlZCIpOwogICAgY29uc3QgeyBEYXRhYmFzZVN5bmMgfSA9IGF3YWl0IGltcG9ydCgibm9kZTpzcWxpdGUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgbW9kdWxlIGltcG9ydCBjb21wbGV0ZSIpOwogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgY3VycmVudFBhdGgpOwogICAgZm9yIChjb25zdCB7IHByZXBhcmVkLCByZWxlYXNlIH0gb2YgcGVuZGluZ0xvY2FsKSB7CiAgICAgIGN1cnJlbnRQYXRoID0gcHJlcGFyZWQucGF0aDsKICAgICAgY29uc3QgaXRlbSA9IHsKICAgICAgICBkYXRhYmFzZTogdW5kZWZpbmVkLAogICAgICAgIHJlbGVhc2VJblByb2Nlc3M6IHJlbGVhc2UsCiAgICAgICAgaW5Qcm9jZXNzUmVsZWFzZWQ6IGZhbHNlLAogICAgICB9OwogICAgICBhY3F1aXJlZC5wdXNoKGl0ZW0pOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIHRyYW5zYWN0aW9uIGFjcXVpc2l0aW9uIHN0YXJ0ZWQiKTsKICAgICAgaXRlbS5kYXRhYmFzZSA9IGF3YWl0IGFjcXVpcmVTcWxpdGVEYXRhYmFzZShEYXRhYmFzZVN5bmMsIHByZXBhcmVkLCBjb250ZXh0KTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSB0cmFuc2FjdGlvbiBhY3F1aXNpdGlvbiBjb21wbGV0ZSIpOwogICAgfQogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBjb25zdCBjbGVhbnVwRXJyb3JzID0gW107CiAgICB0cnkgewogICAgICByZWxlYXNlQWNxdWlyZWQoYWNxdWlyZWQsIGxhYmVsKTsKICAgIH0gY2F0Y2ggKGNsZWFudXBFcnJvcikgewogICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgIH0KICAgIGZvciAoY29uc3QgeyByZWxlYXNlIH0gb2YgcGVuZGluZ0xvY2FsLnNsaWNlKGFjcXVpcmVkLmxlbmd0aCkudG9SZXZlcnNlZCgpKSB7CiAgICAgIHRyeSB7CiAgICAgICAgcmVsZWFzZSgpOwogICAgICB9IGNhdGNoIChjbGVhbnVwRXJyb3IpIHsKICAgICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgICAgfQogICAgfQogICAgY29uc3QgZm9ybWF0dGVkID0gaXNTcWxpdGVCdXN5RXJyb3IoZXJyb3IpCiAgICAgID8gdGltZW91dEVycm9yKGNvbnRleHQsIGN1cnJlbnRQYXRoLCBlcnJvcikKICAgICAgOiBlcnJvcjsKICAgIGlmIChjbGVhbnVwRXJyb3JzLmxlbmd0aCA+IDApIHsKICAgICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKAogICAgICAgIFtmb3JtYXR0ZWQsIC4uLmNsZWFudXBFcnJvcnNdLAogICAgICAgIGBhZ2VuYzogJHtsYWJlbH0gbG9jayBhY3F1aXNpdGlvbiBhbmQgcm9sbGJhY2sgYm90aCBmYWlsZWRgLAogICAgICApOwogICAgfQogICAgdGhyb3cgZm9ybWF0dGVkOwogIH0KCiAgbGV0IHJlbGVhc2VkID0gZmFsc2U7CiAgcmV0dXJuICgpID0+IHsKICAgIGlmIChyZWxlYXNlZCkgcmV0dXJuOwogICAgcmVsZWFzZUFjcXVpcmVkKGFjcXVpcmVkLCBsYWJlbCk7CiAgICByZWxlYXNlZCA9IGFjcXVpcmVkLmV2ZXJ5KChpdGVtKSA9PiBpdGVtLmluUHJvY2Vzc1JlbGVhc2VkKTsKICB9Owp9CgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYWNxdWlyZUxvY2FsU3FsaXRlTG9jayhwYXRoLCBvcHRpb25zKSB7CiAgcmV0dXJuIGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2tzKFtwYXRoXSwgb3B0aW9ucyk7Cn0K";
let sqliteLockModulePromise;
function loadSqliteLockModule() {
  sqliteLockModulePromise ??= import(
    `data:text/javascript;base64,${AGENC_SQLITE_LOCK_SOURCE_BASE64}`,
  );
  return sqliteLockModulePromise;
}
// END GENERATED AGENC SQLITE LOCK MODULE

function strictRelativeRuntimeFile(root, relativePath) {
  if (relativePath.length === 0 || isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).some((part) => part.length === 0 || part === "." || part === "..")) {
    return false;
  }
  const finalPath = resolve(root, relativePath);
  const within = relative(resolve(root), finalPath);
  if (within === "" || within === ".." ||
      within.startsWith(`..${pathSeparator}`) || isAbsolute(within)) return false;
  let current = root;
  const parts = relativePath.split(/[\\/]/);
  try {
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}
function strictMarkerMatches(path) {
  try {
    const marker = join(path, ".agenc-runtime-ok");
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) return false;
    const content = readFileSync(marker, "utf8");
    return content === expectedSha || content === `${expectedSha}\n`;
  } catch { return false; }
}
const PROVENANCE_RECEIPT_NAME = ".agenc-runtime-provenance-v1.json";
function compareAsciiKeys(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort(compareAsciiKeys).join("\0") ===
      [...expected].sort(compareAsciiKeys).join("\0");
}
function decodeProvenanceJson(encoded, label) {
  if (encoded === "" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length > 4096) throw new Error(`invalid ${label}`);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`invalid ${label}`); }
}
function validProvenanceExpectation(value) {
  const baseKeys = [
    "schema", "artifactSha256", "artifactUrl", "sourceRepository", "sourceWorkflow",
    "sourceCommit", "sourceRef", "attestationUrl", "attestationSha256",
    "attestationBytes", "verificationPolicy",
  ];
  const dual = value?.schema === "agenc-runtime-provenance/v2";
  return exactKeys(value, dual ? [
    ...baseKeys,
    "buildProvenanceUrl", "buildProvenanceSha256", "buildProvenanceBytes",
    "buildSourceRef",
  ] : baseKeys) &&
    (dual || value.schema === "agenc-runtime-provenance/v1") &&
    value.artifactSha256 === expectedSha &&
    typeof value.artifactUrl === "string" &&
    value.artifactUrl.startsWith("https://github.com/tetsuo-ai/agenc-releases/releases/download/") &&
    value.sourceRepository === "tetsuo-ai/agenc-core" &&
    value.sourceWorkflow === "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml" &&
    /^[0-9a-f]{40,64}$/.test(value.sourceCommit) &&
    /^refs\/tags\/agenc-v[^\r\n]+$/.test(value.sourceRef) &&
    value.attestationUrl === `${value.artifactUrl}.sigstore.json` &&
    /^[0-9a-f]{64}$/.test(value.attestationSha256) &&
    Number.isSafeInteger(value.attestationBytes) && value.attestationBytes > 0 &&
    value.attestationBytes <= 4 * 1024 * 1024 &&
    (!dual || (
      value.buildProvenanceUrl === `${value.artifactUrl}.build.sigstore.json` &&
      /^[0-9a-f]{64}$/.test(value.buildProvenanceSha256) &&
      Number.isSafeInteger(value.buildProvenanceBytes) &&
      value.buildProvenanceBytes > 0 &&
      value.buildProvenanceBytes <= 4 * 1024 * 1024 &&
      value.buildSourceRef === "refs/heads/main"
    )) &&
    exactKeys(value.verificationPolicy, [
      "hostname", "certOidcIssuer", "predicateType", "denySelfHostedRunners",
    ]) && value.verificationPolicy.hostname === "github.com" &&
    value.verificationPolicy.certOidcIssuer === "https://token.actions.githubusercontent.com" &&
    value.verificationPolicy.predicateType === "https://slsa.dev/provenance/v1" &&
    value.verificationPolicy.denySelfHostedRunners === true;
}
const provenanceExpectation = provenanceExpectationBase64 === ""
  ? undefined
  : decodeProvenanceJson(provenanceExpectationBase64, "provenance expectation");
if (provenanceExpectation !== undefined && !validProvenanceExpectation(provenanceExpectation)) {
  throw new Error("invalid provenance expectation");
}
function validProvenanceReceipt(value) {
  if (provenanceExpectation === undefined ||
      !exactKeys(value, Object.keys(provenanceExpectation))) return false;
  for (const key of Object.keys(provenanceExpectation)) {
    if (JSON.stringify(value[key]) !== JSON.stringify(provenanceExpectation[key])) return false;
  }
  return true;
}
function strictProvenanceReceiptMatches(path) {
  if (provenanceExpectation === undefined) return true;
  try {
    const receipt = join(path, PROVENANCE_RECEIPT_NAME);
    const stat = lstatSync(receipt);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) return false;
    return validProvenanceReceipt(JSON.parse(readFileSync(receipt, "utf8")));
  } catch { return false; }
}
function readyAt(path) {
  try {
    const root = lstatSync(path);
    return root.isDirectory() && !root.isSymbolicLink() &&
      strictRelativeRuntimeFile(path, binRel) &&
      (embeddedNodeRel === "" || (
        strictRelativeRuntimeFile(path, embeddedNodeRel) &&
        strictRelativeRuntimeFile(path, "node_modules/.agenc-node/identity.json")
      )) &&
      (embeddedNodeLibraryRel === "" ||
        strictRelativeRuntimeFile(path, `${embeddedNodeLibraryRel}/libatomic.so.1`)) &&
      strictMarkerMatches(path) &&
      strictProvenanceReceiptMatches(path);
  } catch { return false; }
}
function hasResidue(versionDir, base) {
  return readdirSync(versionDir).some((name) =>
    name.startsWith(`.${base}.install-`) || name.startsWith(`${base}.old-`));
}

function promote(candidate, canonical) {
  const backup = `${canonical}.old-${process.pid}-${randomUUID()}`;
  let movedExisting = false;
  try {
    if (existsSync(canonical)) {
      renameSync(canonical, backup);
      syncDirectory(dirname(canonical));
      movedExisting = true;
    }
    renameSync(candidate, canonical);
    syncDirectory(dirname(canonical));
  } catch (error) {
    if (!existsSync(canonical) && movedExisting && existsSync(backup)) {
      try {
        renameSync(backup, canonical);
        syncDirectory(dirname(canonical));
      }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `runtime promotion failed; prior tree retained at ${backup}`);
      }
    }
    throw error;
  }
}
async function trustedReadyAt(path, assertLocalPrivateDirectory) {
  if (!readyAt(path)) return false;
  const canonical = await assertLocalPrivateDirectory(path, {
    label: "runtime cache validation",
    timeoutMs: 120_000,
  });
  if (canonical !== resolve(path)) {
    throw new Error(`runtime cache must use its canonical path: ${path}`);
  }
  return readyAt(path);
}
async function reconcile(versionDir, base, assertLocalPrivateDirectory) {
  const entries = readdirSync(versionDir);
  const newestReady = async (prefix) => {
    const candidates = entries.filter((name) => name.startsWith(prefix))
      .map((name) => join(versionDir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const candidate of candidates) {
      if (await trustedReadyAt(candidate, assertLocalPrivateDirectory)) return candidate;
    }
    return undefined;
  };
  if (!(await trustedReadyAt(installDir, assertLocalPrivateDirectory))) {
    const candidate = await newestReady(`.${base}.install-`) ??
      await newestReady(`${base}.old-`);
    if (candidate !== undefined) promote(candidate, installDir);
  }
  if (!(await trustedReadyAt(installDir, assertLocalPrivateDirectory))) return false;
  for (const name of readdirSync(versionDir)) {
    if (name.startsWith(`.${base}.install-`) || name.startsWith(`${base}.old-`)) {
      try { removeDurably(join(versionDir, name), { recursive: true, force: true }); } catch { /* retry later */ }
    }
  }
  return true;
}

function readOptionalFile(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function replaceFileAtomically(path, content, fileMode) {
  const temporary = `${path}.agenc-activate-${process.pid}-${randomUUID()}`;
  try {
    writeFileDurably(temporary, content, { flag: "wx", mode: fileMode });
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    try {
      if (existsSync(temporary)) removeDurably(temporary, { force: true });
    } catch { /* transaction recovery retries */ }
  }
}
// BEGIN GENERATED AGENC WRAPPER CONTRACT MODULE
// Generated by scripts/sync-installer-sqlite-lock.mjs from the canonical
// launcher module. Do not edit this embedded payload by hand.
const AGENC_GENERATED_WRAPPER_SOURCE_BASE64 = "Ly8gQnl0ZS1jYW5vbmljYWwgc3RhbmRhbG9uZS1pbnN0YWxsZXIgd3JhcHBlciBjb250cmFjdCBzaGFyZWQgYnkgdGhlIHJ1bnRpbWUKLy8gdXBkYXRlciBhbmQgYm90aCBlbWJlZGRlZCBpbnN0YWxsZXJzLiBQYXJzaW5nIGlzIGRlbGliZXJhdGVseSBmdWxsLWZpbGU6Ci8vIG1hcmtlciBzdWJzdHJpbmdzIG11c3QgbmV2ZXIgZ3JhbnQgb3duZXJzaGlwIG9mIGEgdXNlci1hdXRob3JlZCBleGVjdXRhYmxlLgoKaW1wb3J0IHsgaXNBYnNvbHV0ZSwgcG9zaXgsIHdpbjMyIH0gZnJvbSAibm9kZTpwYXRoIjsKCmV4cG9ydCBjb25zdCBHRU5FUkFURURfV1JBUFBFUl9NQVhfQllURVMgPSA2NCAqIDEwMjQ7CmNvbnN0IFBPU0lYX1dSQVBQRVJfU0lHTkFUVVJFID0gIkdlbmVyYXRlZCBieSBBZ2VuQyBpbnN0YWxsLnNoIjsKY29uc3QgQ01EX1dSQVBQRVJfU0lHTkFUVVJFID0gIkdlbmVyYXRlZCBieSBBZ2VuQyBpbnN0YWxsLnBzMSI7CmNvbnN0IFdSQVBQRVJfTUVUQURBVEFfUFJFRklYID0gIkFnZW5DIHdyYXBwZXIgbWV0YWRhdGEgdjE6IjsKCmZ1bmN0aW9uIHZhbGlkYXRlVmFsdWVzKGtpbmQsIHZhbHVlcykgewogIGlmICghdmFsdWVzIHx8IHR5cGVvZiB2YWx1ZXMgIT09ICJvYmplY3QiKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJ3cmFwcGVyIHZhbHVlcyBtdXN0IGJlIGFuIG9iamVjdCIpOwogIH0KICBmb3IgKGNvbnN0IGxhYmVsIG9mIFsibm9kZUJpbiIsICJydW50aW1lQmluIiwgImFnZW5jSG9tZSJdKSB7CiAgICBjb25zdCB2YWx1ZSA9IHZhbHVlc1tsYWJlbF07CiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAic3RyaW5nIikgdGhyb3cgbmV3IFR5cGVFcnJvcihgd3JhcHBlciAke2xhYmVsfSBtdXN0IGJlIGEgc3RyaW5nYCk7CiAgICBpZiAodmFsdWUuaW5jbHVkZXMoIlwwIikpIHRocm93IG5ldyBFcnJvcihgd3JhcHBlciAke2xhYmVsfSBjb250YWlucyBOVUxgKTsKICAgIGlmIChraW5kID09PSAiY21kIiAmJiAvWyJcclxuXS91LnRlc3QodmFsdWUpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgV2luZG93cyB3cmFwcGVyICR7bGFiZWx9IGNvbnRhaW5zIGFuIHVuc3VwcG9ydGVkIGNoYXJhY3RlcmApOwogICAgfQogIH0KICBpZiAoIWlzQWJzb2x1dGUodmFsdWVzLmFnZW5jSG9tZSkpIHsKICAgIHRocm93IG5ldyBFcnJvcigid3JhcHBlciBBR0VOQ19IT01FIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCIpOwogIH0KICBpZiAodmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlcy5ub2RlTGlicmFyeVBhdGggIT09ICJzdHJpbmciKSB7CiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoIndyYXBwZXIgbm9kZUxpYnJhcnlQYXRoIG11c3QgYmUgYSBzdHJpbmciKTsKICAgIH0KICAgIGlmICh2YWx1ZXMubm9kZUxpYnJhcnlQYXRoLmluY2x1ZGVzKCJcMCIpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigid3JhcHBlciBub2RlTGlicmFyeVBhdGggY29udGFpbnMgTlVMIik7CiAgICB9CiAgICBpZiAoIWlzQWJzb2x1dGUodmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCkpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJ3cmFwcGVyIG5vZGVMaWJyYXJ5UGF0aCBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGgiKTsKICAgIH0KICAgIGlmIChraW5kID09PSAiY21kIikgewogICAgICB0aHJvdyBuZXcgRXJyb3IoIldpbmRvd3Mgd3JhcHBlcnMgZG8gbm90IHN1cHBvcnQgbm9kZUxpYnJhcnlQYXRoIik7CiAgICB9CiAgfQp9CgpmdW5jdGlvbiBtZXRhZGF0YUZvcih2YWx1ZXMpIHsKICBjb25zdCBtZXRhZGF0YSA9IHsKICAgIG5vZGVCaW46IHZhbHVlcy5ub2RlQmluLAogICAgcnVudGltZUJpbjogdmFsdWVzLnJ1bnRpbWVCaW4sCiAgICBhZ2VuY0hvbWU6IHZhbHVlcy5hZ2VuY0hvbWUsCiAgICAuLi4odmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCA9PT0gdW5kZWZpbmVkCiAgICAgID8ge30KICAgICAgOiB7IG5vZGVMaWJyYXJ5UGF0aDogdmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCB9KSwKICB9OwogIHJldHVybiBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeShtZXRhZGF0YSksICJ1dGY4IikudG9TdHJpbmcoImJhc2U2NHVybCIpOwp9CgpmdW5jdGlvbiByZW5kZXJMZWdhY3lPb21Qb3NpeFdyYXBwZXIoeyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUgfSkgewogIHJldHVybiBbCiAgICAiIyEvYmluL3NoIiwKICAgIGAjICR7UE9TSVhfV1JBUFBFUl9TSUdOQVRVUkV9IOKAlCByZXdyaXR0ZW4gb24gZXZlcnkgaW5zdGFsbC91cGdyYWRlLmAsCiAgICBgZXhwb3J0IEFHRU5DX0hPTUU9Ilwke0FHRU5DX0hPTUU6LSR7YWdlbmNIb21lfX0iYCwKICAgICIjIE9PTSBzZWxmLWRpYWdub3NpczogaGF2ZSBWOCB3cml0ZSBhIGhlYXAgc25hcHNob3QgZnJvbSBpbnNpZGUgdGhlIEdDIHdoZW4iLAogICAgIiMgdGhlIGhlYXAgbmVhcnMgaXRzIGxpbWl0IChyZWxpYWJsZSBldmVuIGluIHRoZSBlbmQtc3RhZ2UgR0Mgc3RhbGwgd2hlcmUgSlMiLAogICAgIiMgdGltZXJzIHN0YXJ2ZSksIGludG8gJEFHRU5DX0hPTUUvb29tLXNuYXBzaG90cy4gVGhlIHJ1bnRpbWUgcHJ1bmVzIG9sZCIsCiAgICAiIyBjYXB0dXJlcyBhbmQgcG9pbnRzIGF0IGZyZXNoIG9uZXMgb24gdGhlIG5leHQgc3RhcnR1cC4gVXNlci1wcm92aWRlZCIsCiAgICAiIyBOT0RFX09QVElPTlMgd2luOiBvdXJzIGFyZSBwcmVwZW5kZWQsIGFuZCB3ZSBza2lwIGVudGlyZWx5IHdoZW4gdGhlIHVzZXIiLAogICAgIiMgYWxyZWFkeSB0dW5lcyBoZWFwIHNuYXBzaG90cy4iLAogICAgJ2Nhc2UgIiAke05PREVfT1BUSU9OUzotfSAiIGluJywKICAgICIgICpoZWFwc25hcHNob3QtbmVhci1oZWFwLWxpbWl0KikgOiA7OyIsCiAgICAiICAqKSIsCiAgICAnICAgIG1rZGlyIC1wICIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiIDI+L2Rldi9udWxsIHx8IDonLAogICAgJyAgICBOT0RFX09QVElPTlM9Ii0taGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdD0xIC0tZGlhZ25vc3RpYy1kaXI9JHtBR0VOQ19IT01FfS9vb20tc25hcHNob3RzICR7Tk9ERV9PUFRJT05TOi19IicsCiAgICAiICAgIGV4cG9ydCBOT0RFX09QVElPTlMiLAogICAgIiAgICA7OyIsCiAgICAiZXNhYyIsCiAgICBgZXhlYyAiJHtub2RlQmlufSIgIiR7cnVudGltZUJpbn0iICIkQCJgLAogICAgIiIsCiAgXS5qb2luKCJcbiIpOwp9CgpleHBvcnQgZnVuY3Rpb24gcmVuZGVyR2VuZXJhdGVkV3JhcHBlckNvbnRlbnQoewogIGtpbmQsCiAgbm9kZUJpbiwKICBydW50aW1lQmluLAogIGFnZW5jSG9tZSwKICBub2RlTGlicmFyeVBhdGgsCn0pIHsKICBpZiAoa2luZCAhPT0gInBvc2l4IiAmJiBraW5kICE9PSAiY21kIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgdW5zdXBwb3J0ZWQgd3JhcHBlciBraW5kOiAke1N0cmluZyhraW5kKX1gKTsKICB9CiAgY29uc3QgdmFsdWVzID0geyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUsIG5vZGVMaWJyYXJ5UGF0aCB9OwogIHZhbGlkYXRlVmFsdWVzKGtpbmQsIHZhbHVlcyk7CiAgY29uc3QgbWV0YWRhdGEgPSBtZXRhZGF0YUZvcih2YWx1ZXMpOwogIGlmIChraW5kID09PSAiY21kIikgewogICAgcmV0dXJuIHJlbmRlckNtZFdyYXBwZXIoewogICAgICBub2RlQmluLAogICAgICBydW50aW1lQmluLAogICAgICBhZ2VuY0hvbWUsCiAgICAgIG1ldGFkYXRhLAogICAgICByZWNvcmRJbnN0YWxsUHJlZml4OiB0cnVlLAogICAgfSk7CiAgfQogIGNvbnN0IHF1b3RlID0gKHZhbHVlKSA9PiBgJyR7dmFsdWUucmVwbGFjZUFsbCgiJyIsIGAnIiciJ2ApfSdgOwogIGNvbnN0IG5vZGVEaXIgPSBwb3NpeC5kaXJuYW1lKG5vZGVCaW4pOwogIGNvbnN0IGV4ZWNQcmVmaXggPSBub2RlTGlicmFyeVBhdGggPT09IHVuZGVmaW5lZAogICAgPyAiZXhlYyAiCiAgICA6IGBMRF9MSUJSQVJZX1BBVEg9JHtxdW90ZShub2RlTGlicmFyeVBhdGgpfSBleGVjIGA7CiAgcmV0dXJuIFsKICAgICIjIS9iaW4vc2giLAogICAgYCMgJHtQT1NJWF9XUkFQUEVSX1NJR05BVFVSRX0g4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsL3VwZ3JhZGUuYCwKICAgIGAjICR7V1JBUFBFUl9NRVRBREFUQV9QUkVGSVh9ICR7bWV0YWRhdGF9YCwKICAgICdpZiBbIC16ICIke0FHRU5DX0hPTUU6LX0iIF07IHRoZW4nLAogICAgYCAgZXhwb3J0IEFHRU5DX0hPTUU9JHtxdW90ZShhZ2VuY0hvbWUpfWAsCiAgICAiZmkiLAogICAgJ2lmIFsgLW4gIiR7UEFUSDotfSIgXTsgdGhlbicsCiAgICBgICBleHBvcnQgUEFUSD0ke3F1b3RlKG5vZGVEaXIpfToiJFBBVEgiYCwKICAgICJlbHNlIiwKICAgIGAgIGV4cG9ydCBQQVRIPSR7cXVvdGUobm9kZURpcil9YCwKICAgICJmaSIsCiAgICAiIyBDYXB0dXJlIG9uZSBWOCBuZWFyLWhlYXAtbGltaXQgc25hcHNob3QgdW5sZXNzIHRoZSBvcGVyYXRvciBhbHJlYWR5IGNvbmZpZ3VyZWQgaXQuIiwKICAgICdjYXNlICIgJHtOT0RFX09QVElPTlM6LX0gIiBpbicsCiAgICAiICAqaGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdCopIiwKICAgIGAgICAgJHtleGVjUHJlZml4fSR7cXVvdGUobm9kZUJpbil9ICR7cXVvdGUocnVudGltZUJpbil9ICIkQCJgLAogICAgIiAgICA7OyIsCiAgICAiICAqKSIsCiAgICAnICAgIG1rZGlyIC1wICIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiIDI+L2Rldi9udWxsIHx8IDonLAogICAgYCAgICAke2V4ZWNQcmVmaXh9JHtxdW90ZShub2RlQmluKX0gLS1oZWFwc25hcHNob3QtbmVhci1oZWFwLWxpbWl0PTEgYCArCiAgICAgICctLWRpYWdub3N0aWMtZGlyPSIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiICcgKwogICAgICBgJHtxdW90ZShydW50aW1lQmluKX0gIiRAImAsCiAgICAiICAgIDs7IiwKICAgICJlc2FjIiwKICAgICIiLAogIF0uam9pbigiXG4iKTsKfQoKZnVuY3Rpb24gcmVuZGVyQ21kV3JhcHBlcih7CiAgbm9kZUJpbiwKICBydW50aW1lQmluLAogIGFnZW5jSG9tZSwKICBtZXRhZGF0YSwKICByZWNvcmRJbnN0YWxsUHJlZml4LAp9KSB7CiAgY29uc3QgYmF0Y2ggPSAodmFsdWUpID0+IHZhbHVlLnJlcGxhY2VBbGwoIiUiLCAiJSUiKTsKICBjb25zdCBub2RlRGlyID0gd2luMzIuZGlybmFtZShub2RlQmluKTsKICBjb25zdCBsaW5lcyA9IFsKICAgICJAZWNobyBvZmYiLAogICAgInNldGxvY2FsIERpc2FibGVEZWxheWVkRXhwYW5zaW9uIiwKICAgIGByZW0gJHtDTURfV1JBUFBFUl9TSUdOQVRVUkV9IC0gcmV3cml0dGVuIG9uIGV2ZXJ5IGluc3RhbGwvdXBncmFkZS5gLAogICAgYHJlbSAke1dSQVBQRVJfTUVUQURBVEFfUFJFRklYfSAke21ldGFkYXRhfWAsCiAgICBgaWYgbm90IGRlZmluZWQgQUdFTkNfSE9NRSBzZXQgIkFHRU5DX0hPTUU9JHtiYXRjaChhZ2VuY0hvbWUpfSJgLAogIF07CiAgaWYgKHJlY29yZEluc3RhbGxQcmVmaXgpIHsKICAgIGxpbmVzLnB1c2goCiAgICAgICdpZiBub3QgZGVmaW5lZCBBR0VOQ19JTlNUQUxMX1BSRUZJWCBmb3IgJSVJIGluICgiJX5kcDAuLiIpIGRvIHNldCAiQUdFTkNfSU5TVEFMTF9QUkVGSVg9JSV+ZkkiJywKICAgICk7CiAgfQogIGxpbmVzLnB1c2goCiAgICBgc2V0ICJQQVRIPSR7YmF0Y2gobm9kZURpcil9OyVQQVRIJSJgLAogICAgYCIke2JhdGNoKG5vZGVCaW4pfSIgIiR7YmF0Y2gocnVudGltZUJpbil9IiAlKmAsCiAgICAiIiwKICApOwogIHJldHVybiBsaW5lcy5qb2luKCJcclxuIik7Cn0KCmZ1bmN0aW9uIHJlbmRlckhpc3RvcmljYWxQcml2YXRlTm9kZUNtZFdyYXBwZXIodmFsdWVzKSB7CiAgcmV0dXJuIHJlbmRlckNtZFdyYXBwZXIoewogICAgLi4udmFsdWVzLAogICAgbWV0YWRhdGE6IG1ldGFkYXRhRm9yKHZhbHVlcyksCiAgICByZWNvcmRJbnN0YWxsUHJlZml4OiBmYWxzZSwKICB9KTsKfQoKLy8gUmVsZWFzZXMgMC42LjIgdGhyb3VnaCAwLjEwLjAgZW1pdHRlZCB0aGlzIGltbXV0YWJsZSBtZXRhZGF0YS12MSBzaGFwZQovLyBiZWZvcmUgc3RhbmRhbG9uZSBpbnN0YWxscyBjYXJyaWVkIGEgcHJpdmF0ZSBOb2RlIHJ1bnRpbWUuIEtlZXAgdGhlIHJlbmRlcmVyCi8vIHByaXZhdGU6IGl0IGV4aXN0cyBvbmx5IHNvIG93bmVyc2hpcCBjYW4gYmUgcHJvdmVuIGJ5IGV4YWN0IGZ1bGwtZmlsZQovLyByZWNvbnN0cnVjdGlvbiwgbmV2ZXIgYnkgdHJ1c3RpbmcgdGhlIGhpc3RvcmljYWwgbWFya2VyIG9yIG1ldGFkYXRhIGFsb25lLgpmdW5jdGlvbiByZW5kZXJQcmVQcml2YXRlTm9kZVdyYXBwZXJDb250ZW50KHsKICBraW5kLAogIG5vZGVCaW4sCiAgcnVudGltZUJpbiwKICBhZ2VuY0hvbWUsCn0pIHsKICBpZiAoa2luZCAhPT0gInBvc2l4IiAmJiBraW5kICE9PSAiY21kIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgdW5zdXBwb3J0ZWQgd3JhcHBlciBraW5kOiAke1N0cmluZyhraW5kKX1gKTsKICB9CiAgY29uc3QgdmFsdWVzID0geyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUgfTsKICB2YWxpZGF0ZVZhbHVlcyhraW5kLCB2YWx1ZXMpOwogIGNvbnN0IG1ldGFkYXRhID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkoewogICAgbm9kZUJpbiwKICAgIHJ1bnRpbWVCaW4sCiAgICBhZ2VuY0hvbWUsCiAgfSksICJ1dGY4IikudG9TdHJpbmcoImJhc2U2NHVybCIpOwogIGlmIChraW5kID09PSAiY21kIikgewogICAgY29uc3QgYmF0Y2ggPSAodmFsdWUpID0+IHZhbHVlLnJlcGxhY2VBbGwoIiUiLCAiJSUiKTsKICAgIHJldHVybiBbCiAgICAgICJAZWNobyBvZmYiLAogICAgICAic2V0bG9jYWwgRGlzYWJsZURlbGF5ZWRFeHBhbnNpb24iLAogICAgICBgcmVtICR7Q01EX1dSQVBQRVJfU0lHTkFUVVJFfSAtIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsL3VwZ3JhZGUuYCwKICAgICAgYHJlbSAke1dSQVBQRVJfTUVUQURBVEFfUFJFRklYfSAke21ldGFkYXRhfWAsCiAgICAgIGBpZiBub3QgZGVmaW5lZCBBR0VOQ19IT01FIHNldCAiQUdFTkNfSE9NRT0ke2JhdGNoKGFnZW5jSG9tZSl9ImAsCiAgICAgIGAiJHtiYXRjaChub2RlQmluKX0iICIke2JhdGNoKHJ1bnRpbWVCaW4pfSIgJSpgLAogICAgICAiIiwKICAgIF0uam9pbigiXHJcbiIpOwogIH0KICBjb25zdCBxdW90ZSA9ICh2YWx1ZSkgPT4gYCcke3ZhbHVlLnJlcGxhY2VBbGwoIiciLCBgJyInIidgKX0nYDsKICByZXR1cm4gWwogICAgIiMhL2Jpbi9zaCIsCiAgICBgIyAke1BPU0lYX1dSQVBQRVJfU0lHTkFUVVJFfSDigJQgcmV3cml0dGVuIG9uIGV2ZXJ5IGluc3RhbGwvdXBncmFkZS5gLAogICAgYCMgJHtXUkFQUEVSX01FVEFEQVRBX1BSRUZJWH0gJHttZXRhZGF0YX1gLAogICAgJ2lmIFsgLXogIiR7QUdFTkNfSE9NRTotfSIgXTsgdGhlbicsCiAgICBgICBleHBvcnQgQUdFTkNfSE9NRT0ke3F1b3RlKGFnZW5jSG9tZSl9YCwKICAgICJmaSIsCiAgICAiIyBDYXB0dXJlIG9uZSBWOCBuZWFyLWhlYXAtbGltaXQgc25hcHNob3QgdW5sZXNzIHRoZSBvcGVyYXRvciBhbHJlYWR5IGNvbmZpZ3VyZWQgaXQuIiwKICAgICdjYXNlICIgJHtOT0RFX09QVElPTlM6LX0gIiBpbicsCiAgICAiICAqaGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdCopIiwKICAgIGAgICAgZXhlYyAke3F1b3RlKG5vZGVCaW4pfSAke3F1b3RlKHJ1bnRpbWVCaW4pfSAiJEAiYCwKICAgICIgICAgOzsiLAogICAgIiAgKikiLAogICAgJyAgICBta2RpciAtcCAiJHtBR0VOQ19IT01FfS9vb20tc25hcHNob3RzIiAyPi9kZXYvbnVsbCB8fCA6JywKICAgIGAgICAgZXhlYyAke3F1b3RlKG5vZGVCaW4pfSAtLWhlYXBzbmFwc2hvdC1uZWFyLWhlYXAtbGltaXQ9MSBgICsKICAgICAgJy0tZGlhZ25vc3RpYy1kaXI9IiR7QUdFTkNfSE9NRX0vb29tLXNuYXBzaG90cyIgJyArCiAgICAgIGAke3F1b3RlKHJ1bnRpbWVCaW4pfSAiJEAiYCwKICAgICIgICAgOzsiLAogICAgImVzYWMiLAogICAgIiIsCiAgXS5qb2luKCJcbiIpOwp9CgpmdW5jdGlvbiBkZWNvZGVDYW5vbmljYWxNZXRhZGF0YShlbmNvZGVkKSB7CiAgdHJ5IHsKICAgIGNvbnN0IGJ5dGVzID0gQnVmZmVyLmZyb20oZW5jb2RlZCwgImJhc2U2NHVybCIpOwogICAgaWYgKGJ5dGVzLnRvU3RyaW5nKCJiYXNlNjR1cmwiKSAhPT0gZW5jb2RlZCkgcmV0dXJuIHVuZGVmaW5lZDsKICAgIGNvbnN0IGRlY29kZWQgPSBuZXcgVGV4dERlY29kZXIoInV0Zi04IiwgeyBmYXRhbDogdHJ1ZSB9KS5kZWNvZGUoYnl0ZXMpOwogICAgY29uc3QgdmFsdWUgPSBKU09OLnBhcnNlKGRlY29kZWQpOwogICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSAhPT0gIm9iamVjdCIgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB1bmRlZmluZWQ7CiAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXModmFsdWUpOwogICAgY29uc3QgZXhwZWN0ZWRLZXlzID0gdmFsdWUubm9kZUxpYnJhcnlQYXRoID09PSB1bmRlZmluZWQKICAgICAgPyBbIm5vZGVCaW4iLCAicnVudGltZUJpbiIsICJhZ2VuY0hvbWUiXQogICAgICA6IFsibm9kZUJpbiIsICJydW50aW1lQmluIiwgImFnZW5jSG9tZSIsICJub2RlTGlicmFyeVBhdGgiXTsKICAgIGlmICgKICAgICAga2V5cy5sZW5ndGggIT09IGV4cGVjdGVkS2V5cy5sZW5ndGggfHwKICAgICAgIWV4cGVjdGVkS2V5cy5ldmVyeSgoa2V5LCBpbmRleCkgPT4ga2V5c1tpbmRleF0gPT09IGtleSkgfHwKICAgICAgdHlwZW9mIHZhbHVlLm5vZGVCaW4gIT09ICJzdHJpbmciIHx8CiAgICAgIHR5cGVvZiB2YWx1ZS5ydW50aW1lQmluICE9PSAic3RyaW5nIiB8fAogICAgICB0eXBlb2YgdmFsdWUuYWdlbmNIb21lICE9PSAic3RyaW5nIiB8fAogICAgICAodmFsdWUubm9kZUxpYnJhcnlQYXRoICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCAhPT0gInN0cmluZyIpCiAgICApIHJldHVybiB1bmRlZmluZWQ7CiAgICByZXR1cm4gewogICAgICBub2RlQmluOiB2YWx1ZS5ub2RlQmluLAogICAgICBydW50aW1lQmluOiB2YWx1ZS5ydW50aW1lQmluLAogICAgICBhZ2VuY0hvbWU6IHZhbHVlLmFnZW5jSG9tZSwKICAgICAgLi4uKHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCA9PT0gdW5kZWZpbmVkCiAgICAgICAgPyB7fQogICAgICAgIDogeyBub2RlTGlicmFyeVBhdGg6IHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCB9KSwKICAgIH07CiAgfSBjYXRjaCB7CiAgICByZXR1cm4gdW5kZWZpbmVkOwogIH0KfQoKZnVuY3Rpb24gcGFyc2VNb2Rlcm4ocGF0aCwgY29udGVudCkgewogIGNvbnN0IG1hcmtlciA9IGNvbnRlbnQubWF0Y2goCiAgICAvXigjfHJlbSkgQWdlbkMgd3JhcHBlciBtZXRhZGF0YSB2MTogKFtBLVphLXowLTlfLV0rKVxyPyQvbXUsCiAgKTsKICBpZiAobWFya2VyID09PSBudWxsKSByZXR1cm4gdW5kZWZpbmVkOwogIGNvbnN0IGtpbmQgPSBtYXJrZXJbMV0gPT09ICJyZW0iID8gImNtZCIgOiAicG9zaXgiOwogIGNvbnN0IHZhbHVlcyA9IGRlY29kZUNhbm9uaWNhbE1ldGFkYXRhKG1hcmtlclsyXSk7CiAgaWYgKHZhbHVlcyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkOwogIHRyeSB7CiAgICBjb25zdCB3cmFwcGVyID0geyBraW5kLCBwYXRoLCAuLi52YWx1ZXMgfTsKICAgIGlmIChyZW5kZXJHZW5lcmF0ZWRXcmFwcGVyQ29udGVudCh3cmFwcGVyKSA9PT0gY29udGVudCkgcmV0dXJuIHdyYXBwZXI7CiAgICBpZiAoCiAgICAgIGtpbmQgPT09ICJjbWQiICYmCiAgICAgIHZhbHVlcy5ub2RlTGlicmFyeVBhdGggPT09IHVuZGVmaW5lZCAmJgogICAgICByZW5kZXJIaXN0b3JpY2FsUHJpdmF0ZU5vZGVDbWRXcmFwcGVyKHZhbHVlcykgPT09IGNvbnRlbnQKICAgICkgcmV0dXJuIHdyYXBwZXI7CiAgICBpZiAoCiAgICAgIHZhbHVlcy5ub2RlTGlicmFyeVBhdGggPT09IHVuZGVmaW5lZCAmJgogICAgICByZW5kZXJQcmVQcml2YXRlTm9kZVdyYXBwZXJDb250ZW50KHdyYXBwZXIpID09PSBjb250ZW50CiAgICApIHJldHVybiB3cmFwcGVyOwogICAgcmV0dXJuIHVuZGVmaW5lZDsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpmdW5jdGlvbiBwYXJzZUxlZ2FjeShwYXRoLCBjb250ZW50KSB7CiAgY29uc3QgcG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKHBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogcG9zaXhbMV0sIG5vZGVCaW46IHBvc2l4WzJdLCBydW50aW1lQmluOiBwb3NpeFszXSB9OwogICAgdHJ5IHsKICAgICAgdmFsaWRhdGVWYWx1ZXMoInBvc2l4IiwgdmFsdWVzKTsKICAgICAgcmV0dXJuIHsga2luZDogInBvc2l4IiwgcGF0aCwgLi4udmFsdWVzIH07CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuIHVuZGVmaW5lZDsKICAgIH0KICB9CiAgLy8gMC42LjIgZGV2ZWxvcG1lbnQgbWFpbiBicmllZmx5IGVtaXR0ZWQgdGhpcyBleGFjdCBmdWxsLWZpbGUgd3JhcHBlciBiZWZvcmUKICAvLyBhY3RpdmF0aW9uIG93bmVyc2hpcCBiZWNhbWUgY2Fub25pY2FsLiBBY2NlcHRpbmcgb25seSBhIGJ5dGUtZm9yLWJ5dGUKICAvLyByZWNvbnN0cnVjdGlvbiBwcmVzZXJ2ZXMgdXBncmFkZXMgZnJvbSB0aGF0IHN1cmZhY2Ugd2l0aG91dCB0dXJuaW5nIHRoZQogIC8vIGhpc3RvcmljYWwgbWFya2VyIGludG8gYSBnZW5lcmFsIG93bmVyc2hpcCBvcmFjbGUuCiAgY29uc3Qgb29tUG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuW1xzXFNdKlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKG9vbVBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7CiAgICAgIGFnZW5jSG9tZTogb29tUG9zaXhbMV0sCiAgICAgIG5vZGVCaW46IG9vbVBvc2l4WzJdLAogICAgICBydW50aW1lQmluOiBvb21Qb3NpeFszXSwKICAgIH07CiAgICB0cnkgewogICAgICB2YWxpZGF0ZVZhbHVlcygicG9zaXgiLCB2YWx1ZXMpOwogICAgICBpZiAocmVuZGVyTGVnYWN5T29tUG9zaXhXcmFwcGVyKHZhbHVlcykgPT09IGNvbnRlbnQpIHsKICAgICAgICByZXR1cm4geyBraW5kOiAicG9zaXgiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICAgICAgfQogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiB1bmRlZmluZWQ7CiAgICB9CiAgfQogIGNvbnN0IGNtZCA9IGNvbnRlbnQubWF0Y2goCiAgICAvXkBlY2hvIG9mZihccj9cbilyZW0gR2VuZXJhdGVkIGJ5IEFnZW5DIGluc3RhbGxcLnBzMSAtIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cMWlmIG5vdCBkZWZpbmVkIEFHRU5DX0hPTUUgc2V0ICJBR0VOQ19IT01FPShbXiJcclxuXSspIlwxIihbXiJcclxuXSspIiAiKFteIlxyXG5dKykiICVcKlwxJC91LAogICk7CiAgaWYgKGNtZCA9PT0gbnVsbCkgcmV0dXJuIHVuZGVmaW5lZDsKICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogY21kWzJdLCBub2RlQmluOiBjbWRbM10sIHJ1bnRpbWVCaW46IGNtZFs0XSB9OwogIHRyeSB7CiAgICB2YWxpZGF0ZVZhbHVlcygiY21kIiwgdmFsdWVzKTsKICAgIHJldHVybiB7IGtpbmQ6ICJjbWQiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpleHBvcnQgZnVuY3Rpb24gcGFyc2VHZW5lcmF0ZWRXcmFwcGVyQ29udGVudChwYXRoLCBjb250ZW50KSB7CiAgaWYgKAogICAgdHlwZW9mIHBhdGggIT09ICJzdHJpbmciIHx8ICFpc0Fic29sdXRlKHBhdGgpIHx8CiAgICB0eXBlb2YgY29udGVudCAhPT0gInN0cmluZyIgfHwgQnVmZmVyLmJ5dGVMZW5ndGgoY29udGVudCwgInV0ZjgiKSA+IEdFTkVSQVRFRF9XUkFQUEVSX01BWF9CWVRFUwogICkgcmV0dXJuIG51bGw7CiAgcmV0dXJuIHBhcnNlTW9kZXJuKHBhdGgsIGNvbnRlbnQpID8/IHBhcnNlTGVnYWN5KHBhdGgsIGNvbnRlbnQpID8/IG51bGw7Cn0K";
let generatedWrapperModulePromise;
function loadGeneratedWrapperModule() {
  generatedWrapperModulePromise ??= import(
    `data:text/javascript;base64,${AGENC_GENERATED_WRAPPER_SOURCE_BASE64}`,
  );
  return generatedWrapperModulePromise;
}
// END GENERATED AGENC WRAPPER CONTRACT MODULE

// BEGIN GENERATED AGENC STABLE NODE MODULE
function loadStableNodeModule() {
  return import("data:text/javascript;base64,Ly8gbWFjT1Mga2VlcHMgY29tbWFuZC1saW5lIHByaXZhY3kgZ3JhbnRzIGJ5IGV4ZWN1dGFibGUgcGF0aCBhbmQgY29kZSBpZGVudGl0eS4KLy8gQ29weSB0aGUgdmVyaWZpZWQgcmVsZWFzZSBieXRlcy4gTmV2ZXIgc3ltbGluaywgcGF0Y2gsIHN0cmlwLCBvciByZS1zaWduIE5vZGUuCmltcG9ydCB7IGNyZWF0ZUhhc2gsIHJhbmRvbVVVSUQgfSBmcm9tICJub2RlOmNyeXB0byI7CmltcG9ydCB7IGNsb3NlU3luYywgY29uc3RhbnRzLCBjb3B5RmlsZVN5bmMsIGZjaG1vZFN5bmMsIGZzeW5jU3luYywgbHN0YXRTeW5jLAogIG1rZGlyU3luYywgb3BlblN5bmMsIHJlYWRGaWxlU3luYywgcmVhZGxpbmtTeW5jLCByZWFkZGlyU3luYywgcmVhbHBhdGhTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHN5bWxpbmtTeW5jIH0gZnJvbSAibm9kZTpmcyI7CmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gIm5vZGU6cGF0aCI7CgpleHBvcnQgZnVuY3Rpb24gc3RhYmxlTm9kZVBhdGgoaG9tZSkgeyByZXR1cm4gam9pbihob21lLCAiYmluIiwgImFnZW5jLW5vZGUiKTsgfQoKZnVuY3Rpb24gcmVndWxhcihwYXRoKSB7CiAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhwYXRoKTsKICBpZiAoIXN0YXQuaXNGaWxlKCkgfHwgc3RhdC5pc1N5bWJvbGljTGluaygpIHx8IHN0YXQubmxpbmsgIT09IDEpIHsKICAgIHRocm93IG5ldyBFcnJvcihgTm9kZSBtdXN0IGJlIGEgcmVndWxhciB1bmFsaWFzZWQgZmlsZTogJHtwYXRofWApOwogIH0KICByZXR1cm4gc3RhdDsKfQpmdW5jdGlvbiBoYXNoKHBhdGgpIHsKICByZWd1bGFyKHBhdGgpOwogIHJldHVybiBjcmVhdGVIYXNoKCJzaGEyNTYiKS51cGRhdGUocmVhZEZpbGVTeW5jKHBhdGgpKS5kaWdlc3QoImhleCIpOwp9CmZ1bmN0aW9uIHN5bmNEaXJlY3RvcnkocGF0aCkgewogIGNvbnN0IGZkID0gb3BlblN5bmMocGF0aCwgY29uc3RhbnRzLk9fUkRPTkxZKTsKICB0cnkgeyBmc3luY1N5bmMoZmQpOyB9IGZpbmFsbHkgeyBjbG9zZVN5bmMoZmQpOyB9Cn0KCi8vIEEgdHJhbnNhY3Rpb24gc3RvcmVzIG9ubHkgYSBzb3VyY2UgaW5zaWRlIGl0cyB2ZXJpZmllZCBjb250ZW50LWFkZHJlc3NlZCB0cmVlLgovLyBSZWNvdmVyeSByZWNoZWNrcyBpZGVudGl0eS5qc29uIGFuZCB0aGUgcGlubmVkIGV4ZWN1dGFibGUgaGFzaCBiZWZvcmUgY29weWluZy4KZXhwb3J0IGZ1bmN0aW9uIGRlc2NyaWJlU3RhYmxlTm9kZShob21lLCBzb3VyY2UpIHsKICBob21lID0gcmVhbHBhdGhTeW5jKGhvbWUpOwogIGNvbnN0IHBhcnRzID0gcmVsYXRpdmUoam9pbihob21lLCAicnVudGltZSIpLCByZXNvbHZlKHNvdXJjZSkpLnNwbGl0KCIvIik7CiAgaWYgKHBhcnRzLmxlbmd0aCAhPT0gNiB8fCAhL15cZCtcLlxkK1wuXGQrKD86LVswLTlBLVphLXouLV0rKT8kLy50ZXN0KHBhcnRzWzBdKSB8fAogICAgICAhL15kYXJ3aW4tKD86YXJtNjR8eDY0KS1uYXRpdmUtbm9kZS1hYmktXGQrLXNoYTI1Ni1bYS1mMC05XXs2NH0kLy50ZXN0KHBhcnRzWzFdKSB8fAogICAgICBwYXJ0cy5zbGljZSgyKS5qb2luKCIvIikgIT09ICJub2RlX21vZHVsZXMvLmFnZW5jLW5vZGUvYmluL25vZGUiIHx8CiAgICAgIHJlYWxwYXRoU3luYyhzb3VyY2UpICE9PSByZXNvbHZlKHNvdXJjZSkpIHsKICAgIHRocm93IG5ldyBFcnJvcigic3RhYmxlIE5vZGUgc291cmNlIG11c3QgYmUgaW4gYSBtYWNPUyBjb250ZW50LWFkZHJlc3NlZCBydW50aW1lIik7CiAgfQogIGNvbnN0IHRyZWUgPSBqb2luKGhvbWUsICJydW50aW1lIiwgcGFydHNbMF0sIHBhcnRzWzFdKTsKICBjb25zdCBtYXJrZXIgPSByZWFkRmlsZVN5bmMoam9pbih0cmVlLCAiLmFnZW5jLXJ1bnRpbWUtb2siKSwgInV0ZjgiKS50cmltKCk7CiAgaWYgKG1hcmtlciAhPT0gcGFydHNbMV0uc2xpY2UoLTY0KSkgdGhyb3cgbmV3IEVycm9yKCJzdGFibGUgTm9kZSBydW50aW1lIG1hcmtlciBtaXNtYXRjaCIpOwogIGNvbnN0IGlkZW50aXR5UGF0aCA9IGpvaW4oZGlybmFtZShkaXJuYW1lKHNvdXJjZSkpLCAiaWRlbnRpdHkuanNvbiIpOwogIHJlZ3VsYXIoaWRlbnRpdHlQYXRoKTsKICBjb25zdCBpZGVudGl0eSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGlkZW50aXR5UGF0aCwgInV0ZjgiKSk7CiAgaWYgKGlkZW50aXR5LnNjaGVtYVZlcnNpb24gIT09IDEgfHwgaWRlbnRpdHkuZXhlY3V0YWJsZSAhPT0gImJpbi9ub2RlIiB8fAogICAgICAhL15bYS1mMC05XXs2NH0kLy50ZXN0KGlkZW50aXR5LmV4ZWN1dGFibGVTaGEyNTYpIHx8CiAgICAgIHJlZ3VsYXIoc291cmNlKS5zaXplICE9PSBpZGVudGl0eS5leGVjdXRhYmxlQnl0ZXMgfHwKICAgICAgaGFzaChzb3VyY2UpICE9PSBpZGVudGl0eS5leGVjdXRhYmxlU2hhMjU2KSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoInN0YWJsZSBOb2RlIGV4ZWN1dGFibGUgaWRlbnRpdHkgbWlzbWF0Y2giKTsKICB9CiAgcmV0dXJuIHsgc291cmNlOiByZXNvbHZlKHNvdXJjZSksIHNoYTI1NjogaWRlbnRpdHkuZXhlY3V0YWJsZVNoYTI1NiB9Owp9CgpmdW5jdGlvbiBjbGVhbnVwTm9kZVN0YWdpbmcoZGlyZWN0b3J5KSB7CiAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKGRpcmVjdG9yeSkpIHsKICAgIGNvbnN0IG1hdGNoID0gL15cLmFnZW5jLW5vZGUtKFxkKyktW2EtZjAtOS1dezM2fSQvLmV4ZWMobmFtZSk7CiAgICBpZiAobWF0Y2ggPT09IG51bGwpIGNvbnRpbnVlOwogICAgdHJ5IHsgcHJvY2Vzcy5raWxsKE51bWJlcihtYXRjaFsxXSksIDApOyBjb250aW51ZTsgfQogICAgY2F0Y2ggKGVycm9yKSB7IGlmIChlcnJvci5jb2RlICE9PSAiRVNSQ0giKSBjb250aW51ZTsgfQogICAgY29uc3QgcGF0aCA9IGpvaW4oZGlyZWN0b3J5LCBuYW1lKTsKICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMocGF0aCk7CiAgICBpZiAoc3RhdC5pc0ZpbGUoKSAmJiAhc3RhdC5pc1N5bWJvbGljTGluaygpICYmIHN0YXQubmxpbmsgPT09IDEgJiYgc3RhdC51aWQgPT09IHByb2Nlc3MuZ2V0dWlkKCkpIHsKICAgICAgcm1TeW5jKHBhdGgpOwogICAgfQogIH0KfQoKZnVuY3Rpb24gbm9kZUFsaWFzKHRhcmdldCkgewogIGNvbnN0IGFsaWFzID0gam9pbihkaXJuYW1lKHRhcmdldCksICJub2RlIik7CiAgdHJ5IHsKICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMoYWxpYXMpOwogICAgaWYgKCFzdGF0LmlzU3ltYm9saWNMaW5rKCkgfHwgcmVhZGxpbmtTeW5jKGFsaWFzKSAhPT0gYmFzZW5hbWUodGFyZ2V0KSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoInN0YWJsZSBOb2RlIFBBVEggYWxpYXMgaXMgb2NjdXBpZWQiKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgaWYgKGVycm9yLmNvZGUgIT09ICJFTk9FTlQiKSB0aHJvdyBlcnJvcjsKICAgIHN5bWxpbmtTeW5jKGJhc2VuYW1lKHRhcmdldCksIGFsaWFzKTsKICAgIHN5bmNEaXJlY3RvcnkoZGlybmFtZSh0YXJnZXQpKTsKICB9CiAgcmV0dXJuIHRhcmdldDsKfQoKZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxTdGFibGVOb2RlKGhvbWUsIGRlc2NyaXB0aW9uLCBjaGVja3BvaW50ID0gKCkgPT4ge30pIHsKICBjb25zdCBjaGVja2VkID0gZGVzY3JpYmVTdGFibGVOb2RlKGhvbWUsIGRlc2NyaXB0aW9uLnNvdXJjZSk7CiAgaWYgKGNoZWNrZWQuc2hhMjU2ICE9PSBkZXNjcmlwdGlvbi5zaGEyNTYpIHRocm93IG5ldyBFcnJvcigic3RhYmxlIE5vZGUgam91cm5hbCBoYXNoIG1pc21hdGNoIik7CiAgY29uc3QgdGFyZ2V0ID0gc3RhYmxlTm9kZVBhdGgoaG9tZSk7CiAgY29uc3QgZGlyZWN0b3J5ID0gZGlybmFtZSh0YXJnZXQpOwogIG1rZGlyU3luYyhkaXJlY3RvcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBtb2RlOiAwbzcwMCB9KTsKICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGRpcmVjdG9yeSk7CiAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkgfHwgc3RhdC5pc1N5bWJvbGljTGluaygpIHx8IHJlYWxwYXRoU3luYyhkaXJlY3RvcnkpICE9PSBkaXJlY3RvcnkgfHwKICAgICAgc3RhdC51aWQgIT09IHByb2Nlc3MuZ2V0dWlkKCkgfHwgKHN0YXQubW9kZSAmIDBvMDIyKSAhPT0gMCkgewogICAgdGhyb3cgbmV3IEVycm9yKCJzdGFibGUgTm9kZSBkaXJlY3RvcnkgaXMgbm90IHByaXZhdGUgYW5kIGNhbm9uaWNhbCIpOwogIH0KICBjbGVhbnVwTm9kZVN0YWdpbmcoZGlyZWN0b3J5KTsKICB0cnkgewogICAgaWYgKGhhc2godGFyZ2V0KSA9PT0gY2hlY2tlZC5zaGEyNTYpIHJldHVybiBub2RlQWxpYXModGFyZ2V0KTsKICB9IGNhdGNoIChlcnJvcikgewogICAgaWYgKGVycm9yLmNvZGUgIT09ICJFTk9FTlQiKSB0aHJvdyBlcnJvcjsKICB9CiAgY29uc3QgdGVtcG9yYXJ5ID0gam9pbihkaXJlY3RvcnksIGAuJHtiYXNlbmFtZSh0YXJnZXQpfS0ke3Byb2Nlc3MucGlkfS0ke3JhbmRvbVVVSUQoKX1gKTsKICB0cnkgewogICAgY29weUZpbGVTeW5jKGNoZWNrZWQuc291cmNlLCB0ZW1wb3JhcnksIGNvbnN0YW50cy5DT1BZRklMRV9FWENMKTsKICAgIGlmIChoYXNoKHRlbXBvcmFyeSkgIT09IGNoZWNrZWQuc2hhMjU2KSB0aHJvdyBuZXcgRXJyb3IoInN0YWJsZSBOb2RlIGNvcHkgY2hlY2tzdW0gbWlzbWF0Y2giKTsKICAgIGNvbnN0IGZkID0gb3BlblN5bmModGVtcG9yYXJ5LCBjb25zdGFudHMuT19SRE9OTFkgfCBjb25zdGFudHMuT19OT0ZPTExPVyk7CiAgICB0cnkgeyBmY2htb2RTeW5jKGZkLCAwbzc1NSk7IGZzeW5jU3luYyhmZCk7IH0gZmluYWxseSB7IGNsb3NlU3luYyhmZCk7IH0KICAgIGNoZWNrcG9pbnQoIm5vZGUtc3RhZ2VkIik7CiAgICAvLyByZW5hbWUgcHJlc2VydmVzIGEgcnVubmluZyBwcm9jZXNzJ3Mgb2xkIGV4ZWN1dGFibGUgbWFwcGluZy4gV3JpdGluZyBpbnRvCiAgICAvLyB0aGUgZXhpc3RpbmcgaW5vZGUgd291bGQgaW52YWxpZGF0ZSBzaWduZWQgZXhlY3V0YWJsZSBwYWdlcyBvbiBtYWNPUy4KICAgIHJlbmFtZVN5bmModGVtcG9yYXJ5LCB0YXJnZXQpOwogICAgc3luY0RpcmVjdG9yeShkaXJlY3RvcnkpOwogICAgY2hlY2twb2ludCgibm9kZS1yZXBsYWNlZCIpOwogICAgcmV0dXJuIG5vZGVBbGlhcyh0YXJnZXQpOwogIH0gZmluYWxseSB7CiAgICBybVN5bmModGVtcG9yYXJ5LCB7IGZvcmNlOiB0cnVlIH0pOwogIH0KfQo=");
}
// END GENERATED AGENC STABLE NODE MODULE

// BEGIN GENERATED AGENC RUNTIME MAINTENANCE MODULE
function loadRuntimeMaintenanceModule() {
  return import("data:text/javascript;base64,Ly8gQ2xlYW51cCBpcyBkZWxpYmVyYXRlbHkgbWFjT1Mtb25seS4gS2VlcCBMaW51eC9XaW5kb3dzIGluc3RhbGwgc2VtYW50aWNzLgppbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gIm5vZGU6Y2hpbGRfcHJvY2VzcyI7CmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICJub2RlOmNyeXB0byI7CmltcG9ydCB7IGNsb3NlU3luYywgY29uc3RhbnRzLCBmY2htb2RTeW5jLCBmc3RhdFN5bmMsIGZzeW5jU3luYywgbHN0YXRTeW5jLCBta2RpclN5bmMsIG9wZW5TeW5jLCByZWFkRmlsZVN5bmMsCiAgcmVhZGRpclN5bmMsIHJlYWxwYXRoU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCBleGlzdHNTeW5jIH0gZnJvbSAibm9kZTpmcyI7CmltcG9ydCB7IGpvaW4sIGRpcm5hbWUgfSBmcm9tICJub2RlOnBhdGgiOwppbXBvcnQgeyBhY3F1aXJlTG9jYWxTcWxpdGVMb2NrIH0gZnJvbSAiZGF0YTp0ZXh0L2phdmFzY3JpcHQ7YmFzZTY0LEx5OGdRM0p2YzNNdGNISnZZMlZ6Y3lCc2IyTmhiQ0JtYVd4bGMzbHpkR1Z0SUd4dlkydHpJR0poWTJ0bFpDQmllU0JUVVV4cGRHVW5jeUJQVXlCc2IyTnJhVzVuSUd4aGVXVnlMZ292THdvdkx5QkNSVWRKVGlCSlRVMUZSRWxCVkVVZ2IzZHVjeUIwYUdVZ2QzSnBkR1Z5SUhKbGMyVnlkbUYwYVc5dUlHWnZjaUIwYUdVZ1kyRnNiR1Z5SjNNZ1kzSnBkR2xqWVd3S0x5OGdjMlZqZEdsdmJpNGdVMUZNYVhSbElISmxiR1ZoYzJWeklHbDBJRzl1SUdOc2IzTmxJRzl5SUhCeWIyTmxjM01nWkdWaGRHZ3NJR2x1WTJ4MVpHbHVaeUJUU1VkTFNVeE1MZ292THlCQklIQnliMk5sYzNNdGQybGtaU0JHU1VaUElISmxaMmx6ZEhKNUlIQnlaWFpsYm5SeklHUjFjR3hwWTJGMFpTQnRiMlIxYkdVZ2FXNXpkR0Z1WTJWeklHWnliMjBLTHk4Z1lteHZZMnRwYm1jZ2IyNWxJR0Z1YjNSb1pYSWdhVzV6YVdSbElITjVibU5vY205dWIzVnpJRk5SVEdsMFpTQmpZV3hzY3pzZ1kzSnZjM010Y0hKdlkyVnpjeUJpZFhONUNpOHZJR052Ym5SbGJuUnBiMjRnYVhNZ2NtVjBjbWxsWkNCaGMzbHVZMmh5YjI1dmRYTnNlU0JoWjJGcGJuTjBJRzl1WlNCdGIyNXZkRzl1YVdNZ1pHVmhaR3hwYm1VdUNncHBiWEJ2Y25RZ2V5QmxlR1ZqUm1sc1pTQjlJR1p5YjIwZ0ltNXZaR1U2WTJocGJHUmZjSEp2WTJWemN5STdDbWx0Y0c5eWRDQjdDaUFnWTJ4dmMyVlRlVzVqTEFvZ0lHTnZibk4wWVc1MGN5QmhjeUJtYzBOdmJuTjBZVzUwY3l3S0lDQm1jM1JoZEZONWJtTXNDaUFnYkhOMFlYUlRlVzVqTEFvZ0lHOXdaVzVUZVc1akxBb2dJSEpsWVd4d1lYUm9VM2x1WXl3S2ZTQm1jbTl0SUNKdWIyUmxPbVp6SWpzS2FXMXdiM0owSUhzS0lDQmphRzF2WkN3S0lDQnNjM1JoZEN3S0lDQnRhMlJwY2l3S0lDQnZjR1Z1TEFvZ0lISmxZV1JHYVd4bExBb2dJSEpsWVd4d1lYUm9MQXA5SUdaeWIyMGdJbTV2WkdVNlpuTXZjSEp2YldselpYTWlPd3BwYlhCdmNuUWdld29nSUdKaGMyVnVZVzFsTEFvZ0lHUnBjbTVoYldVc0NpQWdhbTlwYml3S0lDQnlaWE52YkhabExBb2dJSE5sY0N3S0lDQjNhVzR6TWl3S2ZTQm1jbTl0SUNKdWIyUmxPbkJoZEdnaU93cHBiWEJ2Y25RZ2V5QnpaWFJVYVcxbGIzVjBJR0Z6SUdSbGJHRjVJSDBnWm5KdmJTQWlibTlrWlRwMGFXMWxjbk12Y0hKdmJXbHpaWE1pT3dvS1kyOXVjM1FnVEU5RFMxOUJVRkJNU1VOQlZFbFBUbDlKUkNBOUlEQjROREUwTnpSbE5ETTdJQzh2SUNKQlIwNURJZ3BqYjI1emRDQk1UME5MWDBaUFVrMUJWRjlXUlZKVFNVOU9JRDBnTVRzS1kyOXVjM1FnVTFGTVNWUkZYMEpWVTFrZ1BTQTFPd3BqYjI1emRDQlNSVWRKVTFSU1dWOVdSVkpUU1U5T0lEMGdNVHNLWTI5dWMzUWdVa1ZIU1ZOVVVsbGZVMWxOUWs5TUlEMGdVM2x0WW05c0xtWnZjaWdpUUhSbGRITjFieTFoYVM5aFoyVnVZeTV6Y1d4cGRHVXRiRzlqYXkxeVpXZHBjM1J5ZVNJcE93cGpiMjV6ZENCTlFWaGZRbFZUV1Y5U1JWUlNXVjlOVXlBOUlEVXdPd3BqYjI1emRDQk5RVmhmVkVsTlJWSmZSRVZNUVZsZlRWTWdQU0F5WHpFME4xODBPRE5mTmpRM093cGpiMjV6ZENCRVFWSlhTVTVmUmtsTVJWTlpVMVJGVFY5UVVrOUNSVjlVU1UxRlQxVlVYMDFUSUQwZ01sOHdNREE3Q21OdmJuTjBJRlZPVTFWUVVFOVNWRVZFWDBaSlRFVmZTVVJmTmpRZ1BTQXdlR1ptWm1aZlptWm1abDltWm1abVgyWm1abVp1T3dwamIyNXpkQ0JYU1U1RVQxZFRYMUJCVkVoZlZGSkJUbE5RVDFKVVgwMUJXRjlEU0VGU1V5QTlJREUyWHpNNE5Ec0tZMjl1YzNRZ1YwbE9SRTlYVTE5UVFWUklYMVJTUVU1VFVFOVNWRjlOUVZoZlJVNVVVa2xGVXlBOUlERXlPRHNLWTI5dWMzUWdWMGxPUkU5WFUxOVRXVk5VUlUxZlVrOVBWQ0E5SUZOMGNtbHVaeTV5WVhkZ1hGdy9YRWRNVDBKQlRGSlBUMVJjVTNsemRHVnRVbTl2ZEdBN0NtTnZibk4wSUZkSlRrUlBWMU5mUlZoRlExVlVRVUpNUlY5R1NVeEZVMWxUVkVWTklEMGdld29nSUd4emRHRjBPaUFvY0dGMGFDa2dQVDRnYkhOMFlYUlRlVzVqS0hCaGRHZ3NJSHNnWW1sbmFXNTBPaUIwY25WbElIMHBMQW9nSUc5d1pXNDZJQ2h3WVhSb0tTQTlQaUJ2Y0dWdVUzbHVZeWdLSUNBZ0lIQmhkR2dzQ2lBZ0lDQm1jME52Ym5OMFlXNTBjeTVQWDFKRVQwNU1XU0I4SUNobWMwTnZibk4wWVc1MGN5NVBYMDVQUms5TVRFOVhJRDgvSURBcExBb2dJQ2tzQ2lBZ1puTjBZWFE2SUNoa1pYTmpjbWx3ZEc5eUtTQTlQaUJtYzNSaGRGTjVibU1vWkdWelkzSnBjSFJ2Y2l3Z2V5QmlhV2RwYm5RNklIUnlkV1VnZlNrc0NpQWdZMnh2YzJVNklHTnNiM05sVTNsdVl5d0tmVHNLWTI5dWMzUWdURTlEUVV4ZlJrbE1SVk5aVTFSRlRWOVVXVkJGVXlBOUlHNWxkeUJUWlhRb1d3b2dJQ0poY0daeklpd2dJbUpqWVdOb1pXWnpJaXdnSW1KMGNtWnpJaXdnSW1WNFptRjBJaXdnSW1WNGRESWlMQ0FpWlhoME15SXNJQ0psZUhRMElpd2dJbVl5Wm5NaUxBb2dJQ0pvWm5NaUxDQWlhR1p6Y0d4MWN5SXNJQ0pxWm5NaUxDQWliWE5rYjNNaUxDQWlibWxzWm5NeUlpd2dJbTUwWm5NaUxDQWliblJtY3pNaUxDQWliM1psY214aGVTSXNDaUFnSW5KaGJXWnpJaXdnSW5KbGFYTmxjbVp6SWl3Z0luUnRjR1p6SWl3Z0luVmlhV1p6SWl3Z0luVm1jeUlzSUNKMlptRjBJaXdnSW5obWN5SXNJQ0o2Wm5NaUxBcGRLVHNLWTI5dWMzUWdSRUZTVjBsT1gwRkRURjlTUlVGRVgxSkpSMGhVVXlBOUlHNWxkeUJUWlhRb1d3b2dJQ0p5WldGa0lpd2dJbXhwYzNRaUxDQWljMlZoY21Ob0lpd2dJbVY0WldOMWRHVWlMQ0FpY21WaFpHRjBkSElpTENBaWNtVmhaR1Y0ZEdGMGRISWlMQ0FpY21WaFpITmxZM1Z5YVhSNUlpd0tYU2s3Q21OdmJuTjBJRVJCVWxkSlRsOUJRMHhmU1U1SVJWSkpWRUZPUTBWZlJreEJSMU1nUFNCdVpYY2dVMlYwS0ZzS0lDQWlabWxzWlY5cGJtaGxjbWwwSWl3Z0ltUnBjbVZqZEc5eWVWOXBibWhsY21sMElpd2dJbXhwYldsMFgybHVhR1Z5YVhRaUxDQWliMjVzZVY5cGJtaGxjbWwwSWl3S1hTazdDbU52Ym5OMElFUkJVbGRKVGw5QlEweGZUVlZVUVZSSlQwNWZVa2xIU0ZSVElEMGdibVYzSUZObGRDaGJDaUFnSW5keWFYUmxJaXdnSW1Gd2NHVnVaQ0lzSUNKaFpHUmZabWxzWlNJc0lDSmhaR1JmYzNWaVpHbHlaV04wYjNKNUlpd2dJbVJsYkdWMFpTSXNJQ0prWld4bGRHVmZZMmhwYkdRaUxBb2dJQ0ozY21sMFpXRjBkSElpTENBaWQzSnBkR1ZsZUhSaGRIUnlJaXdnSW5keWFYUmxjMlZqZFhKcGRIa2lMQ0FpWTJodmQyNGlMQXBkS1RzS1kyOXVjM1FnUkVGU1YwbE9YMEZEVEY5TFRrOVhUbDlVVDB0RlRsTWdQU0J1WlhjZ1UyVjBLRnNLSUNBdUxpNUVRVkpYU1U1ZlFVTk1YMUpGUVVSZlVrbEhTRlJUTEFvZ0lDNHVMa1JCVWxkSlRsOUJRMHhmU1U1SVJWSkpWRUZPUTBWZlJreEJSMU1zQ2lBZ0xpNHVSRUZTVjBsT1gwRkRURjlOVlZSQlZFbFBUbDlTU1VkSVZGTXNDbDBwT3dwamIyNXpkQ0JFUVZKWFNVNWZRVU5NWDFaRlVrUkpRMVJmUTBGRFNFVmZURWxOU1ZRZ1BTQTFNVEk3Q21OdmJuTjBJR1JoY25kcGJrRmpiRlpsY21ScFkzUnpJRDBnYm1WM0lFMWhjQ2dwT3dvS1kyOXVjM1FnVjBsT1JFOVhVMTlUUlVOVlVrbFVXVjlUUTFKSlVGUWdQU0JUZEhKcGJtY3VjbUYzWUFva1JYSnliM0pCWTNScGIyNVFjbVZtWlhKbGJtTmxJRDBnSjFOMGIzQW5DaU1nUzJWbGNDQjBhR2x6SUdScGNtVmpkQzB1VGtWVUlHOXViSGs2SUcxdlpIVnNaU0JoZFhSdmJHOWhaQ0JqWVc0Z1pYaG9ZWFZ6ZENCMGFHVWdjMmhoY21Wa0lHeHZZMnNnWkdWaFpHeHBibVV1Q2lSMGNtRnVjM0J2Y25RZ1BTQmJjM1J5YVc1blhTUmxiblk2UVVkRlRrTmZURTlEUzE5UVFWUklVd3BwWmlBb1czTjBjbWx1WjEwNk9rbHpUblZzYkU5eVJXMXdkSGtvSkhSeVlXNXpjRzl5ZENrZ0xXOXlJQ1IwY21GdWMzQnZjblF1VEdWdVozUm9JQzFuZENBa2UxZEpUa1JQVjFOZlVFRlVTRjlVVWtGT1UxQlBVbFJmVFVGWVgwTklRVkpUZlNrZ2V3b2dJSFJvY205M0lDZHBiblpoYkdsa0lIQnliM1JsWTNSbFpDMXdZWFJvSUhSeVlXNXpjRzl5ZENjS2ZRb2taVzUwY21sbGN5QTlJRnR6ZEhKcGJtZGJYVjBrZEhKaGJuTndiM0owTGxOd2JHbDBLRnRqYUdGeVhURXdLUXBwWmlBb0pHVnVkSEpwWlhNdVEyOTFiblFnTFd4MElERWdMVzl5SUNSbGJuUnlhV1Z6TGtOdmRXNTBJQzFuZENBa2UxZEpUa1JQVjFOZlVFRlVTRjlVVWtGT1UxQlBVbFJmVFVGWVgwVk9WRkpKUlZOOUtTQjdDaUFnZEdoeWIzY2dKMmx1ZG1Gc2FXUWdjSEp2ZEdWamRHVmtMWEJoZEdnZ2RISmhibk53YjNKMEp3cDlDaVJqZFhKeVpXNTBVMmxrSUQwZ1cxTjVjM1JsYlM1VFpXTjFjbWwwZVM1UWNtbHVZMmx3WVd3dVYybHVaRzkzYzBsa1pXNTBhWFI1WFRvNlIyVjBRM1Z5Y21WdWRDZ3BMbFZ6WlhJdVZtRnNkV1VLSkhSeWRYTjBaV1FnUFNCQUtBb2dJQ1JqZFhKeVpXNTBVMmxrTEFvZ0lDZFRMVEV0TlMweE9DY3NDaUFnSjFNdE1TMDFMVE15TFRVME5DY3NDaUFnSjFNdE1TMDFMVGd3TFRrMU5qQXdPRGc0TlMwek5ERTROVEl5TmpRNUxURTRNekV3TXpnd05EUXRNVGcxTXpJNU1qWXpNUzB5TWpjeE5EYzRORFkwSndvcENpTWdVM0JsWTJsbWFXTWdiWFYwWVhScGIyNGdjbWxuYUhSeklIQnNkWE1nUjBWT1JWSkpRMTlYVWtsVVJTQmhibVFnUjBWT1JWSkpRMTlCVEV3dUNpUnNaV0ZtVFhWMFlYUnBiMjVOWVhOcklEMGdXMmx1ZERZMFhURXpORE13TWprMU9UQUtKR0Z1WTJWemRHOXlUWFYwWVhScGIyNU5ZWE5ySUQwZ1cybHVkRFkwWFRFek5ETXdNamsxT0RZS1ptOXlaV0ZqYUNBb0pHVnVkSEo1SUdsdUlDUmxiblJ5YVdWektTQjdDaUFnSkhObGNHRnlZWFJ2Y2lBOUlDUmxiblJ5ZVM1SmJtUmxlRTltS0Z0amFHRnlYVFU0S1FvZ0lHbG1JQ2drYzJWd1lYSmhkRzl5SUMxc2RDQXhJQzF2Y2lBa2MyVndZWEpoZEc5eUlDMWxjU0FvSkdWdWRISjVMa3hsYm1kMGFDQXRJREVwS1NCN0NpQWdJQ0IwYUhKdmR5QW5hVzUyWVd4cFpDQndjbTkwWldOMFpXUXRjR0YwYUNCMGNtRnVjM0J2Y25RbkNpQWdmUW9nSUNSeWIyeGxJRDBnSkdWdWRISjVMbE4xWW5OMGNtbHVaeWd3TENBa2MyVndZWEpoZEc5eUtRb2dJR2xtSUNoQUtDZHNaV0ZtUkdseVpXTjBiM0o1Snl3Z0oyRnVZMlZ6ZEc5eVJHbHlaV04wYjNKNUp5d2dKMlpwYkdVbktTQXRibTkwWTI5dWRHRnBibk1nSkhKdmJHVXBJSHNLSUNBZ0lIUm9jbTkzSUNKcGJuWmhiR2xrSUhCeWIzUmxZM1JsWkMxd1lYUm9JSEp2YkdVNklDUnliMnhsSWdvZ0lIMEtJQ0FrWlc1amIyUmxaRkJoZEdnZ1BTQWtaVzUwY25rdVUzVmljM1J5YVc1bktDUnpaWEJoY21GMGIzSWdLeUF4S1FvZ0lHbG1JQ2dvSkdWdVkyOWtaV1JRWVhSb0xreGxibWQwYUNBbElEUXBJQzF1WlNBd0tTQjdJSFJvY205M0lDZHBiblpoYkdsa0lIQnliM1JsWTNSbFpDMXdZWFJvSUhSeVlXNXpjRzl5ZENjZ2ZRb2dJQ1J3WVhSb1FubDBaWE1nUFNCYlUzbHpkR1Z0TGtOdmJuWmxjblJkT2pwR2NtOXRRbUZ6WlRZMFUzUnlhVzVuS0NSbGJtTnZaR1ZrVUdGMGFDa0tJQ0JwWmlBb0tDUndZWFJvUW5sMFpYTXVUR1Z1WjNSb0lDVWdNaWtnTFc1bElEQXBJSHNnZEdoeWIzY2dKMmx1ZG1Gc2FXUWdjSEp2ZEdWamRHVmtMWEJoZEdnZ2RISmhibk53YjNKMEp5QjlDaUFnYVdZZ0tGdFRlWE4wWlcwdVEyOXVkbVZ5ZEYwNk9sUnZRbUZ6WlRZMFUzUnlhVzVuS0NSd1lYUm9RbmwwWlhNcElDMWpibVVnSkdWdVkyOWtaV1JRWVhSb0tTQjdDaUFnSUNCMGFISnZkeUFuYm05dUxXTmhibTl1YVdOaGJDQndjbTkwWldOMFpXUXRjR0YwYUNCMGNtRnVjM0J2Y25RbkNpQWdmUW9nSUNSd1lYUm9RMmhoY21GamRHVnljeUE5SUZ0amFHRnlXMTFkT2pwdVpYY29XMmx1ZEYwb0pIQmhkR2hDZVhSbGN5NU1aVzVuZEdnZ0x5QXlLU2tLSUNCbWIzSWdLQ1JwYm1SbGVDQTlJREE3SUNScGJtUmxlQ0F0YkhRZ0pIQmhkR2hEYUdGeVlXTjBaWEp6TGt4bGJtZDBhRHNnSkdsdVpHVjRJQ3M5SURFcElIc0tJQ0FnSUNSaWVYUmxUMlptYzJWMElEMGdKR2x1WkdWNElDb2dNZ29nSUNBZ0pHeHZkMEo1ZEdVZ1BTQmJhVzUwWFNSd1lYUm9RbmwwWlhOYkpHSjVkR1ZQWm1aelpYUmRDaUFnSUNBa2FHbG5hRUo1ZEdVZ1BTQmJhVzUwWFNSd1lYUm9RbmwwWlhOYkpHSjVkR1ZQWm1aelpYUWdLeUF4WFFvZ0lDQWdKSEJoZEdoRGFHRnlZV04wWlhKeld5UnBibVJsZUYwZ1BTQmJZMmhoY2wwb0pHeHZkMEo1ZEdVZ0xXSnZjaUFvSkdocFoyaENlWFJsSUMxemFHd2dPQ2twQ2lBZ2ZRb2dJQ1J5WlhGMVpYTjBaV1FnUFNCYmMzUnlhVzVuWFRvNmJtVjNLQ1J3WVhSb1EyaGhjbUZqZEdWeWN5a0tJQ0FrYlhWMFlYUnBiMjVOWVhOcklEMGdhV1lnS0NSeWIyeGxJQzFsY1NBbllXNWpaWE4wYjNKRWFYSmxZM1J2Y25rbktTQjdDaUFnSUNBa1lXNWpaWE4wYjNKTmRYUmhkR2x2YmsxaGMyc0tJQ0I5SUdWc2MyVWdld29nSUNBZ0pHeGxZV1pOZFhSaGRHbHZiazFoYzJzS0lDQjlDaUFnSkdaMWJHd2dQU0JiVTNsemRHVnRMa2xQTGxCaGRHaGRPanBIWlhSR2RXeHNVR0YwYUNna2NtVnhkV1Z6ZEdWa0tRb2dJR2xtSUNna1puVnNiQzVUZEdGeWRITlhhWFJvS0NkY1hDY3BJQzF2Y2lBa1puVnNiQzVUZEdGeWRITlhhWFJvS0NkY1hEOWNKeWtnTFc5eUlDUm1kV3hzTGxOMFlYSjBjMWRwZEdnb0oxeGNMbHduS1NrZ2V3b2dJQ0FnZEdoeWIzY2dJbTVsZEhkdmNtc2dZVzVrSUdSbGRtbGpaU0J3WVhSb2N5QmhjbVVnZFc1emRYQndiM0owWldRNklDUm1kV3hzSWdvZ0lIMEtJQ0FrWVhSMGNtbGlkWFJsY3lBOUlGdFRlWE4wWlcwdVNVOHVSbWxzWlYwNk9rZGxkRUYwZEhKcFluVjBaWE1vSkdaMWJHd3BDaUFnYVdZZ0tDZ2tZWFIwY21saWRYUmxjeUF0WW1GdVpDQmJVM2x6ZEdWdExrbFBMa1pwYkdWQmRIUnlhV0oxZEdWelhUbzZVbVZ3WVhKelpWQnZhVzUwS1NBdGJtVWdNQ2tnZXdvZ0lDQWdkR2h5YjNjZ0luSmxjR0Z5YzJVZ2NHOXBiblJ6SUdGeVpTQjFibk4xY0hCdmNuUmxaRG9nSkdaMWJHd2lDaUFnZlFvZ0lDUnBjMFJwY21WamRHOXllU0E5SUNna1lYUjBjbWxpZFhSbGN5QXRZbUZ1WkNCYlUzbHpkR1Z0TGtsUExrWnBiR1ZCZEhSeWFXSjFkR1Z6WFRvNlJHbHlaV04wYjNKNUtTQXRibVVnTUFvZ0lHbG1JQ2drYVhORWFYSmxZM1J2Y25rZ0xXNWxJQ2drY205c1pTQXRibVVnSjJacGJHVW5LU2tnZXdvZ0lDQWdkR2h5YjNjZ0luQnliM1JsWTNSbFpDMXdZWFJvSUhKdmJHVWdaRzlsY3lCdWIzUWdiV0YwWTJnZ2FYUnpJSFI1Y0dVNklDUm1kV3hzSWdvZ0lIMEtJQ0FrWkhKcGRtVWdQU0JiVTNsemRHVnRMa2xQTGtSeWFYWmxTVzVtYjEwNk9tNWxkeWhiVTNsemRHVnRMa2xQTGxCaGRHaGRPanBIWlhSUVlYUm9VbTl2ZENna1puVnNiQ2twQ2lBZ2FXWWdLRUFvTWl3Z015d2dOaWtnTFc1dmRHTnZiblJoYVc1eklGdHBiblJkSkdSeWFYWmxMa1J5YVhabFZIbHdaU2tnZXdvZ0lDQWdkR2h5YjNjZ0ltNXZiaTFzYjJOaGJDQmtjbWwyWlNCcGN5QjFibk4xY0hCdmNuUmxaRG9nSkdaMWJHd2lDaUFnZlFvZ0lHbG1JQ2drWkhKcGRtVXVSSEpwZG1WR2IzSnRZWFFnTFc1bElDZE9WRVpUSnlrZ2V3b2dJQ0FnZEdoeWIzY2dJbVpwYkdWemVYTjBaVzBnWTJGdWJtOTBJR1Z1Wm05eVkyVWdkR2hsSUhKbGNYVnBjbVZrSUVGRFRDQmpiMjUwY21GamREb2dKR1oxYkd3aUNpQWdmUW9nSUNSaFkyeFRaV04wYVc5dWN5QTlJRnRUZVhOMFpXMHVVMlZqZFhKcGRIa3VRV05qWlhOelEyOXVkSEp2YkM1QlkyTmxjM05EYjI1MGNtOXNVMlZqZEdsdmJuTmRPanBQZDI1bGNpQXRZbTl5SUZ0VGVYTjBaVzB1VTJWamRYSnBkSGt1UVdOalpYTnpRMjl1ZEhKdmJDNUJZMk5sYzNORGIyNTBjbTlzVTJWamRHbHZibk5kT2pwQlkyTmxjM01LSUNCcFppQW9KR2x6UkdseVpXTjBiM0o1S1NCN0NpQWdJQ0FrWVdOc0lEMGdXMU41YzNSbGJTNUpUeTVFYVhKbFkzUnZjbmxkT2pwSFpYUkJZMk5sYzNORGIyNTBjbTlzS0NSbWRXeHNMQ0FrWVdOc1UyVmpkR2x2Ym5NcENpQWdmU0JsYkhObElIc0tJQ0FnSUNSaFkyd2dQU0JiVTNsemRHVnRMa2xQTGtacGJHVmRPanBIWlhSQlkyTmxjM05EYjI1MGNtOXNLQ1JtZFd4c0xDQWtZV05zVTJWamRHbHZibk1wQ2lBZ2ZRb2dJR2xtSUNndGJtOTBJQ1JoWTJ3dVFYSmxRV05qWlhOelVuVnNaWE5EWVc1dmJtbGpZV3dwSUhzS0lDQWdJSFJvY205M0lDSnViMjR0WTJGdWIyNXBZMkZzSUVGRFRDQnBjeUIxYm5OMWNIQnZjblJsWkRvZ0pHWjFiR3dpQ2lBZ2ZRb2dJQ1JpZVhSbGN5QTlJQ1JoWTJ3dVIyVjBVMlZqZFhKcGRIbEVaWE5qY21sd2RHOXlRbWx1WVhKNVJtOXliU2dwQ2lBZ0pISmhkeUE5SUZ0VGVYTjBaVzB1VTJWamRYSnBkSGt1UVdOalpYTnpRMjl1ZEhKdmJDNVNZWGRUWldOMWNtbDBlVVJsYzJOeWFYQjBiM0pkT2pwdVpYY29KR0o1ZEdWekxDQXdLUW9nSUdsbUlDZ2tiblZzYkNBdFpYRWdKSEpoZHk1RWFYTmpjbVYwYVc5dVlYSjVRV05zS1NCN0NpQWdJQ0IwYUhKdmR5QWliblZzYkNCRVFVTk1JR2x6SUhWdWMzVndjRzl5ZEdWa09pQWtablZzYkNJS0lDQjlDaUFnSkc5M2JtVnlJRDBnSkdGamJDNUhaWFJQZDI1bGNpaGJVM2x6ZEdWdExsTmxZM1Z5YVhSNUxsQnlhVzVqYVhCaGJDNVRaV04xY21sMGVVbGtaVzUwYVdacFpYSmRLUzVXWVd4MVpRb2dJR2xtSUNna2RISjFjM1JsWkNBdGJtOTBZMjl1ZEdGcGJuTWdKRzkzYm1WeUtTQjdDaUFnSUNCMGFISnZkeUFpZFc1MGNuVnpkR1ZrSUc5M2JtVnlJRk5KUkNCdmJpQnNiMk5ySUhCaGRHZzZJQ1JtZFd4c0lnb2dJSDBLSUNBa2NuVnNaWE1nUFNBa1lXTnNMa2RsZEVGalkyVnpjMUoxYkdWektBb2dJQ0FnSkhSeWRXVXNDaUFnSUNBa2RISjFaU3dLSUNBZ0lGdFRlWE4wWlcwdVUyVmpkWEpwZEhrdVVISnBibU5wY0dGc0xsTmxZM1Z5YVhSNVNXUmxiblJwWm1sbGNsMEtJQ0FwQ2lBZ1ptOXlaV0ZqYUNBb0pISjFiR1VnYVc0Z0pISjFiR1Z6S1NCN0NpQWdJQ0JwWmlBb0pISjFiR1V1UVdOalpYTnpRMjl1ZEhKdmJGUjVjR1VnTFc1bElGdFRlWE4wWlcwdVUyVmpkWEpwZEhrdVFXTmpaWE56UTI5dWRISnZiQzVCWTJObGMzTkRiMjUwY205c1ZIbHdaVjA2T2tGc2JHOTNLU0I3Q2lBZ0lDQWdJR052Ym5ScGJuVmxDaUFnSUNCOUNpQWdJQ0FrYVc1b1pYSnBkRTl1YkhrZ1BTQW9KSEoxYkdVdVVISnZjR0ZuWVhScGIyNUdiR0ZuY3lBdFltRnVaQ0JiVTNsemRHVnRMbE5sWTNWeWFYUjVMa0ZqWTJWemMwTnZiblJ5YjJ3dVVISnZjR0ZuWVhScGIyNUdiR0ZuYzEwNk9rbHVhR1Z5YVhSUGJteDVLU0F0Ym1VZ01Bb2dJQ0FnYVdZZ0tDUnBibWhsY21sMFQyNXNlU2tnZXdvZ0lDQWdJQ0FrWTJocGJHUkpibWhsY21sMFlXNWpaU0E5SUZ0VGVYTjBaVzB1VTJWamRYSnBkSGt1UVdOalpYTnpRMjl1ZEhKdmJDNUpibWhsY21sMFlXNWpaVVpzWVdkelhUbzZUMkpxWldOMFNXNW9aWEpwZENBdFltOXlJRnRUZVhOMFpXMHVVMlZqZFhKcGRIa3VRV05qWlhOelEyOXVkSEp2YkM1SmJtaGxjbWwwWVc1alpVWnNZV2R6WFRvNlEyOXVkR0ZwYm1WeVNXNW9aWEpwZEFvZ0lDQWdJQ0FrY21WaFkyaGxjMDVsZDBOb2FXeGtJRDBnS0NSeWRXeGxMa2x1YUdWeWFYUmhibU5sUm14aFozTWdMV0poYm1RZ0pHTm9hV3hrU1c1b1pYSnBkR0Z1WTJVcElDMXVaU0F3Q2lBZ0lDQWdJR2xtSUNna2NtOXNaU0F0Ym1VZ0oyeGxZV1pFYVhKbFkzUnZjbmtuSUMxdmNpQXRibTkwSUNSeVpXRmphR1Z6VG1WM1EyaHBiR1FwSUhzS0lDQWdJQ0FnSUNCamIyNTBhVzUxWlFvZ0lDQWdJQ0I5Q2lBZ0lDQjlDaUFnSUNBa2MybGtJRDBnSkhKMWJHVXVTV1JsYm5ScGRIbFNaV1psY21WdVkyVXVWbUZzZFdVS0lDQWdJQ1J5YVdkb2RITWdQU0FvVzJsdWREWTBYU1J5ZFd4bExrWnBiR1ZUZVhOMFpXMVNhV2RvZEhNcElDMWlZVzVrSUZ0cGJuUTJORjAwTWprME9UWTNNamsxQ2lBZ0lDQnBaaUFvSkhSeWRYTjBaV1FnTFc1dmRHTnZiblJoYVc1eklDUnphV1FnTFdGdVpDQW9LQ1J5YVdkb2RITWdMV0poYm1RZ0pHMTFkR0YwYVc5dVRXRnpheWtnTFc1bElEQXBLU0I3Q2lBZ0lDQWdJSFJvY205M0lDSjFiblJ5ZFhOMFpXUWdiWFYwWVhScGIyNGdRVU5GSUc5dUlHeHZZMnNnY0dGMGFEb2dKR1oxYkd3aUNpQWdJQ0I5Q2lBZ2ZRcDlDbHREYjI1emIyeGxYVG82VDNWMExsZHlhWFJsS0NkUFN5Y3BDbUE3Q21OdmJuTjBJRmRKVGtSUFYxTmZVMFZEVlZKSlZGbGZVME5TU1ZCVVgwSkJVMFUyTkNBOUlFSjFabVpsY2k1bWNtOXRLQW9nSUZkSlRrUlBWMU5mVTBWRFZWSkpWRmxmVTBOU1NWQlVMQW9nSUNKMWRHWXhObXhsSWl3S0tTNTBiMU4wY21sdVp5Z2lZbUZ6WlRZMElpazdDZ3BsZUhCdmNuUWdZMnhoYzNNZ1RHOWpZV3hUY1d4cGRHVk1iMk5yVkdsdFpXOTFkRVZ5Y205eUlHVjRkR1Z1WkhNZ1JYSnliM0lnZXdvZ0lHTnZibk4wY25WamRHOXlLSHNnY0dGMGFDd2diR0ZpWld3c0lIUnBiV1Z2ZFhSTmN5d2dZMkYxYzJVZ2ZTa2dld29nSUNBZ2MzVndaWElvQ2lBZ0lDQWdJR0JoWjJWdVl6b2dKSHRzWVdKbGJIMGdkR2x0WldRZ2IzVjBJR0ZtZEdWeUlDUjdkR2x0Wlc5MWRFMXpmVzF6SUhkaGFYUnBibWNnWm05eUlHeHZZMkZzSUhCeWIyTmxjM01nYkc5amF5QWtlM0JoZEdoOVlDd0tJQ0FnSUNBZ1kyRjFjMlVnUFQwOUlIVnVaR1ZtYVc1bFpDQS9JSFZ1WkdWbWFXNWxaQ0E2SUhzZ1kyRjFjMlVnZlN3S0lDQWdJQ2s3Q2lBZ0lDQjBhR2x6TG01aGJXVWdQU0FpVEc5allXeFRjV3hwZEdWTWIyTnJWR2x0Wlc5MWRFVnljbTl5SWpzS0lDQWdJSFJvYVhNdVkyOWtaU0E5SUNKQlIwVk9RMTlNVDBOTFgxUkpUVVZQVlZRaU93b2dJQ0FnZEdocGN5NXdZWFJvSUQwZ2NHRjBhRHNLSUNBZ0lIUm9hWE11YkdGaVpXd2dQU0JzWVdKbGJEc0tJQ0FnSUhSb2FYTXVkR2x0Wlc5MWRFMXpJRDBnZEdsdFpXOTFkRTF6T3dvZ0lIMEtmUW9LWm5WdVkzUnBiMjRnZEdsdFpXOTFkRVZ5Y205eUtHTnZiblJsZUhRc0lIQmhkR2dzSUdOaGRYTmxLU0I3Q2lBZ2NtVjBkWEp1SUc1bGR5Qk1iMk5oYkZOeGJHbDBaVXh2WTJ0VWFXMWxiM1YwUlhKeWIzSW9ld29nSUNBZ2NHRjBhQ3dLSUNBZ0lHeGhZbVZzT2lCamIyNTBaWGgwTG14aFltVnNMQW9nSUNBZ2RHbHRaVzkxZEUxek9pQmpiMjUwWlhoMExuUnBiV1Z2ZFhSTmN5d0tJQ0FnSUdOaGRYTmxMQW9nSUgwcE93cDlDZ3BtZFc1amRHbHZiaUJ5WlcxaGFXNXBibWROYVd4c2FYTmxZMjl1WkhNb1kyOXVkR1Y0ZENrZ2V3b2dJSEpsZEhWeWJpQk5ZWFJvTG1ac2IyOXlLR052Ym5SbGVIUXVaR1ZoWkd4cGJtVWdMU0J3WlhKbWIzSnRZVzVqWlM1dWIzY29LU2s3Q24wS0NtWjFibU4wYVc5dUlIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCaGRHZ3NJR05oZFhObEtTQjdDaUFnYVdZZ0tISmxiV0ZwYm1sdVowMXBiR3hwYzJWamIyNWtjeWhqYjI1MFpYaDBLU0E4UFNBd0tTQjdDaUFnSUNCMGFISnZkeUIwYVcxbGIzVjBSWEp5YjNJb1kyOXVkR1Y0ZEN3Z2NHRjBhQ3dnWTJGMWMyVXBPd29nSUgwS2ZRb0tablZ1WTNScGIyNGdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z2NHaGhjMlVwSUhzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2NtVnpkV3gwSUQwZ1kyOXVkR1Y0ZEM1dmJsQnliMmR5WlhOelB5NG9jR2hoYzJVcE93b2dJQ0FnYVdZZ0tISmxjM1ZzZENBaFBUMGdkVzVrWldacGJtVmtLU0I3Q2lBZ0lDQWdJSFp2YVdRZ1VISnZiV2x6WlM1eVpYTnZiSFpsS0hKbGMzVnNkQ2t1WTJGMFkyZ29LQ2tnUFQ0Z2UzMHBPd29nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dld29nSUNBZ0x5OGdSR2xoWjI1dmMzUnBZM01nYlhWemRDQnVaWFpsY2lCamFHRnVaMlVnYkc5amF5QmhZM0YxYVhOcGRHbHZiaUJ2Y2lCeVpXeGxZWE5sSUhObGJXRnVkR2xqY3k0S0lDQjlDbjBLQ21aMWJtTjBhVzl1SUhCeWIyTmxjM05NYjJOclVtVm5hWE4wY25rb0tTQjdDaUFnWTI5dWMzUWdZM1Z5Y21WdWRDQTlJSEJ5YjJObGMzTmJVa1ZIU1ZOVVVsbGZVMWxOUWs5TVhUc0tJQ0JwWmlBb1kzVnljbVZ1ZENBaFBUMGdkVzVrWldacGJtVmtLU0I3Q2lBZ0lDQnBaaUFvQ2lBZ0lDQWdJR04xY25KbGJuUWdQVDA5SUc1MWJHd2dmSHdLSUNBZ0lDQWdkSGx3Wlc5bUlHTjFjbkpsYm5RZ0lUMDlJQ0p2WW1wbFkzUWlJSHg4Q2lBZ0lDQWdJR04xY25KbGJuUXVkbVZ5YzJsdmJpQWhQVDBnVWtWSFNWTlVVbGxmVmtWU1UwbFBUaUI4ZkFvZ0lDQWdJQ0FoS0dOMWNuSmxiblF1Ykc5amEzTWdhVzV6ZEdGdVkyVnZaaUJOWVhBcENpQWdJQ0FwSUhzS0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLQW9nSUNBZ0lDQWdJQ0poWjJWdVl6b2dhVzVqYjIxd1lYUnBZbXhsSUhCeWIyTmxjM010ZDJsa1pTQlRVVXhwZEdVZ2JHOWpheUJ5WldkcGMzUnllU0JwY3lCaGJISmxZV1I1SUdsdWMzUmhiR3hsWkNJc0NpQWdJQ0FnSUNrN0NpQWdJQ0I5Q2lBZ0lDQnlaWFIxY200Z1kzVnljbVZ1ZERzS0lDQjlDaUFnWTI5dWMzUWdZM0psWVhSbFpDQTlJSHNnZG1WeWMybHZiam9nVWtWSFNWTlVVbGxmVmtWU1UwbFBUaXdnYkc5amEzTTZJRzVsZHlCTllYQW9LU0I5T3dvZ0lFOWlhbVZqZEM1a1pXWnBibVZRY205d1pYSjBlU2h3Y205alpYTnpMQ0JTUlVkSlUxUlNXVjlUV1UxQ1Qwd3NJSHNLSUNBZ0lIWmhiSFZsT2lCamNtVmhkR1ZrTEFvZ0lDQWdZMjl1Wm1sbmRYSmhZbXhsT2lCbVlXeHpaU3dLSUNBZ0lHVnVkVzFsY21GaWJHVTZJR1poYkhObExBb2dJQ0FnZDNKcGRHRmliR1U2SUdaaGJITmxMQW9nSUgwcE93b2dJSEpsZEhWeWJpQmpjbVZoZEdWa093cDlDZ3BtZFc1amRHbHZiaUJoWTNGMWFYSmxTVzVRY205alpYTnpURzlqYXlod2NtVndZWEpsWkN3Z1kyOXVkR1Y0ZENrZ2V3b2dJR052Ym5OMElISmxaMmx6ZEhKNUlEMGdjSEp2WTJWemMweHZZMnRTWldkcGMzUnllU2dwT3dvZ0lHTnZibk4wSUd0bGVTQTlJSEJ5WlhCaGNtVmtMbWxrWlc1MGFYUjVTMlY1T3dvZ0lHeGxkQ0J6ZEdGMFpTQTlJSEpsWjJsemRISjVMbXh2WTJ0ekxtZGxkQ2hyWlhrcE93b2dJR2xtSUNoemRHRjBaU0E5UFQwZ2RXNWtaV1pwYm1Wa0tTQjdDaUFnSUNCemRHRjBaU0E5SUhzZ2JHOWphMlZrT2lCbVlXeHpaU3dnZDJGcGRHVnljem9nVzEwZ2ZUc0tJQ0FnSUhKbFoybHpkSEo1TG14dlkydHpMbk5sZENoclpYa3NJSE4wWVhSbEtUc0tJQ0I5Q2dvZ0lHTnZibk4wSUcxaGEyVlNaV3hsWVhObElEMGdLQ2tnUFQ0Z2V3b2dJQ0FnYkdWMElISmxiR1ZoYzJWa0lEMGdabUZzYzJVN0NpQWdJQ0J5WlhSMWNtNGdLQ2tnUFQ0Z2V3b2dJQ0FnSUNCcFppQW9jbVZzWldGelpXUXBJSEpsZEhWeWJqc0tJQ0FnSUNBZ2NtVnNaV0Z6WldRZ1BTQjBjblZsT3dvZ0lDQWdJQ0JqYjI1emRDQnVaWGgwSUQwZ2MzUmhkR1V1ZDJGcGRHVnljeTV6YUdsbWRDZ3BPd29nSUNBZ0lDQnBaaUFvYm1WNGRDQTlQVDBnZFc1a1pXWnBibVZrS1NCN0NpQWdJQ0FnSUNBZ2MzUmhkR1V1Ykc5amEyVmtJRDBnWm1Gc2MyVTdDaUFnSUNBZ0lDQWdjbVZuYVhOMGNua3ViRzlqYTNNdVpHVnNaWFJsS0d0bGVTazdDaUFnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUNBZ1kyeGxZWEpVYVcxbGIzVjBLRzVsZUhRdWRHbHRaWElwT3dvZ0lDQWdJQ0FnSUc1bGVIUXVjbVZ6YjJ4MlpTaHRZV3RsVW1Wc1pXRnpaU2dwS1RzS0lDQWdJQ0FnZlFvZ0lDQWdmVHNLSUNCOU93b0tJQ0JwWmlBb0lYTjBZWFJsTG14dlkydGxaQ2tnZXdvZ0lDQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NISmxjR0Z5WldRdWNHRjBhQ2s3Q2lBZ0lDQnpkR0YwWlM1c2IyTnJaV1FnUFNCMGNuVmxPd29nSUNBZ2NtVjBkWEp1SUZCeWIyMXBjMlV1Y21WemIyeDJaU2h0WVd0bFVtVnNaV0Z6WlNncEtUc0tJQ0I5Q2dvZ0lHTnZibk4wSUhKbGJXRnBibWx1WnlBOUlISmxiV0ZwYm1sdVowMXBiR3hwYzJWamIyNWtjeWhqYjI1MFpYaDBLVHNLSUNCcFppQW9jbVZ0WVdsdWFXNW5JRHc5SURBcElIc0tJQ0FnSUhKbGRIVnliaUJRY205dGFYTmxMbkpsYW1WamRDaDBhVzFsYjNWMFJYSnliM0lvWTI5dWRHVjRkQ3dnY0hKbGNHRnlaV1F1Y0dGMGFDa3BPd29nSUgwS0lDQnlaWFIxY200Z2JtVjNJRkJ5YjIxcGMyVW9LSEpsYzI5c2RtVlhZV2wwTENCeVpXcGxZM1JYWVdsMEtTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCM1lXbDBaWElnUFNCN0NpQWdJQ0FnSUhKbGMyOXNkbVU2SUhKbGMyOXNkbVZYWVdsMExBb2dJQ0FnSUNCMGFXMWxjam9nZFc1a1pXWnBibVZrTEFvZ0lDQWdmVHNLSUNBZ0lHTnZibk4wSUdGeWJWUnBiV1Z2ZFhRZ1BTQW9LU0E5UGlCN0NpQWdJQ0FnSUdOdmJuTjBJR1JsYkdGNVRYTWdQU0J5WlcxaGFXNXBibWROYVd4c2FYTmxZMjl1WkhNb1kyOXVkR1Y0ZENrN0NpQWdJQ0FnSUdsbUlDaGtaV3hoZVUxeklEdzlJREFwSUhzS0lDQWdJQ0FnSUNCamIyNXpkQ0JwYm1SbGVDQTlJSE4wWVhSbExuZGhhWFJsY25NdWFXNWtaWGhQWmloM1lXbDBaWElwT3dvZ0lDQWdJQ0FnSUdsbUlDaHBibVJsZUNBaFBUMGdMVEVwSUhOMFlYUmxMbmRoYVhSbGNuTXVjM0JzYVdObEtHbHVaR1Y0TENBeEtUc0tJQ0FnSUNBZ0lDQnlaV3BsWTNSWFlXbDBLSFJwYldWdmRYUkZjbkp2Y2loamIyNTBaWGgwTENCd2NtVndZWEpsWkM1d1lYUm9LU2s3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVPd29nSUNBZ0lDQjlDaUFnSUNBZ0lIZGhhWFJsY2k1MGFXMWxjaUE5SUhObGRGUnBiV1Z2ZFhRb1lYSnRWR2x0Wlc5MWRDd2dUV0YwYUM1dGFXNG9aR1ZzWVhsTmN5d2dUVUZZWDFSSlRVVlNYMFJGVEVGWlgwMVRLU2s3Q2lBZ0lDQjlPd29nSUNBZ2MzUmhkR1V1ZDJGcGRHVnljeTV3ZFhOb0tIZGhhWFJsY2lrN0NpQWdJQ0JoY20xVWFXMWxiM1YwS0NrN0NpQWdmU2s3Q24wS0NtWjFibU4wYVc5dUlHUmxZMjlrWlUxdmRXNTBVR0YwYUNoMllXeDFaU2tnZXdvZ0lISmxkSFZ5YmlCMllXeDFaUzV5WlhCc1lXTmxLQzljWENoYk1DMDNYWHN6ZlNrdlp5d2dLRjl0WVhSamFDd2diMk4wWVd3cElEMCtDaUFnSUNCVGRISnBibWN1Wm5KdmJVTm9ZWEpEYjJSbEtFNTFiV0psY2k1d1lYSnpaVWx1ZENodlkzUmhiQ3dnT0NrcEtUc0tmUW9LWm5WdVkzUnBiMjRnY0dGMGFFbHpWMmwwYUdsdUtIQmhkR2dzSUcxdmRXNTBVRzlwYm5RcElIc0tJQ0J5WlhSMWNtNGdjR0YwYUNBOVBUMGdiVzkxYm5SUWIybHVkQ0I4ZkFvZ0lDQWdjR0YwYUM1emRHRnlkSE5YYVhSb0tHMXZkVzUwVUc5cGJuUWdQVDA5SUhObGNDQS9JRzF2ZFc1MFVHOXBiblFnT2lCZ0pIdHRiM1Z1ZEZCdmFXNTBmU1I3YzJWd2ZXQXBPd3A5Q2dwbWRXNWpkR2x2YmlCbGVHVmpSbWxzWlZWMFpqZ29abWxzWlN3Z1lYSm5jeXdnYjNCMGFXOXVjeXdnWTI5dWRHVjRkQ3dnY0dGMGFDa2dld29nSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNnb2NtVnpiMngyWlZKMWJpd2djbVZxWldOMFVuVnVLU0E5UGlCN0NpQWdJQ0JzWlhRZ1pHVmhaR3hwYm1WVWFXMWxjanNLSUNBZ0lHeGxkQ0JsZUhCcGNtVmtJRDBnWm1Gc2MyVTdDaUFnSUNCamIyNXpkQ0JqYUdsc1pDQTlJR1Y0WldOR2FXeGxLQW9nSUNBZ0lDQm1hV3hsTEFvZ0lDQWdJQ0JoY21kekxBb2dJQ0FnSUNCN0lDNHVMbTl3ZEdsdmJuTXNJR1Z1WTI5a2FXNW5PaUFpZFhSbU9DSWdmU3dLSUNBZ0lDQWdLR1Z5Y205eUxDQnpkR1J2ZFhRc0lITjBaR1Z5Y2lrZ1BUNGdld29nSUNBZ0lDQWdJR2xtSUNoa1pXRmtiR2x1WlZScGJXVnlJQ0U5UFNCMWJtUmxabWx1WldRcElHTnNaV0Z5VkdsdFpXOTFkQ2hrWldGa2JHbHVaVlJwYldWeUtUc0tJQ0FnSUNBZ0lDQnBaaUFvWlhod2FYSmxaQ2tnY21WMGRYSnVPd29nSUNBZ0lDQWdJR2xtSUNobGNuSnZjaUFoUFQwZ2JuVnNiQ2tnZXdvZ0lDQWdJQ0FnSUNBZ1QySnFaV04wTG1GemMybG5iaWhsY25KdmNpd2dleUJ6ZEdSdmRYUXNJSE4wWkdWeWNpQjlLVHNLSUNBZ0lDQWdJQ0FnSUhKbGFtVmpkRkoxYmlobGNuSnZjaWs3Q2lBZ0lDQWdJQ0FnSUNCeVpYUjFjbTQ3Q2lBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUhKbGMyOXNkbVZTZFc0b2V5QnpkR1J2ZFhRc0lITjBaR1Z5Y2lCOUtUc0tJQ0FnSUNBZ2ZTd0tJQ0FnSUNrN0NpQWdJQ0JqYjI1emRDQmhjbTFFWldGa2JHbHVaU0E5SUNncElEMCtJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NtVnRZV2x1YVc1bklEMGdjbVZ0WVdsdWFXNW5UV2xzYkdselpXTnZibVJ6S0dOdmJuUmxlSFFwT3dvZ0lDQWdJQ0JwWmlBb2NtVnRZV2x1YVc1bklEdzlJREFwSUhzS0lDQWdJQ0FnSUNCbGVIQnBjbVZrSUQwZ2RISjFaVHNLSUNBZ0lDQWdJQ0F2THlCQklHaGxiSEJsY2lCemRIVmpheUJwYmlCclpYSnVaV3dnU1M5UElHMWhlU0J1WlhabGNpQmxlR2wwTENCbGRtVnVJR0ZtZEdWeUlGTkpSMHRKVEV3dUNpQWdJQ0FnSUNBZ0x5OGdVMlYwZEd4bElHRjBJRzkxY2lCa1pXRmtiR2x1WlNCaGJtUWdjbVZzWldGelpTQmxkbVZ5ZVNCbGRtVnVkQzFzYjI5d0lISmxabVZ5Wlc1alpTQnlZWFJvWlhJS0lDQWdJQ0FnSUNBdkx5QjBhR0Z1SUhkaGFYUnBibWNnWm05eUlHVjRaV05HYVd4bEozTWdaWGhwZEM5emRHUnBieTFqYkc5elpTQmpZV3hzWW1GamF5NEtJQ0FnSUNBZ0lDQnlaV3BsWTNSU2RXNG9kR2x0Wlc5MWRFVnljbTl5S0dOdmJuUmxlSFFzSUhCaGRHZ3BLVHNLSUNBZ0lDQWdJQ0JqYUdsc1pDNXJhV3hzS0NKVFNVZExTVXhNSWlrN0NpQWdJQ0FnSUNBZ1kyaHBiR1F1YzNSa2FXNC9MbVJsYzNSeWIza29LVHNLSUNBZ0lDQWdJQ0JqYUdsc1pDNXpkR1J2ZFhRL0xtUmxjM1J5YjNrb0tUc0tJQ0FnSUNBZ0lDQmphR2xzWkM1emRHUmxjbkkvTG1SbGMzUnliM2tvS1RzS0lDQWdJQ0FnSUNCamFHbHNaQzUxYm5KbFppZ3BPd29nSUNBZ0lDQWdJSEpsZEhWeWJqc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCa1pXRmtiR2x1WlZScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENnS0lDQWdJQ0FnSUNCaGNtMUVaV0ZrYkdsdVpTd0tJQ0FnSUNBZ0lDQk5ZWFJvTG0xcGJpaHlaVzFoYVc1cGJtY3NJRTFCV0Y5VVNVMUZVbDlFUlV4QldWOU5VeWtzQ2lBZ0lDQWdJQ2s3Q2lBZ0lDQjlPd29nSUNBZ1lYSnRSR1ZoWkd4cGJtVW9LVHNLSUNCOUtUc0tmUW9LWm5WdVkzUnBiMjRnYm05eWJXRnNhWHBsVkdsdFpXUkRiMjF0WVc1a1JYSnliM0lvWlhKeWIzSXNJR052Ym5SbGVIUXNJSEJoZEdncElIc0tJQ0JwWmlBb0NpQWdJQ0J5WlcxaGFXNXBibWROYVd4c2FYTmxZMjl1WkhNb1kyOXVkR1Y0ZENrZ1BEMGdNQ0I4ZkFvZ0lDQWdaWEp5YjNJL0xtTnZaR1VnUFQwOUlDSkZWRWxOUlVSUFZWUWlJSHg4Q2lBZ0lDQmxjbkp2Y2o4dWEybHNiR1ZrSUQwOVBTQjBjblZsQ2lBZ0tTQjdDaUFnSUNCeVpYUjFjbTRnZEdsdFpXOTFkRVZ5Y205eUtHTnZiblJsZUhRc0lIQmhkR2dzSUdWeWNtOXlLVHNLSUNCOUNpQWdjbVYwZFhKdUlHVnljbTl5T3dwOUNncG1kVzVqZEdsdmJpQjJZV3hwWkdGMFpVUmhjbmRwYmtGamJFeHBjM1JwYm1jb2MzUmtiM1YwTENCd1lYUm9MQ0J5YjJ4bEtTQjdDaUFnYVdZZ0tITjBaRzkxZEM1cGJtTnNkV1JsY3lnaVhISWlLU2tnZXdvZ0lDQWdkR2h5YjNjZ2JtVjNJRVZ5Y205eUtHQmhaMlZ1WXpvZ1JHRnlkMmx1SUVGRFRDQm9aV3h3WlhJZ2NtVjBkWEp1WldRZ2JtOXVMV05oYm05dWFXTmhiQ0J2ZFhSd2RYUWdabTl5SUNSN2NHRjBhSDFnS1RzS0lDQjlDaUFnWTI5dWMzUWdiR2x1WlhNZ1BTQnpkR1J2ZFhRdWMzQnNhWFFvSWx4dUlpazdDaUFnYVdZZ0tHeHBibVZ6TG1GMEtDMHhLU0E5UFQwZ0lpSXBJR3hwYm1WekxuQnZjQ2dwT3dvZ0lHbG1JQ2hzYVc1bGN5NXNaVzVuZEdnZ1BUMDlJREFnZkh3Z2JHbHVaWE5iTUYwdWJHVnVaM1JvSUQwOVBTQXdLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCRVlYSjNhVzRnUVVOTUlHaGxiSEJsY2lCeVpYUjFjbTVsWkNCdWJ5QnRaWFJoWkdGMFlTQm1iM0lnSkh0d1lYUm9mV0FwT3dvZ0lIMEtJQ0JzWlhRZ2NISmxkbWx2ZFhOUGNtUnBibUZzSUQwZ0xURTdDaUFnYkdWMElITmhkMHhsWjJGamVVOTNibVZ5SUQwZ1ptRnNjMlU3Q2lBZ1ptOXlJQ2hqYjI1emRDQnNhVzVsSUc5bUlHeHBibVZ6TG5Oc2FXTmxLREVwS1NCN0NpQWdJQ0JwWmlBb0wxNWNjeXB2ZDI1bGNqcGNjeXRjVXk0cUpDOTFMblJsYzNRb2JHbHVaU2tnSmlZZ0lYTmhkMHhsWjJGamVVOTNibVZ5SUNZbUlIQnlaWFpwYjNWelQzSmthVzVoYkNBOVBUMGdMVEVwSUhzS0lDQWdJQ0FnYzJGM1RHVm5ZV041VDNkdVpYSWdQU0IwY25WbE93b2dJQ0FnSUNCamIyNTBhVzUxWlRzS0lDQWdJSDBLSUNBZ0lHTnZibk4wSUcxaGRHTm9JRDBnYkdsdVpTNXRZWFJqYUNnS0lDQWdJQ0FnTDE1Y2N5b29YR1FyS1RwY2N5c29MaXMvS1Z4ekt5Zy9PaWhwYm1obGNtbDBaV1FwWEhNcktUOG9ZV3hzYjNkOFpHVnVlU2xjY3lzb1cyRXRlbDlkS3lnL09peGJZUzE2WDEwcktTb3BYSE1xSkM5MUxBb2dJQ0FnS1RzS0lDQWdJR2xtSUNodFlYUmphQ0E5UFQwZ2JuVnNiQ2tnZXdvZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQkVZWEozYVc0Z1FVTk1JR2hsYkhCbGNpQnlaWFIxY201bFpDQjFibkpsWTI5bmJtbDZaV1FnYjNWMGNIVjBJR1p2Y2lBa2UzQmhkR2g5WUNrN0NpQWdJQ0I5Q2lBZ0lDQmpiMjV6ZENCdmNtUnBibUZzSUQwZ1RuVnRZbVZ5S0cxaGRHTm9XekZkS1RzS0lDQWdJR2xtSUNnaFRuVnRZbVZ5TG1selUyRm1aVWx1ZEdWblpYSW9iM0prYVc1aGJDa2dmSHdnYjNKa2FXNWhiQ0E4UFNCd2NtVjJhVzkxYzA5eVpHbHVZV3dwSUhzS0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2dSR0Z5ZDJsdUlFRkRUQ0JvWld4d1pYSWdjbVYwZFhKdVpXUWdhVzUyWVd4cFpDQkJRMFVnYjNKa1pYSnBibWNnWm05eUlDUjdjR0YwYUgxZ0tUc0tJQ0FnSUgwS0lDQWdJSEJ5WlhacGIzVnpUM0prYVc1aGJDQTlJRzl5WkdsdVlXdzdDaUFnSUNCamIyNXpkQ0JoYzNOdlkybGhkR2x2YmlBOUlHMWhkR05vV3pSZE93b2dJQ0FnWTI5dWMzUWdkRzlyWlc1eklEMGdiV0YwWTJoYk5WMHVjM0JzYVhRb0lpd2lLVHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdkRzlyWlc0Z2IyWWdkRzlyWlc1ektTQjdDaUFnSUNBZ0lHbG1JQ2doUkVGU1YwbE9YMEZEVEY5TFRrOVhUbDlVVDB0RlRsTXVhR0Z6S0hSdmEyVnVLU2tnZXdvZ0lDQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJRVJoY25kcGJpQkJRMHdnYUdWc2NHVnlJSEpsZEhWeWJtVmtJSFZ1YTI1dmQyNGdjbWxuYUhRZ0pIdDBiMnRsYm4wNklDUjdjR0YwYUgxZ0tUc0tJQ0FnSUNBZ2ZRb2dJQ0FnZlFvZ0lDQWdhV1lnS0FvZ0lDQWdJQ0JoYzNOdlkybGhkR2x2YmlBOVBUMGdJbUZzYkc5M0lpQW1KZ29nSUNBZ0lDQjBiMnRsYm5NdWMyOXRaU2dvZEc5clpXNHBJRDArSUVSQlVsZEpUbDlCUTB4ZlRWVlVRVlJKVDA1ZlVrbEhTRlJUTG1oaGN5aDBiMnRsYmlrcENpQWdJQ0FwSUhzS0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLQW9nSUNBZ0lDQWdJR0JoWjJWdVl6b2djSEp2ZEdWamRHVmtJQ1I3Y205c1pYMGdhR0Z6SUdFZ2JYVjBZWFJwYjI0dFkyRndZV0pzWlNCRVlYSjNhVzRnUVVOTU9pQWtlM0JoZEdoOVlDd0tJQ0FnSUNBZ0tUc0tJQ0FnSUgwS0lDQjlDbjBLQ21GemVXNWpJR1oxYm1OMGFXOXVJR0Z6YzJWeWRFUmhjbmRwYmxCaGRHaFRaV04xY21sMGVTaHdZWFJvTENCeWIyeGxMQ0JqYjI1MFpYaDBLU0I3Q2lBZ2NtVjBkWEp1SUdGemMyVnlkRVJoY25kcGJsQmhkR2hUWldOMWNtbDBlVmRwZEdoSlR5Z0tJQ0FnSUhCaGRHZ3NDaUFnSUNCeWIyeGxMQW9nSUNBZ1kyOXVkR1Y0ZEN3S0lDQWdJR1Y0WldOR2FXeGxWWFJtT0N3S0lDQWdJQ2hqWVc1a2FXUmhkR1VwSUQwK0lHeHpkR0YwS0dOaGJtUnBaR0YwWlN3Z2V5QmlhV2RwYm5RNklIUnlkV1VnZlNrc0NpQWdLVHNLZlFvS0x5OGdTRVpUS3lCeVpYQnZjblJ6SUdOb1lXNW5aU0IwYVcxbElHbHVJSGRvYjJ4bElITmxZMjl1WkhNc0lITnZJR0Z1SUVGRFRDQmxaR2wwSUhkcGRHaHBiaUIwYUdVZ2MyRnRaUW92THlCelpXTnZibVFnWTJGdUlHeGxZWFpsSUhSb1pTQnBaR1Z1ZEdsMGVTQjFibU5vWVc1blpXUXVJRTl1YkhrZ2MzVmlMWE5sWTI5dVpDQmphR0Z1WjJVZ2RHbHRaWE1nWVhKbENpOHZJSEJ5WldOcGMyVWdaVzV2ZFdkb0lIUnZJR05oWTJobElHRWdkbVZ5WkdsamRDNEtablZ1WTNScGIyNGdhR0Z6VTNWaWMyVmpiMjVrUTJoaGJtZGxWR2x0WlNoemRHRjBjeWtnZXdvZ0lHbG1JQ2gwZVhCbGIyWWdjM1JoZEhNdVkzUnBiV1ZPY3lBOVBUMGdJbUpwWjJsdWRDSXBJSEpsZEhWeWJpQnpkR0YwY3k1amRHbHRaVTV6SUNVZ01WOHdNREJmTURBd1h6QXdNRzRnSVQwOUlEQnVPd29nSUhKbGRIVnliaUJPZFcxaVpYSXVhWE5HYVc1cGRHVW9jM1JoZEhNdVkzUnBiV1ZOY3lrZ0ppWWdjM1JoZEhNdVkzUnBiV1ZOY3lBbElERXdNREFnSVQwOUlEQTdDbjBLQ21aMWJtTjBhVzl1SUdSaGNuZHBia0ZqYkVsa1pXNTBhWFI1S0hOMFlYUnpLU0I3Q2lBZ2NtVjBkWEp1SUZzS0lDQWdJSE4wWVhSekxtUmxkaXdnYzNSaGRITXVhVzV2TENCemRHRjBjeTVqZEdsdFpVNXpJRDgvSUhOMFlYUnpMbU4wYVcxbFRYTXNDaUFnSUNCemRHRjBjeTV0YjJSbExDQnpkR0YwY3k1MWFXUXNJSE4wWVhSekxtZHBaQ3dLSUNBZ0lIQnliMk5sYzNNdVoyVjBkV2xrUHk0b0tTd2djSEp2WTJWemN5NW5aWFJsZFdsa1B5NG9LU3dLSUNCZExtcHZhVzRvSWpvaUtUc0tmUW9LWVhONWJtTWdablZ1WTNScGIyNGdZWE56WlhKMFJHRnlkMmx1VUdGMGFGTmxZM1Z5YVhSNVYybDBhRWxQS0hCaGRHZ3NJSEp2YkdVc0lHTnZiblJsZUhRc0lHeHBjM1JsY2l3Z2MzUmhkRkJoZEdncElIc0tJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQndZWFJvS1RzS0lDQXZMeUJCSUVSaGNuZHBiaUJCUTB3Z1pXUnBkQ0JoWkhaaGJtTmxjeUJqZEdsdFpTNGdVbVV0YzNSaGRDQnZiaUJsZG1WeWVTQnNiMjlyZFhBZ2MyOGdZVzRnYjJ4a0NpQWdMeThnYzNWalkyVnpjMloxYkNCMlpYSmthV04wSUdOaGJtNXZkQ0JoZFhSb2IzSnBlbVVnWVNCamFHRnVaMlZrSUdsdWIyUmxMQ0J2ZDI1bGNpd2diM0lnUVVOTUxnb2dJR052Ym5OMElHSmxabTl5WlNBOUlHUmhjbmRwYmtGamJFbGtaVzUwYVhSNUtHRjNZV2wwSUhOMFlYUlFZWFJvS0hCaGRHZ3BLVHNLSUNCamIyNXpkQ0JqWVdOb1pVdGxlU0E5SUdBa2UzSnZiR1Y5WERBa2UzQmhkR2g5WURzS0lDQnBaaUFvWkdGeWQybHVRV05zVm1WeVpHbGpkSE11WjJWMEtHTmhZMmhsUzJWNUtTQTlQVDBnWW1WbWIzSmxLU0I3Q2lBZ0lDQjBhSEp2ZDBsbVJYaHdhWEpsWkNoamIyNTBaWGgwTENCd1lYUm9LVHNLSUNBZ0lISmxkSFZ5YmpzS0lDQjlDaUFnWkdGeWQybHVRV05zVm1WeVpHbGpkSE11WkdWc1pYUmxLR05oWTJobFMyVjVLVHNLSUNCc1pYUWdjbVZ6ZFd4ME93b2dJSFJ5ZVNCN0NpQWdJQ0J5WlhOMWJIUWdQU0JoZDJGcGRDQnNhWE4wWlhJb0NpQWdJQ0FnSUNJdlltbHVMMnh6SWl3S0lDQWdJQ0FnV3lJdGJHUmxjU0lzSUhCaGRHaGRMQW9nSUNBZ0lDQjdDaUFnSUNBZ0lDQWdaVzUyT2lCN0lFeERYMEZNVERvZ0lrTWlJSDBzQ2lBZ0lDQWdJQ0FnYldGNFFuVm1abVZ5T2lBeU5UWWdLaUF4TURJMExBb2dJQ0FnSUNCOUxBb2dJQ0FnSUNCamIyNTBaWGgwTEFvZ0lDQWdJQ0J3WVhSb0xBb2dJQ0FnS1RzS0lDQjlJR05oZEdOb0lDaGxjbkp2Y2lrZ2V3b2dJQ0FnZEdoeWIzY2dibTl5YldGc2FYcGxWR2x0WldSRGIyMXRZVzVrUlhKeWIzSW9aWEp5YjNJc0lHTnZiblJsZUhRc0lIQmhkR2dwT3dvZ0lIMEtJQ0JwWmlBb2NtVnpkV3gwTG5OMFpHVnljaUFoUFQwZ0lpSXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUVSaGNuZHBiaUJCUTB3Z2FHVnNjR1Z5SUhKbGRIVnlibVZrSUhWdVpYaHdaV04wWldRZ1pHbGhaMjV2YzNScFkzTWdabTl5SUNSN2NHRjBhSDFnS1RzS0lDQjlDaUFnZG1Gc2FXUmhkR1ZFWVhKM2FXNUJZMnhNYVhOMGFXNW5LSEpsYzNWc2RDNXpkR1J2ZFhRc0lIQmhkR2dzSUhKdmJHVXBPd29nSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJSEJoZEdncE93b2dJQzh2SUVFZ2NHRjBhQ0JqYUdGdVoyVmtJSGRvYVd4bElHeHpJSEpoYmlCdGRYTjBJRzVsZG1WeUlITmxaV1FnWVNCMlpYSmthV04wSUdadmNpQnBkSE1nYm1WM0lITjBZWFJsTGdvZ0lHTnZibk4wSUdGbWRHVnlVM1JoZEhNZ1BTQmhkMkZwZENCemRHRjBVR0YwYUNod1lYUm9LVHNLSUNCamIyNXpkQ0JoWm5SbGNpQTlJR1JoY25kcGJrRmpiRWxrWlc1MGFYUjVLR0ZtZEdWeVUzUmhkSE1wT3dvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCaGRHZ3BPd29nSUdsbUlDaGhablJsY2lBOVBUMGdZbVZtYjNKbElDWW1JR2hoYzFOMVluTmxZMjl1WkVOb1lXNW5aVlJwYldVb1lXWjBaWEpUZEdGMGN5a3BJSHNLSUNBZ0lHbG1JQ2hrWVhKM2FXNUJZMnhXWlhKa2FXTjBjeTV6YVhwbElENDlJRVJCVWxkSlRsOUJRMHhmVmtWU1JFbERWRjlEUVVOSVJWOU1TVTFKVkNrZ2V3b2dJQ0FnSUNCa1lYSjNhVzVCWTJ4V1pYSmthV04wY3k1a1pXeGxkR1VvWkdGeWQybHVRV05zVm1WeVpHbGpkSE11YTJWNWN5Z3BMbTVsZUhRb0tTNTJZV3gxWlNrN0NpQWdJQ0I5Q2lBZ0lDQmtZWEozYVc1QlkyeFdaWEprYVdOMGN5NXpaWFFvWTJGamFHVkxaWGtzSUdKbFptOXlaU2s3Q2lBZ2ZRcDlDZ3BtZFc1amRHbHZiaUIwY25WemRHVmtWMmx1Wkc5M2MxQnZkMlZ5VTJobGJHeFFZWFJvS0FvZ0lHTmhibTl1YVdOaGJHbDZaU0E5SUhKbFlXeHdZWFJvVTNsdVl5NXVZWFJwZG1Vc0NpQWdabWxzWlhONWMzUmxiU0E5SUZkSlRrUlBWMU5mUlZoRlExVlVRVUpNUlY5R1NVeEZVMWxUVkVWTkxBb3BJSHNLSUNBdkx5QkVaWEpwZG1VZ1lTQkRjbVZoZEdWUWNtOWpaWE56TFdOdmJYQmhkR2xpYkdVZ1JFOVRJSE53Wld4c2FXNW5JR1p5YjIwZ1IweFBRa0ZNVWs5UFZDd2dkR2hsYmlCd2NtOTJaUW9nSUM4dklHSnZkR2dnYzNCbGJHeHBibWR6SUhOMGFXeHNJRzVoYldVZ2RHaGxJSE5oYldVZ2NtVm5kV3hoY2lCemVYTjBaVzBnWm1sc1pTQmlaV1p2Y21VZ2JHRjFibU5vTGdvZ0lHTnZibk4wSUhONWMzUmxiVkp2YjNRZ1BTQmpZVzV2Ym1sallXeHBlbVVvVjBsT1JFOVhVMTlUV1ZOVVJVMWZVazlQVkNrN0NpQWdhV1lnS0NFdlhsdGhMWHBkT2x4Y0wybDFMblJsYzNRb2MzbHpkR1Z0VW05dmRDa2dmSHdnZDJsdU16SXVibTl5YldGc2FYcGxLSE41YzNSbGJWSnZiM1FwSUNFOVBTQnplWE4wWlcxU2IyOTBLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb0luUnlkWE4wWldRZ1YybHVaRzkzY3lCVGVYTjBaVzFTYjI5MElHUnBaQ0J1YjNRZ2NtVnpiMngyWlNCMGJ5QmhJR05oYm05dWFXTmhiQ0JzYjJOaGJDQkVUMU1nY0dGMGFDSXBPd29nSUgwS0lDQmpiMjV6ZENCM2IzSnJhVzVuUkdseVpXTjBiM0o1SUQwZ2QybHVNekl1YW05cGJpaHplWE4wWlcxU2IyOTBMQ0FpVTNsemRHVnRNeklpS1RzS0lDQmpiMjV6ZENCbGVHVmpkWFJoWW14bElEMGdkMmx1TXpJdWFtOXBiaWdLSUNBZ0lIZHZjbXRwYm1kRWFYSmxZM1J2Y25rc0NpQWdJQ0FpVjJsdVpHOTNjMUJ2ZDJWeVUyaGxiR3dpTEFvZ0lDQWdJbll4TGpBaUxBb2dJQ0FnSW5CdmQyVnljMmhsYkd3dVpYaGxJaXdLSUNBcE93b2dJR052Ym5OMElHNWhiV1Z6Y0dGalpVVjRaV04xZEdGaWJHVWdQU0IzYVc0ek1pNXFiMmx1S0FvZ0lDQWdWMGxPUkU5WFUxOVRXVk5VUlUxZlVrOVBWQ3dLSUNBZ0lDSlRlWE4wWlcwek1pSXNDaUFnSUNBaVYybHVaRzkzYzFCdmQyVnlVMmhsYkd3aUxBb2dJQ0FnSW5ZeExqQWlMQW9nSUNBZ0luQnZkMlZ5YzJobGJHd3VaWGhsSWl3S0lDQXBPd29nSUhabGNtbG1lVmRwYm1SdmQzTkZlR1ZqZFhSaFlteGxRV3hwWVhObGN5aHVZVzFsYzNCaFkyVkZlR1ZqZFhSaFlteGxMQ0JsZUdWamRYUmhZbXhsTENCbWFXeGxjM2x6ZEdWdEtUc0tJQ0J5WlhSMWNtNGdld29nSUNBZ2MzbHpkR1Z0VW05dmRDd0tJQ0FnSUhkdmNtdHBibWRFYVhKbFkzUnZjbmtzQ2lBZ0lDQmxlR1ZqZFhSaFlteGxMQW9nSUgwN0NuMEtDbVoxYm1OMGFXOXVJSFpsY21sbWVWZHBibVJ2ZDNORmVHVmpkWFJoWW14bFFXeHBZWE5sY3lodVlXMWxjM0JoWTJWRmVHVmpkWFJoWW14bExDQmxlR1ZqZFhSaFlteGxMQ0JtYVd4bGMzbHpkR1Z0S1NCN0NpQWdiR1YwSUc1aGJXVnpjR0ZqWlVSbGMyTnlhWEIwYjNJN0NpQWdiR1YwSUdOaGJtUnBaR0YwWlVSbGMyTnlhWEIwYjNJN0NpQWdiR1YwSUc5d1pYSmhkR2x2YmtWeWNtOXlPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0J1WVcxbGMzQmhZMlZDWldadmNtVWdQU0JtYVd4bGMzbHpkR1Z0TG14emRHRjBLRzVoYldWemNHRmpaVVY0WldOMWRHRmliR1VwT3dvZ0lDQWdZMjl1YzNRZ1kyRnVaR2xrWVhSbFFtVm1iM0psSUQwZ1ptbHNaWE41YzNSbGJTNXNjM1JoZENobGVHVmpkWFJoWW14bEtUc0tJQ0FnSUdGemMyVnlkRkpsWjNWc1lYSlhhVzVrYjNkelJYaGxZM1YwWVdKc1pTaHVZVzFsYzNCaFkyVkNaV1p2Y21Vc0lDSkhURTlDUVV4U1QwOVVJSEJoZEdnaUtUc0tJQ0FnSUdGemMyVnlkRkpsWjNWc1lYSlhhVzVrYjNkelJYaGxZM1YwWVdKc1pTaGpZVzVrYVdSaGRHVkNaV1p2Y21Vc0lDSkVUMU1nY0dGMGFDSXBPd29nSUNBZ2JtRnRaWE53WVdObFJHVnpZM0pwY0hSdmNpQTlJR1pwYkdWemVYTjBaVzB1YjNCbGJpaHVZVzFsYzNCaFkyVkZlR1ZqZFhSaFlteGxLVHNLSUNBZ0lHTmhibVJwWkdGMFpVUmxjMk55YVhCMGIzSWdQU0JtYVd4bGMzbHpkR1Z0TG05d1pXNG9aWGhsWTNWMFlXSnNaU2s3Q2lBZ0lDQmpiMjV6ZENCdVlXMWxjM0JoWTJWUGNHVnVaV1FnUFNCbWFXeGxjM2x6ZEdWdExtWnpkR0YwS0c1aGJXVnpjR0ZqWlVSbGMyTnlhWEIwYjNJcE93b2dJQ0FnWTI5dWMzUWdZMkZ1Wkdsa1lYUmxUM0JsYm1Wa0lEMGdabWxzWlhONWMzUmxiUzVtYzNSaGRDaGpZVzVrYVdSaGRHVkVaWE5qY21sd2RHOXlLVHNLSUNBZ0lHTnZibk4wSUc1aGJXVnpjR0ZqWlVGbWRHVnlJRDBnWm1sc1pYTjVjM1JsYlM1c2MzUmhkQ2h1WVcxbGMzQmhZMlZGZUdWamRYUmhZbXhsS1RzS0lDQWdJR052Ym5OMElHTmhibVJwWkdGMFpVRm1kR1Z5SUQwZ1ptbHNaWE41YzNSbGJTNXNjM1JoZENobGVHVmpkWFJoWW14bEtUc0tJQ0FnSUdGemMyVnlkRkpsWjNWc1lYSlhhVzVrYjNkelJYaGxZM1YwWVdKc1pTaHVZVzFsYzNCaFkyVlBjR1Z1WldRc0lDSkhURTlDUVV4U1QwOVVJR1JsYzJOeWFYQjBiM0lpS1RzS0lDQWdJR0Z6YzJWeWRGSmxaM1ZzWVhKWGFXNWtiM2R6UlhobFkzVjBZV0pzWlNoallXNWthV1JoZEdWUGNHVnVaV1FzSUNKRVQxTWdaR1Z6WTNKcGNIUnZjaUlwT3dvZ0lDQWdZWE56WlhKMFVtVm5kV3hoY2xkcGJtUnZkM05GZUdWamRYUmhZbXhsS0c1aGJXVnpjR0ZqWlVGbWRHVnlMQ0FpUjB4UFFrRk1VazlQVkNCd1lYUm9JaWs3Q2lBZ0lDQmhjM05sY25SU1pXZDFiR0Z5VjJsdVpHOTNjMFY0WldOMWRHRmliR1VvWTJGdVpHbGtZWFJsUVdaMFpYSXNJQ0pFVDFNZ2NHRjBhQ0lwT3dvZ0lDQWdabTl5SUNoamIyNXpkQ0JwWkdWdWRHbDBlU0J2WmlCYkNpQWdJQ0FnSUc1aGJXVnpjR0ZqWlVKbFptOXlaU3dLSUNBZ0lDQWdZMkZ1Wkdsa1lYUmxRbVZtYjNKbExBb2dJQ0FnSUNCdVlXMWxjM0JoWTJWUGNHVnVaV1FzQ2lBZ0lDQWdJR05oYm1ScFpHRjBaVTl3Wlc1bFpDd0tJQ0FnSUNBZ2JtRnRaWE53WVdObFFXWjBaWElzQ2lBZ0lDQWdJR05oYm1ScFpHRjBaVUZtZEdWeUxBb2dJQ0FnWFNrZ2V3b2dJQ0FnSUNCcFppQW9DaUFnSUNBZ0lDQWdhV1JsYm5ScGRIa3VaR1YySUR3OUlEQnVJSHg4SUdsa1pXNTBhWFI1TG1sdWJ5QThQU0F3YmlCOGZBb2dJQ0FnSUNBZ0lHbGtaVzUwYVhSNUxtUmxkaUE5UFQwZ1ZVNVRWVkJRVDFKVVJVUmZSa2xNUlY5SlJGODJOQ0I4ZkNCcFpHVnVkR2wwZVM1cGJtOGdQVDA5SUZWT1UxVlFVRTlTVkVWRVgwWkpURVZmU1VSZk5qUUtJQ0FnSUNBZ0tTQjdDaUFnSUNBZ0lDQWdkR2h5YjNjZ2JtVjNJRVZ5Y205eUtDSjBjblZ6ZEdWa0lGZHBibVJ2ZDNNZ2MzbHpkR1Z0SUdWNFpXTjFkR0ZpYkdVZ2FXUmxiblJwZEhrZ2FYTWdkVzVoZG1GcGJHRmliR1VpS1RzS0lDQWdJQ0FnZlFvZ0lDQWdmUW9nSUNBZ2FXWWdLQW9nSUNBZ0lDQWhjMkZ0WlVacGJHVkpaR1Z1ZEdsMGVTaHVZVzFsYzNCaFkyVkNaV1p2Y21Vc0lHNWhiV1Z6Y0dGalpVOXdaVzVsWkNrZ2ZId0tJQ0FnSUNBZ0lYTmhiV1ZHYVd4bFNXUmxiblJwZEhrb2JtRnRaWE53WVdObFQzQmxibVZrTENCdVlXMWxjM0JoWTJWQlpuUmxjaWtnZkh3S0lDQWdJQ0FnSVhOaGJXVkdhV3hsU1dSbGJuUnBkSGtvWTJGdVpHbGtZWFJsUW1WbWIzSmxMQ0JqWVc1a2FXUmhkR1ZQY0dWdVpXUXBJSHg4Q2lBZ0lDQWdJQ0Z6WVcxbFJtbHNaVWxrWlc1MGFYUjVLR05oYm1ScFpHRjBaVTl3Wlc1bFpDd2dZMkZ1Wkdsa1lYUmxRV1owWlhJcElIeDhDaUFnSUNBZ0lDRnpZVzFsUm1sc1pVbGtaVzUwYVhSNUtHNWhiV1Z6Y0dGalpVOXdaVzVsWkN3Z1kyRnVaR2xrWVhSbFQzQmxibVZrS1FvZ0lDQWdLU0I3Q2lBZ0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpZ2lkSEoxYzNSbFpDQlhhVzVrYjNkeklITjVjM1JsYlNCbGVHVmpkWFJoWW14bElHbGtaVzUwYVhSNUlHMXBjMjFoZEdOb0lpazdDaUFnSUNCOUNpQWdmU0JqWVhSamFDQW9aWEp5YjNJcElIc0tJQ0FnSUc5d1pYSmhkR2x2YmtWeWNtOXlJRDBnWlhKeWIzSTdDaUFnZlFvZ0lHTnZibk4wSUdOc2IzTmxSWEp5YjNKeklEMGdXMTA3Q2lBZ1ptOXlJQ2hqYjI1emRDQmtaWE5qY21sd2RHOXlJRzltSUZ0allXNWthV1JoZEdWRVpYTmpjbWx3ZEc5eUxDQnVZVzFsYzNCaFkyVkVaWE5qY21sd2RHOXlYU2tnZXdvZ0lDQWdhV1lnS0dSbGMyTnlhWEIwYjNJZ1BUMDlJSFZ1WkdWbWFXNWxaQ2tnWTI5dWRHbHVkV1U3Q2lBZ0lDQjBjbmtnZXlCbWFXeGxjM2x6ZEdWdExtTnNiM05sS0dSbGMyTnlhWEIwYjNJcE95QjlJR05oZEdOb0lDaGxjbkp2Y2lrZ2V5QmpiRzl6WlVWeWNtOXljeTV3ZFhOb0tHVnljbTl5S1RzZ2ZRb2dJSDBLSUNCcFppQW9iM0JsY21GMGFXOXVSWEp5YjNJZ0lUMDlJSFZ1WkdWbWFXNWxaQ2tnZXdvZ0lDQWdhV1lnS0dOc2IzTmxSWEp5YjNKekxteGxibWQwYUNBK0lEQXBJSHNLSUNBZ0lDQWdkR2h5YjNjZ2JtVjNJRUZuWjNKbFoyRjBaVVZ5Y205eUtBb2dJQ0FnSUNBZ0lGdHZjR1Z5WVhScGIyNUZjbkp2Y2l3Z0xpNHVZMnh2YzJWRmNuSnZjbk5kTEFvZ0lDQWdJQ0FnSUNKMGNuVnpkR1ZrSUZkcGJtUnZkM01nWlhobFkzVjBZV0pzWlNCMllXeHBaR0YwYVc5dUlHRnVaQ0JqYkdWaGJuVndJR0p2ZEdnZ1ptRnBiR1ZrSWl3S0lDQWdJQ0FnS1RzS0lDQWdJSDBLSUNBZ0lIUm9jbTkzSUc5d1pYSmhkR2x2YmtWeWNtOXlPd29nSUgwS0lDQnBaaUFvWTJ4dmMyVkZjbkp2Y25NdWJHVnVaM1JvSUQwOVBTQXhLU0IwYUhKdmR5QmpiRzl6WlVWeWNtOXljMXN3WFRzS0lDQnBaaUFvWTJ4dmMyVkZjbkp2Y25NdWJHVnVaM1JvSUQ0Z01Ta2dld29nSUNBZ2RHaHliM2NnYm1WM0lFRm5aM0psWjJGMFpVVnljbTl5S0FvZ0lDQWdJQ0JqYkc5elpVVnljbTl5Y3l3S0lDQWdJQ0FnSW5SeWRYTjBaV1FnVjJsdVpHOTNjeUJsZUdWamRYUmhZbXhsSUdSbGMyTnlhWEIwYjNJZ1kyeGxZVzUxY0NCbVlXbHNaV1FpTEFvZ0lDQWdLVHNLSUNCOUNuMEtDbVoxYm1OMGFXOXVJR0Z6YzJWeWRGSmxaM1ZzWVhKWGFXNWtiM2R6UlhobFkzVjBZV0pzWlNocFpHVnVkR2wwZVN3Z2MzQmxiR3hwYm1jcElIc0tJQ0JwWmlBb0lXbGtaVzUwYVhSNUxtbHpSbWxzWlNncElIeDhJR2xrWlc1MGFYUjVMbWx6VTNsdFltOXNhV05NYVc1cktDa3BJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ2RISjFjM1JsWkNCWGFXNWtiM2R6SUNSN2MzQmxiR3hwYm1kOUlHVjRaV04xZEdGaWJHVWdhWE1nYm05MElHRWdjbVZuZFd4aGNpQnViMjR0YkdsdWF5Qm1hV3hsWUNrN0NpQWdmUXA5Q2dwbWRXNWpkR2x2YmlCellXMWxSbWxzWlVsa1pXNTBhWFI1S0d4bFpuUXNJSEpwWjJoMEtTQjdDaUFnY21WMGRYSnVJR3hsWm5RdVpHVjJJRDA5UFNCeWFXZG9kQzVrWlhZZ0ppWWdiR1ZtZEM1cGJtOGdQVDA5SUhKcFoyaDBMbWx1YnpzS2ZRb0tablZ1WTNScGIyNGdkMmx1Wkc5M2MxQnZkMlZ5VTJobGJHeEZiblpwY205dWJXVnVkQ2h3WVhSb2N5d2dkSEoxYzNSbFpGQmhkR2h6SUQwZ2RISjFjM1JsWkZkcGJtUnZkM05RYjNkbGNsTm9aV3hzVUdGMGFDZ3BLU0I3Q2lBZ1kyOXVjM1FnZXlCemVYTjBaVzFTYjI5MExDQjNiM0pyYVc1blJHbHlaV04wYjNKNUlIMGdQU0IwY25WemRHVmtVR0YwYUhNN0NpQWdMeThnYkdsaWRYWWdabWxzYkhNZ1lTQm1hWGhsWkNCelpYUWdiMllnSW5KbGNYVnBjbVZrSWlCWGFXNWtiM2R6SUhaaGNtbGhZbXhsY3lCbWNtOXRJSFJvWlNCd1lYSmxiblFLSUNBdkx5QjNhR1Z1SUhSb1pYa2dZWEpsSUdGaWMyVnVkQzRnUkdWbWFXNWxJR1YyWlhKNUlHOXVaU0J6YnlCd2IybHpiMjVsWkNCallXeHNaWElnYzNSaGRHVWdZMkZ1Ym05MElHSmxDaUFnTHk4Z2MybHNaVzUwYkhrZ2FXNW9aWEpwZEdWa0lHbHVkRzhnZEdobElIWmhiR2xrWVhScGIyNGdhR1ZzY0dWeUxnb2dJSEpsZEhWeWJpQjdDaUFnSUNCQlIwVk9RMTlNVDBOTFgxQkJWRWhUT2lCM2FXNWtiM2R6VUdGMGFGUnlZVzV6Y0c5eWRDaHdZWFJvY3lrc0NpQWdJQ0JCVUZCRVFWUkJPaUFpSWl3S0lDQWdJRU5QVFZOUVJVTTZJQ0lpTEFvZ0lDQWdTRTlOUlVSU1NWWkZPaUFpSWl3S0lDQWdJRWhQVFVWUVFWUklPaUFpSWl3S0lDQWdJRXhQUTBGTVFWQlFSRUZVUVRvZ0lpSXNDaUFnSUNCTVQwZFBUbE5GVWxaRlVqb2dJaUlzQ2lBZ0lDQlFRVlJJT2lCM2IzSnJhVzVuUkdseVpXTjBiM0o1TEFvZ0lDQWdVRUZVU0VWWVZEb2dJaTVGV0VVaUxBb2dJQ0FnVUZOTlQwUlZURVZRUVZSSU9pQWlJaXdLSUNBZ0lGTlpVMVJGVFVSU1NWWkZPaUFpSWl3S0lDQWdJRk5aVTFSRlRWSlBUMVE2SUhONWMzUmxiVkp2YjNRc0NpQWdJQ0JVUlUxUU9pQjNiM0pyYVc1blJHbHlaV04wYjNKNUxBb2dJQ0FnVkUxUU9pQjNiM0pyYVc1blJHbHlaV04wYjNKNUxBb2dJQ0FnVlZORlVrUlBUVUZKVGpvZ0lpSXNDaUFnSUNCVlUwVlNUa0ZOUlRvZ0lpSXNDaUFnSUNCVlUwVlNVRkpQUmtsTVJUb2dkMjl5YTJsdVowUnBjbVZqZEc5eWVTd0tJQ0FnSUZkSlRrUkpVam9nYzNsemRHVnRVbTl2ZEN3S0lDQjlPd3A5Q2dwbWRXNWpkR2x2YmlCM2FXNWtiM2R6VUdGMGFGUnlZVzV6Y0c5eWRDaGxiblJ5YVdWektTQjdDaUFnYVdZZ0tBb2dJQ0FnSVVGeWNtRjVMbWx6UVhKeVlYa29aVzUwY21sbGN5a2dmSHdLSUNBZ0lHVnVkSEpwWlhNdWJHVnVaM1JvSUR3Z01TQjhmQW9nSUNBZ1pXNTBjbWxsY3k1c1pXNW5kR2dnUGlCWFNVNUVUMWRUWDFCQlZFaGZWRkpCVGxOUVQxSlVYMDFCV0Y5RlRsUlNTVVZUQ2lBZ0tTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvSW1GblpXNWpPaUJYYVc1a2IzZHpJSEJ5YjNSbFkzUmxaQzF3WVhSb0lIUnlZVzV6Y0c5eWRDQm9ZWE1nWVc0Z2FXNTJZV3hwWkNCbGJuUnllU0JqYjNWdWRDSXBPd29nSUgwS0lDQmpiMjV6ZENCeVpXTnZjbVJ6SUQwZ1cxMDdDaUFnYkdWMElIUnlZVzV6Y0c5eWRFTm9ZWEp6SUQwZ01Ec0tJQ0JtYjNJZ0tHTnZibk4wSUdWdWRISjVJRzltSUdWdWRISnBaWE1wSUhzS0lDQWdJR052Ym5OMElIQmhkR2dnUFNCbGJuUnllVDh1Y0dGMGFEc0tJQ0FnSUdOdmJuTjBJSEp2YkdVZ1BTQmxiblJ5ZVQ4dWNtOXNaVHNLSUNBZ0lHbG1JQ2dLSUNBZ0lDQWdkSGx3Wlc5bUlIQmhkR2dnSVQwOUlDSnpkSEpwYm1jaUlIeDhDaUFnSUNBZ0lIQmhkR2d1YkdWdVozUm9JRDA5UFNBd0lIeDhDaUFnSUNBZ0lIQmhkR2d1YkdWdVozUm9JRDRnVjBsT1JFOVhVMTlRUVZSSVgxUlNRVTVUVUU5U1ZGOU5RVmhmUTBoQlVsTWdmSHdLSUNBZ0lDQWdLSEp2YkdVZ0lUMDlJQ0pzWldGbVJHbHlaV04wYjNKNUlpQW1KaUJ5YjJ4bElDRTlQU0FpWVc1alpYTjBiM0pFYVhKbFkzUnZjbmtpSUNZbUlISnZiR1VnSVQwOUlDSm1hV3hsSWlrS0lDQWdJQ2tnZXdvZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9JbUZuWlc1ak9pQlhhVzVrYjNkeklIQnliM1JsWTNSbFpDMXdZWFJvSUhSeVlXNXpjRzl5ZENCbGJuUnllU0JwY3lCcGJuWmhiR2xrSWlrN0NpQWdJQ0I5Q2lBZ0lDQmpiMjV6ZENCeVpXTnZjbVFnUFNCZ0pIdHliMnhsZlRva2UwSjFabVpsY2k1bWNtOXRLSEJoZEdnc0lDSjFkR1l4Tm14bElpa3VkRzlUZEhKcGJtY29JbUpoYzJVMk5DSXBmV0E3Q2lBZ0lDQjBjbUZ1YzNCdmNuUkRhR0Z5Y3lBclBTQnlaV052Y21RdWJHVnVaM1JvSUNzZ0tISmxZMjl5WkhNdWJHVnVaM1JvSUQwOVBTQXdJRDhnTUNBNklERXBPd29nSUNBZ2FXWWdLSFJ5WVc1emNHOXlkRU5vWVhKeklENGdWMGxPUkU5WFUxOVFRVlJJWDFSU1FVNVRVRTlTVkY5TlFWaGZRMGhCVWxNcElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0NKaFoyVnVZem9nVjJsdVpHOTNjeUJ3Y205MFpXTjBaV1F0Y0dGMGFDQjBjbUZ1YzNCdmNuUWdaWGhqWldWa2N5QnBkSE1nYkdsdGFYUWlLVHNLSUNBZ0lIMEtJQ0FnSUhKbFkyOXlaSE11Y0hWemFDaHlaV052Y21RcE93b2dJSDBLSUNCeVpYUjFjbTRnY21WamIzSmtjeTVxYjJsdUtDSmNiaUlwT3dwOUNncGhjM2x1WXlCbWRXNWpkR2x2YmlCaGMzTmxjblJYYVc1a2IzZHpVR0YwYUZObFkzVnlhWFI1S0dWdWRISnBaWE1zSUdOdmJuUmxlSFFwSUhzS0lDQmpiMjV6ZENCa2FYTndiR0Y1VUdGMGFDQTlJR1Z1ZEhKcFpYTXVZWFFvTFRFcFB5NXdZWFJvSUQ4L0lDSjFibXR1YjNkdUlqc0tJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQmthWE53YkdGNVVHRjBhQ2s3Q2lBZ1kyOXVjM1FnZEhKMWMzUmxaRkJoZEdoeklEMGdkSEoxYzNSbFpGZHBibVJ2ZDNOUWIzZGxjbE5vWld4c1VHRjBhQ2dwT3dvZ0lHTnZibk4wSUhzZ2QyOXlhMmx1WjBScGNtVmpkRzl5ZVN3Z1pYaGxZM1YwWVdKc1pTQjlJRDBnZEhKMWMzUmxaRkJoZEdoek93b2dJR3hsZENCeVpYTjFiSFE3Q2lBZ2RISjVJSHNLSUNBZ0lISmxjM1ZzZENBOUlHRjNZV2wwSUdWNFpXTkdhV3hsVlhSbU9DZ0tJQ0FnSUNBZ1pYaGxZM1YwWVdKc1pTd0tJQ0FnSUNBZ1d3b2dJQ0FnSUNBZ0lDSXRUbTlNYjJkdklpd0tJQ0FnSUNBZ0lDQWlMVTV2VUhKdlptbHNaU0lzQ2lBZ0lDQWdJQ0FnSWkxT2IyNUpiblJsY21GamRHbDJaU0lzQ2lBZ0lDQWdJQ0FnSWkxRmJtTnZaR1ZrUTI5dGJXRnVaQ0lzQ2lBZ0lDQWdJQ0FnVjBsT1JFOVhVMTlUUlVOVlVrbFVXVjlUUTFKSlVGUmZRa0ZUUlRZMExBb2dJQ0FnSUNCZExBb2dJQ0FnSUNCN0NpQWdJQ0FnSUNBZ1kzZGtPaUIzYjNKcmFXNW5SR2x5WldOMGIzSjVMQW9nSUNBZ0lDQWdJR1Z1ZGpvZ2QybHVaRzkzYzFCdmQyVnlVMmhsYkd4RmJuWnBjbTl1YldWdWRDaGxiblJ5YVdWekxDQjBjblZ6ZEdWa1VHRjBhSE1wTEFvZ0lDQWdJQ0FnSUcxaGVFSjFabVpsY2pvZ01UQXlOQ0FxSURFd01qUXNDaUFnSUNBZ0lDQWdkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNDaUFnSUNBZ0lIMHNDaUFnSUNBZ0lHTnZiblJsZUhRc0NpQWdJQ0FnSUdScGMzQnNZWGxRWVhSb0xBb2dJQ0FnS1RzS0lDQjlJR05oZEdOb0lDaGxjbkp2Y2lrZ2V3b2dJQ0FnZEdoeWIzY2dibTl5YldGc2FYcGxWR2x0WldSRGIyMXRZVzVrUlhKeWIzSW9aWEp5YjNJc0lHTnZiblJsZUhRc0lHUnBjM0JzWVhsUVlYUm9LVHNLSUNCOUNpQWdhV1lnS0hKbGMzVnNkQzV6ZEdSdmRYUWdJVDA5SUNKUFN5SXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUZkcGJtUnZkM01nYkc5amF5MXdZWFJvSUhaaGJHbGtZWFJwYjI0Z2NtVjBkWEp1WldRZ1lXNGdhVzUyWVd4cFpDQnlaWE53YjI1elpTQm1iM0lnSkh0a2FYTndiR0Y1VUdGMGFIMWdLVHNLSUNCOUNpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1pHbHpjR3hoZVZCaGRHZ3BPd3A5Q2dwbWRXNWpkR2x2YmlCMWJuTjFjSEJ2Y25SbFpFeHZZMnRHYVd4bGMzbHpkR1Z0S0hCaGNtVnVkQ3dnWm1sc1pYTjVjM1JsYlZSNWNHVXNJR05oZFhObEtTQjdDaUFnY21WMGRYSnVJRzVsZHlCRmNuSnZjaWdLSUNBZ0lHQmhaMlZ1WXpvZ2JtOXVMV3h2WTJGc0lHOXlJSFZ1YTI1dmQyNGdiRzlqYXlCbWFXeGxjM2x6ZEdWdElHbHpJSFZ1YzNWd2NHOXlkR1ZrSUNna2UyWnBiR1Z6ZVhOMFpXMVVlWEJsSUQ4L0lDSjFibXR1YjNkdUluMHBPaUFrZTNCaGNtVnVkSDFnTEFvZ0lDQWdZMkYxYzJVZ1BUMDlJSFZ1WkdWbWFXNWxaQ0EvSUhWdVpHVm1hVzVsWkNBNklIc2dZMkYxYzJVZ2ZTd0tJQ0FwT3dwOUNncGhjM2x1WXlCbWRXNWpkR2x2YmlCaGMzTmxjblJNYjJOaGJFWnBiR1Z6ZVhOMFpXMG9jR0Z5Wlc1MExDQmpiMjUwWlhoMEtTQjdDaUFnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2djR0Z5Wlc1MEtUc0tJQ0JzWlhRZ1ptbHNaWE41YzNSbGJWUjVjR1U3Q2lBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNKc2FXNTFlQ0lwSUhzS0lDQWdJR052Ym5OMElHMXZkVzUwY3lBOUlHRjNZV2wwSUhKbFlXUkdhV3hsS0NJdmNISnZZeTl6Wld4bUwyMXZkVzUwYVc1bWJ5SXNJQ0oxZEdZNElpazdDaUFnSUNCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0J3WVhKbGJuUXBPd29nSUNBZ2JHVjBJR3h2Ym1kbGMzUWdQU0F0TVRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnYkdsdVpTQnZaaUJ0YjNWdWRITXVjM0JzYVhRb0lseHVJaWtwSUhzS0lDQWdJQ0FnWTI5dWMzUWdabWxsYkdSeklEMGdiR2x1WlM1emNHeHBkQ2dpSUNJcE93b2dJQ0FnSUNCamIyNXpkQ0J6WlhCaGNtRjBiM0pKYm1SbGVDQTlJR1pwWld4a2N5NXBibVJsZUU5bUtDSXRJaWs3Q2lBZ0lDQWdJR2xtSUNnS0lDQWdJQ0FnSUNCelpYQmhjbUYwYjNKSmJtUmxlQ0E4SURZZ2ZId0tJQ0FnSUNBZ0lDQm1hV1ZzWkhOYk5GMGdQVDA5SUhWdVpHVm1hVzVsWkNCOGZBb2dJQ0FnSUNBZ0lHWnBaV3hrYzF0elpYQmhjbUYwYjNKSmJtUmxlQ0FySURGZElEMDlQU0IxYm1SbFptbHVaV1FLSUNBZ0lDQWdLU0JqYjI1MGFXNTFaVHNLSUNBZ0lDQWdZMjl1YzNRZ2JXOTFiblJRYjJsdWRDQTlJR1JsWTI5a1pVMXZkVzUwVUdGMGFDaG1hV1ZzWkhOYk5GMHBPd29nSUNBZ0lDQnBaaUFvY0dGMGFFbHpWMmwwYUdsdUtIQmhjbVZ1ZEN3Z2JXOTFiblJRYjJsdWRDa2dKaVlnYlc5MWJuUlFiMmx1ZEM1c1pXNW5kR2dnUGlCc2IyNW5aWE4wS1NCN0NpQWdJQ0FnSUNBZ2JHOXVaMlZ6ZENBOUlHMXZkVzUwVUc5cGJuUXViR1Z1WjNSb093b2dJQ0FnSUNBZ0lHWnBiR1Z6ZVhOMFpXMVVlWEJsSUQwZ1ptbGxiR1J6VzNObGNHRnlZWFJ2Y2tsdVpHVjRJQ3NnTVYwN0NpQWdJQ0FnSUgwS0lDQWdJSDBLSUNCOUlHVnNjMlVnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ0prWVhKM2FXNGlLU0I3Q2lBZ0lDQmpiMjV6ZENCd2NtOWlaVk4wWVhKMFpXUkJkQ0E5SUhCbGNtWnZjbTFoYm1ObExtNXZkeWdwT3dvZ0lDQWdZMjl1YzNRZ2NISnZZbVZFWldGa2JHbHVaU0E5SUUxaGRHZ3ViV2x1S0FvZ0lDQWdJQ0JqYjI1MFpYaDBMbVJsWVdSc2FXNWxMQW9nSUNBZ0lDQndjbTlpWlZOMFlYSjBaV1JCZENBcklFUkJVbGRKVGw5R1NVeEZVMWxUVkVWTlgxQlNUMEpGWDFSSlRVVlBWVlJmVFZNc0NpQWdJQ0FwT3dvZ0lDQWdZMjl1YzNRZ2NISnZZbVZEYjI1MFpYaDBJRDBnZXdvZ0lDQWdJQ0F1TGk1amIyNTBaWGgwTEFvZ0lDQWdJQ0JrWldGa2JHbHVaVG9nY0hKdlltVkVaV0ZrYkdsdVpTd0tJQ0FnSUNBZ2RHbHRaVzkxZEUxek9pQk5ZWFJvTG0xcGJpZ0tJQ0FnSUNBZ0lDQkVRVkpYU1U1ZlJrbE1SVk5aVTFSRlRWOVFVazlDUlY5VVNVMUZUMVZVWDAxVExBb2dJQ0FnSUNBZ0lFMWhkR2d1YldGNEtERXNJRTFoZEdndVkyVnBiQ2h3Y205aVpVUmxZV1JzYVc1bElDMGdjSEp2WW1WVGRHRnlkR1ZrUVhRcEtTd0tJQ0FnSUNBZ0tTd0tJQ0FnSUNBZ2JHRmlaV3c2SUdBa2UyTnZiblJsZUhRdWJHRmlaV3g5SUNodFlXTlBVeUJzYjJOcklHWnBiR1Z6ZVhOMFpXMGdjSEp2WW1VZ2RtbGhJQzlpYVc0dlpHWXBZQ3dLSUNBZ0lIMDdDaUFnSUNCc1pYUWdjbVZ6ZFd4ME93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0x5OGdWMmwwYUNCaGJpQmxlR2x6ZEdsdVp5QmthWEpsWTNSdmNua2diM0JsY21GdVpDd2daR1lnWTJGc2JITWdjM1JoZEdaeklHOXVJSFJvWVhRZ2NHRjBhQzRLSUNBZ0lDQWdMeThnTFZRZ1ptbHNkR1Z5Y3lCbVgyWnpkSGx3Wlc1aGJXVWdZV2RoYVc1emRDQnZkWElnWlhoaFkzUWdZV3hzYjNkc2FYTjBMQ0JwYm1Oc2RXUnBibWNnYjI0S0lDQWdJQ0FnTHk4Z2MzVndjRzl5ZEdWa0lHMWhZMDlUSUhabGNuTnBiMjV6SUhSb1lYUWdZMkZ1Ym05MElIQnlhVzUwSUhSb1pTQjBlWEJsSUhkcGRHZ2daR1lnTFZrdUNpQWdJQ0FnSUM4dklFNWxkbVZ5SUhWelpTQmhJR0poY21VZ2JXOTFiblF2WkdZZ2IzSWdaR1lnTFd3NklIVnVjbVZzWVhSbFpDQm1hV3hsYzNsemRHVnRjeUJ0WVhrZ1ltVWdjM1IxWTJzdUNpQWdJQ0FnSUhKbGMzVnNkQ0E5SUdGM1lXbDBJR1Y0WldOR2FXeGxWWFJtT0NnS0lDQWdJQ0FnSUNBaUwySnBiaTlrWmlJc0NpQWdJQ0FnSUNBZ1d5SXRVQ0lzSUNJdFZDSXNJRnN1TGk1TVQwTkJURjlHU1V4RlUxbFRWRVZOWDFSWlVFVlRYUzVxYjJsdUtDSXNJaWtzSUhCaGNtVnVkRjBzQ2lBZ0lDQWdJQ0FnZXlCbGJuWTZJSHNnVEVOZlFVeE1PaUFpUXlJZ2ZTd2diV0Y0UW5WbVptVnlPaUEyTkNBcUlERXdNalFnZlN3S0lDQWdJQ0FnSUNCd2NtOWlaVU52Ym5SbGVIUXNDaUFnSUNBZ0lDQWdjR0Z5Wlc1MExBb2dJQ0FnSUNBcE93b2dJQ0FnZlNCallYUmphQ0FvWlhKeWIzSXBJSHNLSUNBZ0lDQWdZMjl1YzNRZ2JtOXliV0ZzYVhwbFpDQTlJRzV2Y20xaGJHbDZaVlJwYldWa1EyOXRiV0Z1WkVWeWNtOXlLR1Z5Y205eUxDQndjbTlpWlVOdmJuUmxlSFFzSUhCaGNtVnVkQ2s3Q2lBZ0lDQWdJR2xtSUNodWIzSnRZV3hwZW1Wa0lHbHVjM1JoYm1ObGIyWWdURzlqWVd4VGNXeHBkR1ZNYjJOclZHbHRaVzkxZEVWeWNtOXlLU0IwYUhKdmR5QnViM0p0WVd4cGVtVmtPd29nSUNBZ0lDQjBhSEp2ZHlCMWJuTjFjSEJ2Y25SbFpFeHZZMnRHYVd4bGMzbHpkR1Z0S0hCaGNtVnVkQ3dnZFc1a1pXWnBibVZrTENCdWIzSnRZV3hwZW1Wa0tUc0tJQ0FnSUgwS0lDQWdJSFJvY205M1NXWkZlSEJwY21Wa0tIQnliMkpsUTI5dWRHVjRkQ3dnY0dGeVpXNTBLVHNLSUNBZ0lHTnZibk4wSUd4cGJtVnpJRDBnY21WemRXeDBMbk4wWkc5MWRDNXpjR3hwZENnaVhHNGlLVHNLSUNBZ0lHbG1JQ2hzYVc1bGN5NWhkQ2d0TVNrZ1BUMDlJQ0lpS1NCc2FXNWxjeTV3YjNBb0tUc0tJQ0FnSUdOdmJuTjBJSEp2ZHlBOUlHeHBibVZ6V3pGZFB5NXRZWFJqYUNndlhpNHJXMXgwSUYwclhHUXJXMXgwSUYwclhHUXJXMXgwSUYwckxUOWNaQ3RiWEhRZ1hTdGNaQ3NsVzF4MElGMHJLRnd2TGlvcEpDOTFLVHNLSUNBZ0lDOHZJRlJvWlNCMGVYQmxJSGRoY3lCamFHVmphMlZrSUdKNUlHUm1JRzl1SUhSb1pTQnZjR1Z5WVc1a0lHbDBjMlZzWmk0Z1JHOGdibTkwSUdsdVptVnlJR2wwSUdaeWIyMEtJQ0FnSUM4dklIUm9aU0J3Y21sdWRHVmtJRzF2ZFc1MElIQnZhVzUwT2lCQlVFWlRJR1pwY20xc2FXNXJjeUJqWVc0Z2JXRndJQzlWYzJWeWN5QjBieUIwYUdVZ1JHRjBZU0IyYjJ4MWJXVUtJQ0FnSUM4dklHMXZkVzUwWldRZ1lYUWdMMU41YzNSbGJTOVdiMngxYldWekwwUmhkR0VnZDJsMGFHOTFkQ0JqYUdGdVoybHVaeUJ5WldGc2NHRjBhQ2d2VlhObGNuTXZMaTR1S1M0S0lDQWdJR2xtSUNnS0lDQWdJQ0FnY21WemRXeDBMbk4wWkdWeWNpQWhQVDBnSWlJZ2ZId2diR2x1WlhNdWJHVnVaM1JvSUNFOVBTQXlJSHg4Q2lBZ0lDQWdJQ0V2WGtacGJHVnplWE4wWlcxYlhIUWdYU3MxTVRJdFlteHZZMnR6VzF4MElGMHJWWE5sWkZ0Y2RDQmRLMEYyWVdsc0tEODZZV0pzWlNrL1cxeDBJRjByUTJGd1lXTnBkSGxiWEhRZ1hTdE5iM1Z1ZEdWa0lHOXVKQzkxTG5SbGMzUW9iR2x1WlhOYk1GMHBJSHg4Q2lBZ0lDQWdJSEp2ZHlBOVBTQnVkV3hzQ2lBZ0lDQXBJSHNLSUNBZ0lDQWdkR2h5YjNjZ2RXNXpkWEJ3YjNKMFpXUk1iMk5yUm1sc1pYTjVjM1JsYlNod1lYSmxiblFwT3dvZ0lDQWdmUW9nSUNBZ2NtVjBkWEp1T3dvZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSW5kcGJqTXlJaWtnZXdvZ0lDQWdZWGRoYVhRZ1lYTnpaWEowVjJsdVpHOTNjMUJoZEdoVFpXTjFjbWwwZVNoYmV5QndZWFJvT2lCd1lYSmxiblFzSUhKdmJHVTZJQ0pzWldGbVJHbHlaV04wYjNKNUlpQjlYU3dnWTI5dWRHVjRkQ2s3Q2lBZ0lDQnlaWFIxY200N0NpQWdmU0JsYkhObElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWdLSUNBZ0lDQWdZR0ZuWlc1ak9pQmpZVzV1YjNRZ1pYTjBZV0pzYVhOb0lHeHZZMnNnWm1sc1pYTjVjM1JsYlNCc2IyTmhiR2wwZVNCdmJpQWtlM0J5YjJObGMzTXVjR3hoZEdadmNtMTlZQ3dLSUNBZ0lDazdDaUFnZlFvZ0lHbG1JQ2htYVd4bGMzbHpkR1Z0Vkhsd1pTQTlQVDBnZFc1a1pXWnBibVZrSUh4OElDRk1UME5CVEY5R1NVeEZVMWxUVkVWTlgxUlpVRVZUTG1oaGN5aG1hV3hsYzNsemRHVnRWSGx3WlNrcElIc0tJQ0FnSUhSb2NtOTNJSFZ1YzNWd2NHOXlkR1ZrVEc5amEwWnBiR1Z6ZVhOMFpXMG9jR0Z5Wlc1MExDQm1hV3hsYzNsemRHVnRWSGx3WlNrN0NpQWdmUXA5Q2dvdktpb0tJQ29nUlhOMFlXSnNhWE5vSUhSb1lYUWdZVzRnWlhocGMzUnBibWNnWkdseVpXTjBiM0o1SUdseklHRWdiRzlqWVd3c0lIQnlhWFpoZEdWc2VTQnRkWFJoWW14bENpQXFJR052YjNKa2FXNWhkR2x2YmlCaWIzVnVaR0Z5ZVM0Z1YzSmhjSEJsY2lCeVpYQnNZV05sYldWdWRDQjFjMlZ6SUdFZ2NtVm5hWE4wY25rdGFHOXpkR1ZrSUZOUlRHbDBaUW9nS2lCc2IyTnJMQ0J6YnlCaElITm9ZWEpsWkNCdmNpQmhkSFJoWTJ0bGNpMTNjbWwwWVdKc1pTQjNjbUZ3Y0dWeUlHUnBjbVZqZEc5eWVTQjNiM1ZzWkNCdmRHaGxjbmRwYzJVS0lDb2djR1Z5YldsMElHTnliM056TFdodmMzUWdjbUZqWlhNZ2IzSWdjR0YwYUNCemRXSnpkR2wwZFhScGIyNGdiM1YwYzJsa1pTQjBhR0YwSUd4dlkyc3VDaUFxTHdwbGVIQnZjblFnWVhONWJtTWdablZ1WTNScGIyNGdZWE56WlhKMFRHOWpZV3hRY21sMllYUmxSR2x5WldOMGIzSjVLQW9nSUhKbGNYVmxjM1JsWkZCaGRHZ3NDaUFnZXdvZ0lDQWdkR2x0Wlc5MWRFMXpJRDBnTmpCZk1EQXdMQW9nSUNBZ2JHRmlaV3dnUFNBaVFXZGxia01nYjNCbGNtRjBhVzl1SWl3S0lDQWdJR1JsWVdSc2FXNWxPaUJ6ZFhCd2JHbGxaRVJsWVdSc2FXNWxMQW9nSUNBZ1lXeHNiM2RVY25WemRHVmtVM1JwWTJ0NVRHVmhaaUE5SUdaaGJITmxMQW9nSUNBZ2IyNVFjbTluY21WemN5d0tJQ0I5SUQwZ2UzMHNDaWtnZXdvZ0lHbG1JQ2doVG5WdFltVnlMbWx6VTJGbVpVbHVkR1ZuWlhJb2RHbHRaVzkxZEUxektTQjhmQ0IwYVcxbGIzVjBUWE1nUEQwZ01Da2dld29nSUNBZ2RHaHliM2NnYm1WM0lGUjVjR1ZGY25KdmNpZ2liRzlqYXlCMGFXMWxiM1YwVFhNZ2JYVnpkQ0JpWlNCaElIQnZjMmwwYVhabElITmhabVVnYVc1MFpXZGxjaUlwT3dvZ0lIMEtJQ0JwWmlBb2MzVndjR3hwWldSRVpXRmtiR2x1WlNBaFBUMGdkVzVrWldacGJtVmtJQ1ltSUNGT2RXMWlaWEl1YVhOR2FXNXBkR1VvYzNWd2NHeHBaV1JFWldGa2JHbHVaU2twSUhzS0lDQWdJSFJvY205M0lHNWxkeUJVZVhCbFJYSnliM0lvSW14dlkyc2daR1ZoWkd4cGJtVWdiWFZ6ZENCaVpTQm1hVzVwZEdVaUtUc0tJQ0I5Q2lBZ2FXWWdLSFI1Y0dWdlppQmhiR3h2ZDFSeWRYTjBaV1JUZEdsamEzbE1aV0ZtSUNFOVBTQWlZbTl2YkdWaGJpSXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QlVlWEJsUlhKeWIzSW9JbUZzYkc5M1ZISjFjM1JsWkZOMGFXTnJlVXhsWVdZZ2JYVnpkQ0JpWlNCaWIyOXNaV0Z1SWlrN0NpQWdmUW9nSUdsbUlDaHZibEJ5YjJkeVpYTnpJQ0U5UFNCMWJtUmxabWx1WldRZ0ppWWdkSGx3Wlc5bUlHOXVVSEp2WjNKbGMzTWdJVDA5SUNKbWRXNWpkR2x2YmlJcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCVWVYQmxSWEp5YjNJb0lteHZZMnNnYjI1UWNtOW5jbVZ6Y3lCdGRYTjBJR0psSUdFZ1puVnVZM1JwYjI0aUtUc0tJQ0I5Q2lBZ1kyOXVjM1FnWTI5dWRHVjRkQ0E5SUhzS0lDQWdJR1JsWVdSc2FXNWxPaUJOWVhSb0xtMXBiaWdLSUNBZ0lDQWdjM1Z3Y0d4cFpXUkVaV0ZrYkdsdVpTQS9QeUJPZFcxaVpYSXVVRTlUU1ZSSlZrVmZTVTVHU1U1SlZGa3NDaUFnSUNBZ0lIQmxjbVp2Y20xaGJtTmxMbTV2ZHlncElDc2dkR2x0Wlc5MWRFMXpMQW9nSUNBZ0tTd0tJQ0FnSUd4aFltVnNMQW9nSUNBZ2RHbHRaVzkxZEUxekxBb2dJQ0FnYjI1UWNtOW5jbVZ6Y3l3S0lDQjlPd29nSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0p3Y21sMllYUmxJR1JwY21WamRHOXllU0IyWVd4cFpHRjBhVzl1SUhOMFlYSjBaV1FpS1RzS0lDQmpiMjV6ZENCaFluTnZiSFYwWlNBOUlISmxjMjlzZG1Vb2NtVnhkV1Z6ZEdWa1VHRjBhQ2s3Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnWVdKemIyeDFkR1VwT3dvZ0lHTnZibk4wSUdOaGJtOXVhV05oYkNBOUlHRjNZV2wwSUhKbFlXeHdZWFJvS0dGaWMyOXNkWFJsS1RzS0lDQmpiMjV6ZENCaGJtTmxjM1J2Y25NZ1BTQmJYVHNLSUNCbWIzSWdLR3hsZENCamRYSnlaVzUwSUQwZ1kyRnViMjVwWTJGc095QTdJR04xY25KbGJuUWdQU0JrYVhKdVlXMWxLR04xY25KbGJuUXBLU0I3Q2lBZ0lDQmhibU5sYzNSdmNuTXVjSFZ6YUNoamRYSnlaVzUwS1RzS0lDQWdJR2xtSUNoa2FYSnVZVzFsS0dOMWNuSmxiblFwSUQwOVBTQmpkWEp5Wlc1MEtTQmljbVZoYXpzS0lDQjlDaUFnWTI5dWMzUWdZM1Z5Y21WdWRGVnBaQ0E5SUhCeWIyTmxjM011WjJWMGRXbGtQeTRvS1RzS0lDQmpiMjV6ZENCaVpXWnZjbVZKWkdWdWRHbDBhV1Z6SUQwZ2JtVjNJRTFoY0NncE93b2dJR1p2Y2lBb2JHVjBJR2x1WkdWNElEMGdNRHNnYVc1a1pYZ2dQQ0JoYm1ObGMzUnZjbk11YkdWdVozUm9PeUJwYm1SbGVDQXJQU0F4S1NCN0NpQWdJQ0JqYjI1emRDQndZWFJvSUQwZ1lXNWpaWE4wYjNKelcybHVaR1Y0WFRzS0lDQWdJR052Ym5OMElITjBZWFJ6SUQwZ1lYZGhhWFFnYkhOMFlYUW9jR0YwYUN3Z2V5QmlhV2RwYm5RNklIUnlkV1VnZlNrN0NpQWdJQ0JwWmlBb0lYTjBZWFJ6TG1selJHbHlaV04wYjNKNUtDa2dmSHdnYzNSaGRITXVhWE5UZVcxaWIyeHBZMHhwYm1zb0tTa2dld29nSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCd2NtOTBaV04wWldRZ2NHRjBhQ0JoYm1ObGMzUnZjaUJwY3lCdWIzUWdZU0J5WldGc0lHUnBjbVZqZEc5eWVUb2dKSHR3WVhSb2ZXQXBPd29nSUNBZ2ZRb2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ0ozYVc0ek1pSXBJSHNLSUNBZ0lDQWdZMjl1YzNRZ2JHVmhaaUE5SUdsdVpHVjRJRDA5UFNBd093b2dJQ0FnSUNCamIyNXpkQ0IwY25WemRHVmtUM2R1WlhJZ1BTQnpkR0YwY3k1MWFXUWdQVDA5SURCdUlIeDhDaUFnSUNBZ0lDQWdLR04xY25KbGJuUlZhV1FnSVQwOUlIVnVaR1ZtYVc1bFpDQW1KaUJ6ZEdGMGN5NTFhV1FnUFQwOUlFSnBaMGx1ZENoamRYSnlaVzUwVldsa0tTazdDaUFnSUNBZ0lHTnZibk4wSUhOMGFXTnJlVUp2ZFc1a1lYSjVJRDBnS0NGc1pXRm1JSHg4SUdGc2JHOTNWSEoxYzNSbFpGTjBhV05yZVV4bFlXWXBJQ1ltQ2lBZ0lDQWdJQ0FnS0hOMFlYUnpMbTF2WkdVZ0ppQXdiekV3TURCdUtTQWhQVDBnTUc0Z0ppWWdkSEoxYzNSbFpFOTNibVZ5T3dvZ0lDQWdJQ0JwWmlBb0lYUnlkWE4wWldSUGQyNWxjaUI4ZkNBb0tITjBZWFJ6TG0xdlpHVWdKaUF3YnpBeU1tNHBJQ0U5UFNBd2JpQW1KaUFoYzNScFkydDVRbTkxYm1SaGNua3BLU0I3Q2lBZ0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLQW9nSUNBZ0lDQWdJQ0FnWUdGblpXNWpPaUJ3Y205MFpXTjBaV1FnWkdseVpXTjBiM0o1SUdOb1lXbHVJSEJsY20xcGRITWdkVzUwY25WemRHVmtJRzExZEdGMGFXOXVPaUFrZTNCaGRHaDlPeUJnSUNzS0lDQWdJQ0FnSUNBZ0lDSnlaVzF2ZG1VZ1ozSnZkWEF2ZDI5eWJHUWdkM0pwZEdVZ1lXTmpaWE56SUdKbFptOXlaU0J5WlhSeWVXbHVaeUlzQ2lBZ0lDQWdJQ0FnS1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JwWmlBb0NpQWdJQ0FnSUNBZ2JHVmhaaUFtSmlBaGMzUnBZMnQ1UW05MWJtUmhjbmtnSmlZZ1kzVnljbVZ1ZEZWcFpDQWhQVDBnZFc1a1pXWnBibVZrSUNZbUNpQWdJQ0FnSUNBZ2MzUmhkSE11ZFdsa0lDRTlQU0JDYVdkSmJuUW9ZM1Z5Y21WdWRGVnBaQ2tLSUNBZ0lDQWdLU0I3Q2lBZ0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2djSEp2ZEdWamRHVmtJR1JwY21WamRHOXllU0JwY3lCdWIzUWdiM2R1WldRZ1lua2dkR2hsSUdOMWNuSmxiblFnZFhObGNqb2dKSHR3WVhSb2ZXQXBPd29nSUNBZ0lDQjlDaUFnSUNCOUNpQWdJQ0JpWldadmNtVkpaR1Z1ZEdsMGFXVnpMbk5sZENod1lYUm9MQ0I3SUdSbGRqb2djM1JoZEhNdVpHVjJMQ0JwYm04NklITjBZWFJ6TG1sdWJ5QjlLVHNLSUNBZ0lHbGtaVzUwYVhSNVJuSnZiVk4wWVhSektITjBZWFJ6TENCd1lYUm9LVHNLSUNCOUNpQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDSjNhVzR6TWlJcElIc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pYYVc1a2IzZHpJR0Z1WTJWemRHOXlJRUZEVENCMllXeHBaR0YwYVc5dUlITjBZWEowWldRaUtUc0tJQ0FnSUdGM1lXbDBJR0Z6YzJWeWRGZHBibVJ2ZDNOUVlYUm9VMlZqZFhKcGRIa29DaUFnSUNBZ0lHRnVZMlZ6ZEc5eWN5NXRZWEFvS0hCaGRHZ3NJR2x1WkdWNEtTQTlQaUFvZXdvZ0lDQWdJQ0FnSUhCaGRHZ3NDaUFnSUNBZ0lDQWdjbTlzWlRvZ2FXNWtaWGdnUFQwOUlEQWdQeUFpYkdWaFprUnBjbVZqZEc5eWVTSWdPaUFpWVc1alpYTjBiM0pFYVhKbFkzUnZjbmtpTEFvZ0lDQWdJQ0I5S1Nrc0NpQWdJQ0FnSUdOdmJuUmxlSFFzQ2lBZ0lDQXBPd29nSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSWxkcGJtUnZkM01nWVc1alpYTjBiM0lnUVVOTUlIWmhiR2xrWVhScGIyNGdZMjl0Y0d4bGRHVWlLVHNLSUNCOUlHVnNjMlVnZXdvZ0lDQWdZWGRoYVhRZ1lYTnpaWEowVEc5allXeEdhV3hsYzNsemRHVnRLR05oYm05dWFXTmhiQ3dnWTI5dWRHVjRkQ2s3Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ltUmhjbmRwYmlJcElIc0tJQ0FnSUNBZ1ptOXlJQ2hzWlhRZ2FXNWtaWGdnUFNBd095QnBibVJsZUNBOElHRnVZMlZ6ZEc5eWN5NXNaVzVuZEdnN0lHbHVaR1Y0SUNzOUlERXBJSHNLSUNBZ0lDQWdJQ0JoZDJGcGRDQmhjM05sY25SRVlYSjNhVzVRWVhSb1UyVmpkWEpwZEhrb0NpQWdJQ0FnSUNBZ0lDQmhibU5sYzNSdmNuTmJhVzVrWlhoZExBb2dJQ0FnSUNBZ0lDQWdhVzVrWlhnZ1BUMDlJREFnUHlBaWJHVmhaaUJrYVhKbFkzUnZjbmtpSURvZ0ltRnVZMlZ6ZEc5eUlHUnBjbVZqZEc5eWVTSXNDaUFnSUNBZ0lDQWdJQ0JqYjI1MFpYaDBMQW9nSUNBZ0lDQWdJQ2s3Q2lBZ0lDQWdJSDBLSUNBZ0lIMEtJQ0I5Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnWTJGdWIyNXBZMkZzS1RzS0lDQm1iM0lnS0dOdmJuTjBJSEJoZEdnZ2IyWWdZVzVqWlhOMGIzSnpLU0I3Q2lBZ0lDQmpiMjV6ZENCaFpuUmxjaUE5SUdGM1lXbDBJR3h6ZEdGMEtIQmhkR2dzSUhzZ1ltbG5hVzUwT2lCMGNuVmxJSDBwT3dvZ0lDQWdZMjl1YzNRZ1ltVm1iM0psSUQwZ1ltVm1iM0psU1dSbGJuUnBkR2xsY3k1blpYUW9jR0YwYUNrN0NpQWdJQ0JwWmlBb0NpQWdJQ0FnSUNGaFpuUmxjaTVwYzBScGNtVmpkRzl5ZVNncElIeDhJR0ZtZEdWeUxtbHpVM2x0WW05c2FXTk1hVzVyS0NrZ2ZId2dZbVZtYjNKbElEMDlQU0IxYm1SbFptbHVaV1FnZkh3S0lDQWdJQ0FnWVdaMFpYSXVaR1YySUNFOVBTQmlaV1p2Y21VdVpHVjJJSHg4SUdGbWRHVnlMbWx1YnlBaFBUMGdZbVZtYjNKbExtbHVid29nSUNBZ0tTQjdDaUFnSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUhCeWIzUmxZM1JsWkNCa2FYSmxZM1J2Y25rZ2FXUmxiblJwZEhrZ1kyaGhibWRsWkNCa2RYSnBibWNnZG1Gc2FXUmhkR2x2YmpvZ0pIdHdZWFJvZldBcE93b2dJQ0FnZlFvZ0lIMEtJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWljSEpwZG1GMFpTQmthWEpsWTNSdmNua2dkbUZzYVdSaGRHbHZiaUJqYjIxd2JHVjBaU0lwT3dvZ0lISmxkSFZ5YmlCallXNXZibWxqWVd3N0NuMEtDbVoxYm1OMGFXOXVJR0Z6YzJWeWRGSmxaM1ZzWVhKVGFXNW5iR1ZNYVc1cktITjBZWFJ6TENCd1lYUm9LU0I3Q2lBZ2FXWWdLQ0Z6ZEdGMGN5NXBjMFpwYkdVb0tTQjhmQ0J6ZEdGMGN5NXBjMU41YldKdmJHbGpUR2x1YXlncEtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJzYjJOcklHUmhkR0ZpWVhObElHbHpJRzV2ZENCaElISmxaM1ZzWVhJZ1ptbHNaVG9nSkh0d1lYUm9mV0FwT3dvZ0lIMEtJQ0JwWmlBb2MzUmhkSE11Ym14cGJtc2dJVDA5SURGdUtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJzYjJOcklHUmhkR0ZpWVhObElHMTFjM1FnYm05MElHaGhkbVVnYUdGeVpDMXNhVzVySUdGc2FXRnpaWE02SUNSN2NHRjBhSDFnS1RzS0lDQjlDbjBLQ21aMWJtTjBhVzl1SUdsa1pXNTBhWFI1Um5KdmJWTjBZWFJ6S0hOMFlYUnpMQ0J3WVhSb0tTQjdDaUFnYVdZZ0tBb2dJQ0FnYzNSaGRITXVaR1YySUQwOVBTQXdiaUI4ZkFvZ0lDQWdjM1JoZEhNdWFXNXZJRDA5UFNBd2JpQjhmQW9nSUNBZ2MzUmhkSE11YVc1dklEMDlQU0F0TVc0Z2ZId0tJQ0FnSUVKcFowbHVkQzVoYzFWcGJuUk9LRFkwTENCemRHRjBjeTVwYm04cElEMDlQU0JWVGxOVlVGQlBVbFJGUkY5R1NVeEZYMGxFWHpZMENpQWdLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCc2IyTnJJR1JoZEdGaVlYTmxJR2hoY3lCdWJ5QnpkR0ZpYkdVZ1ptbHNaWE41YzNSbGJTQnBaR1Z1ZEdsMGVUb2dKSHR3WVhSb2ZXQXBPd29nSUgwS0lDQnlaWFIxY200Z1lDUjdjM1JoZEhNdVpHVjJmVG9rZTNOMFlYUnpMbWx1YjMxZ093cDlDZ3BtZFc1amRHbHZiaUJoYzNObGNuUlFiM05wZUU5M2JtVnljMmhwY0NoemRHRjBjeXdnY0dGMGFDd2dhMmx1WkNrZ2V3b2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQWlkMmx1TXpJaUtTQnlaWFIxY200N0NpQWdZMjl1YzNRZ1kzVnljbVZ1ZEZWcFpDQTlJSEJ5YjJObGMzTXVaMlYwZFdsa1B5NG9LVHNLSUNCcFppQW9ZM1Z5Y21WdWRGVnBaQ0FoUFQwZ2RXNWtaV1pwYm1Wa0lDWW1JSE4wWVhSekxuVnBaQ0FoUFQwZ1FtbG5TVzUwS0dOMWNuSmxiblJWYVdRcEtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJzYjJOcklHUmhkR0ZpWVhObElDUjdhMmx1WkgwZ2FYTWdibTkwSUc5M2JtVmtJR0o1SUhSb1pTQmpkWEp5Wlc1MElIVnpaWEk2SUNSN2NHRjBhSDFnS1RzS0lDQjlDaUFnYVdZZ0tDaHpkR0YwY3k1dGIyUmxJQ1lnTUc4d01qSnVLU0FoUFQwZ01HNHBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUd4dlkyc2daR0YwWVdKaGMyVWdKSHRyYVc1a2ZTQnBjeUJuY205MWNDOTNiM0pzWkMxM2NtbDBZV0pzWlRvZ0pIdHdZWFJvZldBcE93b2dJSDBLZlFvS0x5b3FDaUFxSUZaaGJHbGtZWFJsSUdFZ2NtVm5kV3hoY2lCbWFXeGxJR0Z1WkNCcGRITWdZMjl0Y0d4bGRHVWdaR2x5WldOMGIzSjVJR05vWVdsdUlHSmxabTl5WlNCaElHTmhiR3hsY2dvZ0tpQjBjblZ6ZEhNZ2FYUnpJR052Ym5SbGJuUnpMaUJVYUdseklHbHpJR2x1ZEdWdWRHbHZibUZzYkhrZ2JtOXVMVzExZEdGMGFXNW5PaUIxYm5OaFptVWdiM2R1WlhKemFHbHdMQW9nS2lCdGIyUmxJR0pwZEhNc0lFRkRUSE1zSUdGc2FXRnpaWE1zSUc5eUlHbGtaVzUwYVhSNUlHTm9ZVzVuWlhNZ1ptRnBiQ0JqYkc5elpXUXVDaUFxTHdwbGVIQnZjblFnWVhONWJtTWdablZ1WTNScGIyNGdZWE56WlhKMFRHOWpZV3hRY21sMllYUmxSbWxzWlNnS0lDQnlaWEYxWlhOMFpXUlFZWFJvTEFvZ0lIc0tJQ0FnSUhScGJXVnZkWFJOY3lBOUlEWXdYekF3TUN3S0lDQWdJR3hoWW1Wc0lEMGdJa0ZuWlc1RElHOXdaWEpoZEdsdmJpSXNDaUFnSUNCa1pXRmtiR2x1WlRvZ2MzVndjR3hwWldSRVpXRmtiR2x1WlN3S0lDQWdJRzl1VUhKdlozSmxjM01zQ2lBZ2ZTQTlJSHQ5TEFvcElIc0tJQ0JwWmlBb0lVNTFiV0psY2k1cGMxTmhabVZKYm5SbFoyVnlLSFJwYldWdmRYUk5jeWtnZkh3Z2RHbHRaVzkxZEUxeklEdzlJREFwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJVZVhCbFJYSnliM0lvSW14dlkyc2dkR2x0Wlc5MWRFMXpJRzExYzNRZ1ltVWdZU0J3YjNOcGRHbDJaU0J6WVdabElHbHVkR1ZuWlhJaUtUc0tJQ0I5Q2lBZ2FXWWdLSE4xY0hCc2FXVmtSR1ZoWkd4cGJtVWdJVDA5SUhWdVpHVm1hVzVsWkNBbUppQWhUblZ0WW1WeUxtbHpSbWx1YVhSbEtITjFjSEJzYVdWa1JHVmhaR3hwYm1VcEtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1ZIbHdaVVZ5Y205eUtDSnNiMk5ySUdSbFlXUnNhVzVsSUcxMWMzUWdZbVVnWm1sdWFYUmxJaWs3Q2lBZ2ZRb2dJR2xtSUNodmJsQnliMmR5WlhOeklDRTlQU0IxYm1SbFptbHVaV1FnSmlZZ2RIbHdaVzltSUc5dVVISnZaM0psYzNNZ0lUMDlJQ0ptZFc1amRHbHZiaUlwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJVZVhCbFJYSnliM0lvSW14dlkyc2diMjVRY205bmNtVnpjeUJ0ZFhOMElHSmxJR0VnWm5WdVkzUnBiMjRpS1RzS0lDQjlDaUFnWTI5dWMzUWdZMjl1ZEdWNGRDQTlJSHNLSUNBZ0lHUmxZV1JzYVc1bE9pQk5ZWFJvTG0xcGJpZ0tJQ0FnSUNBZ2MzVndjR3hwWldSRVpXRmtiR2x1WlNBL1B5Qk9kVzFpWlhJdVVFOVRTVlJKVmtWZlNVNUdTVTVKVkZrc0NpQWdJQ0FnSUhCbGNtWnZjbTFoYm1ObExtNXZkeWdwSUNzZ2RHbHRaVzkxZEUxekxBb2dJQ0FnS1N3S0lDQWdJR3hoWW1Wc0xBb2dJQ0FnZEdsdFpXOTFkRTF6TEFvZ0lDQWdiMjVRY205bmNtVnpjeXdLSUNCOU93b2dJSEpsY0c5eWRGQnliMmR5WlhOektHTnZiblJsZUhRc0lDSndjbWwyWVhSbElHWnBiR1VnZG1Gc2FXUmhkR2x2YmlCemRHRnlkR1ZrSWlrN0NpQWdZMjl1YzNRZ1lXSnpiMngxZEdVZ1BTQnlaWE52YkhabEtISmxjWFZsYzNSbFpGQmhkR2dwT3dvZ0lHTnZibk4wSUhCaGNtVnVkQ0E5SUdScGNtNWhiV1VvWVdKemIyeDFkR1VwT3dvZ0lHTnZibk4wSUdOaGJtOXVhV05oYkZCaGNtVnVkQ0E5SUdGM1lXbDBJR0Z6YzJWeWRFeHZZMkZzVUhKcGRtRjBaVVJwY21WamRHOXllU2h3WVhKbGJuUXNJSHNLSUNBZ0lIUnBiV1Z2ZFhSTmN5d0tJQ0FnSUd4aFltVnNMQW9nSUNBZ1pHVmhaR3hwYm1VNklHTnZiblJsZUhRdVpHVmhaR3hwYm1Vc0NpQWdJQ0F1TGk0b2IyNVFjbTluY21WemN5QTlQVDBnZFc1a1pXWnBibVZrSUQ4Z2UzMGdPaUI3SUc5dVVISnZaM0psYzNNZ2ZTa3NDaUFnZlNrN0NpQWdhV1lnS0dOaGJtOXVhV05oYkZCaGNtVnVkQ0FoUFQwZ2NHRnlaVzUwS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQndjbTkwWldOMFpXUWdabWxzWlNCd1lYSmxiblFnYlhWemRDQjFjMlVnYVhSeklHTmhibTl1YVdOaGJDQndZWFJvT2lBa2UzQmhjbVZ1ZEgxZ0tUc0tJQ0I5Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnWVdKemIyeDFkR1VwT3dvZ0lHTnZibk4wSUdKbFptOXlaU0E5SUdGM1lXbDBJR3h6ZEdGMEtHRmljMjlzZFhSbExDQjdJR0pwWjJsdWREb2dkSEoxWlNCOUtUc0tJQ0JwWmlBb0lXSmxabTl5WlM1cGMwWnBiR1VvS1NCOGZDQmlaV1p2Y21VdWFYTlRlVzFpYjJ4cFkweHBibXNvS1NCOGZDQmlaV1p2Y21VdWJteHBibXNnSVQwOUlERnVLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCd2NtOTBaV04wWldRZ1ptbHNaU0J0ZFhOMElHSmxJR0VnY21WbmRXeGhjaUJ6YVc1bmJHVXRiR2x1YXlCbWFXeGxPaUFrZTJGaWMyOXNkWFJsZldBcE93b2dJSDBLSUNCcFpHVnVkR2wwZVVaeWIyMVRkR0YwY3loaVpXWnZjbVVzSUdGaWMyOXNkWFJsS1RzS0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0luZHBiak15SWlrZ2V3b2dJQ0FnWTI5dWMzUWdZM1Z5Y21WdWRGVnBaQ0E5SUhCeWIyTmxjM011WjJWMGRXbGtQeTRvS1RzS0lDQWdJR2xtSUNoamRYSnlaVzUwVldsa0lDRTlQU0IxYm1SbFptbHVaV1FnSmlZZ1ltVm1iM0psTG5WcFpDQWhQVDBnUW1sblNXNTBLR04xY25KbGJuUlZhV1FwS1NCN0NpQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJSEJ5YjNSbFkzUmxaQ0JtYVd4bElHbHpJRzV2ZENCdmQyNWxaQ0JpZVNCMGFHVWdZM1Z5Y21WdWRDQjFjMlZ5T2lBa2UyRmljMjlzZFhSbGZXQXBPd29nSUNBZ2ZRb2dJQ0FnYVdZZ0tDaGlaV1p2Y21VdWJXOWtaU0FtSURCdk1ESXliaWtnSVQwOUlEQnVLU0I3Q2lBZ0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklIQnliM1JsWTNSbFpDQm1hV3hsSUdseklHZHliM1Z3TDNkdmNteGtMWGR5YVhSaFlteGxPaUFrZTJGaWMyOXNkWFJsZldBcE93b2dJQ0FnZlFvZ0lIMEtJQ0JqYjI1emRDQmpZVzV2Ym1sallXd2dQU0JoZDJGcGRDQnlaV0ZzY0dGMGFDaGhZbk52YkhWMFpTazdDaUFnYVdZZ0tHTmhibTl1YVdOaGJDQWhQVDBnWVdKemIyeDFkR1VwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklIQnliM1JsWTNSbFpDQm1hV3hsSUcxMWMzUWdkWE5sSUdsMGN5QmpZVzV2Ym1sallXd2djR0YwYURvZ0pIdGhZbk52YkhWMFpYMWdLVHNLSUNCOUNpQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDSjNhVzR6TWlJcElIc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pYYVc1a2IzZHpJR1pwYkdVZ1FVTk1JSFpoYkdsa1lYUnBiMjRnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdZWGRoYVhRZ1lYTnpaWEowVjJsdVpHOTNjMUJoZEdoVFpXTjFjbWwwZVNoYmV5QndZWFJvT2lCallXNXZibWxqWVd3c0lISnZiR1U2SUNKbWFXeGxJaUI5WFN3Z1kyOXVkR1Y0ZENrN0NpQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlWMmx1Wkc5M2N5Qm1hV3hsSUVGRFRDQjJZV3hwWkdGMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ2ZTQmxiSE5sSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FpWkdGeWQybHVJaWtnZXdvZ0lDQWdZWGRoYVhRZ1lYTnpaWEowUkdGeWQybHVVR0YwYUZObFkzVnlhWFI1S0dOaGJtOXVhV05oYkN3Z0ltWnBiR1VpTENCamIyNTBaWGgwS1RzS0lDQjlDaUFnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2dZMkZ1YjI1cFkyRnNLVHNLSUNCamIyNXpkQ0JoWm5SbGNpQTlJR0YzWVdsMElHeHpkR0YwS0dOaGJtOXVhV05oYkN3Z2V5QmlhV2RwYm5RNklIUnlkV1VnZlNrN0NpQWdhV1lnS0FvZ0lDQWdJV0ZtZEdWeUxtbHpSbWxzWlNncElIeDhJR0ZtZEdWeUxtbHpVM2x0WW05c2FXTk1hVzVyS0NrZ2ZId2dZV1owWlhJdWJteHBibXNnSVQwOUlERnVJSHg4Q2lBZ0lDQmhablJsY2k1a1pYWWdJVDA5SUdKbFptOXlaUzVrWlhZZ2ZId2dZV1owWlhJdWFXNXZJQ0U5UFNCaVpXWnZjbVV1YVc1dkNpQWdLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCd2NtOTBaV04wWldRZ1ptbHNaU0JwWkdWdWRHbDBlU0JqYUdGdVoyVmtJR1IxY21sdVp5QjJZV3hwWkdGMGFXOXVPaUFrZTJOaGJtOXVhV05oYkgxZ0tUc0tJQ0I5Q2lBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSW5CeWFYWmhkR1VnWm1sc1pTQjJZV3hwWkdGMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ2NtVjBkWEp1SUdOaGJtOXVhV05oYkRzS2ZRb0tZWE41Ym1NZ1puVnVZM1JwYjI0Z2NISmxjR0Z5WlV4dlkydFFZWFJvS0hKbGNYVmxjM1JsWkZCaGRHZ3NJR052Ym5SbGVIUXBJSHNLSUNCamIyNXpkQ0JoWW5OdmJIVjBaU0E5SUhKbGMyOXNkbVVvY21WeGRXVnpkR1ZrVUdGMGFDazdDaUFnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbXh2WTJzZ2NHRjBhQ0J3Y21Wd1lYSmhkR2x2YmlCemRHRnlkR1ZrSWlrN0NpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1lXSnpiMngxZEdVcE93b2dJR0YzWVdsMElHMXJaR2x5S0dScGNtNWhiV1VvWVdKemIyeDFkR1VwTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z2JXOWtaVG9nTUc4M01EQWdmU2s3Q2lBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSW14dlkyc2djR0Z5Wlc1MElHTnlaV0YwYVc5dUlHTnZiWEJzWlhSbElpazdDaUFnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2dZV0p6YjJ4MWRHVXBPd29nSUdOdmJuTjBJSEJoY21WdWRDQTlJR0YzWVdsMElISmxZV3h3WVhSb0tHUnBjbTVoYldVb1lXSnpiMngxZEdVcEtUc0tJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWliRzlqYXlCd1lYSmxiblFnWTJGdWIyNXBZMkZzYVhwaGRHbHZiaUJqYjIxd2JHVjBaU0lwT3dvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUdGaWMyOXNkWFJsS1RzS0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaWJHOWpheUJ3WVhKbGJuUWdjMlZqZFhKcGRIa2dkbUZzYVdSaGRHbHZiaUJ6ZEdGeWRHVmtJaWs3Q2lBZ1kyOXVjM1FnZG1Gc2FXUmhkR1ZrVUdGeVpXNTBJRDBnWVhkaGFYUWdZWE56WlhKMFRHOWpZV3hRY21sMllYUmxSR2x5WldOMGIzSjVLSEJoY21WdWRDd2dld29nSUNBZ2RHbHRaVzkxZEUxek9pQmpiMjUwWlhoMExuUnBiV1Z2ZFhSTmN5d0tJQ0FnSUd4aFltVnNPaUJqYjI1MFpYaDBMbXhoWW1Wc0xBb2dJQ0FnWkdWaFpHeHBibVU2SUdOdmJuUmxlSFF1WkdWaFpHeHBibVVzQ2lBZ0lDQXVMaTRvWTI5dWRHVjRkQzV2YmxCeWIyZHlaWE56SUQwOVBTQjFibVJsWm1sdVpXUUtJQ0FnSUNBZ1B5QjdmUW9nSUNBZ0lDQTZJSHNnYjI1UWNtOW5jbVZ6Y3pvZ1kyOXVkR1Y0ZEM1dmJsQnliMmR5WlhOeklIMHBMQW9nSUgwcE93b2dJSEpsY0c5eWRGQnliMmR5WlhOektHTnZiblJsZUhRc0lDSnNiMk5ySUhCaGNtVnVkQ0J6WldOMWNtbDBlU0IyWVd4cFpHRjBhVzl1SUdOdmJYQnNaWFJsSWlrN0NpQWdhV1lnS0haaGJHbGtZWFJsWkZCaGNtVnVkQ0FoUFQwZ2NHRnlaVzUwS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQnNiMk5ySUdSaGRHRmlZWE5sSUhCaGNtVnVkQ0J0ZFhOMElIVnpaU0JwZEhNZ1kyRnViMjVwWTJGc0lIQmhkR2c2SUNSN2NHRnlaVzUwZldBcE93b2dJSDBLSUNCamIyNXpkQ0J3WVhKbGJuUlRkR0YwY3lBOUlHRjNZV2wwSUd4emRHRjBLSEJoY21WdWRDd2dleUJpYVdkcGJuUTZJSFJ5ZFdVZ2ZTazdDaUFnYVdZZ0tDRndZWEpsYm5SVGRHRjBjeTVwYzBScGNtVmpkRzl5ZVNncElIeDhJSEJoY21WdWRGTjBZWFJ6TG1selUzbHRZbTlzYVdOTWFXNXJLQ2twSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklHeHZZMnNnWkdGMFlXSmhjMlVnY0dGeVpXNTBJR2x6SUc1dmRDQmhJSEpsWVd3Z1pHbHlaV04wYjNKNU9pQWtlM0JoY21WdWRIMWdLVHNLSUNCOUNpQWdZWE56WlhKMFVHOXphWGhQZDI1bGNuTm9hWEFvY0dGeVpXNTBVM1JoZEhNc0lIQmhjbVZ1ZEN3Z0luQmhjbVZ1ZENJcE93b0tJQ0JqYjI1emRDQndZWFJvSUQwZ2FtOXBiaWh3WVhKbGJuUXNJR0poYzJWdVlXMWxLR0ZpYzI5c2RYUmxLU2s3Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnY0dGMGFDazdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJR2hoYm1Sc1pTQTlJR0YzWVdsMElHOXdaVzRvY0dGMGFDd2dJbmQ0SWl3Z01HODJNREFwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWVhkaGFYUWdhR0Z1Wkd4bExtTnNiM05sS0NrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsY25KdmNpa2dld29nSUNBZ0lDQmhkMkZwZENCb1lXNWtiR1V1WTJ4dmMyVW9LUzVqWVhSamFDZ29LU0E5UGlCN2ZTazdDaUFnSUNBZ0lIUm9jbTkzSUdWeWNtOXlPd29nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dLR1Z5Y205eUtTQjdDaUFnSUNCcFppQW9aWEp5YjNJL0xtTnZaR1VnSVQwOUlDSkZSVmhKVTFRaUtTQjBhSEp2ZHlCbGNuSnZjanNLSUNCOUNpQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lteHZZMnNnWkdGMFlXSmhjMlVnWm1sc1pTQmpjbVZoZEdsdmJpQmpiMjF3YkdWMFpTSXBPd29nSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJSEJoZEdncE93b2dJR052Ym5OMElIQmhkR2hUZEdGMGN5QTlJR0YzWVdsMElHeHpkR0YwS0hCaGRHZ3NJSHNnWW1sbmFXNTBPaUIwY25WbElIMHBPd29nSUdGemMyVnlkRkpsWjNWc1lYSlRhVzVuYkdWTWFXNXJLSEJoZEdoVGRHRjBjeXdnY0dGMGFDazdDaUFnWVhOelpYSjBVRzl6YVhoUGQyNWxjbk5vYVhBb2NHRjBhRk4wWVhSekxDQndZWFJvTENBaVptbHNaU0lwT3dvZ0lHTnZibk4wSUdOaGJtOXVhV05oYkNBOUlHRjNZV2wwSUhKbFlXeHdZWFJvS0hCaGRHZ3BPd29nSUdOdmJuTjBJSE4wWVhSeklEMGdZWGRoYVhRZ2JITjBZWFFvWTJGdWIyNXBZMkZzTENCN0lHSnBaMmx1ZERvZ2RISjFaU0I5S1RzS0lDQmhjM05sY25SU1pXZDFiR0Z5VTJsdVoyeGxUR2x1YXloemRHRjBjeXdnWTJGdWIyNXBZMkZzS1RzS0lDQmhjM05sY25SUWIzTnBlRTkzYm1WeWMyaHBjQ2h6ZEdGMGN5d2dZMkZ1YjI1cFkyRnNMQ0FpWm1sc1pTSXBPd29nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElDRTlQU0FpZDJsdU16SWlLU0I3Q2lBZ0lDQmhkMkZwZENCamFHMXZaQ2hqWVc1dmJtbGpZV3dzSURCdk5qQXdLVHNLSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBaVpHRnlkMmx1SWlrZ2V3b2dJQ0FnSUNCaGQyRnBkQ0JoYzNObGNuUkVZWEozYVc1UVlYUm9VMlZqZFhKcGRIa29ZMkZ1YjI1cFkyRnNMQ0FpYkc5amF5QmtZWFJoWW1GelpTQm1hV3hsSWl3Z1kyOXVkR1Y0ZENrN0NpQWdJQ0I5Q2lBZ2ZTQmxiSE5sSUhzS0lDQWdJSEpsY0c5eWRGQnliMmR5WlhOektHTnZiblJsZUhRc0lDSnNiMk5ySUdSaGRHRmlZWE5sSUVGRFRDQjJZV3hwWkdGMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNBZ0lHRjNZV2wwSUdGemMyVnlkRmRwYm1SdmQzTlFZWFJvVTJWamRYSnBkSGtvV3dvZ0lDQWdJQ0I3SUhCaGRHZzZJSEJoY21WdWRDd2djbTlzWlRvZ0lteGxZV1pFYVhKbFkzUnZjbmtpSUgwc0NpQWdJQ0FnSUhzZ2NHRjBhRG9nWTJGdWIyNXBZMkZzTENCeWIyeGxPaUFpWm1sc1pTSWdmU3dLSUNBZ0lGMHNJR052Ym5SbGVIUXBPd29nSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSW14dlkyc2daR0YwWVdKaGMyVWdRVU5NSUhaaGJHbGtZWFJwYjI0Z1kyOXRjR3hsZEdVaUtUc0tJQ0I5Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnWTJGdWIyNXBZMkZzS1RzS0lDQmpiMjV6ZENCelpXTjFjbVZrVTNSaGRITWdQU0JoZDJGcGRDQnNjM1JoZENoallXNXZibWxqWVd3c0lIc2dZbWxuYVc1ME9pQjBjblZsSUgwcE93b2dJR0Z6YzJWeWRGSmxaM1ZzWVhKVGFXNW5iR1ZNYVc1cktITmxZM1Z5WldSVGRHRjBjeXdnWTJGdWIyNXBZMkZzS1RzS0lDQmhjM05sY25SUWIzTnBlRTkzYm1WeWMyaHBjQ2h6WldOMWNtVmtVM1JoZEhNc0lHTmhibTl1YVdOaGJDd2dJbVpwYkdVaUtUc0tJQ0J5WlhSMWNtNGdld29nSUNBZ2NHRjBhRG9nWTJGdWIyNXBZMkZzTEFvZ0lDQWdjR0Z5Wlc1MExBb2dJQ0FnWkdWMk9pQnpaV04xY21Wa1UzUmhkSE11WkdWMkxBb2dJQ0FnYVc1dk9pQnpaV04xY21Wa1UzUmhkSE11YVc1dkxBb2dJQ0FnYVdSbGJuUnBkSGxMWlhrNklHbGtaVzUwYVhSNVJuSnZiVk4wWVhSektITmxZM1Z5WldSVGRHRjBjeXdnWTJGdWIyNXBZMkZzS1N3S0lDQjlPd3A5Q2dwaGMzbHVZeUJtZFc1amRHbHZiaUJ5WlhaaGJHbGtZWFJsVUhKbGNHRnlaV1JNYjJOcktBb2dJSEJ5WlhCaGNtVmtMQW9nSUdOdmJuUmxlSFFzQ2lBZ2V5QjJZV3hwWkdGMFpWZHBibVJ2ZDNOQlkyd2dQU0JtWVd4elpTQjlJRDBnZTMwc0Npa2dld29nSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJSEJ5WlhCaGNtVmtMbkJoZEdncE93b2dJR052Ym5OMElIQmhjbVZ1ZEZOMFlYUnpJRDBnWVhkaGFYUWdiSE4wWVhRb2NISmxjR0Z5WldRdWNHRnlaVzUwTENCN0lHSnBaMmx1ZERvZ2RISjFaU0I5S1RzS0lDQnBaaUFvSVhCaGNtVnVkRk4wWVhSekxtbHpSR2x5WldOMGIzSjVLQ2tnZkh3Z2NHRnlaVzUwVTNSaGRITXVhWE5UZVcxaWIyeHBZMHhwYm1zb0tTa2dld29nSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nYkc5amF5QmtZWFJoWW1GelpTQndZWEpsYm5RZ2FYTWdibThnYkc5dVoyVnlJR0VnY21WaGJDQmthWEpsWTNSdmNuazZJQ1I3Y0hKbGNHRnlaV1F1Y0dGeVpXNTBmV0FwT3dvZ0lIMEtJQ0JoYzNObGNuUlFiM05wZUU5M2JtVnljMmhwY0Nod1lYSmxiblJUZEdGMGN5d2djSEpsY0dGeVpXUXVjR0Z5Wlc1MExDQWljR0Z5Wlc1MElpazdDaUFnWTI5dWMzUWdjM1JoZEhNZ1BTQmhkMkZwZENCc2MzUmhkQ2h3Y21Wd1lYSmxaQzV3WVhSb0xDQjdJR0pwWjJsdWREb2dkSEoxWlNCOUtUc0tJQ0JoYzNObGNuUlNaV2QxYkdGeVUybHVaMnhsVEdsdWF5aHpkR0YwY3l3Z2NISmxjR0Z5WldRdWNHRjBhQ2s3Q2lBZ1lYTnpaWEowVUc5emFYaFBkMjVsY25Ob2FYQW9jM1JoZEhNc0lIQnlaWEJoY21Wa0xuQmhkR2dzSUNKbWFXeGxJaWs3Q2lBZ2FXWWdLSE4wWVhSekxtUmxkaUFoUFQwZ2NISmxjR0Z5WldRdVpHVjJJSHg4SUhOMFlYUnpMbWx1YnlBaFBUMGdjSEpsY0dGeVpXUXVhVzV2S1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQnNiMk5ySUdSaGRHRmlZWE5sSUdsa1pXNTBhWFI1SUdOb1lXNW5aV1FnWkhWeWFXNW5JR0ZqY1hWcGMybDBhVzl1T2lBa2UzQnlaWEJoY21Wa0xuQmhkR2g5WUNrN0NpQWdmUW9nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FpZDJsdU16SWlJQ1ltSUhaaGJHbGtZWFJsVjJsdVpHOTNjMEZqYkNrZ2V3b2dJQ0FnWVhkaGFYUWdZWE56WlhKMFYybHVaRzkzYzFCaGRHaFRaV04xY21sMGVTaGJDaUFnSUNBZ0lIc2djR0YwYURvZ2NISmxjR0Z5WldRdWNHRnlaVzUwTENCeWIyeGxPaUFpYkdWaFprUnBjbVZqZEc5eWVTSWdmU3dLSUNBZ0lDQWdleUJ3WVhSb09pQndjbVZ3WVhKbFpDNXdZWFJvTENCeWIyeGxPaUFpWm1sc1pTSWdmU3dLSUNBZ0lGMHNJR052Ym5SbGVIUXBPd29nSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdJbVJoY25kcGJpSXBJSHNLSUNBZ0lHRjNZV2wwSUdGemMyVnlkRVJoY25kcGJsQmhkR2hUWldOMWNtbDBlU2h3Y21Wd1lYSmxaQzV3WVhSb0xDQWliRzlqYXlCa1lYUmhZbUZ6WlNCbWFXeGxJaXdnWTI5dWRHVjRkQ2s3Q2lBZ2ZRb2dJSFJvY205M1NXWkZlSEJwY21Wa0tHTnZiblJsZUhRc0lIQnlaWEJoY21Wa0xuQmhkR2dwT3dwOUNncG1kVzVqZEdsdmJpQndjbUZuYldGV1lXeDFaU2hrWVhSaFltRnpaU3dnY0hKaFoyMWhLU0I3Q2lBZ1kyOXVjM1FnY205M0lEMGdaR0YwWVdKaGMyVXVjSEpsY0dGeVpTaGdVRkpCUjAxQklDUjdjSEpoWjIxaGZXQXBMbWRsZENncE93b2dJSEpsZEhWeWJpQnliM2NnUFQwOUlIVnVaR1ZtYVc1bFpDQS9JSFZ1WkdWbWFXNWxaQ0E2SUU5aWFtVmpkQzUyWVd4MVpYTW9jbTkzS1Zzd1hUc0tmUW9LWm5WdVkzUnBiMjRnY0hKaFoyMWhUblZ0WW1WeUtHUmhkR0ZpWVhObExDQndjbUZuYldFcElIc0tJQ0JqYjI1emRDQjJZV3gxWlNBOUlIQnlZV2R0WVZaaGJIVmxLR1JoZEdGaVlYTmxMQ0J3Y21GbmJXRXBPd29nSUhKbGRIVnliaUIwZVhCbGIyWWdkbUZzZFdVZ1BUMDlJQ0p1ZFcxaVpYSWlJRDhnZG1Gc2RXVWdPaUIxYm1SbFptbHVaV1E3Q24wS0NtWjFibU4wYVc5dUlIQnlZV2R0WVZSbGVIUW9aR0YwWVdKaGMyVXNJSEJ5WVdkdFlTa2dld29nSUdOdmJuTjBJSFpoYkhWbElEMGdjSEpoWjIxaFZtRnNkV1VvWkdGMFlXSmhjMlVzSUhCeVlXZHRZU2s3Q2lBZ2NtVjBkWEp1SUhSNWNHVnZaaUIyWVd4MVpTQTlQVDBnSW5OMGNtbHVaeUlnUHlCMllXeDFaUzUwYjB4dmQyVnlRMkZ6WlNncElEb2dkVzVrWldacGJtVmtPd3A5Q2dwbGVIQnZjblFnWm5WdVkzUnBiMjRnWTI5dVptbG5kWEpsVEc5allXeFRjV3hwZEdWTWIyTnJRMjl1Ym1WamRHbHZiaWhrWVhSaFltRnpaU2tnZXdvZ0lHUmhkR0ZpWVhObExtVjRaV01vSWxCU1FVZE5RU0JpZFhONVgzUnBiV1Z2ZFhRZ1BTQXdJaWs3Q2lBZ1pHRjBZV0poYzJVdVpYaGxZeWdpVUZKQlIwMUJJSFJ5ZFhOMFpXUmZjMk5vWlcxaElEMGdUMFpHSWlrN0NpQWdaR0YwWVdKaGMyVXVaWGhsWXlnaVVGSkJSMDFCSUhONWJtTm9jbTl1YjNWeklEMGdSVmhVVWtFaUtUc0tJQ0JrWVhSaFltRnpaUzVsYm1GaWJHVkVaV1psYm5OcGRtVW9kSEoxWlNrN0NpQWdaR0YwWVdKaGMyVXVaVzVoWW14bFRHOWhaRVY0ZEdWdWMybHZiaWhtWVd4elpTazdDaUFnYVdZZ0tBb2dJQ0FnY0hKaFoyMWhUblZ0WW1WeUtHUmhkR0ZpWVhObExDQWlZblZ6ZVY5MGFXMWxiM1YwSWlrZ0lUMDlJREFnZkh3S0lDQWdJSEJ5WVdkdFlVNTFiV0psY2loa1lYUmhZbUZ6WlN3Z0luUnlkWE4wWldSZmMyTm9aVzFoSWlrZ0lUMDlJREFnZkh3S0lDQWdJSEJ5WVdkdFlVNTFiV0psY2loa1lYUmhZbUZ6WlN3Z0luTjVibU5vY205dWIzVnpJaWtnSVQwOUlETUtJQ0FwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpZ2lZV2RsYm1NNklGTlJUR2wwWlNCc2IyTnJJR052Ym01bFkzUnBiMjRnYUdGeVpHVnVhVzVuSUdScFpDQnViM1FnZEdGclpTQmxabVpsWTNRaUtUc0tJQ0I5Q24wS0NtWjFibU4wYVc5dUlHbHVjM0JsWTNSTWIyTnJSR0YwWVdKaGMyVW9aR0YwWVdKaGMyVXNJSEJoZEdncElIc0tJQ0JqYjI1emRDQmhjSEJzYVdOaGRHbHZia2xrSUQwZ2NISmhaMjFoVG5WdFltVnlLR1JoZEdGaVlYTmxMQ0FpWVhCd2JHbGpZWFJwYjI1ZmFXUWlLVHNLSUNCcFppQW9ZWEJ3YkdsallYUnBiMjVKWkNBOVBUMGdNQ2tnZXdvZ0lDQWdZMjl1YzNRZ2NtOTNJRDBnWkdGMFlXSmhjMlV1Y0hKbGNHRnlaU2dLSUNBZ0lDQWdJbE5GVEVWRFZDQmpiM1Z1ZENncUtTQkJVeUJqYjNWdWRDQkdVazlOSUhOeGJHbDBaVjl6WTJobGJXRWdWMGhGVWtVZ2JtRnRaU0JPVDFRZ1RFbExSU0FuYzNGc2FYUmxYeVVuSWl3S0lDQWdJQ2t1WjJWMEtDazdDaUFnSUNCcFppQW9jbTkzUHk1amIzVnVkQ0FoUFQwZ01Da2dld29nSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb0NpQWdJQ0FnSUNBZ1lHRm5aVzVqT2lCeVpXWjFjMmx1WnlCMGJ5QnlaWFZ6WlNCaGJpQjFibkpsYkdGMFpXUWdVMUZNYVhSbElHUmhkR0ZpWVhObElHRnpJR0VnYkc5amF6b2dKSHR3WVhSb2ZXQXNDaUFnSUNBZ0lDazdDaUFnSUNCOUNpQWdJQ0J5WlhSMWNtNGdJbVZ0Y0hSNUlqc0tJQ0I5Q2lBZ2FXWWdLR0Z3Y0d4cFkyRjBhVzl1U1dRZ0lUMDlJRXhQUTB0ZlFWQlFURWxEUVZSSlQwNWZTVVFwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklHeHZZMnNnWkdGMFlXSmhjMlVnYUdGeklHRnVJR2x1WTI5dGNHRjBhV0pzWlNCaGNIQnNhV05oZEdsdmJpQnBaRG9nSkh0d1lYUm9mV0FwT3dvZ0lIMEtJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdjMk5vWlcxaElEMGdaR0YwWVdKaGMyVXVjSEpsY0dGeVpTZ0tJQ0FnSUNBZ0lsTkZURVZEVkNCMGVYQmxMQ0J6Y1d3Z1JsSlBUU0J6Y1d4cGRHVmZjMk5vWlcxaElGZElSVkpGSUc1aGJXVWdQU0FuWVdkbGJtTmZiRzlqWVd4ZmNISnZZMlZ6YzE5c2IyTnJKeUlzQ2lBZ0lDQXBMbWRsZENncE93b2dJQ0FnWTI5dWMzUWdiMkpxWldOMGN5QTlJR1JoZEdGaVlYTmxMbkJ5WlhCaGNtVW9DaUFnSUNBZ0lDSlRSVXhGUTFRZ1kyOTFiblFvS2lrZ1FWTWdZMjkxYm5RZ1JsSlBUU0J6Y1d4cGRHVmZjMk5vWlcxaElGZElSVkpGSUc1aGJXVWdUazlVSUV4SlMwVWdKM054YkdsMFpWOGxKeUlzQ2lBZ0lDQXBMbWRsZENncE93b2dJQ0FnWTI5dWMzUWdjbTkzY3lBOUlHUmhkR0ZpWVhObExuQnlaWEJoY21Vb0NpQWdJQ0FnSUNKVFJVeEZRMVFnYzJsdVoyeGxkRzl1TENCbWIzSnRZWFJmZG1WeWMybHZiaUJHVWs5TklHRm5aVzVqWDJ4dlkyRnNYM0J5YjJObGMzTmZiRzlqYXlJc0NpQWdJQ0FwTG1Gc2JDZ3BPd29nSUNBZ1kyOXVjM1FnYm05eWJXRnNhWHBsWkZOamFHVnRZU0E5SUhSNWNHVnZaaUJ6WTJobGJXRS9Mbk54YkNBOVBUMGdJbk4wY21sdVp5SUtJQ0FnSUNBZ1B5QnpZMmhsYldFdWMzRnNMbkpsY0d4aFkyVW9MMXh6S3k5bkxDQWlJQ0lwTG5SeWFXMG9LUW9nSUNBZ0lDQTZJSFZ1WkdWbWFXNWxaRHNLSUNBZ0lHbG1JQ2dLSUNBZ0lDQWdjMk5vWlcxaFB5NTBlWEJsSUNFOVBTQWlkR0ZpYkdVaUlIeDhDaUFnSUNBZ0lHNXZjbTFoYkdsNlpXUlRZMmhsYldFZ0lUMDlDaUFnSUNBZ0lDQWdJa05TUlVGVVJTQlVRVUpNUlNCaFoyVnVZMTlzYjJOaGJGOXdjbTlqWlhOelgyeHZZMnNnS0NCemFXNW5iR1YwYjI0Z1NVNVVSVWRGVWlCUVVrbE5RVkpaSUV0RldTQkRTRVZEU3lBb2MybHVaMnhsZEc5dUlEMGdNU2tzSUdadmNtMWhkRjkyWlhKemFXOXVJRWxPVkVWSFJWSWdUazlVSUU1VlRFd2dLU0JUVkZKSlExUWlJSHg4Q2lBZ0lDQWdJRzlpYW1WamRITS9MbU52ZFc1MElDRTlQU0F4SUh4OENpQWdJQ0FnSUhKdmQzTXViR1Z1WjNSb0lDRTlQU0F4SUh4OENpQWdJQ0FnSUhKdmQzTmJNRjAvTG5OcGJtZHNaWFJ2YmlBaFBUMGdNU0I4ZkFvZ0lDQWdJQ0J5YjNkeld6QmRQeTVtYjNKdFlYUmZkbVZ5YzJsdmJpQWhQVDBnVEU5RFMxOUdUMUpOUVZSZlZrVlNVMGxQVGdvZ0lDQWdLU0I3Q2lBZ0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpZ2lhVzUyWVd4cFpDQnpaVzUwYVc1bGJDQnpZMmhsYldFaUtUc0tJQ0FnSUgwS0lDQjlJR05oZEdOb0lDaGxjbkp2Y2lrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2diRzlqYXlCa1lYUmhZbUZ6WlNCb1lYTWdZVzRnYVc1amIyMXdZWFJwWW14bElHWnZjbTFoZERvZ0pIdHdZWFJvZldBc0lIc0tJQ0FnSUNBZ1kyRjFjMlU2SUdWeWNtOXlMQW9nSUNBZ2ZTazdDaUFnZlFvZ0lISmxkSFZ5YmlBaWRtRnNhV1FpT3dwOUNncG1kVzVqZEdsdmJpQmlkWE41VkhKaGJuTnBkR2x2YmtWeWNtOXlLSEJoZEdnc0lHMXZaR1VwSUhzS0lDQnlaWFIxY200Z1QySnFaV04wTG1GemMybG5iaWdLSUNBZ0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklGTlJUR2wwWlNCc2IyTnJJR3B2ZFhKdVlXd2diVzlrWlNCeVpXMWhhVzVsWkNBa2UyMXZaR1VnUHo4Z0luVnVhMjV2ZDI0aWZUb2dKSHR3WVhSb2ZXQXBMQW9nSUNBZ2V5QmxjbkpqYjJSbE9pQlRVVXhKVkVWZlFsVlRXU0I5TEFvZ0lDazdDbjBLQ21aMWJtTjBhVzl1SUdKbFoybHVRVzVrVm1Gc2FXUmhkR1ZNYjJOcktHUmhkR0ZpWVhObExDQndZWFJvTENCamIyNTBaWGgwS1NCN0NpQWdabTl5SUNoc1pYUWdjR2hoYzJVZ1BTQXdPeUJ3YUdGelpTQThJRGc3SUhCb1lYTmxJQ3M5SURFcElIc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdkSEpoYm5OaFkzUnBiMjRnWW1WbmFXNGdjM1JoY25SbFpDSXBPd29nSUNBZ1pHRjBZV0poYzJVdVpYaGxZeWdpUWtWSFNVNGdTVTFOUlVSSlFWUkZJaWs3Q2lBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUhSeVlXNXpZV04wYVc5dUlHSmxaMmx1SUdOdmJYQnNaWFJsSWlrN0NpQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElHeHZZMnNnWkdGMFlXSmhjMlVnYVc1emNHVmpkR2x2YmlCemRHRnlkR1ZrSWlrN0NpQWdJQ0JqYjI1emRDQnpkR0YwWlNBOUlHbHVjM0JsWTNSTWIyTnJSR0YwWVdKaGMyVW9aR0YwWVdKaGMyVXNJSEJoZEdncE93b2dJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQnNiMk5ySUdSaGRHRmlZWE5sSUdsdWMzQmxZM1JwYjI0Z1kyOXRjR3hsZEdVaUtUc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdhbTkxY201aGJDQnRiMlJsSUdsdWMzQmxZM1JwYjI0Z2MzUmhjblJsWkNJcE93b2dJQ0FnWTI5dWMzUWdhbTkxY201aGJFMXZaR1VnUFNCd2NtRm5iV0ZVWlhoMEtHUmhkR0ZpWVhObExDQWlhbTkxY201aGJGOXRiMlJsSWlrN0NpQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElHcHZkWEp1WVd3Z2JXOWtaU0JwYm5Od1pXTjBhVzl1SUdOdmJYQnNaWFJsSWlrN0NpQWdJQ0JwWmlBb2FtOTFjbTVoYkUxdlpHVWdJVDA5SUNKa1pXeGxkR1VpS1NCN0NpQWdJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdhbTkxY201aGJDQnRiMlJsSUhKbGMyVjBJSE4wWVhKMFpXUWlLVHNLSUNBZ0lDQWdaR0YwWVdKaGMyVXVaWGhsWXlnaVVrOU1URUpCUTBzaUtUc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWc1pXTjBaV1FnUFNCd2NtRm5iV0ZVWlhoMEtHUmhkR0ZpWVhObExDQWlhbTkxY201aGJGOXRiMlJsUFVSRlRFVlVSU0lwT3dvZ0lDQWdJQ0JwWmlBb2MyVnNaV04wWldRZ0lUMDlJQ0prWld4bGRHVWlLU0IwYUhKdmR5QmlkWE41VkhKaGJuTnBkR2x2YmtWeWNtOXlLSEJoZEdnc0lITmxiR1ZqZEdWa0tUc0tJQ0FnSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSWxOUlRHbDBaU0JxYjNWeWJtRnNJRzF2WkdVZ2NtVnpaWFFnWTI5dGNHeGxkR1VpS1RzS0lDQWdJQ0FnWTI5dWRHbHVkV1U3Q2lBZ0lDQjlDaUFnSUNCcFppQW9jM1JoZEdVZ1BUMDlJQ0psYlhCMGVTSXBJSHNLSUNBZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCc2IyTnJJR1JoZEdGaVlYTmxJR2x1YVhScFlXeHBlbUYwYVc5dUlITjBZWEowWldRaUtUc0tJQ0FnSUNBZ1pHRjBZV0poYzJVdVpYaGxZeWhnQ2lBZ0lDQWdJQ0FnVUZKQlIwMUJJR0Z3Y0d4cFkyRjBhVzl1WDJsa0lEMGdKSHRNVDBOTFgwRlFVRXhKUTBGVVNVOU9YMGxFZlRzS0lDQWdJQ0FnSUNCRFVrVkJWRVVnVkVGQ1RFVWdZV2RsYm1OZmJHOWpZV3hmY0hKdlkyVnpjMTlzYjJOcklDZ0tJQ0FnSUNBZ0lDQWdJSE5wYm1kc1pYUnZiaUJKVGxSRlIwVlNJRkJTU1UxQlVsa2dTMFZaSUVOSVJVTkxJQ2h6YVc1bmJHVjBiMjRnUFNBeEtTd0tJQ0FnSUNBZ0lDQWdJR1p2Y20xaGRGOTJaWEp6YVc5dUlFbE9WRVZIUlZJZ1RrOVVJRTVWVEV3S0lDQWdJQ0FnSUNBcElGTlVVa2xEVkRzS0lDQWdJQ0FnSUNCSlRsTkZVbFFnU1U1VVR5QmhaMlZ1WTE5c2IyTmhiRjl3Y205alpYTnpYMnh2WTJzZ0tITnBibWRzWlhSdmJpd2dabTl5YldGMFgzWmxjbk5wYjI0cENpQWdJQ0FnSUNBZ1ZrRk1WVVZUSUNneExDQWtlMHhQUTB0ZlJrOVNUVUZVWDFaRlVsTkpUMDU5S1RzS0lDQWdJQ0FnSUNCRFQwMU5TVlE3Q2lBZ0lDQWdJR0FwT3dvZ0lDQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElHeHZZMnNnWkdGMFlXSmhjMlVnYVc1cGRHbGhiR2w2WVhScGIyNGdZMjl0Y0d4bGRHVWlLVHNLSUNBZ0lDQWdZMjl1ZEdsdWRXVTdDaUFnSUNCOUNpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUd4dlkyc2daR0YwWVdKaGMyVWdhVzVwZEdsaGJHbDZZWFJwYjI0Z1pHbGtJRzV2ZENCamIyNTJaWEpuWlRvZ0pIdHdZWFJvZldBcE93cDlDZ3BtZFc1amRHbHZiaUJqYkc5elpVUmhkR0ZpWVhObEtHUmhkR0ZpWVhObEtTQjdDaUFnYVdZZ0tDRmtZWFJoWW1GelpUOHVhWE5QY0dWdUtTQnlaWFIxY200N0NpQWdZMjl1YzNRZ1pYSnliM0p6SUQwZ1cxMDdDaUFnZEhKNUlIc0tJQ0FnSUdsbUlDaGtZWFJoWW1GelpTNXBjMVJ5WVc1ellXTjBhVzl1S1NCa1lYUmhZbUZ6WlM1bGVHVmpLQ0pTVDB4TVFrRkRTeUlwT3dvZ0lIMGdZMkYwWTJnZ0tHVnljbTl5S1NCN0NpQWdJQ0JsY25KdmNuTXVjSFZ6YUNobGNuSnZjaWs3Q2lBZ2ZRb2dJSFJ5ZVNCN0NpQWdJQ0JrWVhSaFltRnpaUzVqYkc5elpTZ3BPd29nSUgwZ1kyRjBZMmdnS0dWeWNtOXlLU0I3Q2lBZ0lDQmxjbkp2Y25NdWNIVnphQ2hsY25KdmNpazdDaUFnZlFvZ0lHbG1JQ2hsY25KdmNuTXViR1Z1WjNSb0lEMDlQU0F4S1NCMGFISnZkeUJsY25KdmNuTmJNRjA3Q2lBZ2FXWWdLR1Z5Y205eWN5NXNaVzVuZEdnZ1BpQXhLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dRV2RuY21WbllYUmxSWEp5YjNJb1pYSnliM0p6TENBaVlXZGxibU02SUdaaGFXeGxaQ0IwYnlCamJHOXpaU0JoSUd4dlkyRnNJSEJ5YjJObGMzTWdiRzlqYXlCa1lYUmhZbUZ6WlNJcE93b2dJSDBLZlFvS1pYaHdiM0owSUdaMWJtTjBhVzl1SUdselUzRnNhWFJsUW5WemVVVnljbTl5S0dWeWNtOXlLU0I3Q2lBZ2NtVjBkWEp1SUhSNWNHVnZaaUJsY25KdmNqOHVaWEp5WTI5a1pTQTlQVDBnSW01MWJXSmxjaUlnSmlZS0lDQWdJQ2hsY25KdmNpNWxjbkpqYjJSbElDWWdNSGhtWmlrZ1BUMDlJRk5SVEVsVVJWOUNWVk5aT3dwOUNncGhjM2x1WXlCbWRXNWpkR2x2YmlCM1lXbDBSbTl5UW5WemVWSmxkSEo1S0dOdmJuUmxlSFFzSUhCaGRHZ3NJR0YwZEdWdGNIUXNJR05oZFhObEtTQjdDaUFnWTI5dWMzUWdjbVZ0WVdsdWFXNW5JRDBnY21WdFlXbHVhVzVuVFdsc2JHbHpaV052Ym1SektHTnZiblJsZUhRcE93b2dJR2xtSUNoeVpXMWhhVzVwYm1jZ1BEMGdNQ2tnZEdoeWIzY2dkR2x0Wlc5MWRFVnljbTl5S0dOdmJuUmxlSFFzSUhCaGRHZ3NJR05oZFhObEtUc0tJQ0JqYjI1emRDQmxlSEJ2Ym1WdWRHbGhiRU5oY0NBOUlFMWhkR2d1YldsdUtFMUJXRjlDVlZOWlgxSkZWRkpaWDAxVExDQXlJQ29xSUUxaGRHZ3ViV2x1S0dGMGRHVnRjSFFzSURZcEtUc0tJQ0JqYjI1emRDQnFhWFIwWlhJZ1BTQk5ZWFJvTG0xaGVDZ3hMQ0JOWVhSb0xtWnNiMjl5S0UxaGRHZ3VjbUZ1Wkc5dEtDa2dLaUFvWlhod2IyNWxiblJwWVd4RFlYQWdLeUF4S1NrcE93b2dJR052Ym5OMElIZGhhWFJOY3lBOUlFMWhkR2d1YldsdUtISmxiV0ZwYm1sdVp5d2dhbWwwZEdWeUtUc0tJQ0JqYjI1emRDQnphV2R1WVd3Z1BTQmpiMjUwWlhoMExuSmxkSEo1VjJGclpWTnBaMjVoYkRzS0lDQnBaaUFvYzJsbmJtRnNJRDA5UFNCMWJtUmxabWx1WldRZ2ZId2dZMjl1ZEdWNGRDNXlaWFJ5ZVZkaGEyVkRiMjV6ZFcxbFpDa2dld29nSUNBZ1lYZGhhWFFnWkdWc1lYa29kMkZwZEUxektUc0tJQ0I5SUdWc2MyVWdld29nSUNBZ0x5OGdRU0JvYVc1MElHOXViSGtnYzJodmNuUmxibk1nYjI1bElITnNaV1Z3TGlCVWFHVWdibVY0ZENCaGRIUmxiWEIwSUcxMWMzUWdjM1JwYkd3Z2RtRnNhV1JoZEdVS0lDQWdJQzh2SUhSb1pTQndZWFJvSUdGdVpDQmhZM0YxYVhKbElIUm9aU0JUVVV4cGRHVWdkSEpoYm5OaFkzUnBiMjRnWVdkaGFXNXpkQ0IwYUdVZ2MyRnRaU0JrWldGa2JHbHVaUzRLSUNBZ0lHeGxkQ0IwYVcxbGNqc0tJQ0FnSUd4bGRDQjNZV3RsT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWVhkaGFYUWdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVwSUQwK0lIc0tJQ0FnSUNBZ0lDQjNZV3RsSUQwZ0tDa2dQVDRnZXdvZ0lDQWdJQ0FnSUNBZ1kyOXVkR1Y0ZEM1eVpYUnllVmRoYTJWRGIyNXpkVzFsWkNBOUlIUnlkV1U3Q2lBZ0lDQWdJQ0FnSUNCeVpYTnZiSFpsS0NrN0NpQWdJQ0FnSUNBZ2ZUc0tJQ0FnSUNBZ0lDQjBhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9jbVZ6YjJ4MlpTd2dkMkZwZEUxektUc0tJQ0FnSUNBZ0lDQnphV2R1WVd3dVlXUmtSWFpsYm5STWFYTjBaVzVsY2lnaVlXSnZjblFpTENCM1lXdGxMQ0I3SUc5dVkyVTZJSFJ5ZFdVZ2ZTazdDaUFnSUNBZ0lDQWdMeThnUTI5MlpYSnpJSEpsWVdScGJtVnpjeUJpWldadmNtVWdjM1ZpYzJOeWFYQjBhVzl1SUdGeklIZGxiR3dnWVhNZ1ltVm1iM0psSUdGamNYVnBjMmwwYVc5dUxnb2dJQ0FnSUNBZ0lHbG1JQ2h6YVdkdVlXd3VZV0p2Y25SbFpDa2dkMkZyWlNncE93b2dJQ0FnSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnWW5WemVTQnlaWFJ5ZVNCM1lXbDBJSE4wWVhKMFpXUWlLVHNLSUNBZ0lDQWdmU2s3Q2lBZ0lDQjlJR1pwYm1Gc2JIa2dld29nSUNBZ0lDQmpiR1ZoY2xScGJXVnZkWFFvZEdsdFpYSXBPd29nSUNBZ0lDQnBaaUFvZDJGclpTQWhQVDBnZFc1a1pXWnBibVZrS1NCemFXZHVZV3d1Y21WdGIzWmxSWFpsYm5STWFYTjBaVzVsY2lnaVlXSnZjblFpTENCM1lXdGxLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnY0dGMGFDd2dZMkYxYzJVcE93cDlDZ3BoYzNsdVl5Qm1kVzVqZEdsdmJpQmhZM0YxYVhKbFUzRnNhWFJsUkdGMFlXSmhjMlVvUkdGMFlXSmhjMlZUZVc1akxDQndjbVZ3WVhKbFpDd2dZMjl1ZEdWNGRDa2dld29nSUd4bGRDQmhkSFJsYlhCMElEMGdNRHNLSUNCc1pYUWdiR0Z6ZEVKMWMzazdDaUFnZDJocGJHVWdLSFJ5ZFdVcElIc0tJQ0FnSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJSEJ5WlhCaGNtVmtMbkJoZEdnc0lHeGhjM1JDZFhONUtUc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdjSEpsTFc5d1pXNGdiRzlqYXlCMllXeHBaR0YwYVc5dUlITjBZWEowWldRaUtUc0tJQ0FnSUdGM1lXbDBJSEpsZG1Gc2FXUmhkR1ZRY21Wd1lYSmxaRXh2WTJzb2NISmxjR0Z5WldRc0lHTnZiblJsZUhRc0lIc0tJQ0FnSUNBZ0x5OGdWR2hsSUdOeVpXRjBhVzl1SUhCaGRHZ2dZV3h5WldGa2VTQjJZV3hwWkdGMFpXUWdkR2hsSUdOdmJYQnNaWFJsSUdGdVkyVnpkRzl5SUdOb1lXbHVJR0Z1WkFvZ0lDQWdJQ0F2THlCMGFHVWdaWGhoWTNRZ2NHRnlaVzUwTDJacGJHVWdRVU5NY3k0Z1VtVjJZV3hwWkdGMFpTQkJRMHh6SUdGbWRHVnlJR052Ym5SbGJuUnBiMjRnWW1WallYVnpaUW9nSUNBZ0lDQXZMeUJoYm05MGFHVnlJR2h2YkdSbGNpQmhibVFnWVc0Z2RXNWliM1Z1WkdWa0lHbHVkR1Z5ZG1Gc0lHaGhkbVVnWTNKdmMzTmxaQ0IwYUdseklHRjBkR1Z0Y0hRdUNpQWdJQ0FnSUhaaGJHbGtZWFJsVjJsdVpHOTNjMEZqYkRvZ1lYUjBaVzF3ZENBK0lEQXNDaUFnSUNCOUtUc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdjSEpsTFc5d1pXNGdiRzlqYXlCMllXeHBaR0YwYVc5dUlHTnZiWEJzWlhSbElpazdDaUFnSUNCc1pYUWdaR0YwWVdKaGMyVTdDaUFnSUNCMGNua2dld29nSUNBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUdSaGRHRmlZWE5sSUc5d1pXNGdjM1JoY25SbFpDSXBPd29nSUNBZ0lDQmtZWFJoWW1GelpTQTlJRzVsZHlCRVlYUmhZbUZ6WlZONWJtTW9jSEpsY0dGeVpXUXVjR0YwYUN3Z2V3b2dJQ0FnSUNBZ0lHRnNiRzkzUlhoMFpXNXphVzl1T2lCbVlXeHpaU3dLSUNBZ0lDQWdJQ0IwYVcxbGIzVjBPaUF3TEFvZ0lDQWdJQ0I5S1RzS0lDQWdJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQmtZWFJoWW1GelpTQnZjR1Z1SUdOdmJYQnNaWFJsSWlrN0NpQWdJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdZMjl1Ym1WamRHbHZiaUJvWVhKa1pXNXBibWNnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdJQ0JqYjI1bWFXZDFjbVZNYjJOaGJGTnhiR2wwWlV4dlkydERiMjV1WldOMGFXOXVLR1JoZEdGaVlYTmxLVHNLSUNBZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCamIyNXVaV04wYVc5dUlHaGhjbVJsYm1sdVp5QmpiMjF3YkdWMFpTSXBPd29nSUNBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUhCdmMzUXRiM0JsYmlCc2IyTnJJSFpoYkdsa1lYUnBiMjRnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdJQ0JoZDJGcGRDQnlaWFpoYkdsa1lYUmxVSEpsY0dGeVpXUk1iMk5yS0hCeVpYQmhjbVZrTENCamIyNTBaWGgwS1RzS0lDQWdJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQndiM04wTFc5d1pXNGdiRzlqYXlCMllXeHBaR0YwYVc5dUlHTnZiWEJzWlhSbElpazdDaUFnSUNBZ0lHSmxaMmx1UVc1a1ZtRnNhV1JoZEdWTWIyTnJLR1JoZEdGaVlYTmxMQ0J3Y21Wd1lYSmxaQzV3WVhSb0xDQmpiMjUwWlhoMEtUc0tJQ0FnSUNBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnY0hKbGNHRnlaV1F1Y0dGMGFDd2diR0Z6ZEVKMWMza3BPd29nSUNBZ0lDQnlaWFIxY200Z1pHRjBZV0poYzJVN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsY25KdmNpa2dld29nSUNBZ0lDQmpiMjV6ZENCamJHVmhiblZ3UlhKeWIzSnpJRDBnVzEwN0NpQWdJQ0FnSUdsbUlDaGtZWFJoWW1GelpTQWhQVDBnZFc1a1pXWnBibVZrS1NCN0NpQWdJQ0FnSUNBZ2RISjVJSHNLSUNBZ0lDQWdJQ0FnSUdOc2IzTmxSR0YwWVdKaGMyVW9aR0YwWVdKaGMyVXBPd29nSUNBZ0lDQWdJSDBnWTJGMFkyZ2dLR05zWldGdWRYQkZjbkp2Y2lrZ2V3b2dJQ0FnSUNBZ0lDQWdZMnhsWVc1MWNFVnljbTl5Y3k1d2RYTm9LR05zWldGdWRYQkZjbkp2Y2lrN0NpQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNCOUNpQWdJQ0FnSUdsbUlDaGpiR1ZoYm5Wd1JYSnliM0p6TG14bGJtZDBhQ0ErSURBcElIc0tJQ0FnSUNBZ0lDQjBhSEp2ZHlCdVpYY2dRV2RuY21WbllYUmxSWEp5YjNJb0NpQWdJQ0FnSUNBZ0lDQmJaWEp5YjNJc0lDNHVMbU5zWldGdWRYQkZjbkp2Y25OZExBb2dJQ0FnSUNBZ0lDQWdZR0ZuWlc1ak9pQnNiMk5ySUdGMGRHVnRjSFFnWVc1a0lHTnNaV0Z1ZFhBZ1ltOTBhQ0JtWVdsc1pXUWdabTl5SUNSN2NISmxjR0Z5WldRdWNHRjBhSDFnTEFvZ0lDQWdJQ0FnSUNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnYVdZZ0tDRnBjMU54YkdsMFpVSjFjM2xGY25KdmNpaGxjbkp2Y2lrcElIUm9jbTkzSUdWeWNtOXlPd29nSUNBZ0lDQnNZWE4wUW5WemVTQTlJR1Z5Y205eU93b2dJQ0FnSUNCaGRIUmxiWEIwSUNzOUlERTdDaUFnSUNBZ0lHRjNZV2wwSUhkaGFYUkdiM0pDZFhONVVtVjBjbmtvWTI5dWRHVjRkQ3dnY0hKbGNHRnlaV1F1Y0dGMGFDd2dZWFIwWlcxd2RDd2diR0Z6ZEVKMWMza3BPd29nSUNBZ2ZRb2dJSDBLZlFvS1puVnVZM1JwYjI0Z2NtVnNaV0Z6WlVGamNYVnBjbVZrS0dGamNYVnBjbVZrTENCc1lXSmxiQ2tnZXdvZ0lHTnZibk4wSUdWeWNtOXljeUE5SUZ0ZE93b2dJR1p2Y2lBb1kyOXVjM1FnYVhSbGJTQnZaaUJoWTNGMWFYSmxaQzUwYjFKbGRtVnljMlZrS0NrcElIc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnNiM05sUkdGMFlXSmhjMlVvYVhSbGJTNWtZWFJoWW1GelpTazdDaUFnSUNCOUlHTmhkR05vSUNobGNuSnZjaWtnZXdvZ0lDQWdJQ0JsY25KdmNuTXVjSFZ6YUNobGNuSnZjaWs3Q2lBZ0lDQjlDaUFnSUNCcFppQW9LQ0ZwZEdWdExtUmhkR0ZpWVhObElIeDhJQ0ZwZEdWdExtUmhkR0ZpWVhObExtbHpUM0JsYmlrZ0ppWWdJV2wwWlcwdWFXNVFjbTlqWlhOelVtVnNaV0Z6WldRcElIc0tJQ0FnSUNBZ2RISjVJSHNLSUNBZ0lDQWdJQ0JwZEdWdExuSmxiR1ZoYzJWSmJsQnliMk5sYzNNb0tUc0tJQ0FnSUNBZ0lDQnBkR1Z0TG1sdVVISnZZMlZ6YzFKbGJHVmhjMlZrSUQwZ2RISjFaVHNLSUNBZ0lDQWdmU0JqWVhSamFDQW9aWEp5YjNJcElIc0tJQ0FnSUNBZ0lDQmxjbkp2Y25NdWNIVnphQ2hsY25KdmNpazdDaUFnSUNBZ0lIMEtJQ0FnSUgwS0lDQjlDaUFnYVdZZ0tHVnljbTl5Y3k1c1pXNW5kR2dnUFQwOUlERXBJSFJvY205M0lHVnljbTl5YzFzd1hUc0tJQ0JwWmlBb1pYSnliM0p6TG14bGJtZDBhQ0ErSURFcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCQloyZHlaV2RoZEdWRmNuSnZjaWhsY25KdmNuTXNJR0JoWjJWdVl6b2dKSHRzWVdKbGJIMGdiRzlqYXlCeVpXeGxZWE5sSUdaaGFXeGxaR0FwT3dvZ0lIMEtmUW9LWlhod2IzSjBJR0Z6ZVc1aklHWjFibU4wYVc5dUlHRmpjWFZwY21WTWIyTmhiRk54YkdsMFpVeHZZMnR6S0FvZ0lISmxjWFZsYzNSbFpGQmhkR2h6TEFvZ0lIc0tJQ0FnSUhScGJXVnZkWFJOY3lBOUlEWXdYekF3TUN3S0lDQWdJR3hoWW1Wc0lEMGdJa0ZuWlc1RElHOXdaWEpoZEdsdmJpSXNDaUFnSUNCa1pXRmtiR2x1WlRvZ2MzVndjR3hwWldSRVpXRmtiR2x1WlN3S0lDQWdJRzl1VUhKdlozSmxjM01zQ2lBZ0lDQnlaWFJ5ZVZkaGEyVlRhV2R1WVd3c0NpQWdmU0E5SUh0OUxBb3BJSHNLSUNCcFppQW9JVTUxYldKbGNpNXBjMU5oWm1WSmJuUmxaMlZ5S0hScGJXVnZkWFJOY3lrZ2ZId2dkR2x0Wlc5MWRFMXpJRHc5SURBcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCVWVYQmxSWEp5YjNJb0lteHZZMnNnZEdsdFpXOTFkRTF6SUcxMWMzUWdZbVVnWVNCd2IzTnBkR2wyWlNCellXWmxJR2x1ZEdWblpYSWlLVHNLSUNCOUNpQWdhV1lnS0hOMWNIQnNhV1ZrUkdWaFpHeHBibVVnSVQwOUlIVnVaR1ZtYVc1bFpDQW1KaUFoVG5WdFltVnlMbWx6Um1sdWFYUmxLSE4xY0hCc2FXVmtSR1ZoWkd4cGJtVXBLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dWSGx3WlVWeWNtOXlLQ0pzYjJOcklHUmxZV1JzYVc1bElHMTFjM1FnWW1VZ1ptbHVhWFJsSWlrN0NpQWdmUW9nSUdsbUlDZ2hRWEp5WVhrdWFYTkJjbkpoZVNoeVpYRjFaWE4wWldSUVlYUm9jeWtwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJVZVhCbFJYSnliM0lvSW14dlkyc2djR0YwYUhNZ2JYVnpkQ0JpWlNCaGJpQmhjbkpoZVNJcE93b2dJSDBLSUNCcFppQW9iMjVRY205bmNtVnpjeUFoUFQwZ2RXNWtaV1pwYm1Wa0lDWW1JSFI1Y0dWdlppQnZibEJ5YjJkeVpYTnpJQ0U5UFNBaVpuVnVZM1JwYjI0aUtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1ZIbHdaVVZ5Y205eUtDSnNiMk5ySUc5dVVISnZaM0psYzNNZ2JYVnpkQ0JpWlNCaElHWjFibU4wYVc5dUlpazdDaUFnZlFvZ0lHbG1JQ2h5WlhSeWVWZGhhMlZUYVdkdVlXd2dJVDA5SUhWdVpHVm1hVzVsWkNBbUppQWhLSEpsZEhKNVYyRnJaVk5wWjI1aGJDQnBibk4wWVc1alpXOW1JRUZpYjNKMFUybG5ibUZzS1NrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUZSNWNHVkZjbkp2Y2lnaWJHOWpheUJ5WlhSeWVWZGhhMlZUYVdkdVlXd2diWFZ6ZENCaVpTQmhiaUJCWW05eWRGTnBaMjVoYkNJcE93b2dJSDBLSUNCcFppQW9jbVZ4ZFdWemRHVmtVR0YwYUhNdWJHVnVaM1JvSUQwOVBTQXdLU0J5WlhSMWNtNGdLQ2tnUFQ0Z2UzMDdDZ29nSUdOdmJuTjBJSE4wWVhKMFpXUkJkQ0E5SUhCbGNtWnZjbTFoYm1ObExtNXZkeWdwT3dvZ0lHTnZibk4wSUdOdmJuUmxlSFFnUFNCN0NpQWdJQ0JrWldGa2JHbHVaVG9nVFdGMGFDNXRhVzRvQ2lBZ0lDQWdJSE4xY0hCc2FXVmtSR1ZoWkd4cGJtVWdQejhnVG5WdFltVnlMbEJQVTBsVVNWWkZYMGxPUmtsT1NWUlpMQW9nSUNBZ0lDQnpkR0Z5ZEdWa1FYUWdLeUIwYVcxbGIzVjBUWE1zQ2lBZ0lDQXBMQW9nSUNBZ2JHRmlaV3dzQ2lBZ0lDQjBhVzFsYjNWMFRYTXNDaUFnSUNCdmJsQnliMmR5WlhOekxBb2dJQ0FnY21WMGNubFhZV3RsVTJsbmJtRnNMQW9nSUNBZ2NtVjBjbmxYWVd0bFEyOXVjM1Z0WldRNklHWmhiSE5sTEFvZ0lIMDdDaUFnWTI5dWMzUWdabWx5YzNSRWFYTndiR0Y1VUdGMGFDQTlJSEpsYzI5c2RtVW9jbVZ4ZFdWemRHVmtVR0YwYUhOYk1GMHBPd29nSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJR1pwY25OMFJHbHpjR3hoZVZCaGRHZ3BPd29LSUNCamIyNXpkQ0J3Y21Wd1lYSmxaRUo1U1dSbGJuUnBkSGtnUFNCdVpYY2dUV0Z3S0NrN0NpQWdabTl5SUNoamIyNXpkQ0J5WlhGMVpYTjBaV1JRWVhSb0lHOW1JSEpsY1hWbGMzUmxaRkJoZEdoektTQjdDaUFnSUNCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0J5WlhOdmJIWmxLSEpsY1hWbGMzUmxaRkJoZEdncEtUc0tJQ0FnSUdOdmJuTjBJSEJ5WlhCaGNtVmtJRDBnWVhkaGFYUWdjSEpsY0dGeVpVeHZZMnRRWVhSb0tISmxjWFZsYzNSbFpGQmhkR2dzSUdOdmJuUmxlSFFwT3dvZ0lDQWdjSEpsY0dGeVpXUkNlVWxrWlc1MGFYUjVMbk5sZENod2NtVndZWEpsWkM1cFpHVnVkR2wwZVV0bGVTd2djSEpsY0dGeVpXUXBPd29nSUgwS0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaWJHOWpheUJ3WVhSb0lIQnlaWEJoY21GMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ1kyOXVjM1FnY0hKbGNHRnlaV1JNYjJOcmN5QTlJRnN1TGk1d2NtVndZWEpsWkVKNVNXUmxiblJwZEhrdWRtRnNkV1Z6S0NsZExuTnZjblFvS0d4bFpuUXNJSEpwWjJoMEtTQTlQZ29nSUNBZ2JHVm1kQzVwWkdWdWRHbDBlVXRsZVNBOElISnBaMmgwTG1sa1pXNTBhWFI1UzJWNUlEOGdMVEVnT2lCc1pXWjBMbWxrWlc1MGFYUjVTMlY1SUQ0Z2NtbG5hSFF1YVdSbGJuUnBkSGxMWlhrZ1B5QXhJRG9nTUNrN0NpQWdZMjl1YzNRZ2NHVnVaR2x1WjB4dlkyRnNJRDBnVzEwN0NpQWdZMjl1YzNRZ1lXTnhkV2x5WldRZ1BTQmJYVHNLSUNCc1pYUWdZM1Z5Y21WdWRGQmhkR2dnUFNCd2NtVndZWEpsWkV4dlkydHpXekJkUHk1d1lYUm9JRDgvSUdacGNuTjBSR2x6Y0d4aGVWQmhkR2c3Q2lBZ2RISjVJSHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjSEpsY0dGeVpXUWdiMllnY0hKbGNHRnlaV1JNYjJOcmN5a2dld29nSUNBZ0lDQmpkWEp5Wlc1MFVHRjBhQ0E5SUhCeVpYQmhjbVZrTG5CaGRHZzdDaUFnSUNBZ0lHTnZibk4wSUhKbGJHVmhjMlVnUFNCaGQyRnBkQ0JoWTNGMWFYSmxTVzVRY205alpYTnpURzlqYXlod2NtVndZWEpsWkN3Z1kyOXVkR1Y0ZENrN0NpQWdJQ0FnSUhCbGJtUnBibWRNYjJOaGJDNXdkWE5vS0hzZ2NISmxjR0Z5WldRc0lISmxiR1ZoYzJVZ2ZTazdDaUFnSUNCOUNpQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlhVzR0Y0hKdlkyVnpjeUJzYjJOcklHRmpjWFZwYzJsMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ0lDQjBhSEp2ZDBsbVJYaHdhWEpsWkNoamIyNTBaWGgwTENCamRYSnlaVzUwVUdGMGFDazdDaUFnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpVTFGTWFYUmxJRzF2WkhWc1pTQnBiWEJ2Y25RZ2MzUmhjblJsWkNJcE93b2dJQ0FnWTI5dWMzUWdleUJFWVhSaFltRnpaVk41Ym1NZ2ZTQTlJR0YzWVdsMElHbHRjRzl5ZENnaWJtOWtaVHB6Y1d4cGRHVWlLVHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnYlc5a2RXeGxJR2x0Y0c5eWRDQmpiMjF3YkdWMFpTSXBPd29nSUNBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnWTNWeWNtVnVkRkJoZEdncE93b2dJQ0FnWm05eUlDaGpiMjV6ZENCN0lIQnlaWEJoY21Wa0xDQnlaV3hsWVhObElIMGdiMllnY0dWdVpHbHVaMHh2WTJGc0tTQjdDaUFnSUNBZ0lHTjFjbkpsYm5SUVlYUm9JRDBnY0hKbGNHRnlaV1F1Y0dGMGFEc0tJQ0FnSUNBZ1kyOXVjM1FnYVhSbGJTQTlJSHNLSUNBZ0lDQWdJQ0JrWVhSaFltRnpaVG9nZFc1a1pXWnBibVZrTEFvZ0lDQWdJQ0FnSUhKbGJHVmhjMlZKYmxCeWIyTmxjM002SUhKbGJHVmhjMlVzQ2lBZ0lDQWdJQ0FnYVc1UWNtOWpaWE56VW1Wc1pXRnpaV1E2SUdaaGJITmxMQW9nSUNBZ0lDQjlPd29nSUNBZ0lDQmhZM0YxYVhKbFpDNXdkWE5vS0dsMFpXMHBPd29nSUNBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUhSeVlXNXpZV04wYVc5dUlHRmpjWFZwYzJsMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNBZ0lDQWdhWFJsYlM1a1lYUmhZbUZ6WlNBOUlHRjNZV2wwSUdGamNYVnBjbVZUY1d4cGRHVkVZWFJoWW1GelpTaEVZWFJoWW1GelpWTjVibU1zSUhCeVpYQmhjbVZrTENCamIyNTBaWGgwS1RzS0lDQWdJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQjBjbUZ1YzJGamRHbHZiaUJoWTNGMWFYTnBkR2x2YmlCamIyMXdiR1YwWlNJcE93b2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tHVnljbTl5S1NCN0NpQWdJQ0JqYjI1emRDQmpiR1ZoYm5Wd1JYSnliM0p6SUQwZ1cxMDdDaUFnSUNCMGNua2dld29nSUNBZ0lDQnlaV3hsWVhObFFXTnhkV2x5WldRb1lXTnhkV2x5WldRc0lHeGhZbVZzS1RzS0lDQWdJSDBnWTJGMFkyZ2dLR05zWldGdWRYQkZjbkp2Y2lrZ2V3b2dJQ0FnSUNCamJHVmhiblZ3UlhKeWIzSnpMbkIxYzJnb1kyeGxZVzUxY0VWeWNtOXlLVHNLSUNBZ0lIMEtJQ0FnSUdadmNpQW9ZMjl1YzNRZ2V5QnlaV3hsWVhObElIMGdiMllnY0dWdVpHbHVaMHh2WTJGc0xuTnNhV05sS0dGamNYVnBjbVZrTG14bGJtZDBhQ2t1ZEc5U1pYWmxjbk5sWkNncEtTQjdDaUFnSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJQ0FnY21Wc1pXRnpaU2dwT3dvZ0lDQWdJQ0I5SUdOaGRHTm9JQ2hqYkdWaGJuVndSWEp5YjNJcElIc0tJQ0FnSUNBZ0lDQmpiR1ZoYm5Wd1JYSnliM0p6TG5CMWMyZ29ZMnhsWVc1MWNFVnljbTl5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdmUW9nSUNBZ1kyOXVjM1FnWm05eWJXRjBkR1ZrSUQwZ2FYTlRjV3hwZEdWQ2RYTjVSWEp5YjNJb1pYSnliM0lwQ2lBZ0lDQWdJRDhnZEdsdFpXOTFkRVZ5Y205eUtHTnZiblJsZUhRc0lHTjFjbkpsYm5SUVlYUm9MQ0JsY25KdmNpa0tJQ0FnSUNBZ09pQmxjbkp2Y2pzS0lDQWdJR2xtSUNoamJHVmhiblZ3UlhKeWIzSnpMbXhsYm1kMGFDQStJREFwSUhzS0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVGblozSmxaMkYwWlVWeWNtOXlLQW9nSUNBZ0lDQWdJRnRtYjNKdFlYUjBaV1FzSUM0dUxtTnNaV0Z1ZFhCRmNuSnZjbk5kTEFvZ0lDQWdJQ0FnSUdCaFoyVnVZem9nSkh0c1lXSmxiSDBnYkc5amF5QmhZM0YxYVhOcGRHbHZiaUJoYm1RZ2NtOXNiR0poWTJzZ1ltOTBhQ0JtWVdsc1pXUmdMQW9nSUNBZ0lDQXBPd29nSUNBZ2ZRb2dJQ0FnZEdoeWIzY2dabTl5YldGMGRHVmtPd29nSUgwS0NpQWdiR1YwSUhKbGJHVmhjMlZrSUQwZ1ptRnNjMlU3Q2lBZ2NtVjBkWEp1SUNncElEMCtJSHNLSUNBZ0lHbG1JQ2h5Wld4bFlYTmxaQ2tnY21WMGRYSnVPd29nSUNBZ2NtVnNaV0Z6WlVGamNYVnBjbVZrS0dGamNYVnBjbVZrTENCc1lXSmxiQ2s3Q2lBZ0lDQnlaV3hsWVhObFpDQTlJR0ZqY1hWcGNtVmtMbVYyWlhKNUtDaHBkR1Z0S1NBOVBpQnBkR1Z0TG1sdVVISnZZMlZ6YzFKbGJHVmhjMlZrS1RzS0lDQjlPd3A5Q2dwbGVIQnZjblFnWVhONWJtTWdablZ1WTNScGIyNGdZV054ZFdseVpVeHZZMkZzVTNGc2FYUmxURzlqYXlod1lYUm9MQ0J2Y0hScGIyNXpLU0I3Q2lBZ2NtVjBkWEp1SUdGamNYVnBjbVZNYjJOaGJGTnhiR2wwWlV4dlkydHpLRnR3WVhSb1hTd2diM0IwYVc5dWN5azdDbjBLIjsKCmNvbnN0IHZlcnNpb25QYXR0ZXJuID0gL15cZCtcLlxkK1wuXGQrKD86LVswLTlBLVphLXouLV0rKT8kLzsKZnVuY3Rpb24gcHJpdmF0ZURpcmVjdG9yeShwYXRoLCByZXBhaXJXcml0YWJsZSA9IGZhbHNlKSB7CiAgbWtkaXJTeW5jKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBtb2RlOiAwbzcwMCB9KTsKICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKHBhdGgpOwogIGlmICghc3RhdC5pc0RpcmVjdG9yeSgpIHx8IHN0YXQuaXNTeW1ib2xpY0xpbmsoKSB8fCByZWFscGF0aFN5bmMocGF0aCkgIT09IHBhdGggfHwKICAgICAgc3RhdC51aWQgIT09IHByb2Nlc3MuZ2V0dWlkKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgcnVudGltZSBtYWludGVuYW5jZSBkaXJlY3RvcnkgaXMgdW5zYWZlOiAke3BhdGh9YCk7CiAgfQogIGlmICgoc3RhdC5tb2RlICYgMG8wMjIpICE9PSAwKSB7CiAgICBpZiAoIXJlcGFpcldyaXRhYmxlKSB0aHJvdyBuZXcgRXJyb3IoYHJ1bnRpbWUgbWFpbnRlbmFuY2UgZGlyZWN0b3J5IGlzIHdyaXRhYmxlOiAke3BhdGh9YCk7CiAgICBjb25zdCBmZCA9IG9wZW5TeW5jKHBhdGgsIGNvbnN0YW50cy5PX1JET05MWSB8IGNvbnN0YW50cy5PX0RJUkVDVE9SWSB8IGNvbnN0YW50cy5PX05PRk9MTE9XKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG9wZW5lZCA9IGZzdGF0U3luYyhmZCk7CiAgICAgIGlmIChvcGVuZWQuZGV2ICE9PSBzdGF0LmRldiB8fCBvcGVuZWQuaW5vICE9PSBzdGF0LmlubykgdGhyb3cgbmV3IEVycm9yKCJtYWludGVuYW5jZSBkaXJlY3RvcnkgaWRlbnRpdHkgY2hhbmdlZCIpOwogICAgICBmY2htb2RTeW5jKGZkLCAwbzcwMCk7CiAgICB9IGZpbmFsbHkgeyBjbG9zZVN5bmMoZmQpOyB9CiAgfQp9CmZ1bmN0aW9uIGF0b21pY0pzb24ocGF0aCwgdmFsdWUpIHsKICBjb25zdCB0ZW1wb3JhcnkgPSBgJHtwYXRofS4ke3Byb2Nlc3MucGlkfS0ke3JhbmRvbVVVSUQoKX1gOwogIHRyeSB7CiAgICBjb25zdCBmZCA9IG9wZW5TeW5jKHRlbXBvcmFyeSwgInd4IiwgMG82MDApOwogICAgdHJ5IHsgd3JpdGVGaWxlU3luYyhmZCwgSlNPTi5zdHJpbmdpZnkodmFsdWUpICsgIlxuIik7IGZzeW5jU3luYyhmZCk7IH0KICAgIGZpbmFsbHkgeyBjbG9zZVN5bmMoZmQpOyB9CiAgICByZW5hbWVTeW5jKHRlbXBvcmFyeSwgcGF0aCk7CiAgICBjb25zdCBwYXJlbnQgPSBvcGVuU3luYyhkaXJuYW1lKHBhdGgpLCAiciIpOwogICAgdHJ5IHsgZnN5bmNTeW5jKHBhcmVudCk7IH0gZmluYWxseSB7IGNsb3NlU3luYyhwYXJlbnQpOyB9CiAgfSBmaW5hbGx5IHsgcm1TeW5jKHRlbXBvcmFyeSwgeyBmb3JjZTogdHJ1ZSB9KTsgfQp9CmZ1bmN0aW9uIGxpdmUocGlkKSB7CiAgdHJ5IHsgcHJvY2Vzcy5raWxsKHBpZCwgMCk7IHJldHVybiB0cnVlOyB9CiAgY2F0Y2ggKGVycm9yKSB7IHJldHVybiBlcnJvci5jb2RlICE9PSAiRVNSQ0giOyB9Cn0KCi8vIFRoZSBzYW1lIGxvY2sgc2VyaWFsaXplcyBsZWFzZSBjcmVhdGlvbiBhbmQgY2xlYW51cC4gQSBsZWFzZSBzcGFucyBuZXR3b3JrCi8vIGRvd25sb2FkLCB2ZXJpZmljYXRpb24sIGV4dHJhY3Rpb24gYW5kIGFjdGl2YXRpb24sIGluY2x1ZGluZyB0aGVpciBsb2NrIGdhcHMuCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBiZWdpblJ1bnRpbWVVcGRhdGUoaG9tZSwgcGlkID0gcHJvY2Vzcy5waWQpIHsKICBjb25zdCByb290ID0gam9pbihyZWFscGF0aFN5bmMoaG9tZSksICJydW50aW1lIik7CiAgcHJpdmF0ZURpcmVjdG9yeShyb290LCB0cnVlKTsKICBjb25zdCByZWxlYXNlID0gYXdhaXQgYWNxdWlyZUxvY2FsU3FsaXRlTG9jayhqb2luKHJvb3QsICIubWFpbnRlbmFuY2UtbG9jay5zcWxpdGUiKSwgewogICAgbGFiZWw6ICJydW50aW1lIG1haW50ZW5hbmNlIiwgdGltZW91dE1zOiA2MF8wMDAsCiAgfSk7CiAgdHJ5IHsKICAgIGNvbnN0IGRpcmVjdG9yeSA9IGpvaW4ocm9vdCwgIi51cGRhdGUtbGVhc2VzIik7CiAgICBwcml2YXRlRGlyZWN0b3J5KGRpcmVjdG9yeSk7CiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHBpZCkgfHwgcGlkIDw9IDApIHRocm93IG5ldyBFcnJvcigiaW52YWxpZCB1cGRhdGUgcGlkIik7CiAgICBjb25zdCBwYXRoID0gam9pbihkaXJlY3RvcnksIGAke3BpZH0tJHtyYW5kb21VVUlEKCl9Lmpzb25gKTsKICAgIGF0b21pY0pzb24ocGF0aCwgeyBwaWQgfSk7CiAgICByZXR1cm4gcGF0aDsKICB9IGZpbmFsbHkgeyByZWxlYXNlKCk7IH0KfQpleHBvcnQgZnVuY3Rpb24gZW5kUnVudGltZVVwZGF0ZShsZWFzZSkgeyBybVN5bmMobGVhc2UsIHsgZm9yY2U6IHRydWUgfSk7IH0KCmV4cG9ydCBmdW5jdGlvbiByZWNvcmRSdW50aW1lQWN0aXZhdGlvbihob21lLCBjdXJyZW50LCBwcmV2aW91cykgewogIGlmICghdmVyc2lvblBhdHRlcm4udGVzdChjdXJyZW50KSB8fCAocHJldmlvdXMgIT09IHVuZGVmaW5lZCAmJiAhdmVyc2lvblBhdHRlcm4udGVzdChwcmV2aW91cykpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgcnVudGltZSBhY3RpdmF0aW9uIGhpc3RvcnkiKTsKICB9CiAgY29uc3QgcGF0aCA9IGpvaW4oaG9tZSwgInJ1bnRpbWUiLCAiLmFjdGl2YXRpb24taGlzdG9yeS5qc29uIik7CiAgbGV0IG9sZDsKICB0cnkgeyBvbGQgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCAidXRmOCIpKTsgfQogIGNhdGNoIChlcnJvcikgeyBpZiAoZXJyb3IuY29kZSAhPT0gIkVOT0VOVCIpIHRocm93IGVycm9yOyB9CiAgLy8gUmVpbnN0YWxsaW5nIHRoZSBjdXJyZW50IHJlbGVhc2UgbXVzdCBub3QgZm9yZ2V0IHRoZSByb2xsYmFjayB2ZXJzaW9uLgogIGlmIChwcmV2aW91cyA9PT0gY3VycmVudCB8fCBwcmV2aW91cyA9PT0gdW5kZWZpbmVkKSB7CiAgICBwcmV2aW91cyA9IG9sZD8uY3VycmVudCA9PT0gY3VycmVudCA/IG9sZC5wcmV2aW91cyA6IG9sZD8uY3VycmVudDsKICB9CiAgaWYgKG9sZD8uY3VycmVudCA9PT0gY3VycmVudCAmJiBvbGQ/LnByZXZpb3VzID09PSBwcmV2aW91cykgcmV0dXJuIGZhbHNlOwogIGF0b21pY0pzb24ocGF0aCwgeyBjdXJyZW50LCAuLi4ocHJldmlvdXMgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBwcmV2aW91cyB9KSB9KTsKICByZXR1cm4gdHJ1ZTsKfQoKZnVuY3Rpb24gaW52ZW50b3J5SGVscGVyKHJvb3QpIHsKICBjb25zdCB7IGN1cnJlbnQgfSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgIi5hY3RpdmF0aW9uLWhpc3RvcnkuanNvbiIpLCAidXRmOCIpKTsKICBpZiAoIXZlcnNpb25QYXR0ZXJuLnRlc3QoY3VycmVudCkpIHRocm93IG5ldyBFcnJvcigiaW52YWxpZCBydW50aW1lIGFjdGl2YXRpb24gaGlzdG9yeSIpOwogIGNvbnN0IHZlcnNpb24gPSBqb2luKHJvb3QsIGN1cnJlbnQpOwogIGlmIChsc3RhdFN5bmModmVyc2lvbikuaXNTeW1ib2xpY0xpbmsoKSkgdGhyb3cgbmV3IEVycm9yKCJ1bnNhZmUgaW52ZW50b3J5IGhlbHBlciBwYXJlbnQiKTsKICBmb3IgKGNvbnN0IGtleSBvZiByZWFkZGlyU3luYyh2ZXJzaW9uKSkgewogICAgaWYgKCFuZXcgUmVnRXhwKGBeZGFyd2luLSR7cHJvY2Vzcy5hcmNofS1uYXRpdmUtbm9kZS1hYmktXFxkKy1zaGEyNTYtW2EtZjAtOV17NjR9JGApLnRlc3Qoa2V5KSkgY29udGludWU7CiAgICBjb25zdCB0cmVlID0gam9pbih2ZXJzaW9uLCBrZXkpOwogICAgaWYgKGxzdGF0U3luYyh0cmVlKS5pc1N5bWJvbGljTGluaygpKSBjb250aW51ZTsKICAgIGNvbnN0IG1hcmtlciA9IGpvaW4odHJlZSwgIi5hZ2VuYy1ydW50aW1lLW9rIik7CiAgICBpZiAoIWV4aXN0c1N5bmMobWFya2VyKSB8fCBsc3RhdFN5bmMobWFya2VyKS5pc1N5bWJvbGljTGluaygpIHx8CiAgICAgICAgcmVhZEZpbGVTeW5jKG1hcmtlciwgInV0ZjgiKS50cmltKCkgIT09IGtleS5zbGljZSgtNjQpKSBjb250aW51ZTsKICAgIGxldCBoZWxwZXIgPSB0cmVlOwogICAgZm9yIChjb25zdCBwYXJ0IG9mIFsibm9kZV9tb2R1bGVzIiwgIkB0ZXRzdW8tYWkiLCAicnVudGltZSIsICJkaXN0IiwgImFnZW5jLXJ1bnRpbWUtaW52ZW50b3J5Il0pIHsKICAgICAgaGVscGVyID0gam9pbihoZWxwZXIsIHBhcnQpOwogICAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGhlbHBlcik7CiAgICAgIGlmIChzdGF0LmlzU3ltYm9saWNMaW5rKCkgfHwgc3RhdC51aWQgIT09IHByb2Nlc3MuZ2V0dWlkKCkgfHwgKHN0YXQubW9kZSAmIDBvMDIyKSAhPT0gMCkgewogICAgICAgIHRocm93IG5ldyBFcnJvcigidW5zYWZlIHJ1bnRpbWUgaW52ZW50b3J5IGhlbHBlciIpOwogICAgICB9CiAgICB9CiAgICBpZiAoIWxzdGF0U3luYyhoZWxwZXIpLmlzRmlsZSgpKSB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgcnVudGltZSBpbnZlbnRvcnkgaGVscGVyIik7CiAgICByZXR1cm4gaGVscGVyOwogIH0KICB0aHJvdyBuZXcgRXJyb3IoInJ1bnRpbWUgaW52ZW50b3J5IGhlbHBlciB1bmF2YWlsYWJsZSIpOwp9CgovLyBleGVjRmlsZSdzIHRpbWVvdXQgc3RpbGwgd2FpdHMgZm9yIGV4aXQvcGlwZSBjbG9zdXJlLiBBIHByb2Nlc3Mgc3R1Y2sgaW4ga2VybmVsCi8vIEkvTyBtYXkgbmV2ZXIgZGVsaXZlciBlaXRoZXIsIGV2ZW4gYWZ0ZXIgU0lHS0lMTC4gT3duIHRoZSBkZWFkbGluZSBhbmQgZGV0YWNoCi8vIGV2ZXJ5IGV2ZW50LWxvb3AgcmVmZXJlbmNlIGJlZm9yZSByZXR1cm5pbmcgYW4gaW5jb25jbHVzaXZlIGludmVudG9yeS4KZnVuY3Rpb24gaW52ZW50b3J5Q29tbWFuZChmaWxlLCBhcmdzLCBkZWFkbGluZSwgcnVuQ29tbWFuZCkgewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICBsZXQgY2hpbGQ7CiAgICBsZXQgc2V0dGxlZCA9IGZhbHNlOwogICAgY29uc3QgZXhwaXJlID0gKCkgPT4gewogICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuOwogICAgICBzZXR0bGVkID0gdHJ1ZTsKICAgICAgcmVqZWN0KG5ldyBFcnJvcigicnVudGltZSB1c2FnZSBpbnZlbnRvcnkgZGVhZGxpbmUgZXhjZWVkZWQiKSk7CiAgICAgIGZvciAoY29uc3QgY2xlYW51cCBvZiBbCiAgICAgICAgKCkgPT4gY2hpbGQ/LmtpbGwoIlNJR0tJTEwiKSwKICAgICAgICAoKSA9PiBjaGlsZD8uc3RkaW4/LmRlc3Ryb3koKSwKICAgICAgICAoKSA9PiBjaGlsZD8uc3Rkb3V0Py5kZXN0cm95KCksCiAgICAgICAgKCkgPT4gY2hpbGQ/LnN0ZGVycj8uZGVzdHJveSgpLAogICAgICAgICgpID0+IGNoaWxkPy51bnJlZigpLAogICAgICBdKSB7IHRyeSB7IGNsZWFudXAoKTsgfSBjYXRjaCB7IC8qIGRldGFjaGluZyBtdXN0IG5vdCB3YWl0IGZvciB0aGUgY2hpbGQgKi8gfSB9CiAgICB9OwogICAgY29uc3QgcmVtYWluaW5nID0gZGVhZGxpbmUgLSBwZXJmb3JtYW5jZS5ub3coKTsKICAgIGlmIChyZW1haW5pbmcgPD0gMCkgeyBleHBpcmUoKTsgcmV0dXJuOyB9CiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZXhwaXJlLCBNYXRoLmNlaWwocmVtYWluaW5nKSk7CiAgICB0cnkgewogICAgICBjaGlsZCA9IHJ1bkNvbW1hbmQoZmlsZSwgYXJncywgewogICAgICAgIGVuY29kaW5nOiAidXRmOCIsIG1heEJ1ZmZlcjogMzIgKiAxMDI0ICogMTAyNCwKICAgICAgfSwgKGVycm9yLCBzdGRvdXQsIHN0ZGVycikgPT4gewogICAgICAgIGlmIChzZXR0bGVkKSByZXR1cm47CiAgICAgICAgaWYgKHBlcmZvcm1hbmNlLm5vdygpID49IGRlYWRsaW5lKSB7IGV4cGlyZSgpOyByZXR1cm47IH0KICAgICAgICBzZXR0bGVkID0gdHJ1ZTsKICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpOwogICAgICAgIGlmIChlcnJvciB8fCBzdGRlcnIgIT09ICIiIHx8IHR5cGVvZiBzdGRvdXQgIT09ICJzdHJpbmciKSB7CiAgICAgICAgICByZWplY3QobmV3IEVycm9yKCJjYW5ub3QgZXN0YWJsaXNoIHJ1bm5pbmcgcnVudGltZSB1c2FnZSIsIHsgY2F1c2U6IGVycm9yIH0pKTsKICAgICAgICB9IGVsc2UgcmVzb2x2ZShzdGRvdXQpOwogICAgICB9KTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHNldHRsZWQgPSB0cnVlOwogICAgICBjbGVhclRpbWVvdXQodGltZXIpOwogICAgICByZWplY3QoZXJyb3IpOwogICAgfQogIH0pOwp9CgovLyBJbmNsdWRlIGNvbW1hbmQgbGluZXMgKEpTIGVudHJ5cG9pbnRzKSBwbHVzIHBlci1QSUQgb3BlbiBmaWxlcywgZXhlY3V0YWJsZQovLyBtYXBwaW5ncywgbmF0aXZlIGFkZG9ucyBhbmQgY3dkLiBUaGUgaGVscGVyIHdhbGtzIG9ubHkgdGhpcyBydW50aW1lIHJvb3QgdG8KLy8gbWF0Y2ggaW5vZGUgYWxpYXNlczsgaXQgbmV2ZXIgZW51bWVyYXRlcyBtb3VudHMgb3Igc3RhdHMgdW5yZWxhdGVkIHBhdGhzLgovLyBBIGZhaWxlZCwgaW5jb21wbGV0ZSBvciB0cnVuY2F0ZWQgaW52ZW50b3J5IGRpc2FibGVzIGFsbCBjbGVhbnVwLgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVudGltZVByb2Nlc3NJbnZlbnRvcnkocm9vdCwgewogIHJ1bkNvbW1hbmQgPSBleGVjRmlsZSwgdGltZW91dE1zID0gMzBfMDAwLCBoZWxwZXJQYXRoLAp9ID0ge30pIHsKICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRpbWVvdXRNcykgfHwgdGltZW91dE1zIDw9IDAgfHwgdGltZW91dE1zID4gMl8xNDdfNDgzXzY0NykgewogICAgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHJ1bnRpbWUgaW52ZW50b3J5IGRlYWRsaW5lIik7CiAgfQogIGNvbnN0IGRlYWRsaW5lID0gcGVyZm9ybWFuY2Uubm93KCkgKyB0aW1lb3V0TXM7CiAgY29uc3QgcHMgPSBhd2FpdCBpbnZlbnRvcnlDb21tYW5kKCIvYmluL3BzIiwgWyItYXh3dyIsICItbyIsICJwaWQ9LGNvbW1hbmQ9Il0sIGRlYWRsaW5lLCBydW5Db21tYW5kKTsKICBjb25zdCBmaWxlcyA9IGF3YWl0IGludmVudG9yeUNvbW1hbmQoaGVscGVyUGF0aCA/PyBpbnZlbnRvcnlIZWxwZXIocm9vdCksIFtyb290XSwgZGVhZGxpbmUsIHJ1bkNvbW1hbmQpOwogIGNvbnN0IGNvbXBsZXRlID0gIkFHRU5DX1JVTlRJTUVfSU5WRU5UT1JZX09LXG4iOwogIGlmICghZmlsZXMuZW5kc1dpdGgoY29tcGxldGUpKSB0aHJvdyBuZXcgRXJyb3IoImluY29tcGxldGUgcnVudGltZSB1c2FnZSBpbnZlbnRvcnkiKTsKICByZXR1cm4gcHMgKyAiXG4iICsgZmlsZXMuc2xpY2UoMCwgLWNvbXBsZXRlLmxlbmd0aCk7Cn0KZnVuY3Rpb24gdHJlZUJ5dGVzKHBhdGgpIHsKICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKHBhdGgpOwogIGlmIChzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHJldHVybiBzdGF0LnNpemU7CiAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkpIHJldHVybiBzdGF0LnNpemU7CiAgcmV0dXJuIHJlYWRkaXJTeW5jKHBhdGgpLnJlZHVjZSgoc3VtLCBuYW1lKSA9PiBzdW0gKyB0cmVlQnl0ZXMoam9pbihwYXRoLCBuYW1lKSksIDApOwp9CgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJ1bmVSdW50aW1lcyhob21lLCB7IGludmVudG9yeSA9IHJ1bnRpbWVQcm9jZXNzSW52ZW50b3J5LCBjaGVja3BvaW50ID0gKCkgPT4ge30gfSA9IHt9KSB7CiAgY29uc3Qgcm9vdCA9IGpvaW4ocmVhbHBhdGhTeW5jKGhvbWUpLCAicnVudGltZSIpOwogIHByaXZhdGVEaXJlY3Rvcnkocm9vdCk7CiAgY29uc3QgcmVsZWFzZSA9IGF3YWl0IGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2soam9pbihyb290LCAiLm1haW50ZW5hbmNlLWxvY2suc3FsaXRlIiksIHsKICAgIGxhYmVsOiAicnVudGltZSBtYWludGVuYW5jZSIsIHRpbWVvdXRNczogNjBfMDAwLAogIH0pOwogIGxldCByZWxlYXNlQWN0aXZhdGlvbjsKICBjb25zdCByZXN1bHQgPSB7IHJlbW92ZWQ6IFtdLCBmcmVlZEJ5dGVzOiAwLCBza2lwcGVkOiB1bmRlZmluZWQgfTsKICB0cnkgewogICAgcmVsZWFzZUFjdGl2YXRpb24gPSBhd2FpdCBhY3F1aXJlTG9jYWxTcWxpdGVMb2NrKGpvaW4ocm9vdCwgIi5hY3RpdmF0aW9uLWxvY2suc3FsaXRlIiksIHsKICAgICAgbGFiZWw6ICJydW50aW1lIHBydW5lIGFjdGl2YXRpb24iLCB0aW1lb3V0TXM6IDYwXzAwMCwKICAgIH0pOwogICAgaWYgKGV4aXN0c1N5bmMoam9pbihyb290LCAiLmFjdGl2YXRpb24tdHJhbnNhY3Rpb24uanNvbiIpKSkgewogICAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6ICJhY3RpdmF0aW9uIHJlY292ZXJ5IHBlbmRpbmciIH07CiAgICB9CiAgICBjb25zdCBsZWFzZXMgPSBqb2luKHJvb3QsICIudXBkYXRlLWxlYXNlcyIpOwogICAgaWYgKGV4aXN0c1N5bmMobGVhc2VzKSkgewogICAgICBwcml2YXRlRGlyZWN0b3J5KGxlYXNlcyk7CiAgICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhsZWFzZXMpKSB7CiAgICAgICAgY29uc3QgcGF0aCA9IGpvaW4obGVhc2VzLCBuYW1lKTsKICAgICAgICBpZiAoIWxzdGF0U3luYyhwYXRoKS5pc0ZpbGUoKSB8fCBsc3RhdFN5bmMocGF0aCkuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiAidW5yZWNvZ25pemVkIHVwZGF0ZSBsZWFzZSIgfTsKICAgICAgICB9CiAgICAgICAgY29uc3QgbGVhc2UgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCAidXRmOCIpKTsKICAgICAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGxlYXNlLnBpZCkgfHwgbGVhc2UucGlkIDw9IDAgfHwgbGl2ZShsZWFzZS5waWQpKSB7CiAgICAgICAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6ICJ1cGRhdGUgaW4gcHJvZ3Jlc3MiIH07CiAgICAgICAgfQogICAgICAgIHJtU3luYyhwYXRoKTsKICAgICAgfQogICAgfQogICAgY29uc3QgaGlzdG9yeSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgIi5hY3RpdmF0aW9uLWhpc3RvcnkuanNvbiIpLCAidXRmOCIpKTsKICAgIGlmICghdmVyc2lvblBhdHRlcm4udGVzdChoaXN0b3J5LmN1cnJlbnQpIHx8ICF2ZXJzaW9uUGF0dGVybi50ZXN0KGhpc3RvcnkucHJldmlvdXMpKSB7CiAgICAgIHJldHVybiB7IC4uLnJlc3VsdCwgc2tpcHBlZDogInR3byBzdWNjZXNzZnVsIGFjdGl2YXRpb25zIG5vdCByZWNvcmRlZCIgfTsKICAgIH0KICAgIGNvbnN0IHVzYWdlID0gYXdhaXQgaW52ZW50b3J5KHJvb3QpOwogICAgLy8gT2xkZXIgdXBkYXRlciBiaW5hcmllcyBwcmVkYXRlIGxlYXNlcy4gVGhlaXIgZnVsbCBjb21tYW5kIGxpbmUgc3RpbGwKICAgIC8vIGlkZW50aWZpZXMgYW4gdXBkYXRlIG9mIHRoaXMgaG9tZS4gRXhjbHVkZSB0aGlzIGNvbXBsZXRlZCB1cGRhdGVyIGl0c2VsZi4KICAgIGlmICh1c2FnZS5zcGxpdCgiXG4iKS5zb21lKChsaW5lKSA9PiB7CiAgICAgIGNvbnN0IGNvbW1hbmQgPSAvXlxzKihcZCspXHMrKC4rKSQvLmV4ZWMobGluZSk7CiAgICAgIHJldHVybiBjb21tYW5kICE9PSBudWxsICYmIE51bWJlcihjb21tYW5kWzFdKSAhPT0gcHJvY2Vzcy5waWQgJiYKICAgICAgICBjb21tYW5kWzJdLmluY2x1ZGVzKHJvb3QgKyAiLyIpICYmIC9cL2FnZW5jKD86XC5qcyk/XHMrdXBkYXRlKD86XHN8JCkvLnRlc3QoY29tbWFuZFsyXSk7CiAgICB9KSkgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiAib2xkZXIgdXBkYXRlciBpbiBwcm9ncmVzcyIgfTsKICAgIGZvciAoY29uc3QgdmVyc2lvbiBvZiByZWFkZGlyU3luYyhyb290KSkgewogICAgICBpZiAoIXZlcnNpb25QYXR0ZXJuLnRlc3QodmVyc2lvbikpIGNvbnRpbnVlOwogICAgICBjb25zdCBwYXRoID0gam9pbihyb290LCB2ZXJzaW9uKTsKICAgICAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhwYXRoKTsKICAgICAgaWYgKHN0YXQuaXNEaXJlY3RvcnkoKSAmJiAhc3RhdC5pc1N5bWJvbGljTGluaygpICYmCiAgICAgICAgICByZWFkZGlyU3luYyhwYXRoKS5zb21lKChuYW1lKSA9PiBuYW1lLnN0YXJ0c1dpdGgoIi4iKSkpIHsKICAgICAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6ICJydW50aW1lIGV4dHJhY3Rpb24gb3IgcmVjb3ZlcnkgcGVuZGluZyIgfTsKICAgICAgfQogICAgfQogICAgY29uc3QgcHJ1bmVKb3VybmFsID0gam9pbihyb290LCAiLnBydW5lLXRyYW5zYWN0aW9uLmpzb24iKTsKICAgIGNvbnN0IHJlbW92ZVRyZWUgPSBhc3luYyAodmVyc2lvbiwgdHJlZU5hbWUsIHF1YXJhbnRpbmVOYW1lLCByZWNvdmVyaW5nID0gZmFsc2UpID0+IHsKICAgICAgaWYgKCF2ZXJzaW9uUGF0dGVybi50ZXN0KHZlcnNpb24pIHx8CiAgICAgICAgICAhL14oPzpkYXJ3aW58bGludXh8d2luKS0oPzphcm02NHx4NjQpLSg/Om5hdGl2ZXxnbGliYyktbm9kZS1hYmktXGQrLXNoYTI1Ni1bYS1mMC05XXs2NH0kLy50ZXN0KHRyZWVOYW1lKSB8fAogICAgICAgICAgIS9eXC5wcnVuZS1bYS1mMC05LV17MzZ9JC8udGVzdChxdWFyYW50aW5lTmFtZSkpIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgcHJ1bmUgam91cm5hbCIpOwogICAgICB9CiAgICAgIGNvbnN0IHZlcnNpb25EaXIgPSBqb2luKHJvb3QsIHZlcnNpb24pLCB0cmVlID0gam9pbih2ZXJzaW9uRGlyLCB0cmVlTmFtZSk7CiAgICAgIGNvbnN0IHF1YXJhbnRpbmUgPSBqb2luKHJvb3QsIHF1YXJhbnRpbmVOYW1lKTsKICAgICAgY29uc3Qgc3luY1BhcmVudHMgPSAoKSA9PiB7CiAgICAgICAgZm9yIChjb25zdCBwYXRoIG9mIFt2ZXJzaW9uRGlyLCByb290XSkgewogICAgICAgICAgY29uc3QgZmQgPSBvcGVuU3luYyhwYXRoLCAiciIpOwogICAgICAgICAgdHJ5IHsgZnN5bmNTeW5jKGZkKTsgfSBmaW5hbGx5IHsgY2xvc2VTeW5jKGZkKTsgfQogICAgICAgIH0KICAgICAgfTsKICAgICAgY29uc3QgcmVzdG9yZSA9ICgpID0+IHsKICAgICAgICBpZiAoZXhpc3RzU3luYyhxdWFyYW50aW5lKSkgewogICAgICAgICAgaWYgKGV4aXN0c1N5bmModHJlZSkpIHRocm93IG5ldyBFcnJvcigicmV0YWluZWQgcnVudGltZSBoYXMgYSBwZW5kaW5nIHF1YXJhbnRpbmUgY29weSIpOwogICAgICAgICAgcmVuYW1lU3luYyhxdWFyYW50aW5lLCB0cmVlKTsKICAgICAgICAgIHN5bmNQYXJlbnRzKCk7CiAgICAgICAgfQogICAgICAgIHJtU3luYyhwcnVuZUpvdXJuYWwsIHsgZm9yY2U6IHRydWUgfSk7CiAgICAgIH07CiAgICAgIGlmICh2ZXJzaW9uID09PSBoaXN0b3J5LmN1cnJlbnQgfHwgdmVyc2lvbiA9PT0gaGlzdG9yeS5wcmV2aW91cykgewogICAgICAgIGlmIChyZWNvdmVyaW5nKSByZXN0b3JlKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IGJ1c3kgPSAoc25hcHNob3QpID0+IFt2ZXJzaW9uRGlyLCBxdWFyYW50aW5lXS5zb21lKChwYXRoKSA9PgogICAgICAgIHNuYXBzaG90LmluY2x1ZGVzKHBhdGggKyAiLyIpIHx8IHNuYXBzaG90LmluY2x1ZGVzKHBhdGggKyAiXG4iKSk7CiAgICAgIGlmIChidXN5KGF3YWl0IGludmVudG9yeShyb290KSkpIHsKICAgICAgICBpZiAocmVjb3ZlcmluZykgcmVzdG9yZSgpOwogICAgICAgIHRocm93IG5ldyBFcnJvcigicnVudGltZSBiZWNhbWUgYnVzeSBiZWZvcmUgcHJ1bmluZyIpOwogICAgICB9CiAgICAgIGlmIChsc3RhdFN5bmModmVyc2lvbkRpcikuaXNTeW1ib2xpY0xpbmsoKSkgdGhyb3cgbmV3IEVycm9yKCJwcnVuZSBwYXJlbnQgY2hhbmdlZCBpZGVudGl0eSIpOwogICAgICBmb3IgKGNvbnN0IHBhdGggb2YgW3RyZWUsIHF1YXJhbnRpbmVdKSB7CiAgICAgICAgaWYgKGV4aXN0c1N5bmMocGF0aCkgJiYgKCFsc3RhdFN5bmMocGF0aCkuaXNEaXJlY3RvcnkoKSB8fCBsc3RhdFN5bmMocGF0aCkuaXNTeW1ib2xpY0xpbmsoKSkpIHsKICAgICAgICAgIHRocm93IG5ldyBFcnJvcigicHJ1bmUgdHJlZSBjaGFuZ2VkIGlkZW50aXR5Iik7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICghcmVjb3ZlcmluZykgYXRvbWljSnNvbihwcnVuZUpvdXJuYWwsIHsgdmVyc2lvbiwgdHJlZU5hbWUsIHF1YXJhbnRpbmVOYW1lIH0pOwogICAgICBjaGVja3BvaW50KCJwcnVuZS1yZWNvcmRlZCIpOwogICAgICBpZiAoZXhpc3RzU3luYyh0cmVlKSkgewogICAgICAgIGlmIChleGlzdHNTeW5jKHF1YXJhbnRpbmUpKSB0aHJvdyBuZXcgRXJyb3IoImFtYmlndW91cyBwcnVuZSByZWNvdmVyeSBzdGF0ZSIpOwogICAgICAgIHJlbmFtZVN5bmModHJlZSwgcXVhcmFudGluZSk7CiAgICAgICAgc3luY1BhcmVudHMoKTsKICAgICAgfQogICAgICBjaGVja3BvaW50KCJwcnVuZS1xdWFyYW50aW5lZCIpOwogICAgICAvLyBDbG9zZSB0aGUgbGF1bmNoLXZlcnN1cy1zY2FuIHJhY2U6IG9yaWdpbmFsIGxhdW5jaCBwYXRocyBhcmUgbm93IGFic2VudC4KICAgICAgLy8gQSBwcm9jZXNzIHRoYXQgZW50ZXJlZCBiZWZvcmUgcmVuYW1lIGlzIHZpc2libGUgYnkgaXRzIG9sZCBhcmd2LCBvcGVuCiAgICAgIC8vIGRlc2NyaXB0b3JzLCBleGVjdXRhYmxlIG1hcHBpbmcgb3IgY3dkLiBSZXN0b3JlIGl0cyB0cmVlIGluc3RlYWQuCiAgICAgIGxldCBhZnRlclJlbmFtZTsKICAgICAgdHJ5IHsgYWZ0ZXJSZW5hbWUgPSBhd2FpdCBpbnZlbnRvcnkocm9vdCk7IH0KICAgICAgY2F0Y2ggKGVycm9yKSB7IHJlc3RvcmUoKTsgdGhyb3cgZXJyb3I7IH0KICAgICAgaWYgKGJ1c3koYWZ0ZXJSZW5hbWUpKSB7CiAgICAgICAgcmVzdG9yZSgpOwogICAgICAgIHRocm93IG5ldyBFcnJvcigicnVudGltZSBiZWNhbWUgYnVzeSBkdXJpbmcgcHJ1bmluZyIpOwogICAgICB9CiAgICAgIGNvbnN0IGJ5dGVzID0gZXhpc3RzU3luYyhxdWFyYW50aW5lKSA/IHRyZWVCeXRlcyhxdWFyYW50aW5lKSA6IDA7CiAgICAgIHJtU3luYyhxdWFyYW50aW5lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7CiAgICAgIGNoZWNrcG9pbnQoInBydW5lLXJlbW92ZWQiKTsKICAgICAgcm1TeW5jKHBydW5lSm91cm5hbCk7CiAgICAgIHN5bmNQYXJlbnRzKCk7CiAgICAgIHJlc3VsdC5yZW1vdmVkLnB1c2godHJlZSk7CiAgICAgIHJlc3VsdC5mcmVlZEJ5dGVzICs9IGJ5dGVzOwogICAgfTsKICAgIGlmIChleGlzdHNTeW5jKHBydW5lSm91cm5hbCkpIHsKICAgICAgaWYgKCFsc3RhdFN5bmMocHJ1bmVKb3VybmFsKS5pc0ZpbGUoKSB8fCBsc3RhdFN5bmMocHJ1bmVKb3VybmFsKS5pc1N5bWJvbGljTGluaygpKSB0aHJvdyBuZXcgRXJyb3IoInVuc2FmZSBwcnVuZSBqb3VybmFsIik7CiAgICAgIGNvbnN0IHBlbmRpbmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwcnVuZUpvdXJuYWwsICJ1dGY4IikpOwogICAgICBhd2FpdCByZW1vdmVUcmVlKHBlbmRpbmcudmVyc2lvbiwgcGVuZGluZy50cmVlTmFtZSwgcGVuZGluZy5xdWFyYW50aW5lTmFtZSwgdHJ1ZSk7CiAgICB9CiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhZGRpclN5bmMocm9vdCkpIHsKICAgICAgaWYgKCF2ZXJzaW9uUGF0dGVybi50ZXN0KG5hbWUpIHx8IG5hbWUgPT09IGhpc3RvcnkuY3VycmVudCB8fCBuYW1lID09PSBoaXN0b3J5LnByZXZpb3VzKSBjb250aW51ZTsKICAgICAgY29uc3QgcGF0aCA9IGpvaW4ocm9vdCwgbmFtZSk7CiAgICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMocGF0aCk7CiAgICAgIGlmICghc3RhdC5pc0RpcmVjdG9yeSgpIHx8IHN0YXQuaXNTeW1ib2xpY0xpbmsoKSB8fCBzdGF0LnVpZCAhPT0gcHJvY2Vzcy5nZXR1aWQoKSkgY29udGludWU7CiAgICAgIC8vIFByZXNlcnZlIGludGVycnVwdGVkIGV4dHJhY3Rpb24vYmFja3VwIHRyZWVzIGFuZCB0aGVpciBwZXJzaXN0ZW50IGxvY2sKICAgICAgLy8gaWRlbnRpdGllcy4gTmV2ZXIgcmVtb3ZlIHRoZSB2ZXJzaW9uIGRpcmVjdG9yeSBvciBTUUxpdGUgbG9jayBmaWxlcy4KICAgICAgY29uc3QgY2hpbGRyZW4gPSByZWFkZGlyU3luYyhwYXRoKTsKICAgICAgaWYgKGNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC5zdGFydHNXaXRoKCIuIikpKSBjb250aW51ZTsKICAgICAgaWYgKHVzYWdlLmluY2x1ZGVzKHBhdGggKyAiLyIpIHx8IHVzYWdlLmluY2x1ZGVzKHBhdGggKyAiXG4iKSkgY29udGludWU7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHsKICAgICAgICBpZiAoIS9eKD86ZGFyd2lufGxpbnV4fHdpbiktKD86YXJtNjR8eDY0KS0oPzpuYXRpdmV8Z2xpYmMpLW5vZGUtYWJpLVxkKy1zaGEyNTYtW2EtZjAtOV17NjR9JC8udGVzdChjaGlsZCkpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHRyZWUgPSBqb2luKHBhdGgsIGNoaWxkKTsKICAgICAgICBjb25zdCB0cmVlU3RhdCA9IGxzdGF0U3luYyh0cmVlKTsKICAgICAgICBpZiAoIXRyZWVTdGF0LmlzRGlyZWN0b3J5KCkgfHwgdHJlZVN0YXQuaXNTeW1ib2xpY0xpbmsoKSkgY29udGludWU7CiAgICAgICAgY29uc3QgbWFya2VyID0gam9pbih0cmVlLCAiLmFnZW5jLXJ1bnRpbWUtb2siKTsKICAgICAgICBpZiAoIWV4aXN0c1N5bmMobWFya2VyKSB8fCBsc3RhdFN5bmMobWFya2VyKS5pc1N5bWJvbGljTGluaygpIHx8CiAgICAgICAgICAgIHJlYWRGaWxlU3luYyhtYXJrZXIsICJ1dGY4IikudHJpbSgpICE9PSBjaGlsZC5zbGljZSgtNjQpKSBjb250aW51ZTsKICAgICAgICAvLyBBIGR1cmFibGUgcGVyLXRyZWUgam91cm5hbCBtYWtlcyBpbnRlcnJ1cHRlZCByZWN1cnNpdmUgcmVtb3ZhbAogICAgICAgIC8vIHJldHJ5YWJsZSBldmVuIGlmIHRoZSBtYXJrZXIgd2FzIHJlbW92ZWQgYmVmb3JlIHRoZSBjcmFzaC4KICAgICAgICBhd2FpdCByZW1vdmVUcmVlKG5hbWUsIGNoaWxkLCBgLnBydW5lLSR7cmFuZG9tVVVJRCgpfWApOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gcmVzdWx0OwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6IGVycm9yLm1lc3NhZ2UgfTsKICB9IGZpbmFsbHkgeyByZWxlYXNlQWN0aXZhdGlvbj8uKCk7IHJlbGVhc2UoKTsgfQp9Cg==");
}
// END GENERATED AGENC RUNTIME MAINTENANCE MODULE

function validateActivationTransaction(raw, parseGeneratedWrapperContent) {
  if (raw.length > 4 * 1024 * 1024) throw new Error("wrapper activation journal is too large");
  const transaction = JSON.parse(raw);
  if (transaction?.version !== 1 ||
      typeof transaction.targetVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(transaction.targetVersion) ||
      !Array.isArray(transaction.entries) ||
      transaction.entries.length === 0 || transaction.entries.length > 64) {
    throw new Error("wrapper activation journal is invalid");
  }
  if (transaction.previousVersion !== undefined &&
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(transaction.previousVersion)) {
    throw new Error("wrapper activation previous version is invalid");
  }
  const seen = new Set();
  for (const entry of transaction.entries) {
    if (typeof entry?.path !== "string" || !isAbsolute(entry.path) || seen.has(entry.path) ||
        (entry.original !== null && typeof entry.original !== "string") ||
        typeof entry.desired !== "string" ||
        !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("wrapper activation journal entry is invalid");
    }
    const originalWrapper = entry.original === null
      ? null
      : parseGeneratedWrapperContent(entry.path, entry.original);
    const desiredWrapper = parseGeneratedWrapperContent(entry.path, entry.desired);
    if ((entry.original !== null && originalWrapper === null) || desiredWrapper === null ||
        (originalWrapper !== null && originalWrapper.kind !== desiredWrapper.kind) ||
        entry.mode !== (desiredWrapper.kind === "cmd" ? 0o644 : 0o755)) {
      throw new Error("wrapper activation journal entry is invalid");
    }
    seen.add(entry.path);
  }
  return transaction;
}
async function completeActivationTransaction(journalPath, parseGeneratedWrapperContent) {
  const raw = readOptionalFile(journalPath);
  if (raw === null) return;
  const transaction = validateActivationTransaction(raw, parseGeneratedWrapperContent);
  for (const entry of transaction.entries) {
    const current = readOptionalFile(entry.path);
    if (current !== entry.original && current !== entry.desired) {
      throw new Error(`wrapper changed outside interrupted activation: ${entry.path}`);
    }
  }
  if (transaction.stableNode !== undefined) {
    const { describeStableNode, installStableNode, stableNodePath } = await loadStableNodeModule();
    const home = dirname(dirname(journalPath));
    const checked = describeStableNode(home, transaction.stableNode.source);
    if (checked.sha256 !== transaction.stableNode.sha256 ||
        relative(join(home, "runtime"), checked.source).split("/")[0] !== transaction.targetVersion ||
        transaction.entries.some((entry) => {
          const wrapper = parseGeneratedWrapperContent(entry.path, entry.desired);
          return wrapper.agencHome !== home || wrapper.nodeBin !== stableNodePath(home) ||
            activeRuntimeVersion(wrapper, home) !== transaction.targetVersion;
        })) throw new Error("stable Node activation journal is invalid");
    installStableNode(home, checked);
    activationTestDelay("AGENC_INSTALL_TEST_AFTER_STABLE_NODE_MS");
  }
  for (const entry of transaction.entries) {
    if (readOptionalFile(entry.path) !== entry.desired) {
      replaceFileAtomically(entry.path, entry.desired, entry.mode);
    }
  }
  if (transaction.stableNode !== undefined) {
    const { recordRuntimeActivation } = await loadRuntimeMaintenanceModule();
    recordRuntimeActivation(dirname(dirname(journalPath)), transaction.targetVersion, transaction.previousVersion);
  }
  removeDurably(journalPath, { force: true });
}
function compareSemver(left, right) {
  const parse = (value) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) throw new Error(`invalid semantic version: ${value}`);
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  if (a.pre === undefined || b.pre === undefined) return a.pre === b.pre ? 0 : a.pre === undefined ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const ai = a.pre[index], bi = b.pre[index];
    if (ai === undefined || bi === undefined) return ai === bi ? 0 : ai === undefined ? -1 : 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai), bn = /^\d+$/.test(bi);
    if (an && bn) return Math.sign(Number(ai) - Number(bi));
    if (an !== bn) return an ? -1 : 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}
function activeRuntimeVersion(wrapper, agencHome) {
  if (wrapper === null) return undefined;
  const runtimeBin = wrapper.runtimeBin;
  const root = resolve(agencHome, "runtime");
  const within = relative(root, resolve(runtimeBin));
  if (within === "" || within === ".." || within.startsWith(`..${require("node:path").sep}`) || isAbsolute(within)) {
    return undefined;
  }
  const version = within.split(/[\\/]/)[0];
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
}
// BEGIN GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE
// Generated by scripts/sync-installer-sqlite-lock.mjs from the canonical
// launcher module. Do not edit this embedded payload by hand.
const AGENC_ACTIVATION_LOCK_IDENTITY_SOURCE_BASE64 = "Ly8gU3RhYmxlIGFjY291bnQgYW5kIHdyYXBwZXIgaWRlbnRpdGllcyBzaGFyZWQgYnkgdGhlIGxhdW5jaGVyLCBydW50aW1lCi8vIHVwZGF0ZXIsIGFuZCBzdGFuZGFsb25lIGluc3RhbGxlcnMuIFdyYXBwZXIgZmlsZXMgYXJlIGF0b21pY2FsbHkgcmVwbGFjZWQsCi8vIHNvIHRoZWlyIG93biBpbm9kZSBpcyBpbnRlbnRpb25hbGx5IG5vdCBwYXJ0IG9mIHRoZSBwZXJzaXN0ZW50IGxvY2sga2V5LgoKaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gIm5vZGU6Y3J5cHRvIjsKaW1wb3J0IHsKICBjaG1vZFN5bmMsCiAgZXhpc3RzU3luYywKICBsc3RhdFN5bmMsCiAgbWtkaXJTeW5jLAogIHJlYWxwYXRoU3luYywKfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsgdXNlckluZm8gfSBmcm9tICJub2RlOm9zIjsKaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlc29sdmUgfSBmcm9tICJub2RlOnBhdGgiOwoKbGV0IGNhY2hlZEFjdGl2YXRpb25Mb2NrUmVnaXN0cnk7CmNvbnN0IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQgPSAweGZmZmZfZmZmZl9mZmZmX2ZmZmZuOwoKZnVuY3Rpb24gaGFzVXNhYmxlRmlsZUlkZW50aXR5KHN0YXQpIHsKICByZXR1cm4gc3RhdC5kZXYgIT09IDBuICYmCiAgICBzdGF0LmlubyAhPT0gMG4gJiYKICAgIHN0YXQuaW5vICE9PSAtMW4gJiYKICAgIEJpZ0ludC5hc1VpbnROKDY0LCBzdGF0LmlubykgIT09IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQ7Cn0KCmV4cG9ydCBmdW5jdGlvbiBleGlzdGluZ0FnZW5DSG9tZUlkZW50aXR5KHJlcXVlc3RlZCkgewogIGlmICh0eXBlb2YgcmVxdWVzdGVkICE9PSAic3RyaW5nIiB8fCAhaXNBYnNvbHV0ZShyZXF1ZXN0ZWQpKSByZXR1cm4gdW5kZWZpbmVkOwogIHRyeSB7CiAgICBjb25zdCBjYW5vbmljYWwgPSByZWFscGF0aFN5bmMubmF0aXZlKHJlc29sdmUocmVxdWVzdGVkKSk7CiAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGNhbm9uaWNhbCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkoKSB8fCBzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHJldHVybiB1bmRlZmluZWQ7CiAgICBpZiAoCiAgICAgIHByb2Nlc3MucGxhdGZvcm0gIT09ICJ3aW4zMiIgJiYKICAgICAgdHlwZW9mIHByb2Nlc3MuZ2V0dWlkID09PSAiZnVuY3Rpb24iICYmCiAgICAgIHN0YXQudWlkICE9PSBCaWdJbnQocHJvY2Vzcy5nZXR1aWQoKSkKICAgICkgcmV0dXJuIHVuZGVmaW5lZDsKICAgIGlmICghaGFzVXNhYmxlRmlsZUlkZW50aXR5KHN0YXQpKSByZXR1cm4gdW5kZWZpbmVkOwogICAgcmV0dXJuIGAke3N0YXQuZGV2fToke3N0YXQuaW5vfWA7CiAgfSBjYXRjaCB7CiAgICByZXR1cm4gdW5kZWZpbmVkOwogIH0KfQoKZnVuY3Rpb24gZW5zdXJlQWNjb3VudFJlZ2lzdHJ5UGF0aChhY2NvdW50SG9tZSwgc2VnbWVudHMsIHVpZCkgewogIGNvbnN0IGNhbm9uaWNhbEhvbWUgPSByZWFscGF0aFN5bmMoYWNjb3VudEhvbWUpOwogIGNvbnN0IGhvbWVTdGF0ID0gbHN0YXRTeW5jKGNhbm9uaWNhbEhvbWUpOwogIGlmICghaG9tZVN0YXQuaXNEaXJlY3RvcnkoKSB8fCBob21lU3RhdC5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFjY291bnQgaG9tZSBpcyBub3QgYSByZWFsIGRpcmVjdG9yeTogJHtjYW5vbmljYWxIb21lfWApOwogIH0KICBpZiAodWlkICE9PSB1bmRlZmluZWQgJiYgaG9tZVN0YXQudWlkICE9PSB1aWQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWNjb3VudCBob21lIGhhcyB0aGUgd3Jvbmcgb3duZXI6ICR7Y2Fub25pY2FsSG9tZX1gKTsKICB9CiAgaWYgKHVpZCAhPT0gdW5kZWZpbmVkICYmIChob21lU3RhdC5tb2RlICYgMG8wMjIpICE9PSAwKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFjY291bnQgaG9tZSBpcyBncm91cC93b3JsZCB3cml0YWJsZTogJHtjYW5vbmljYWxIb21lfWApOwogIH0KICBsZXQgY3VycmVudCA9IGNhbm9uaWNhbEhvbWU7CiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHNlZ21lbnRzLmxlbmd0aDsgaW5kZXggKz0gMSkgewogICAgY3VycmVudCA9IGpvaW4oY3VycmVudCwgc2VnbWVudHNbaW5kZXhdKTsKICAgIHRyeSB7CiAgICAgIG1rZGlyU3luYyhjdXJyZW50LCB7IG1vZGU6IDBvNzAwIH0pOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgaWYgKGVycm9yPy5jb2RlICE9PSAiRUVYSVNUIikgdGhyb3cgZXJyb3I7CiAgICB9CiAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGN1cnJlbnQpOwogICAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkgfHwgc3RhdC5pc1N5bWJvbGljTGluaygpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWN0aXZhdGlvbiBsb2NrIHJlZ2lzdHJ5IHBhdGggaXMgbm90IGEgcmVhbCBkaXJlY3Rvcnk6ICR7Y3VycmVudH1gKTsKICAgIH0KICAgIGlmICh1aWQgIT09IHVuZGVmaW5lZCkgewogICAgICBpZiAoc3RhdC51aWQgIT09IHVpZCkgewogICAgICAgIHRocm93IG5ldyBFcnJvcihgYWN0aXZhdGlvbiBsb2NrIHJlZ2lzdHJ5IHBhdGggaGFzIHRoZSB3cm9uZyBvd25lcjogJHtjdXJyZW50fWApOwogICAgICB9CiAgICAgIGlmICgoc3RhdC5tb2RlICYgMG8wMjIpICE9PSAwKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhY3RpdmF0aW9uIGxvY2sgcmVnaXN0cnkgcGF0aCBpcyBncm91cC93b3JsZCB3cml0YWJsZTogJHtjdXJyZW50fWApOwogICAgICB9CiAgICAgIC8vIEFnZW5DLW93bmVkIGNvbXBvbmVudHMgYXJlIHByaXZhdGUuIERvIG5vdCByZXdyaXRlIGNvbnZlbnRpb25hbAogICAgICAvLyBhY2NvdW50IGRpcmVjdG9yaWVzIHN1Y2ggYXMgLmxvY2FsL3N0YXRlIG9yIExpYnJhcnkvQXBwbGljYXRpb24gU3VwcG9ydC4KICAgICAgaWYgKGluZGV4ID49IHNlZ21lbnRzLmxlbmd0aCAtIDIpIGNobW9kU3luYyhjdXJyZW50LCAwbzcwMCk7CiAgICB9CiAgfQogIHJldHVybiBjdXJyZW50Owp9CgpleHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUFjdGl2YXRpb25Mb2NrUmVnaXN0cnkoKSB7CiAgaWYgKGNhY2hlZEFjdGl2YXRpb25Mb2NrUmVnaXN0cnkgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGNhY2hlZEFjdGl2YXRpb25Mb2NrUmVnaXN0cnk7CiAgaWYgKCFbImxpbnV4IiwgImRhcndpbiIsICJ3aW4zMiJdLmluY2x1ZGVzKHByb2Nlc3MucGxhdGZvcm0pKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHVuc3VwcG9ydGVkIHBsYXRmb3JtIGZvciB3cmFwcGVyIGxvY2tpbmc6ICR7cHJvY2Vzcy5wbGF0Zm9ybX1gKTsKICB9CiAgY29uc3QgYWNjb3VudCA9IHVzZXJJbmZvKCk7CiAgaWYgKCFpc0Fic29sdXRlKGFjY291bnQuaG9tZWRpcikpIHsKICAgIHRocm93IG5ldyBFcnJvcigib3BlcmF0aW5nLXN5c3RlbSBhY2NvdW50IGhvbWUgaXMgdW5hdmFpbGFibGUiKTsKICB9CgogIGxldCBzZWdtZW50czsKICBsZXQgdWlkOwogIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAid2luMzIiKSB7CiAgICAvLyBvcy51c2VySW5mbygpLmhvbWVkaXIgaXMgc3VwcGxpZWQgYnkgdGhlIG9wZXJhdGluZyBzeXN0ZW0gcmF0aGVyIHRoYW4KICAgIC8vIFVTRVJQUk9GSUxFLiBLZWVwIHRoZSByZWdpc3RyeSB1bmRlciB0aGF0IHN0YWJsZSBwcm9maWxlIHJvb3QgYW5kIGxldAogICAgLy8gdGhlIFNRTGl0ZSBsb2NrIGxheWVyIGVuZm9yY2UgbG9jYWwtdm9sdW1lIGFuZCBBQ0wgcG9saWN5LgogICAgc2VnbWVudHMgPSBbIi5hZ2VuYy1zdGF0ZSIsICJhY3RpdmF0aW9uLWxvY2tzIl07CiAgfSBlbHNlIHsKICAgIGlmICh0eXBlb2YgcHJvY2Vzcy5nZXR1aWQgIT09ICJmdW5jdGlvbiIgfHwgYWNjb3VudC51aWQgIT09IHByb2Nlc3MuZ2V0dWlkKCkpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJvcGVyYXRpbmctc3lzdGVtIGFjY291bnQgaWRlbnRpdHkgaXMgaW5jb25zaXN0ZW50Iik7CiAgICB9CiAgICB1aWQgPSBwcm9jZXNzLmdldHVpZCgpOwogICAgc2VnbWVudHMgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIgogICAgICA/IFsiTGlicmFyeSIsICJBcHBsaWNhdGlvbiBTdXBwb3J0IiwgIkFnZW5DIiwgImFjdGl2YXRpb24tbG9ja3MiXQogICAgICA6IFsiLmxvY2FsIiwgInN0YXRlIiwgIkFnZW5DIiwgImFjdGl2YXRpb24tbG9ja3MiXTsKICB9CiAgY2FjaGVkQWN0aXZhdGlvbkxvY2tSZWdpc3RyeSA9IHJlYWxwYXRoU3luYygKICAgIGVuc3VyZUFjY291bnRSZWdpc3RyeVBhdGgoYWNjb3VudC5ob21lZGlyLCBzZWdtZW50cywgdWlkKSwKICApOwogIHJldHVybiBjYWNoZWRBY3RpdmF0aW9uTG9ja1JlZ2lzdHJ5Owp9CgpleHBvcnQgZnVuY3Rpb24gd3JhcHBlckFjdGl2YXRpb25Mb2NrUGF0aCh3cmFwcGVyUGF0aCwgcmVnaXN0cnkpIHsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUod3JhcHBlclBhdGgpOwogIGNvbnN0IHBhcmVudCA9IHJlYWxwYXRoU3luYy5uYXRpdmUoZGlybmFtZShhYnNvbHV0ZSkpOwogIGNvbnN0IGNhbmRpZGF0ZSA9IGpvaW4ocGFyZW50LCBiYXNlbmFtZShhYnNvbHV0ZSkpOwogIGxldCBlbnRyeU5hbWUgPSBiYXNlbmFtZShhYnNvbHV0ZSk7CiAgaWYgKGV4aXN0c1N5bmMoY2FuZGlkYXRlKSkgewogICAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhjYW5kaWRhdGUpOwogICAgaWYgKCFzdGF0LmlzRmlsZSgpIHx8IHN0YXQuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgaXMgbm90IGEgcmVndWxhciBub24tc3ltbGluayBmaWxlOiAke2NhbmRpZGF0ZX1gKTsKICAgIH0KICAgIGlmIChzdGF0Lm5saW5rID4gMSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgbXVzdCBub3QgaGF2ZSBoYXJkLWxpbmsgYWxpYXNlczogJHtjYW5kaWRhdGV9YCk7CiAgICB9CiAgICBlbnRyeU5hbWUgPSBiYXNlbmFtZShyZWFscGF0aFN5bmMubmF0aXZlKGNhbmRpZGF0ZSkpOwogIH0KICBjb25zdCBwYXJlbnRTdGF0ID0gbHN0YXRTeW5jKHBhcmVudCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgaWYgKCFwYXJlbnRTdGF0LmlzRGlyZWN0b3J5KCkgfHwgcGFyZW50U3RhdC5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgcGFyZW50IGlzIG5vdCBhIHJlYWwgZGlyZWN0b3J5OiAke3BhcmVudH1gKTsKICB9CiAgaWYgKAogICAgcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gIndpbjMyIiAmJgogICAgdHlwZW9mIHByb2Nlc3MuZ2V0dWlkID09PSAiZnVuY3Rpb24iICYmCiAgICAocGFyZW50U3RhdC51aWQgIT09IEJpZ0ludChwcm9jZXNzLmdldHVpZCgpKSB8fCAocGFyZW50U3RhdC5tb2RlICYgMG8wMjJuKSAhPT0gMG4pCiAgKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgcGFyZW50IGlzIG5vdCBwcml2YXRlbHkgb3duZWQgYnkgdGhlIGN1cnJlbnQgdXNlcjogJHtwYXJlbnR9YCk7CiAgfQogIGlmICghaGFzVXNhYmxlRmlsZUlkZW50aXR5KHBhcmVudFN0YXQpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgcGFyZW50IGhhcyBubyBzdGFibGUgZmlsZXN5c3RlbSBpZGVudGl0eTogJHtwYXJlbnR9YCk7CiAgfQogIC8vIERvIG5vdCBjYXNlLWZvbGQgV2luZG93cyBwYXRocyBvciBlbnRyeSBuYW1lcy4gTlRGUyBzdXBwb3J0cyBwZXItZGlyZWN0b3J5CiAgLy8gY2FzZSBzZW5zaXRpdml0eSwgc28gdHdvIGRpZmZlcmVudGx5LWNhc2VkIG5hbWVzIGNhbiBiZSBkaWZmZXJlbnQgZmlsZXMuCiAgLy8gVGhlIHZhbGlkYXRlZCBkaXJlY3RvcnkgaWRlbnRpdHkgaXMgc3RhYmxlIGFjcm9zcyBhbGlhc2VzIGFuZCByZW5hbWVzOwogIC8vIHJlYWxwYXRoLWRlcml2ZWQgZW50cnkgY2FzaW5nIGRpc3Rpbmd1aXNoZXMgZXhpc3Rpbmcgd3JhcHBlciBlbnRyaWVzLgogIGNvbnN0IGlkZW50aXR5ID0gYHBhcmVudDoke3BhcmVudFN0YXQuZGV2fToke3BhcmVudFN0YXQuaW5vfTpuYW1lOiR7ZW50cnlOYW1lfWA7CiAgY29uc3QgZGlnZXN0ID0gY3JlYXRlSGFzaCgic2hhMjU2IikudXBkYXRlKGlkZW50aXR5KS5kaWdlc3QoImhleCIpOwogIHJldHVybiBqb2luKHJlZ2lzdHJ5LCBgJHtkaWdlc3R9LnNxbGl0ZWApOwp9Cg==";
let activationLockIdentityModulePromise;
function loadActivationLockIdentityModule() {
  activationLockIdentityModulePromise ??= import(
    `data:text/javascript;base64,${AGENC_ACTIVATION_LOCK_IDENTITY_SOURCE_BASE64}`,
  );
  return activationLockIdentityModulePromise;
}
// END GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE

function activationTestDelay(name) {
  const raw = process.env[name];
  if (raw === undefined) return;
  if (!/^\d+$/.test(raw) || Number(raw) > 5_000) throw new Error(`invalid ${name}`);
  sleep(Number(raw));
}
function cleanupTestFailure(name, message) {
  const raw = process.env[name];
  if (raw === undefined) return;
  if (raw !== "1") throw new Error(`invalid ${name}`);
  throw new Error(message);
}
async function activationMain() {
  const desiredPath = archivePath;
  const wrapperPath = installDir;
  const [
    {
      acquireLocalSqliteLock,
      acquireLocalSqliteLocks,
      assertLocalPrivateDirectory,
      assertLocalPrivateFile,
    },
    {
      existingAgenCHomeIdentity,
      resolveActivationLockRegistry,
      wrapperActivationLockPath,
    },
    { parseGeneratedWrapperContent, renderGeneratedWrapperContent },
  ] = await Promise.all([
    loadSqliteLockModule(),
    loadActivationLockIdentityModule(),
    loadGeneratedWrapperModule(),
  ]);
  const agencHome = typeof binRel === "string" && isAbsolute(binRel)
    ? realpathSync(resolve(binRel))
    : undefined;
  const agencHomeIdentity = agencHome === undefined
    ? undefined
    : existingAgenCHomeIdentity(agencHome);
  const targetVersion = expectedSha;
  const allowDowngrade = artifactPlatform === "true";
  if (!isAbsolute(wrapperPath) || agencHomeIdentity === undefined ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
    throw new Error("invalid wrapper activation arguments");
  }
  let desired = readFileSync(desiredPath, "utf8");
  const desiredWrapper = parseGeneratedWrapperContent(wrapperPath, desired);
  if (desiredWrapper === null) throw new Error("desired wrapper is not generated by AgenC");
  const runtimeRoot = join(agencHome, "runtime");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  chmodLockSync(runtimeRoot, 0o700);
  const activationLock = join(runtimeRoot, ".activation-lock.sqlite");
  const journalPath = join(runtimeRoot, ".activation-transaction.json");
  const timeoutMs = 120_000;
  const deadline = performance.now() + timeoutMs;
  const releaseHomeLock = await acquireLocalSqliteLock(activationLock, {
    label: "wrapper activation", timeoutMs, deadline,
  });
  let releaseWrapperLocks;
  let result = "activated";
  let operationError;
  try {
    const wrapperLockRegistry = resolveActivationLockRegistry();
    const wrapperPaths = new Set([resolve(wrapperPath)]);
    const interrupted = readOptionalFile(journalPath);
    if (interrupted !== null) {
      for (const entry of validateActivationTransaction(
        interrupted,
        parseGeneratedWrapperContent,
      ).entries) {
        wrapperPaths.add(resolve(entry.path));
      }
    }
    const wrapperParents = new Set([...wrapperPaths].map((path) => dirname(path)));
    await Promise.all([...wrapperParents].map(async (path) => {
      const canonical = await assertLocalPrivateDirectory(path, {
        label: "wrapper activation", timeoutMs, deadline,
      });
      if (canonical !== resolve(path)) {
        throw new Error(`wrapper parent must use its canonical path: ${path}`);
      }
    }));
    releaseWrapperLocks = await acquireLocalSqliteLocks(
      [...wrapperPaths].map((path) => wrapperActivationLockPath(path, wrapperLockRegistry)),
      { label: "wrapper activation", timeoutMs, deadline },
    );
    activationTestDelay("AGENC_INSTALL_TEST_HOLD_ACTIVATION_LOCK_MS");
    for (const path of wrapperPaths) {
      if (!existsSync(path)) continue;
      const canonical = await assertLocalPrivateFile(path, {
        label: "wrapper activation", timeoutMs, deadline,
      });
      if (canonical !== resolve(path)) {
        throw new Error(`wrapper must use its canonical path: ${path}`);
      }
    }
    await completeActivationTransaction(journalPath, parseGeneratedWrapperContent);
    const original = readOptionalFile(wrapperPath);
    const originalWrapper = original === null
      ? null
      : parseGeneratedWrapperContent(wrapperPath, original);
    if (original !== null && originalWrapper === null) {
      throw new Error(`refusing to replace a wrapper not generated by AgenC: ${wrapperPath}`);
    }
    if (originalWrapper !== null &&
        existingAgenCHomeIdentity(originalWrapper.agencHome) !== agencHomeIdentity) {
      throw new Error(`wrapper belongs to a different AGENC_HOME: ${wrapperPath}`);
    }
    const currentVersion = activeRuntimeVersion(originalWrapper, agencHome);
    if (original !== null && currentVersion === undefined) {
      throw new Error(`wrapper runtime target is outside its AGENC_HOME: ${wrapperPath}`);
    }
    if (existingAgenCHomeIdentity(desiredWrapper.agencHome) !== agencHomeIdentity ||
        activeRuntimeVersion(desiredWrapper, agencHome) !== targetVersion) {
      throw new Error("desired wrapper metadata does not match its AGENC_HOME/runtime version");
    }
    activationTestDelay("AGENC_INSTALL_TEST_AFTER_ACTIVATION_READ_MS");
    if (!allowDowngrade && currentVersion !== undefined && compareSemver(currentVersion, targetVersion) > 0) {
      result = `retained ${currentVersion}`;
      return;
    }
    let stableNode;
    if (process.platform === "darwin" && desiredWrapper.nodeBin.includes("/darwin-")) {
      const stable = await loadStableNodeModule();
      stableNode = stable.describeStableNode(agencHome, desiredWrapper.nodeBin);
      desired = renderGeneratedWrapperContent({ ...desiredWrapper, nodeBin: stable.stableNodePath(agencHome) });
    }
    const transaction = {
      ...(stableNode === undefined ? {} : { stableNode, previousVersion: currentVersion }),
      version: 1,
      targetVersion,
      entries: [{ path: wrapperPath, original, desired, mode: desiredWrapper.kind === "cmd" ? 0o644 : 0o755 }],
    };
    const serializedTransaction = `${JSON.stringify(transaction)}\n`;
    validateActivationTransaction(serializedTransaction, parseGeneratedWrapperContent);
    replaceFileAtomically(journalPath, serializedTransaction, 0o600);
    await completeActivationTransaction(journalPath, parseGeneratedWrapperContent);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const releaseErrors = [];
    try { releaseWrapperLocks?.(); } catch (error) { releaseErrors.push(error); }
    try { releaseHomeLock(); } catch (error) { releaseErrors.push(error); }
    process.stdout.write(`${result}\n`);
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? releaseErrors : [operationError, ...releaseErrors],
        "wrapper activation and lock release did not both complete",
      );
    }
  }
}

async function runtimeMain() {
  const versionDir = dirname(installDir);
  const base = basename(installDir);
  mkdirSync(versionDir, { recursive: true, mode: 0o700 });
  chmodLockSync(versionDir, 0o700);
  const { acquireLocalSqliteLock, assertLocalPrivateDirectory } =
    await loadSqliteLockModule();
  const canonicalVersionDir = await assertLocalPrivateDirectory(versionDir, {
    label: "runtime cache validation",
    timeoutMs: 120_000,
  });
  if (canonicalVersionDir !== resolve(versionDir)) {
    throw new Error(`runtime version directory must use its canonical path: ${versionDir}`);
  }
  if (await trustedReadyAt(installDir, assertLocalPrivateDirectory) &&
      !hasResidue(versionDir, base)) {
    if (mode === "recover") process.stdout.write("ready\n");
    return;
  }
  const lockPath = `${installDir}.agenc-lock.sqlite`;
  const releaseLock = await acquireLocalSqliteLock(lockPath, {
    label: "runtime install",
    timeoutMs: 120_000,
  });
  let stagingDir;
  let operationError;
  try {
    activationTestDelay("AGENC_INSTALL_TEST_HOLD_RUNTIME_LOCK_MS");
    const recovered = await reconcile(versionDir, base, assertLocalPrivateDirectory);
    if (mode === "recover") {
      process.stdout.write(recovered ? "ready\n" : "missing\n");
      return;
    }
    if (recovered) return;
    validateArchive(archivePath);
    stagingDir = mkdtempSync(join(versionDir, `.${base}.install-`));
    let verifiedExtractionTool = extractionTool;
    let verifiedExtractionEnvironment;
    let verifiedExtractionWorkingDirectory = stagingDir;
    if (process.platform === "win32") {
      verifiedExtractionTool = trustedWindowsTarExecutable();
      if (
        win32.normalize(extractionTool).toLowerCase() !==
          verifiedExtractionTool.toLowerCase()
      ) {
        throw new Error("runtime extraction tool is not the trusted Windows tar path");
      }
      const system32 = win32.dirname(verifiedExtractionTool);
      const systemRoot = win32.dirname(system32);
      verifiedExtractionWorkingDirectory = system32;
      verifiedExtractionEnvironment = {
        APPDATA: "",
        COMSPEC: win32.join(system32, "cmd.exe"),
        HOME: "",
        HOMEDRIVE: "",
        HOMEPATH: "",
        LOCALAPPDATA: "",
        LOGONSERVER: "",
        PATH: system32,
        PATHEXT: ".COM;.EXE",
        PSModulePath: "",
        SYSTEMDRIVE: "",
        SystemRoot: systemRoot,
        TEMP: win32.join(systemRoot, "Temp"),
        TMP: win32.join(systemRoot, "Temp"),
        USERDOMAIN: "",
        USERNAME: "",
        USERPROFILE: system32,
        WINDIR: systemRoot,
      };
    } else {
      if (!isAbsolute(extractionTool)) {
        throw new Error("runtime extraction tool must be an absolute path");
      }
      const extractionToolStat = lstatSync(extractionTool);
      if (!extractionToolStat.isFile() || extractionToolStat.isSymbolicLink()) {
        throw new Error("runtime extraction tool must be a regular file");
      }
    }
    const extracted = spawnSync(
      verifiedExtractionTool,
      ["-xzf", archivePath, "-C", stagingDir],
      {
        cwd: verifiedExtractionWorkingDirectory,
        stdio: "inherit",
        ...(verifiedExtractionEnvironment === undefined
          ? {}
          : { env: verifiedExtractionEnvironment }),
      },
    );
    if (extracted.status !== 0) throw new Error(`tar extraction failed (${extracted.status ?? extracted.signal})`);
    if (!strictRelativeRuntimeFile(stagingDir, binRel)) {
      throw new Error("runtime entrypoint is not a contained regular file");
    }
    if (embeddedNodeRel !== "" && (
      !strictRelativeRuntimeFile(stagingDir, embeddedNodeRel) ||
      !strictRelativeRuntimeFile(stagingDir, "node_modules/.agenc-node/identity.json")
    )) {
      throw new Error("runtime private Node payload is incomplete");
    }
    if (embeddedNodeLibraryRel !== "" &&
        !strictRelativeRuntimeFile(stagingDir, `${embeddedNodeLibraryRel}/libatomic.so.1`)) {
      throw new Error("runtime private Node library payload is incomplete");
    }
    syncTree(stagingDir);
    if (provenanceExpectation !== undefined) {
      const receipt = decodeProvenanceJson(provenanceReceiptBase64, "provenance receipt");
      if (!validProvenanceReceipt(receipt)) throw new Error("invalid provenance receipt");
      writeFileDurably(
        join(stagingDir, PROVENANCE_RECEIPT_NAME),
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 },
      );
    } else if (provenanceReceiptBase64 !== "") {
      throw new Error("unexpected provenance receipt");
    }
    writeFileDurably(join(stagingDir, ".agenc-runtime-ok"), expectedSha, { mode: 0o600 });
    syncDirectory(stagingDir);
    promote(stagingDir, installDir);
    stagingDir = undefined;
    if (!(await reconcile(versionDir, base, assertLocalPrivateDirectory))) {
      throw new Error("promoted runtime failed its marker contract");
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (stagingDir !== undefined) {
      try {
        removeDurably(stagingDir, { recursive: true, force: true });
        cleanupTestFailure(
          "AGENC_INSTALL_TEST_FAIL_STAGING_CLEANUP",
          "injected staging cleanup failure",
        );
      }
      catch (error) { cleanupErrors.push(error); }
    }
    try {
      releaseLock();
      if (mode === "install") {
        cleanupTestFailure(
          "AGENC_INSTALL_TEST_FAIL_RELEASE_CLEANUP",
          "injected release cleanup failure",
        );
      }
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "runtime install and cleanup did not both complete",
      );
    }
  }
}
async function renderWrapperMain() {
  const { parseGeneratedWrapperContent, renderGeneratedWrapperContent } =
    await loadGeneratedWrapperModule();
  const kind = artifactPlatform;
  const content = renderGeneratedWrapperContent({
    kind,
    nodeBin: installDir,
    runtimeBin: binRel,
    agencHome: expectedSha,
    ...(extractionTool === "" ? {} : { nodeLibraryPath: extractionTool }),
  });
  if (parseGeneratedWrapperContent(resolve(archivePath), content) === null) {
    throw new Error("rendered wrapper failed canonical validation");
  }
  writeFileSync(archivePath, content, {
    flag: "wx",
    mode: kind === "cmd" ? 0o644 : 0o755,
  });
}
async function prepareWrapperDirectoriesMain() {
  const prefix = resolve(archivePath);
  const wrapperDirectory = resolve(installDir);
  const repairExisting = binRel === "true";
  if (
    !isAbsolute(archivePath) ||
    !isAbsolute(installDir) ||
    wrapperDirectory !== join(prefix, "bin") ||
    !["true", "false"].includes(binRel)
  ) {
    throw new Error("invalid wrapper directory preparation arguments");
  }

  const prefixExisted = existsSync(prefix);
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const prefixSecured = secureOwnerDirectory(prefix, {
    repairWritable: repairExisting,
    ownerOnly: !prefixExisted,
  });
  let repairedExisting = prefixExisted && prefixSecured;

  const wrapperDirectoryExisted = existsSync(wrapperDirectory);
  mkdirSync(wrapperDirectory, { recursive: true, mode: 0o700 });
  const wrapperDirectorySecured = secureOwnerDirectory(wrapperDirectory, {
    repairWritable: repairExisting,
    ownerOnly: !wrapperDirectoryExisted,
  });
  repairedExisting =
    (wrapperDirectoryExisted && wrapperDirectorySecured) || repairedExisting;

  const { assertLocalPrivateDirectory } = await loadSqliteLockModule();
  for (const path of [prefix, wrapperDirectory]) {
    const canonical = await assertLocalPrivateDirectory(path, {
      label: "wrapper directory preparation",
      timeoutMs: 120_000,
    });
    if (canonical !== path) {
      throw new Error(`wrapper directory must use its canonical path: ${path}`);
    }
  }
  process.stdout.write(repairedExisting ? "repaired\n" : "ready\n");
}
async function main() {
  if (["begin-update", "end-update", "prune"].includes(mode)) {
    if (process.platform !== "darwin") return;
    const maintenance = await loadRuntimeMaintenanceModule();
    if (mode === "begin-update") process.stdout.write(await maintenance.beginRuntimeUpdate(archivePath, Number(installDir)));
    if (mode === "end-update") maintenance.endRuntimeUpdate(archivePath);
    if (mode === "prune") process.stdout.write(JSON.stringify(await maintenance.pruneRuntimes(archivePath)) + "\n");
  }
  else if (mode === "render-wrapper") await renderWrapperMain();
  else if (mode === "prepare-wrapper-directories") await prepareWrapperDirectoriesMain();
  else if (mode === "activate") await activationMain();
  else await runtimeMain();
}
function installerErrorMessages(error, seen = new Set()) {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    if (seen.has(error)) return [];
    seen.add(error);
  }
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.flatMap((item) => installerErrorMessages(item, seen)),
    ];
  }
  return [error instanceof Error ? error.message : String(error)];
}
main().catch((error) => {
  console.error(installerErrorMessages(error).join("\n"));
  process.exitCode = 1;
});
// END GENERATED AGENC RUNTIME INSTALLER PROGRAM
AGENC_RUNTIME_INSTALLER

BIN_DIR="${PREFIX}/bin"
WRAPPER="${BIN_DIR}/agenc"
REPAIR_EXISTING_WRAPPER_DIRS=false
[ "$PREFIX_EXPLICIT" -eq 0 ] && REPAIR_EXISTING_WRAPPER_DIRS=true
WRAPPER_DIRECTORY_RESULT="$(node "$RUNTIME_INSTALLER_JS" prepare-wrapper-directories \
  "$PREFIX" "$BIN_DIR" "$REPAIR_EXISTING_WRAPPER_DIRS")" || \
  fail "could not prepare secure wrapper directory: $BIN_DIR"
case "$WRAPPER_DIRECTORY_RESULT" in
  ready) : ;;
  repaired) log "secured existing default wrapper directories: ${PREFIX}, ${BIN_DIR}" ;;
  *) fail "wrapper directory preparation returned an invalid result" ;;
esac

if [ "$OS" = darwin ]; then
  UPDATE_LEASE="$(node "$RUNTIME_INSTALLER_JS" begin-update "$AGENC_HOME_DIR" "$$")" ||
    fail "could not register runtime update"
fi

RECOVERY_STATE="$(node "$RUNTIME_INSTALLER_JS" recover - "$INSTALL_DIR" "$BIN_REL" "$ARTIFACT_SHA" "$OS" \
  "$PROVENANCE_EXPECTATION_BASE64" "" "" "$NODE_BIN_REL" "$NODE_LIBRARY_REL")" || \
  fail "runtime crash recovery failed"

if [ "$RECOVERY_STATE" = "ready" ]; then
  step "runtime ${VERSION} already installed (verified marker) — skipping download" \
    "Runtime ${VERSION} already installed" "verified marker"
elif [ "$RECOVERY_STATE" = "missing" ]; then
  if [ "$UI" = 1 ]; then
    step_begin "Downloading runtime ${VERSION}"
  else
    log "downloading runtime ${VERSION} (${OS}-${ARCH}/abi${ARTIFACT_ABI})..."
  fi
  TARBALL="$WORK/runtime.tar.gz"
  # Scoped to this one call: the runtime artifact is the only download whose
  # size a person waits on, and the only one whose exact size the manifest pins.
  AGENC_INSTALL_PROGRESS="${UI_STYLE:-}" \
  fetch_to "$ARTIFACT_URL" "$TARBALL" "$MAX_ARTIFACT_BYTES" "$ARTIFACT_BYTES" "$MANIFEST_TRUST" || \
    fail "bounded download failed: ${ARTIFACT_URL}"
  # UI only: the plain log already announced this download in one line, and a
  # second "done" line would change bytes that logs and tests depend on.
  if [ "$UI" = 1 ]; then
    step "" "Runtime ${VERSION} downloaded" "${OS}-${ARCH}/abi${ARTIFACT_ABI}"
  fi

  ACTUAL_SHA="$(sha256_of "$TARBALL")" || fail "sha256 computation failed"
  if [ "$ACTUAL_SHA" != "$ARTIFACT_SHA" ]; then
    fail "checksum mismatch for runtime tarball (expected ${ARTIFACT_SHA}, got ${ACTUAL_SHA}). Refusing to install."
  fi
  ACTUAL_BYTES="$(node -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).size))' "$TARBALL")" \
    || fail "byte-count computation failed"
  if [ "$ACTUAL_BYTES" != "$ARTIFACT_BYTES" ]; then
    fail "byte count mismatch for runtime tarball (expected ${ARTIFACT_BYTES}, got ${ACTUAL_BYTES}). Refusing to install."
  fi
  step "checksum verified" "Checksum verified" \
    "sha256 $(printf '%.12s' "$ARTIFACT_SHA")…"

  verify_official_provenance ||
    fail "official runtime provenance verification failed"

  # Validate every tar/PAX member before invoking tar, then acquire the same
  # per-artifact lock used by the npm launcher and `agenc update`. Extraction
  # happens in a unique sibling directory and is atomically promoted only
  # after the entrypoint and marker are complete.
  node "$RUNTIME_INSTALLER_JS" install "$TARBALL" "$INSTALL_DIR" "$BIN_REL" "$ARTIFACT_SHA" "$OS" \
    "$PROVENANCE_EXPECTATION_BASE64" "$PROVENANCE_RECEIPT_BASE64" "$SYSTEM_TAR" \
    "$NODE_BIN_REL" "$NODE_LIBRARY_REL" || \
    fail "runtime archive validation or installation failed"
  # AGENC_HOME holds auth tokens, the daemon cookie, and transcripts.
  chmod 700 "$AGENC_HOME_DIR"
  step "runtime ${VERSION} installed at ${INSTALL_DIR}" "Runtime installed" \
    "$(ui_path "${AGENC_HOME_DIR}/runtime/${VERSION}")"
else
  fail "runtime crash recovery returned an invalid state"
fi

# --- wrapper -----------------------------------------------------------------

# Modern artifacts carry their own exact Node runtime. The bootstrap Node is
# temporary and must never leak into the durable wrapper. The private Node must
# be the exact Node the release manifest's build record names, so a pinned
# older release keeps installing after this installer pins a newer Node. A
# local manifest has no verified build record and uses the installer's pin.
if [ -n "$NODE_BIN_REL" ]; then
  PRIVATE_NODE_VERSION="${MANIFEST_NODE_VERSION#v}"
  [ -n "$PRIVATE_NODE_VERSION" ] || PRIVATE_NODE_VERSION="$SUPPORTED_NODE_VERSION"
  if [ -n "$PRIVATE_NODE_LIBRARY" ]; then
    LD_LIBRARY_PATH="$PRIVATE_NODE_LIBRARY" "$PRIVATE_NODE_BIN" -e '
      if (!/^\d+\.\d+\.\d+$/.test(process.argv[3]) ||
          process.versions.node !== process.argv[3] || process.versions.modules !== "147" ||
          process.versions.napi !== "10" || process.platform !== process.argv[1] ||
          process.arch !== process.argv[2]) process.exit(1);
    ' "$OS" "$ARCH" "$PRIVATE_NODE_VERSION" >/dev/null 2>&1 ||
      fail "installed private Node.js identity is invalid"
  else
    "$PRIVATE_NODE_BIN" -e '
      if (!/^\d+\.\d+\.\d+$/.test(process.argv[3]) ||
          process.versions.node !== process.argv[3] || process.versions.modules !== "147" ||
          process.versions.napi !== "10" || process.platform !== process.argv[1] ||
          process.arch !== process.argv[2]) process.exit(1);
    ' "$OS" "$ARCH" "$PRIVATE_NODE_VERSION" >/dev/null 2>&1 ||
      fail "installed private Node.js identity is invalid"
  fi
fi

WRAPPER_TMP="${WORK}/agenc-wrapper"
node "$RUNTIME_INSTALLER_JS" render-wrapper "$WRAPPER_TMP" "$PRIVATE_NODE_BIN" "$RUNTIME_BIN" \
  "$AGENC_HOME_DIR" posix "" "" "$PRIVATE_NODE_LIBRARY" || \
  fail "could not render wrapper"
ALLOW_DOWNGRADE=false
[ -n "$PIN_VERSION" ] && ALLOW_DOWNGRADE=true
ACTIVATION_RESULT="$(node "$RUNTIME_INSTALLER_JS" activate "$WRAPPER_TMP" "$WRAPPER" "$AGENC_HOME_DIR" "$VERSION" "$ALLOW_DOWNGRADE")" || \
  fail "wrapper activation failed; any durable activation journal will resume on retry"
rm -f "$WRAPPER_TMP"
case "$ACTIVATION_RESULT" in
  retained\ *) log "kept newer active wrapper (${ACTIVATION_RESULT#retained }): ${WRAPPER}" ;;
  activated) step "installed wrapper: ${WRAPPER}" "Wrapper installed" "$(ui_path "$WRAPPER")" ;;
  *) fail "wrapper activation returned an invalid result" ;;
esac

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
  SYSTEMD_WRAPPER="$(node -e '
    const value = process.argv[1];
    if (/[\0-\x1f\x7f]/.test(value)) throw new Error("systemd executable path contains a control character");
    const escaped = value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%");
    process.stdout.write(`:\"${escaped}\"`);
  ' "$WRAPPER")" || fail "could not encode daemon wrapper path for systemd"
  UNIT_DIR="${HOME}/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "${UNIT_DIR}/agenc-daemon.service" <<EOF
[Unit]
Description=AgenC daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${SYSTEMD_WRAPPER} daemon start --foreground
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
  if systemctl --user daemon-reload && systemctl --user enable --now agenc-daemon.service; then
    step "daemon installed and started (systemd user service agenc-daemon)" \
      "Daemon running" "systemd user service"
  else
    log "WARNING: could not enable the systemd user service — start manually: agenc daemon start"
  fi
}

install_daemon_darwin() {
  PLIST_DIR="${HOME}/Library/LaunchAgents"
  PLIST="${PLIST_DIR}/dev.agenc.daemon.plist"
  mkdir -p "$PLIST_DIR"
  XML_WRAPPER="$(node -e '
    const value = process.argv[1];
    if (/\0|[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("launchd path contains an XML-invalid character");
    process.stdout.write(value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("\u0027", "&apos;")
      .replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("\t", "&#9;"));
  ' "$WRAPPER")" || fail "could not encode daemon wrapper path for launchd"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agenc.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${XML_WRAPPER}</string>
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
    step "daemon installed and started (launchd dev.agenc.daemon)" \
      "Daemon running" "launchd agent"
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

# The lease spans the whole install. Cleanup runs only after activation and
# service setup succeed, and skips if another installer/updater owns a lease.
if [ "$OS" = darwin ] && [ "$ACTIVATION_RESULT" = activated ]; then
  node "$RUNTIME_INSTALLER_JS" end-update "$UPDATE_LEASE"
  UPDATE_LEASE=""
  node "$RUNTIME_INSTALLER_JS" prune "$AGENC_HOME_DIR" ||
    log "Runtime cleanup deferred"
fi

# --- done --------------------------------------------------------------------

# Ubuntu 24.04+ restricts the unprivileged user namespace bubblewrap needs, so
# the sandbox is dead on arrival and the first message fails with an error that
# is easy to mistake for a bug. Say so at install time, while the wrapper this
# profile must attach to is exactly the one just installed.
apparmor_userns_restricted() {
  [ "$OS" = "linux" ] || return 1
  restrict_path=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  [ -r "$restrict_path" ] || return 1
  [ "$(cat "$restrict_path" 2>/dev/null)" = "1" ] || return 1
  # Already installed: nothing to prompt.
  [ ! -e /etc/apparmor.d/agenc-native-userns ]
}

if apparmor_userns_restricted; then
  if [ "$UI" = 1 ]; then
    printf '\n  %s%s%s  This system restricts the user namespace AgenC'"'"'s sandbox needs,\n' \
      "$UI_YELLOW" "$UI_WARN" "$UI_RESET" >&2
  else
    printf '\n  Note: this system restricts the user namespace AgenC'"'"'s sandbox needs,\n' >&2
  fi
  printf '  so sandboxed commands will fail until you install its AppArmor profile:\n\n' >&2
  printf '    agenc doctor --apparmor-profile |\n' >&2
  printf '      sudo tee /etc/apparmor.d/agenc-native-userns >/dev/null\n' >&2
  printf '    sudo apparmor_parser -r /etc/apparmor.d/agenc-native-userns\n\n' >&2
  printf '  Then run `agenc doctor` to confirm. See docs/install.md for details.\n' >&2
fi

# Where things landed. The banner below already says "AgenC <version> installed",
# welcomes, and lists next steps, so this adds only the paths -- the one thing
# the collapsed phase lines no longer leave on screen. Redirected stderr keeps
# the single sentence logs have always ended on.
if [ "$UI" = 1 ]; then
  if [ "$INSTALL_DAEMON" = 1 ]; then ui_daemon="running"; else ui_daemon="not installed (--no-daemon)"; fi
  printf '\n  %sbinary%s   %s\n' "$UI_DIM" "$UI_RESET" "$(ui_path "$WRAPPER")" >&2
  printf '  %sruntime%s  %s\n' "$UI_DIM" "$UI_RESET" \
    "$(ui_path "${AGENC_HOME_DIR}/runtime/${VERSION}")" >&2
  printf '  %sdaemon%s   %s\n' "$UI_DIM" "$UI_RESET" "$ui_daemon" >&2
else
  log "install complete"
fi
# Brand "agenc" wordmark — quadrant-block rendering of assets/agenc-wordmark.svg
# (the letterforms, not the icon; 2x2 sub-cell blocks for smoother curves).
# Unicode blocks only on UTF-8 locales, with a plain-text fallback; brand
# purple only on a color-capable TTY (NO_COLOR respected; empty in pipes/CI so
# the banner stays plain + testable).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  wm_color="$(printf '\033[38;5;99m')"; wm_reset="$(printf '\033[0m')"
else
  wm_color=""; wm_reset=""
fi

printf '\n  AgenC %s installed.\n\n  Welcome to\n\n%s' "$VERSION" "$wm_color"
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]*8*)
    cat <<'WORDMARK'
    ▗▟███▙▖     ▗▟██▙▖ ▄▄    ▗▟███▄    ▄▄ ▗▟██▙▖     ▐██████
   ▗██▀▀▀██▖   ▟██▀▀▜█▖██   ▟██▀▀▜█▙   ██▄█▀▀▜██▖    ▐██████
  ▗██    ▝█▙  ▗█▛▘   ▝███  ▐█▛    ▜█▙  ██▛    ▝██  ▐█▌      ██
  ▐█▌     ██  ██▘     ▐██  ██      ██  ██      ██▖ ▐█▌      ██
  ▝▀     ▟██  ██      ▝██ ▗█▛      ▐█▌ ██      ▐█▌ ▐█▌
      ▗▄████ ▗█▌       ██ ▐██████████▌ ██      ▐█▌ ▐█▌
    ▄███▀ ██ ▐█▌       ██ ▐█▛▀▀▀▀▀▀▀▀▘ ██      ▐█▌ ▐█▌
  ▗██▀▘   ██ ▝█▙       ██ ▐█▌          ██      ▐█▌ ▐█▌
  ▟█▘     ██  ██      ▗██ ▝█▙      ▐█▌ ██      ▐█▌ ▐█▌      ▄▄
  ██      ██  ▜█▌     ▟██  ██▖     ██  ██      ▐█▌ ▐█▌      ██
  ██▖   ▗▟██  ▝██▖   ▟▛██  ▝█▙▖   ▟█▌  ██      ▐█▌ ▝▀▚▄▄▄▄▄▄▀▀
  ▝██▙▄██▀██   ▝█████▛ ██   ▀██▙▟██▛   ██      ▐█▌   ▐██████
   ▝▀▀▀▀▘ ▀▀     ▀▀▀▀  ██    ▝▀▜█▀▘    ▀▀      ▝▀▘   ▝▀▀▀▀▀▀
              ▄▄       ██
              ▐█▙     ▟█▌
               ▜█▙▄▄▄▟█▛
                ▀▜███▛▀
WORDMARK
    ;;
  *) printf '  agenc\n' ;;
esac
printf '%s\n  Next steps:\n    agenc onboard          # guided setup: provider, key, theme, first chat\n    agenc security audit   # check exposure + permissions (--fix for safe fixes)\n    agenc daemon status\n\n' \
  "$wm_reset"
