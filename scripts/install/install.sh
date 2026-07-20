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
#   AGENC_HOME              runtime install root (default: ~/.agenc)
#
# Test seams (used by runtime/tests/packaging/install-sh.test.ts):
#   AGENC_INSTALL_PLATFORM / AGENC_INSTALL_ARCH and AGENC_INSTALL_*_VERSION
#   override Node compatibility detection.
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
NODE_USE_ENV_PROXY=1
export NODE_USE_ENV_PROXY

OFFICIAL_REPO="tetsuo-ai/agenc-releases"
REPO="${AGENC_INSTALL_REPO:-tetsuo-ai/agenc-releases}"
MANIFEST_URL="${AGENC_INSTALL_MANIFEST_URL:-}"
MANIFEST_EXPLICIT=0
[ -n "$MANIFEST_URL" ] && MANIFEST_EXPLICIT=1
PIN_VERSION=""
PREFIX="${HOME}/.local"
INSTALL_DAEMON=1
SUPPORTED_NODE_MAJOR=25
SUPPORTED_NODE_MINOR=9
MAX_MANIFEST_BYTES=1048576
MAX_ARTIFACT_BYTES=268435456
MAX_SIGSTORE_BUNDLE_BYTES=4194304
MAX_GH_ARCHIVE_BYTES=67108864
PROVENANCE_SCHEMA="agenc-runtime-provenance/v1"
PROVENANCE_REPOSITORY="tetsuo-ai/agenc-core"
PROVENANCE_WORKFLOW="tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml"
PROVENANCE_HOSTNAME="github.com"
PROVENANCE_OIDC_ISSUER="https://token.actions.githubusercontent.com"
PROVENANCE_PREDICATE_TYPE="https://slsa.dev/provenance/v1"

log() { printf 'agenc-install: %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) PIN_VERSION="${2:?--version needs a value}"; shift 2 ;;
    --manifest-url) MANIFEST_URL="${2:?--manifest-url needs a value}"; MANIFEST_EXPLICIT=1; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    --no-daemon) INSTALL_DAEMON=0; shift ;;
    -h|--help) sed -n '2,30p' "$0" 2>/dev/null; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

# --- prerequisites -----------------------------------------------------------

command -v node >/dev/null 2>&1 || fail \
  "Node.js ${SUPPORTED_NODE_MAJOR}.${SUPPORTED_NODE_MINOR}.x is required. Install it (https://nodejs.org) and re-run."

NODE_BIN="$(command -v node)"
NODE_BIN="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$NODE_BIN")" || \
  fail "could not resolve Node.js executable"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" \
  || fail "could not determine Node.js version"
NODE_MINOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[1]))')" \
  || fail "could not determine Node.js version"
[ "$NODE_MAJOR" -eq "$SUPPORTED_NODE_MAJOR" ] 2>/dev/null && \
  [ "$NODE_MINOR" -ge "$SUPPORTED_NODE_MINOR" ] 2>/dev/null || fail \
  "Node.js >=${SUPPORTED_NODE_MAJOR}.${SUPPORTED_NODE_MINOR} <26 required, found $(node -v). Install the supported release and re-run."
NODE_MODULE_ABI="$(node -e 'process.stdout.write(String(process.versions.modules))')" \
  || fail "could not determine the Node.js native module ABI"
case "$NODE_MODULE_ABI" in
  ''|*[!0-9]*) fail "Node.js reported an invalid native module ABI: ${NODE_MODULE_ABI}" ;;
esac
resolve_system_tool() {
  node -e '
    const { lstatSync, realpathSync, statSync } = require("node:fs");
    const { dirname, isAbsolute } = require("node:path");
    for (const candidate of process.argv.slice(1)) {
      if (!candidate || !isAbsolute(candidate)) continue;
      try {
        const path = realpathSync(candidate);
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
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
fi

# --- platform ----------------------------------------------------------------

detect_platform() {
  if [ -n "${AGENC_INSTALL_PLATFORM:-}" ]; then
    case "$AGENC_INSTALL_PLATFORM" in
      linux|darwin) printf '%s' "$AGENC_INSTALL_PLATFORM"; return ;;
      *) fail "unsupported Node.js platform override: $AGENC_INSTALL_PLATFORM" ;;
    esac
  fi
  case "$(node -p 'process.platform')" in
    linux) printf 'linux' ;;
    darwin) printf 'darwin' ;;
    win32) fail "the selected Node.js binary is for Windows; use install.ps1" ;;
    *) fail "unsupported Node.js platform: $(node -p 'process.platform')" ;;
  esac
}

detect_arch() {
  if [ -n "${AGENC_INSTALL_ARCH:-}" ]; then
    case "$AGENC_INSTALL_ARCH" in
      x64|arm64) printf '%s' "$AGENC_INSTALL_ARCH"; return ;;
      *) fail "unsupported Node.js architecture override: $AGENC_INSTALL_ARCH" ;;
    esac
  fi
  case "$(node -p 'process.arch')" in
    x64) printf 'x64' ;;
    arm64) printf 'arm64' ;;
    *) fail "unsupported Node.js architecture: $(node -p 'process.arch')" ;;
  esac
}

OS="$(detect_platform)" || exit 1
ARCH="$(detect_arch)" || exit 1
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
const timeoutText = process.env.AGENC_INSTALL_TEST_DOWNLOAD_TIMEOUT_MS;
const timeoutMs = timeoutText === undefined ? 120_000 : Number(timeoutText);
if (!Number.isSafeInteger(maximum) || maximum < 1 ||
    (exact !== undefined && (!Number.isSafeInteger(exact) || exact < 1 || exact > maximum)) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
  throw new Error("invalid bounded-download byte contract");
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

function byteLimiter() {
  let count = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (count > maximum) {
        callback(new Error(`download exceeds ${maximum} byte limit`));
      } else if (exact !== undefined && count > exact) {
        callback(new Error(`download exceeds declared ${exact} bytes`));
      } else {
        callback(null, chunk);
      }
    },
    flush(callback) {
      if (exact !== undefined && count !== exact) {
        callback(new Error(`download byte count mismatch (expected ${exact}, got ${count})`));
      } else {
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
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    const throwIfExpired = () => {
      if (controller.signal.aborted || performance.now() >= deadline) {
        if (!controller.signal.aborted) controller.abort(timeoutError);
        throw timeoutError;
      }
    };
    const withinDeadline = async (promise) => {
      throwIfExpired();
      let rejectOnAbort;
      const aborted = new Promise((_resolve, reject) => {
        rejectOnAbort = () => reject(timeoutError);
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
          if (controller.signal.aborted) throw timeoutError;
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
            byteLimiter(),
            createWriteStream(destination, { flags: "wx", mode: 0o600 }),
            { signal: controller.signal },
          );
        } catch (error) {
          if (controller.signal.aborted) throw timeoutError;
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

  log "verifying source-workflow provenance for ${ARTIFACT_URL}"
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
  PROVENANCE_RECEIPT_BASE64="$PROVENANCE_EXPECTATION_BASE64"

  rm -f "$BUNDLE" "$GH_ARCHIVE"
  rm -rf "$GH_ROOT" "$GH_CONFIG_ROOT"
  log "source-workflow provenance verified"
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
WORK=""
trap '[ -z "$WORK" ] || rm -rf "$WORK"; rmdir "$INSTALL_TMP_ROOT" 2>/dev/null || true' EXIT INT TERM
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
  if [ -n "$PIN_VERSION" ]; then
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
    if [ "$REPO" = "$OFFICIAL_REPO" ] && [ "$MANIFEST_EXPLICIT" -eq 0 ]; then
      MANIFEST_TRUST="official"
    elif [ "$REPO" = "$OFFICIAL_REPO" ] && [ "$PIN_VERSION" = "0.7.2" ] && \
         [ "$MANIFEST_URL" = "https://github.com/${OFFICIAL_REPO}/releases/download/agenc-v0.7.2/agenc-runtime-manifest.json" ]; then
      MANIFEST_TRUST="officialLegacy"
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

log "fetching release manifest: ${MANIFEST_URL}"
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
            artifact.attestationBytes !== undefined) {
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
      for (const artifact of artifacts) {
        if (artifact.nodeMajor !== b.nodeMajor || artifact.nodeModuleAbi !== b.nodeModuleAbi ||
            artifact.nodeApiVersion !== b.nodeApiVersion) {
          reject("runtime manifest artifact disagrees with build provenance");
        }
      }
    }
  }
  const matches = artifacts.filter(
    (x) => x.platform === os && x.arch === arch && x.nodeModuleAbi === abi,
  );
  if (matches.length !== 1) {
    const have = artifacts
      .map((x) => `${x.platform}-${x.arch}/abi${x.nodeModuleAbi ?? "?"}`)
      .join(", ");
    console.error(matches.length === 0
      ? `no runtime build for ${os}-${arch}/abi${abi} (available: ${have || "none"})`
      : `duplicate runtime builds for ${os}-${arch}/abi${abi}`);
    process.exit(3);
  }
  const a = matches[0];
  if (!versionPattern.test(m.runtimeVersion || "") ||
      a.runtimeVersion !== m.runtimeVersion ||
      !/^[0-9a-f]{64}$/.test(a.sha256 || "") ||
      !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > artifactCeiling ||
      !/^\d+$/.test(a.nodeApiVersion || "") || a.nodeApiVersion !== process.versions.napi ||
      a.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc") {
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
  ].join("\n"));
' "$MANIFEST_FILE" "$OS" "$ARCH" "$NODE_MODULE_ABI" "$MANIFEST_URL" "$PIN_VERSION" "$OFFICIAL_REPO" "$EXPECTED_MANIFEST_REPO" "$MANIFEST_TRUST" "$MAX_ARTIFACT_BYTES" "$MAX_SIGSTORE_BUNDLE_BYTES")" || \
  fail "manifest rejected (${OS}-${ARCH}/abi${NODE_MODULE_ABI})"

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

PROVENANCE_EXPECTATION_BASE64=""
PROVENANCE_RECEIPT_BASE64=""
if [ "$MANIFEST_TRUST" = "official" ]; then
  PROVENANCE_EXPECTATION_BASE64="$(node -e '
    const value = {
      schema: process.argv[1],
      artifactSha256: process.argv[2],
      artifactUrl: process.argv[10],
      sourceRepository: process.argv[3],
      sourceWorkflow: process.argv[4],
      sourceCommit: process.argv[5],
      sourceRef: process.argv[6],
      attestationUrl: process.argv[11],
      attestationSha256: process.argv[12],
      attestationBytes: Number(process.argv[13]),
      verificationPolicy: {
        hostname: process.argv[7],
        certOidcIssuer: process.argv[8],
        predicateType: process.argv[9],
        denySelfHostedRunners: true,
      },
    };
    process.stdout.write(Buffer.from(JSON.stringify(value)).toString("base64"));
  ' "$PROVENANCE_SCHEMA" "$ARTIFACT_SHA" "$PROVENANCE_REPOSITORY" \
    "$PROVENANCE_WORKFLOW" "$SOURCE_COMMIT" "$SOURCE_REF" \
    "$PROVENANCE_HOSTNAME" "$PROVENANCE_OIDC_ISSUER" "$PROVENANCE_PREDICATE_TYPE" \
    "$ARTIFACT_URL" "$ARTIFACT_ATTESTATION_URL" "$ARTIFACT_ATTESTATION_SHA" \
    "$ARTIFACT_ATTESTATION_BYTES")" || \
    fail "could not construct official provenance expectation"
fi

INSTALL_DIR="${AGENC_HOME_DIR}/runtime/${VERSION}/${ARTIFACT_KEY}-sha256-${ARTIFACT_SHA}"
MARKER="${INSTALL_DIR}/.agenc-runtime-ok"
RUNTIME_BIN="${INSTALL_DIR}/${BIN_REL}"

# --- download + verify + extract (idempotent via the marker contract) --------

RUNTIME_INSTALLER_JS="$WORK/runtime-installer.cjs"
cat > "$RUNTIME_INSTALLER_JS" <<'AGENC_RUNTIME_INSTALLER'
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
  chmodSync: chmodLockSync, closeSync, constants: fsConstants, existsSync,
  fchmodSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync,
  openSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} = require("node:fs");
const {
  basename, dirname, isAbsolute, join, posix, relative, resolve,
  sep: pathSeparator,
} = require("node:path");
const { TextDecoder } = require("node:util");
const { gunzipSync } = require("node:zlib");

const [
  mode, archivePath, installDir, binRel, expectedSha, artifactPlatform,
  provenanceExpectationBase64 = "", provenanceReceiptBase64 = "", extractionTool = "",
] = process.argv.slice(2);
if (!["recover", "install", "activate", "render-wrapper"].includes(mode)) throw new Error(`invalid runtime installer mode: ${mode}`);
const BLOCK_SIZE = 512;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_SYMLINK_EXPANSIONS = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const collisionPaths = new Map();

function syncFile(path) {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    // fsyncSync maps to FlushFileBuffers on Windows, the same durability
    // boundary as FileStream.Flush(true).
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
const AGENC_SQLITE_LOCK_SOURCE_BASE64 = "Ly8gQ3Jvc3MtcHJvY2VzcyBsb2NhbCBmaWxlc3lzdGVtIGxvY2tzIGJhY2tlZCBieSBTUUxpdGUncyBPUyBsb2NraW5nIGxheWVyLgovLwovLyBCRUdJTiBJTU1FRElBVEUgb3ducyB0aGUgd3JpdGVyIHJlc2VydmF0aW9uIGZvciB0aGUgY2FsbGVyJ3MgY3JpdGljYWwKLy8gc2VjdGlvbi4gU1FMaXRlIHJlbGVhc2VzIGl0IG9uIGNsb3NlIG9yIHByb2Nlc3MgZGVhdGgsIGluY2x1ZGluZyBTSUdLSUxMLgovLyBBIHByb2Nlc3Mtd2lkZSBGSUZPIHJlZ2lzdHJ5IHByZXZlbnRzIGR1cGxpY2F0ZSBtb2R1bGUgaW5zdGFuY2VzIGZyb20KLy8gYmxvY2tpbmcgb25lIGFub3RoZXIgaW5zaWRlIHN5bmNocm9ub3VzIFNRTGl0ZSBjYWxsczsgY3Jvc3MtcHJvY2VzcyBidXN5Ci8vIGNvbnRlbnRpb24gaXMgcmV0cmllZCBhc3luY2hyb25vdXNseSBhZ2FpbnN0IG9uZSBtb25vdG9uaWMgZGVhZGxpbmUuCgppbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gIm5vZGU6Y2hpbGRfcHJvY2VzcyI7CmltcG9ydCB7CiAgY2htb2QsCiAgbHN0YXQsCiAgbWtkaXIsCiAgb3BlbiwKICByZWFkRmlsZSwKICByZWFscGF0aCwKfSBmcm9tICJub2RlOmZzL3Byb21pc2VzIjsKaW1wb3J0IHsKICBiYXNlbmFtZSwKICBkaXJuYW1lLAogIGpvaW4sCiAgcmVzb2x2ZSwKICBzZXAsCiAgd2luMzIsCn0gZnJvbSAibm9kZTpwYXRoIjsKaW1wb3J0IHsgc2V0VGltZW91dCBhcyBkZWxheSB9IGZyb20gIm5vZGU6dGltZXJzL3Byb21pc2VzIjsKCmNvbnN0IExPQ0tfQVBQTElDQVRJT05fSUQgPSAweDQxNDc0ZTQzOyAvLyAiQUdOQyIKY29uc3QgTE9DS19GT1JNQVRfVkVSU0lPTiA9IDE7CmNvbnN0IFNRTElURV9CVVNZID0gNTsKY29uc3QgUkVHSVNUUllfVkVSU0lPTiA9IDE7CmNvbnN0IFJFR0lTVFJZX1NZTUJPTCA9IFN5bWJvbC5mb3IoIkB0ZXRzdW8tYWkvYWdlbmMuc3FsaXRlLWxvY2stcmVnaXN0cnkiKTsKY29uc3QgTUFYX0JVU1lfUkVUUllfTVMgPSA1MDsKY29uc3QgTUFYX1RJTUVSX0RFTEFZX01TID0gMl8xNDdfNDgzXzY0NzsKY29uc3QgVU5TVVBQT1JURURfRklMRV9JRF82NCA9IDB4ZmZmZl9mZmZmX2ZmZmZfZmZmZm47CmNvbnN0IFdJTkRPV1NfU1lTVEVNX1JPT1QgPSBTdHJpbmcucmF3YFxcP1xHTE9CQUxST09UXFN5c3RlbVJvb3RgOwpjb25zdCBMT0NBTF9GSUxFU1lTVEVNX1RZUEVTID0gbmV3IFNldChbCiAgImFwZnMiLCAiYmNhY2hlZnMiLCAiYnRyZnMiLCAiZXhmYXQiLCAiZXh0MiIsICJleHQzIiwgImV4dDQiLCAiZjJmcyIsCiAgImhmcyIsICJoZnNwbHVzIiwgImpmcyIsICJtc2RvcyIsICJuaWxmczIiLCAibnRmcyIsICJudGZzMyIsICJvdmVybGF5IiwKICAicmFtZnMiLCAicmVpc2VyZnMiLCAidG1wZnMiLCAidWJpZnMiLCAidWZzIiwgInZmYXQiLCAieGZzIiwgInpmcyIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX1JFQURfUklHSFRTID0gbmV3IFNldChbCiAgInJlYWQiLCAibGlzdCIsICJzZWFyY2giLCAiZXhlY3V0ZSIsICJyZWFkYXR0ciIsICJyZWFkZXh0YXR0ciIsICJyZWFkc2VjdXJpdHkiLApdKTsKY29uc3QgREFSV0lOX0FDTF9JTkhFUklUQU5DRV9GTEFHUyA9IG5ldyBTZXQoWwogICJmaWxlX2luaGVyaXQiLCAiZGlyZWN0b3J5X2luaGVyaXQiLCAibGltaXRfaW5oZXJpdCIsICJvbmx5X2luaGVyaXQiLApdKTsKY29uc3QgREFSV0lOX0FDTF9NVVRBVElPTl9SSUdIVFMgPSBuZXcgU2V0KFsKICAid3JpdGUiLCAiYXBwZW5kIiwgImFkZF9maWxlIiwgImFkZF9zdWJkaXJlY3RvcnkiLCAiZGVsZXRlIiwgImRlbGV0ZV9jaGlsZCIsCiAgIndyaXRlYXR0ciIsICJ3cml0ZWV4dGF0dHIiLCAid3JpdGVzZWN1cml0eSIsICJjaG93biIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX0tOT1dOX1RPS0VOUyA9IG5ldyBTZXQoWwogIC4uLkRBUldJTl9BQ0xfUkVBRF9SSUdIVFMsCiAgLi4uREFSV0lOX0FDTF9JTkhFUklUQU5DRV9GTEFHUywKICAuLi5EQVJXSU5fQUNMX01VVEFUSU9OX1JJR0hUUywKXSk7Cgpjb25zdCBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVCA9IFN0cmluZy5yYXdgCiRFcnJvckFjdGlvblByZWZlcmVuY2UgPSAnU3RvcCcKJGVudHJpZXMgPSBAKENvbnZlcnRGcm9tLUpzb24gLUlucHV0T2JqZWN0ICRlbnY6QUdFTkNfTE9DS19QQVRIU19KU09OKQokY3VycmVudFNpZCA9IFtTeXN0ZW0uU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NJZGVudGl0eV06OkdldEN1cnJlbnQoKS5Vc2VyLlZhbHVlCiR0cnVzdGVkID0gQCgKICAkY3VycmVudFNpZCwKICAnUy0xLTUtMTgnLAogICdTLTEtNS0zMi01NDQnLAogICdTLTEtNS04MC05NTYwMDg4ODUtMzQxODUyMjY0OS0xODMxMDM4MDQ0LTE4NTMyOTI2MzEtMjI3MTQ3ODQ2NCcKKQokbGVhZk11dGF0aW9uTWFzayA9IFtpbnQ2NF04NTIzMTAKJGFuY2VzdG9yTXV0YXRpb25NYXNrID0gW2ludDY0XTg1MjMwNgpmb3JlYWNoICgkZW50cnkgaW4gJGVudHJpZXMpIHsKICAkcmVxdWVzdGVkID0gW3N0cmluZ10kZW50cnkucGF0aAogICRyb2xlID0gW3N0cmluZ10kZW50cnkucm9sZQogIGlmIChAKCdsZWFmRGlyZWN0b3J5JywgJ2FuY2VzdG9yRGlyZWN0b3J5JywgJ2ZpbGUnKSAtbm90Y29udGFpbnMgJHJvbGUpIHsKICAgIHRocm93ICJpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHJvbGU6ICRyb2xlIgogIH0KICAkbXV0YXRpb25NYXNrID0gaWYgKCRyb2xlIC1lcSAnYW5jZXN0b3JEaXJlY3RvcnknKSB7CiAgICAkYW5jZXN0b3JNdXRhdGlvbk1hc2sKICB9IGVsc2UgewogICAgJGxlYWZNdXRhdGlvbk1hc2sKICB9CiAgJGZ1bGwgPSBbU3lzdGVtLklPLlBhdGhdOjpHZXRGdWxsUGF0aChbc3RyaW5nXSRyZXF1ZXN0ZWQpCiAgaWYgKCRmdWxsLlN0YXJ0c1dpdGgoJ1xcJykgLW9yICRmdWxsLlN0YXJ0c1dpdGgoJ1xcP1wnKSAtb3IgJGZ1bGwuU3RhcnRzV2l0aCgnXFwuXCcpKSB7CiAgICB0aHJvdyAibmV0d29yayBhbmQgZGV2aWNlIHBhdGhzIGFyZSB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRpdGVtID0gR2V0LUl0ZW0gLUxpdGVyYWxQYXRoICRmdWxsIC1Gb3JjZQogIGlmICgoJGl0ZW0uQXR0cmlidXRlcyAtYmFuZCBbU3lzdGVtLklPLkZpbGVBdHRyaWJ1dGVzXTo6UmVwYXJzZVBvaW50KSAtbmUgMCkgewogICAgdGhyb3cgInJlcGFyc2UgcG9pbnRzIGFyZSB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRkcml2ZSA9IFtTeXN0ZW0uSU8uRHJpdmVJbmZvXTo6bmV3KFtTeXN0ZW0uSU8uUGF0aF06OkdldFBhdGhSb290KCRmdWxsKSkKICBpZiAoQCgyLCAzLCA2KSAtbm90Y29udGFpbnMgW2ludF0kZHJpdmUuRHJpdmVUeXBlKSB7CiAgICB0aHJvdyAibm9uLWxvY2FsIGRyaXZlIGlzIHVuc3VwcG9ydGVkOiAkZnVsbCIKICB9CiAgaWYgKCRkcml2ZS5Ecml2ZUZvcm1hdCAtbmUgJ05URlMnKSB7CiAgICB0aHJvdyAiZmlsZXN5c3RlbSBjYW5ub3QgZW5mb3JjZSB0aGUgcmVxdWlyZWQgQUNMIGNvbnRyYWN0OiAkZnVsbCIKICB9CiAgJGFjbCA9IEdldC1BY2wgLUxpdGVyYWxQYXRoICRmdWxsCiAgaWYgKC1ub3QgJGFjbC5BcmVBY2Nlc3NSdWxlc0Nhbm9uaWNhbCkgewogICAgdGhyb3cgIm5vbi1jYW5vbmljYWwgQUNMIGlzIHVuc3VwcG9ydGVkOiAkZnVsbCIKICB9CiAgJGJ5dGVzID0gW2J5dGVbXV06Om5ldygkYWNsLkJpbmFyeUxlbmd0aCkKICAkYWNsLkdldFNlY3VyaXR5RGVzY3JpcHRvckJpbmFyeUZvcm0oJGJ5dGVzLCAwKQogICRyYXcgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuUmF3U2VjdXJpdHlEZXNjcmlwdG9yXTo6bmV3KCRieXRlcywgMCkKICBpZiAoJG51bGwgLWVxICRyYXcuRGlzY3JldGlvbmFyeUFjbCkgewogICAgdGhyb3cgIm51bGwgREFDTCBpcyB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRvd25lciA9ICRhY2wuR2V0T3duZXIoW1N5c3RlbS5TZWN1cml0eS5QcmluY2lwYWwuU2VjdXJpdHlJZGVudGlmaWVyXSkuVmFsdWUKICBpZiAoJHRydXN0ZWQgLW5vdGNvbnRhaW5zICRvd25lcikgewogICAgdGhyb3cgInVudHJ1c3RlZCBvd25lciBTSUQgb24gbG9jayBwYXRoOiAkZnVsbCIKICB9CiAgJHJ1bGVzID0gJGFjbC5HZXRBY2Nlc3NSdWxlcygKICAgICR0cnVlLAogICAgJHRydWUsCiAgICBbU3lzdGVtLlNlY3VyaXR5LlByaW5jaXBhbC5TZWN1cml0eUlkZW50aWZpZXJdCiAgKQogIGZvcmVhY2ggKCRydWxlIGluICRydWxlcykgewogICAgaWYgKCRydWxlLkFjY2Vzc0NvbnRyb2xUeXBlIC1uZSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFR5cGVdOjpBbGxvdykgewogICAgICBjb250aW51ZQogICAgfQogICAgJGluaGVyaXRPbmx5ID0gKCRydWxlLlByb3BhZ2F0aW9uRmxhZ3MgLWJhbmQgW1N5c3RlbS5TZWN1cml0eS5BY2Nlc3NDb250cm9sLlByb3BhZ2F0aW9uRmxhZ3NdOjpJbmhlcml0T25seSkgLW5lIDAKICAgIGlmICgkaW5oZXJpdE9ubHkpIHsKICAgICAgJGNoaWxkSW5oZXJpdGFuY2UgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106Ok9iamVjdEluaGVyaXQgLWJvciBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106OkNvbnRhaW5lckluaGVyaXQKICAgICAgJHJlYWNoZXNOZXdDaGlsZCA9ICgkcnVsZS5Jbmhlcml0YW5jZUZsYWdzIC1iYW5kICRjaGlsZEluaGVyaXRhbmNlKSAtbmUgMAogICAgICBpZiAoJHJvbGUgLW5lICdsZWFmRGlyZWN0b3J5JyAtb3IgLW5vdCAkcmVhY2hlc05ld0NoaWxkKSB7CiAgICAgICAgY29udGludWUKICAgICAgfQogICAgfQogICAgJHNpZCA9ICRydWxlLklkZW50aXR5UmVmZXJlbmNlLlZhbHVlCiAgICBpZiAoJHRydXN0ZWQgLW5vdGNvbnRhaW5zICRzaWQgLWFuZCAoKFtpbnQ2NF0kcnVsZS5GaWxlU3lzdGVtUmlnaHRzIC1iYW5kICRtdXRhdGlvbk1hc2spIC1uZSAwKSkgewogICAgICB0aHJvdyAidW50cnVzdGVkIG11dGF0aW9uIEFDRSBvbiBsb2NrIHBhdGg6ICRmdWxsIgogICAgfQogIH0KfQpbQ29uc29sZV06Ok91dC5Xcml0ZSgnT0snKQpgOwpjb25zdCBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVF9CQVNFNjQgPSBCdWZmZXIuZnJvbSgKICBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVCwKICAidXRmMTZsZSIsCikudG9TdHJpbmcoImJhc2U2NCIpOwoKZXhwb3J0IGNsYXNzIExvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciBleHRlbmRzIEVycm9yIHsKICBjb25zdHJ1Y3Rvcih7IHBhdGgsIGxhYmVsLCB0aW1lb3V0TXMsIGNhdXNlIH0pIHsKICAgIHN1cGVyKAogICAgICBgYWdlbmM6ICR7bGFiZWx9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNc31tcyB3YWl0aW5nIGZvciBsb2NhbCBwcm9jZXNzIGxvY2sgJHtwYXRofWAsCiAgICAgIGNhdXNlID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB7IGNhdXNlIH0sCiAgICApOwogICAgdGhpcy5uYW1lID0gIkxvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciI7CiAgICB0aGlzLmNvZGUgPSAiQUdFTkNfTE9DS19USU1FT1VUIjsKICAgIHRoaXMucGF0aCA9IHBhdGg7CiAgICB0aGlzLmxhYmVsID0gbGFiZWw7CiAgICB0aGlzLnRpbWVvdXRNcyA9IHRpbWVvdXRNczsKICB9Cn0KCmZ1bmN0aW9uIHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIHJldHVybiBuZXcgTG9jYWxTcWxpdGVMb2NrVGltZW91dEVycm9yKHsKICAgIHBhdGgsCiAgICBsYWJlbDogY29udGV4dC5sYWJlbCwKICAgIHRpbWVvdXRNczogY29udGV4dC50aW1lb3V0TXMsCiAgICBjYXVzZSwKICB9KTsKfQoKZnVuY3Rpb24gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpIHsKICByZXR1cm4gTWF0aC5mbG9vcihjb250ZXh0LmRlYWRsaW5lIC0gcGVyZm9ybWFuY2Uubm93KCkpOwp9CgpmdW5jdGlvbiB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIGlmIChyZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCkgPD0gMCkgewogICAgdGhyb3cgdGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgsIGNhdXNlKTsKICB9Cn0KCmZ1bmN0aW9uIHByb2Nlc3NMb2NrUmVnaXN0cnkoKSB7CiAgY29uc3QgY3VycmVudCA9IHByb2Nlc3NbUkVHSVNUUllfU1lNQk9MXTsKICBpZiAoY3VycmVudCAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAoCiAgICAgIGN1cnJlbnQgPT09IG51bGwgfHwKICAgICAgdHlwZW9mIGN1cnJlbnQgIT09ICJvYmplY3QiIHx8CiAgICAgIGN1cnJlbnQudmVyc2lvbiAhPT0gUkVHSVNUUllfVkVSU0lPTiB8fAogICAgICAhKGN1cnJlbnQubG9ja3MgaW5zdGFuY2VvZiBNYXApCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKAogICAgICAgICJhZ2VuYzogaW5jb21wYXRpYmxlIHByb2Nlc3Mtd2lkZSBTUUxpdGUgbG9jayByZWdpc3RyeSBpcyBhbHJlYWR5IGluc3RhbGxlZCIsCiAgICAgICk7CiAgICB9CiAgICByZXR1cm4gY3VycmVudDsKICB9CiAgY29uc3QgY3JlYXRlZCA9IHsgdmVyc2lvbjogUkVHSVNUUllfVkVSU0lPTiwgbG9ja3M6IG5ldyBNYXAoKSB9OwogIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShwcm9jZXNzLCBSRUdJU1RSWV9TWU1CT0wsIHsKICAgIHZhbHVlOiBjcmVhdGVkLAogICAgY29uZmlndXJhYmxlOiBmYWxzZSwKICAgIGVudW1lcmFibGU6IGZhbHNlLAogICAgd3JpdGFibGU6IGZhbHNlLAogIH0pOwogIHJldHVybiBjcmVhdGVkOwp9CgpmdW5jdGlvbiBhY3F1aXJlSW5Qcm9jZXNzTG9jayhwcmVwYXJlZCwgY29udGV4dCkgewogIGNvbnN0IHJlZ2lzdHJ5ID0gcHJvY2Vzc0xvY2tSZWdpc3RyeSgpOwogIGNvbnN0IGtleSA9IHByZXBhcmVkLmlkZW50aXR5S2V5OwogIGxldCBzdGF0ZSA9IHJlZ2lzdHJ5LmxvY2tzLmdldChrZXkpOwogIGlmIChzdGF0ZSA9PT0gdW5kZWZpbmVkKSB7CiAgICBzdGF0ZSA9IHsgbG9ja2VkOiBmYWxzZSwgd2FpdGVyczogW10gfTsKICAgIHJlZ2lzdHJ5LmxvY2tzLnNldChrZXksIHN0YXRlKTsKICB9CgogIGNvbnN0IG1ha2VSZWxlYXNlID0gKCkgPT4gewogICAgbGV0IHJlbGVhc2VkID0gZmFsc2U7CiAgICByZXR1cm4gKCkgPT4gewogICAgICBpZiAocmVsZWFzZWQpIHJldHVybjsKICAgICAgcmVsZWFzZWQgPSB0cnVlOwogICAgICBjb25zdCBuZXh0ID0gc3RhdGUud2FpdGVycy5zaGlmdCgpOwogICAgICBpZiAobmV4dCA9PT0gdW5kZWZpbmVkKSB7CiAgICAgICAgc3RhdGUubG9ja2VkID0gZmFsc2U7CiAgICAgICAgcmVnaXN0cnkubG9ja3MuZGVsZXRlKGtleSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY2xlYXJUaW1lb3V0KG5leHQudGltZXIpOwogICAgICAgIG5leHQucmVzb2x2ZShtYWtlUmVsZWFzZSgpKTsKICAgICAgfQogICAgfTsKICB9OwoKICBpZiAoIXN0YXRlLmxvY2tlZCkgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCk7CiAgICBzdGF0ZS5sb2NrZWQgPSB0cnVlOwogICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShtYWtlUmVsZWFzZSgpKTsKICB9CgogIGNvbnN0IHJlbWFpbmluZyA9IHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KTsKICBpZiAocmVtYWluaW5nIDw9IDApIHsKICAgIHJldHVybiBQcm9taXNlLnJlamVjdCh0aW1lb3V0RXJyb3IoY29udGV4dCwgcHJlcGFyZWQucGF0aCkpOwogIH0KICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmVXYWl0LCByZWplY3RXYWl0KSA9PiB7CiAgICBjb25zdCB3YWl0ZXIgPSB7CiAgICAgIHJlc29sdmU6IHJlc29sdmVXYWl0LAogICAgICB0aW1lcjogdW5kZWZpbmVkLAogICAgfTsKICAgIGNvbnN0IGFybVRpbWVvdXQgPSAoKSA9PiB7CiAgICAgIGNvbnN0IGRlbGF5TXMgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgICAgIGlmIChkZWxheU1zIDw9IDApIHsKICAgICAgICBjb25zdCBpbmRleCA9IHN0YXRlLndhaXRlcnMuaW5kZXhPZih3YWl0ZXIpOwogICAgICAgIGlmIChpbmRleCAhPT0gLTEpIHN0YXRlLndhaXRlcnMuc3BsaWNlKGluZGV4LCAxKTsKICAgICAgICByZWplY3RXYWl0KHRpbWVvdXRFcnJvcihjb250ZXh0LCBwcmVwYXJlZC5wYXRoKSk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIHdhaXRlci50aW1lciA9IHNldFRpbWVvdXQoYXJtVGltZW91dCwgTWF0aC5taW4oZGVsYXlNcywgTUFYX1RJTUVSX0RFTEFZX01TKSk7CiAgICB9OwogICAgc3RhdGUud2FpdGVycy5wdXNoKHdhaXRlcik7CiAgICBhcm1UaW1lb3V0KCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGRlY29kZU1vdW50UGF0aCh2YWx1ZSkgewogIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXChbMC03XXszfSkvZywgKF9tYXRjaCwgb2N0YWwpID0+CiAgICBTdHJpbmcuZnJvbUNoYXJDb2RlKE51bWJlci5wYXJzZUludChvY3RhbCwgOCkpKTsKfQoKZnVuY3Rpb24gcGF0aElzV2l0aGluKHBhdGgsIG1vdW50UG9pbnQpIHsKICByZXR1cm4gcGF0aCA9PT0gbW91bnRQb2ludCB8fAogICAgcGF0aC5zdGFydHNXaXRoKG1vdW50UG9pbnQgPT09IHNlcCA/IG1vdW50UG9pbnQgOiBgJHttb3VudFBvaW50fSR7c2VwfWApOwp9CgpmdW5jdGlvbiBleGVjRmlsZVV0ZjgoZmlsZSwgYXJncywgb3B0aW9ucywgY29udGV4dCwgcGF0aCkgewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZVJ1biwgcmVqZWN0UnVuKSA9PiB7CiAgICBsZXQgZGVhZGxpbmVUaW1lcjsKICAgIGxldCBleHBpcmVkID0gZmFsc2U7CiAgICBjb25zdCBjaGlsZCA9IGV4ZWNGaWxlKAogICAgICBmaWxlLAogICAgICBhcmdzLAogICAgICB7IC4uLm9wdGlvbnMsIGVuY29kaW5nOiAidXRmOCIgfSwKICAgICAgKGVycm9yLCBzdGRvdXQsIHN0ZGVycikgPT4gewogICAgICAgIGlmIChkZWFkbGluZVRpbWVyICE9PSB1bmRlZmluZWQpIGNsZWFyVGltZW91dChkZWFkbGluZVRpbWVyKTsKICAgICAgICBpZiAoZXhwaXJlZCkgewogICAgICAgICAgcmVqZWN0UnVuKHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBlcnJvciA/PyB1bmRlZmluZWQpKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgaWYgKGVycm9yICE9PSBudWxsKSB7CiAgICAgICAgICBPYmplY3QuYXNzaWduKGVycm9yLCB7IHN0ZG91dCwgc3RkZXJyIH0pOwogICAgICAgICAgcmVqZWN0UnVuKGVycm9yKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgcmVzb2x2ZVJ1bih7IHN0ZG91dCwgc3RkZXJyIH0pOwogICAgICB9LAogICAgKTsKICAgIGNvbnN0IGFybURlYWRsaW5lID0gKCkgPT4gewogICAgICBjb25zdCByZW1haW5pbmcgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgICAgIGlmIChyZW1haW5pbmcgPD0gMCkgewogICAgICAgIGV4cGlyZWQgPSB0cnVlOwogICAgICAgIGNoaWxkLmtpbGwoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZGVhZGxpbmVUaW1lciA9IHNldFRpbWVvdXQoCiAgICAgICAgYXJtRGVhZGxpbmUsCiAgICAgICAgTWF0aC5taW4ocmVtYWluaW5nLCBNQVhfVElNRVJfREVMQVlfTVMpLAogICAgICApOwogICAgfTsKICAgIGFybURlYWRsaW5lKCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBjb250ZXh0LCBwYXRoKSB7CiAgaWYgKAogICAgcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpIDw9IDAgfHwKICAgIGVycm9yPy5jb2RlID09PSAiRVRJTUVET1VUIiB8fAogICAgZXJyb3I/LmtpbGxlZCA9PT0gdHJ1ZQogICkgewogICAgcmV0dXJuIHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBlcnJvcik7CiAgfQogIHJldHVybiBlcnJvcjsKfQoKZnVuY3Rpb24gdmFsaWRhdGVEYXJ3aW5BY2xMaXN0aW5nKHN0ZG91dCwgcGF0aCwgcm9sZSkgewogIGlmIChzdGRvdXQuaW5jbHVkZXMoIlxyIikpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIG5vbi1jYW5vbmljYWwgb3V0cHV0IGZvciAke3BhdGh9YCk7CiAgfQogIGNvbnN0IGxpbmVzID0gc3Rkb3V0LnNwbGl0KCJcbiIpOwogIGlmIChsaW5lcy5hdCgtMSkgPT09ICIiKSBsaW5lcy5wb3AoKTsKICBpZiAobGluZXMubGVuZ3RoID09PSAwIHx8IGxpbmVzWzBdLmxlbmd0aCA9PT0gMCkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgbm8gbWV0YWRhdGEgZm9yICR7cGF0aH1gKTsKICB9CiAgbGV0IHByZXZpb3VzT3JkaW5hbCA9IC0xOwogIGxldCBzYXdMZWdhY3lPd25lciA9IGZhbHNlOwogIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcy5zbGljZSgxKSkgewogICAgaWYgKC9eXHMqb3duZXI6XHMrXFMuKiQvdS50ZXN0KGxpbmUpICYmICFzYXdMZWdhY3lPd25lciAmJiBwcmV2aW91c09yZGluYWwgPT09IC0xKSB7CiAgICAgIHNhd0xlZ2FjeU93bmVyID0gdHJ1ZTsKICAgICAgY29udGludWU7CiAgICB9CiAgICBjb25zdCBtYXRjaCA9IGxpbmUubWF0Y2goCiAgICAgIC9eXHMqKFxkKyk6XHMrKC4rPylccysoPzooaW5oZXJpdGVkKVxzKyk/KGFsbG93fGRlbnkpXHMrKFthLXpfXSsoPzosW2Etel9dKykqKVxzKiQvdSwKICAgICk7CiAgICBpZiAobWF0Y2ggPT09IG51bGwpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgdW5yZWNvZ25pemVkIG91dHB1dCBmb3IgJHtwYXRofWApOwogICAgfQogICAgY29uc3Qgb3JkaW5hbCA9IE51bWJlcihtYXRjaFsxXSk7CiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKG9yZGluYWwpIHx8IG9yZGluYWwgPD0gcHJldmlvdXNPcmRpbmFsKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIGludmFsaWQgQUNFIG9yZGVyaW5nIGZvciAke3BhdGh9YCk7CiAgICB9CiAgICBwcmV2aW91c09yZGluYWwgPSBvcmRpbmFsOwogICAgY29uc3QgYXNzb2NpYXRpb24gPSBtYXRjaFs0XTsKICAgIGNvbnN0IHRva2VucyA9IG1hdGNoWzVdLnNwbGl0KCIsIik7CiAgICBmb3IgKGNvbnN0IHRva2VuIG9mIHRva2VucykgewogICAgICBpZiAoIURBUldJTl9BQ0xfS05PV05fVE9LRU5TLmhhcyh0b2tlbikpIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCB1bmtub3duIHJpZ2h0ICR7dG9rZW59OiAke3BhdGh9YCk7CiAgICAgIH0KICAgIH0KICAgIGlmICgKICAgICAgYXNzb2NpYXRpb24gPT09ICJhbGxvdyIgJiYKICAgICAgdG9rZW5zLnNvbWUoKHRva2VuKSA9PiBEQVJXSU5fQUNMX01VVEFUSU9OX1JJR0hUUy5oYXModG9rZW4pKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigKICAgICAgICBgYWdlbmM6IHByb3RlY3RlZCAke3JvbGV9IGhhcyBhIG11dGF0aW9uLWNhcGFibGUgRGFyd2luIEFDTDogJHtwYXRofWAsCiAgICAgICk7CiAgICB9CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkocGF0aCwgcm9sZSwgY29udGV4dCkgewogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIGxldCByZXN1bHQ7CiAgdHJ5IHsKICAgIHJlc3VsdCA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgKICAgICAgIi9iaW4vbHMiLAogICAgICBbIi1sZGVxIiwgcGF0aF0sCiAgICAgIHsKICAgICAgICBlbnY6IHsgTENfQUxMOiAiQyIgfSwKICAgICAgICBtYXhCdWZmZXI6IDI1NiAqIDEwMjQsCiAgICAgIH0sCiAgICAgIGNvbnRleHQsCiAgICAgIHBhdGgsCiAgICApOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgcGF0aCk7CiAgfQogIGlmIChyZXN1bHQuc3RkZXJyICE9PSAiIikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgdW5leHBlY3RlZCBkaWFnbm9zdGljcyBmb3IgJHtwYXRofWApOwogIH0KICB2YWxpZGF0ZURhcndpbkFjbExpc3RpbmcocmVzdWx0LnN0ZG91dCwgcGF0aCwgcm9sZSk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7Cn0KCmZ1bmN0aW9uIHRydXN0ZWRXaW5kb3dzUG93ZXJTaGVsbFBhdGgoKSB7CiAgLy8gR0xPQkFMUk9PVCBlbnRlcnMgdGhlIHRydWUgc3lzdGVtIG9iamVjdC1tYW5hZ2VyIG5hbWVzcGFjZSBpbnN0ZWFkIG9mIGEKICAvLyBzZXNzaW9uLXNwZWNpZmljIG9yIGVudmlyb25tZW50LXNlbGVjdGVkIERPUyBwYXRoLiBOZXZlciByZXNvbHZlIHRoaXMKICAvLyBleGVjdXRhYmxlIHRocm91Z2ggUEFUSCwgU3lzdGVtUm9vdCwgV0lORElSLCBvciBhbm90aGVyIGNhbGxlci1jb250cm9sbGVkCiAgLy8gdmFsdWUuCiAgcmV0dXJuIHsKICAgIHN5c3RlbVJvb3Q6IFdJTkRPV1NfU1lTVEVNX1JPT1QsCiAgICB3b3JraW5nRGlyZWN0b3J5OiB3aW4zMi5qb2luKFdJTkRPV1NfU1lTVEVNX1JPT1QsICJTeXN0ZW0zMiIpLAogICAgZXhlY3V0YWJsZTogd2luMzIuam9pbigKICAgICAgV0lORE9XU19TWVNURU1fUk9PVCwKICAgICAgIlN5c3RlbTMyIiwKICAgICAgIldpbmRvd3NQb3dlclNoZWxsIiwKICAgICAgInYxLjAiLAogICAgICAicG93ZXJzaGVsbC5leGUiLAogICAgKSwKICB9Owp9CgpmdW5jdGlvbiB3aW5kb3dzUG93ZXJTaGVsbEVudmlyb25tZW50KHBhdGhzKSB7CiAgY29uc3QgeyBzeXN0ZW1Sb290LCB3b3JraW5nRGlyZWN0b3J5IH0gPSB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKCk7CiAgLy8gbGlidXYgZmlsbHMgYSBmaXhlZCBzZXQgb2YgInJlcXVpcmVkIiBXaW5kb3dzIHZhcmlhYmxlcyBmcm9tIHRoZSBwYXJlbnQKICAvLyB3aGVuIHRoZXkgYXJlIGFic2VudC4gRGVmaW5lIGV2ZXJ5IG9uZSBzbyBwb2lzb25lZCBjYWxsZXIgc3RhdGUgY2Fubm90IGJlCiAgLy8gc2lsZW50bHkgaW5oZXJpdGVkIGludG8gdGhlIHZhbGlkYXRpb24gaGVscGVyLgogIHJldHVybiB7CiAgICBBR0VOQ19MT0NLX1BBVEhTX0pTT046IEpTT04uc3RyaW5naWZ5KHBhdGhzKSwKICAgIEFQUERBVEE6ICIiLAogICAgQ09NU1BFQzogIiIsCiAgICBIT01FRFJJVkU6ICIiLAogICAgSE9NRVBBVEg6ICIiLAogICAgTE9DQUxBUFBEQVRBOiAiIiwKICAgIExPR09OU0VSVkVSOiAiIiwKICAgIFBBVEg6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBQQVRIRVhUOiAiLkVYRSIsCiAgICBQU01PRFVMRVBBVEg6ICIiLAogICAgU1lTVEVNRFJJVkU6ICIiLAogICAgU1lTVEVNUk9PVDogc3lzdGVtUm9vdCwKICAgIFRFTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBUTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBVU0VSRE9NQUlOOiAiIiwKICAgIFVTRVJOQU1FOiAiIiwKICAgIFVTRVJQUk9GSUxFOiB3b3JraW5nRGlyZWN0b3J5LAogICAgV0lORElSOiBzeXN0ZW1Sb290LAogIH07Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoZW50cmllcywgY29udGV4dCkgewogIGNvbnN0IGRpc3BsYXlQYXRoID0gZW50cmllcy5hdCgtMSk/LnBhdGggPz8gInVua25vd24iOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGRpc3BsYXlQYXRoKTsKICBjb25zdCB7IHdvcmtpbmdEaXJlY3RvcnksIGV4ZWN1dGFibGUgfSA9IHRydXN0ZWRXaW5kb3dzUG93ZXJTaGVsbFBhdGgoKTsKICBsZXQgcmVzdWx0OwogIHRyeSB7CiAgICByZXN1bHQgPSBhd2FpdCBleGVjRmlsZVV0ZjgoCiAgICAgIGV4ZWN1dGFibGUsCiAgICAgIFsKICAgICAgICAiLU5vTG9nbyIsCiAgICAgICAgIi1Ob1Byb2ZpbGUiLAogICAgICAgICItTm9uSW50ZXJhY3RpdmUiLAogICAgICAgICItRW5jb2RlZENvbW1hbmQiLAogICAgICAgIFdJTkRPV1NfU0VDVVJJVFlfU0NSSVBUX0JBU0U2NCwKICAgICAgXSwKICAgICAgewogICAgICAgIGN3ZDogd29ya2luZ0RpcmVjdG9yeSwKICAgICAgICBlbnY6IHdpbmRvd3NQb3dlclNoZWxsRW52aXJvbm1lbnQoZW50cmllcyksCiAgICAgICAgbWF4QnVmZmVyOiAxMDI0ICogMTAyNCwKICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSwKICAgICAgfSwKICAgICAgY29udGV4dCwKICAgICAgZGlzcGxheVBhdGgsCiAgICApOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgZGlzcGxheVBhdGgpOwogIH0KICBpZiAocmVzdWx0LnN0ZG91dCAhPT0gIk9LIikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogV2luZG93cyBsb2NrLXBhdGggdmFsaWRhdGlvbiByZXR1cm5lZCBhbiBpbnZhbGlkIHJlc3BvbnNlIGZvciAke2Rpc3BsYXlQYXRofWApOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBkaXNwbGF5UGF0aCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydExvY2FsRmlsZXN5c3RlbShwYXJlbnQsIGNvbnRleHQpIHsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXJlbnQpOwogIGxldCBmaWxlc3lzdGVtVHlwZTsKICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImxpbnV4IikgewogICAgY29uc3QgbW91bnRzID0gYXdhaXQgcmVhZEZpbGUoIi9wcm9jL3NlbGYvbW91bnRpbmZvIiwgInV0ZjgiKTsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhcmVudCk7CiAgICBsZXQgbG9uZ2VzdCA9IC0xOwogICAgZm9yIChjb25zdCBsaW5lIG9mIG1vdW50cy5zcGxpdCgiXG4iKSkgewogICAgICBjb25zdCBmaWVsZHMgPSBsaW5lLnNwbGl0KCIgIik7CiAgICAgIGNvbnN0IHNlcGFyYXRvckluZGV4ID0gZmllbGRzLmluZGV4T2YoIi0iKTsKICAgICAgaWYgKAogICAgICAgIHNlcGFyYXRvckluZGV4IDwgNiB8fAogICAgICAgIGZpZWxkc1s0XSA9PT0gdW5kZWZpbmVkIHx8CiAgICAgICAgZmllbGRzW3NlcGFyYXRvckluZGV4ICsgMV0gPT09IHVuZGVmaW5lZAogICAgICApIGNvbnRpbnVlOwogICAgICBjb25zdCBtb3VudFBvaW50ID0gZGVjb2RlTW91bnRQYXRoKGZpZWxkc1s0XSk7CiAgICAgIGlmIChwYXRoSXNXaXRoaW4ocGFyZW50LCBtb3VudFBvaW50KSAmJiBtb3VudFBvaW50Lmxlbmd0aCA+IGxvbmdlc3QpIHsKICAgICAgICBsb25nZXN0ID0gbW91bnRQb2ludC5sZW5ndGg7CiAgICAgICAgZmlsZXN5c3RlbVR5cGUgPSBmaWVsZHNbc2VwYXJhdG9ySW5kZXggKyAxXTsKICAgICAgfQogICAgfQogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGxldCBzdGRvdXQ7CiAgICB0cnkgewogICAgICAoeyBzdGRvdXQgfSA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgiL3NiaW4vbW91bnQiLCBbXSwgewogICAgICAgIGVudjogeyBMQ19BTEw6ICJDIiB9LAogICAgICAgIG1heEJ1ZmZlcjogNCAqIDEwMjQgKiAxMDI0LAogICAgICB9LCBjb250ZXh0LCBwYXJlbnQpKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHRocm93IG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBjb250ZXh0LCBwYXJlbnQpOwogICAgfQogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGFyZW50KTsKICAgIGxldCBsb25nZXN0ID0gLTE7CiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3Rkb3V0LnNwbGl0KCJcbiIpKSB7CiAgICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgvIG9uICguKykgXCgoW14sXSspLyk7CiAgICAgIGlmIChtYXRjaCA9PT0gbnVsbCkgY29udGludWU7CiAgICAgIGNvbnN0IG1vdW50UG9pbnQgPSBkZWNvZGVNb3VudFBhdGgobWF0Y2hbMV0pOwogICAgICBpZiAocGF0aElzV2l0aGluKHBhcmVudCwgbW91bnRQb2ludCkgJiYgbW91bnRQb2ludC5sZW5ndGggPiBsb25nZXN0KSB7CiAgICAgICAgbG9uZ2VzdCA9IG1vdW50UG9pbnQubGVuZ3RoOwogICAgICAgIGZpbGVzeXN0ZW1UeXBlID0gbWF0Y2hbMl07CiAgICAgIH0KICAgIH0KICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoW3sgcGF0aDogcGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfV0sIGNvbnRleHQpOwogICAgcmV0dXJuOwogIH0gZWxzZSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogY2Fubm90IGVzdGFibGlzaCBsb2NrIGZpbGVzeXN0ZW0gbG9jYWxpdHkgb24gJHtwcm9jZXNzLnBsYXRmb3JtfWAsCiAgICApOwogIH0KICBpZiAoZmlsZXN5c3RlbVR5cGUgPT09IHVuZGVmaW5lZCB8fCAhTE9DQUxfRklMRVNZU1RFTV9UWVBFUy5oYXMoZmlsZXN5c3RlbVR5cGUpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogbm9uLWxvY2FsIG9yIHVua25vd24gbG9jayBmaWxlc3lzdGVtIGlzIHVuc3VwcG9ydGVkICgke2ZpbGVzeXN0ZW1UeXBlID8/ICJ1bmtub3duIn0pOiAke3BhcmVudH1gLAogICAgKTsKICB9Cn0KCi8qKgogKiBFc3RhYmxpc2ggdGhhdCBhbiBleGlzdGluZyBkaXJlY3RvcnkgaXMgYSBsb2NhbCwgcHJpdmF0ZWx5IG11dGFibGUKICogY29vcmRpbmF0aW9uIGJvdW5kYXJ5LiBXcmFwcGVyIHJlcGxhY2VtZW50IHVzZXMgYSByZWdpc3RyeS1ob3N0ZWQgU1FMaXRlCiAqIGxvY2ssIHNvIGEgc2hhcmVkIG9yIGF0dGFja2VyLXdyaXRhYmxlIHdyYXBwZXIgZGlyZWN0b3J5IHdvdWxkIG90aGVyd2lzZQogKiBwZXJtaXQgY3Jvc3MtaG9zdCByYWNlcyBvciBwYXRoIHN1YnN0aXR1dGlvbiBvdXRzaWRlIHRoYXQgbG9jay4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhc3NlcnRMb2NhbFByaXZhdGVEaXJlY3RvcnkoCiAgcmVxdWVzdGVkUGF0aCwKICB7CiAgICB0aW1lb3V0TXMgPSA2MF8wMDAsCiAgICBsYWJlbCA9ICJBZ2VuQyBvcGVyYXRpb24iLAogICAgZGVhZGxpbmU6IHN1cHBsaWVkRGVhZGxpbmUsCiAgICBhbGxvd1RydXN0ZWRTdGlja3lMZWFmID0gZmFsc2UsCiAgfSA9IHt9LAopIHsKICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRpbWVvdXRNcykgfHwgdGltZW91dE1zIDw9IDApIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgdGltZW91dE1zIG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXIiKTsKICB9CiAgaWYgKHN1cHBsaWVkRGVhZGxpbmUgIT09IHVuZGVmaW5lZCAmJiAhTnVtYmVyLmlzRmluaXRlKHN1cHBsaWVkRGVhZGxpbmUpKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIGRlYWRsaW5lIG11c3QgYmUgZmluaXRlIik7CiAgfQogIGlmICh0eXBlb2YgYWxsb3dUcnVzdGVkU3RpY2t5TGVhZiAhPT0gImJvb2xlYW4iKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJhbGxvd1RydXN0ZWRTdGlja3lMZWFmIG11c3QgYmUgYm9vbGVhbiIpOwogIH0KICBjb25zdCBjb250ZXh0ID0gewogICAgZGVhZGxpbmU6IE1hdGgubWluKAogICAgICBzdXBwbGllZERlYWRsaW5lID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwKICAgICAgcGVyZm9ybWFuY2Uubm93KCkgKyB0aW1lb3V0TXMsCiAgICApLAogICAgbGFiZWwsCiAgICB0aW1lb3V0TXMsCiAgfTsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUocmVxdWVzdGVkUGF0aCk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKGFic29sdXRlKTsKICBjb25zdCBhbmNlc3RvcnMgPSBbXTsKICBmb3IgKGxldCBjdXJyZW50ID0gY2Fub25pY2FsOyA7IGN1cnJlbnQgPSBkaXJuYW1lKGN1cnJlbnQpKSB7CiAgICBhbmNlc3RvcnMucHVzaChjdXJyZW50KTsKICAgIGlmIChkaXJuYW1lKGN1cnJlbnQpID09PSBjdXJyZW50KSBicmVhazsKICB9CiAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICBjb25zdCBiZWZvcmVJZGVudGl0aWVzID0gbmV3IE1hcCgpOwogIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBhbmNlc3RvcnMubGVuZ3RoOyBpbmRleCArPSAxKSB7CiAgICBjb25zdCBwYXRoID0gYW5jZXN0b3JzW2luZGV4XTsKICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBpZiAoIXN0YXRzLmlzRGlyZWN0b3J5KCkgfHwgc3RhdHMuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgcGF0aCBhbmNlc3RvciBpcyBub3QgYSByZWFsIGRpcmVjdG9yeTogJHtwYXRofWApOwogICAgfQogICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICJ3aW4zMiIpIHsKICAgICAgY29uc3QgbGVhZiA9IGluZGV4ID09PSAwOwogICAgICBjb25zdCB0cnVzdGVkT3duZXIgPSBzdGF0cy51aWQgPT09IDBuIHx8CiAgICAgICAgKGN1cnJlbnRVaWQgIT09IHVuZGVmaW5lZCAmJiBzdGF0cy51aWQgPT09IEJpZ0ludChjdXJyZW50VWlkKSk7CiAgICAgIGNvbnN0IHN0aWNreUJvdW5kYXJ5ID0gKCFsZWFmIHx8IGFsbG93VHJ1c3RlZFN0aWNreUxlYWYpICYmCiAgICAgICAgKHN0YXRzLm1vZGUgJiAwbzEwMDBuKSAhPT0gMG4gJiYgdHJ1c3RlZE93bmVyOwogICAgICBpZiAoIXRydXN0ZWRPd25lciB8fCAoKHN0YXRzLm1vZGUgJiAwbzAyMm4pICE9PSAwbiAmJiAhc3RpY2t5Qm91bmRhcnkpKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKAogICAgICAgICAgYGFnZW5jOiBwcm90ZWN0ZWQgZGlyZWN0b3J5IGNoYWluIHBlcm1pdHMgdW50cnVzdGVkIG11dGF0aW9uOiAke3BhdGh9OyBgICsKICAgICAgICAgICJyZW1vdmUgZ3JvdXAvd29ybGQgd3JpdGUgYWNjZXNzIGJlZm9yZSByZXRyeWluZyIsCiAgICAgICAgKTsKICAgICAgfQogICAgICBpZiAoCiAgICAgICAgbGVhZiAmJiAhc3RpY2t5Qm91bmRhcnkgJiYgY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmCiAgICAgICAgc3RhdHMudWlkICE9PSBCaWdJbnQoY3VycmVudFVpZCkKICAgICAgKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGRpcmVjdG9yeSBpcyBub3Qgb3duZWQgYnkgdGhlIGN1cnJlbnQgdXNlcjogJHtwYXRofWApOwogICAgICB9CiAgICB9CiAgICBiZWZvcmVJZGVudGl0aWVzLnNldChwYXRoLCB7IGRldjogc3RhdHMuZGV2LCBpbm86IHN0YXRzLmlubyB9KTsKICAgIGlkZW50aXR5RnJvbVN0YXRzKHN0YXRzLCBwYXRoKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoCiAgICAgIGFuY2VzdG9ycy5tYXAoKHBhdGgsIGluZGV4KSA9PiAoewogICAgICAgIHBhdGgsCiAgICAgICAgcm9sZTogaW5kZXggPT09IDAgPyAibGVhZkRpcmVjdG9yeSIgOiAiYW5jZXN0b3JEaXJlY3RvcnkiLAogICAgICB9KSksCiAgICAgIGNvbnRleHQsCiAgICApOwogIH0gZWxzZSB7CiAgICBhd2FpdCBhc3NlcnRMb2NhbEZpbGVzeXN0ZW0oY2Fub25pY2FsLCBjb250ZXh0KTsKICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgYW5jZXN0b3JzLmxlbmd0aDsgaW5kZXggKz0gMSkgewogICAgICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eSgKICAgICAgICAgIGFuY2VzdG9yc1tpbmRleF0sCiAgICAgICAgICBpbmRleCA9PT0gMCA/ICJsZWFmIGRpcmVjdG9yeSIgOiAiYW5jZXN0b3IgZGlyZWN0b3J5IiwKICAgICAgICAgIGNvbnRleHQsCiAgICAgICAgKTsKICAgICAgfQogICAgfQogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGZvciAoY29uc3QgcGF0aCBvZiBhbmNlc3RvcnMpIHsKICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBjb25zdCBiZWZvcmUgPSBiZWZvcmVJZGVudGl0aWVzLmdldChwYXRoKTsKICAgIGlmICgKICAgICAgIWFmdGVyLmlzRGlyZWN0b3J5KCkgfHwgYWZ0ZXIuaXNTeW1ib2xpY0xpbmsoKSB8fCBiZWZvcmUgPT09IHVuZGVmaW5lZCB8fAogICAgICBhZnRlci5kZXYgIT09IGJlZm9yZS5kZXYgfHwgYWZ0ZXIuaW5vICE9PSBiZWZvcmUuaW5vCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGRpcmVjdG9yeSBpZGVudGl0eSBjaGFuZ2VkIGR1cmluZyB2YWxpZGF0aW9uOiAke3BhdGh9YCk7CiAgICB9CiAgfQogIHJldHVybiBjYW5vbmljYWw7Cn0KCmZ1bmN0aW9uIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHN0YXRzLCBwYXRoKSB7CiAgaWYgKCFzdGF0cy5pc0ZpbGUoKSB8fCBzdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGlzIG5vdCBhIHJlZ3VsYXIgZmlsZTogJHtwYXRofWApOwogIH0KICBpZiAoc3RhdHMubmxpbmsgIT09IDFuKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIG11c3Qgbm90IGhhdmUgaGFyZC1saW5rIGFsaWFzZXM6ICR7cGF0aH1gKTsKICB9Cn0KCmZ1bmN0aW9uIGlkZW50aXR5RnJvbVN0YXRzKHN0YXRzLCBwYXRoKSB7CiAgaWYgKAogICAgc3RhdHMuZGV2ID09PSAwbiB8fAogICAgc3RhdHMuaW5vID09PSAwbiB8fAogICAgc3RhdHMuaW5vID09PSAtMW4gfHwKICAgIEJpZ0ludC5hc1VpbnROKDY0LCBzdGF0cy5pbm8pID09PSBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0CiAgKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGhhcyBubyBzdGFibGUgZmlsZXN5c3RlbSBpZGVudGl0eTogJHtwYXRofWApOwogIH0KICByZXR1cm4gYCR7c3RhdHMuZGV2fToke3N0YXRzLmlub31gOwp9CgpmdW5jdGlvbiBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgcGF0aCwga2luZCkgewogIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAid2luMzIiKSByZXR1cm47CiAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICBpZiAoY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmIHN0YXRzLnVpZCAhPT0gQmlnSW50KGN1cnJlbnRVaWQpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlICR7a2luZH0gaXMgbm90IG93bmVkIGJ5IHRoZSBjdXJyZW50IHVzZXI6ICR7cGF0aH1gKTsKICB9CiAgaWYgKChzdGF0cy5tb2RlICYgMG8wMjJuKSAhPT0gMG4pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgJHtraW5kfSBpcyBncm91cC93b3JsZC13cml0YWJsZTogJHtwYXRofWApOwogIH0KfQoKLyoqCiAqIFZhbGlkYXRlIGEgcmVndWxhciBmaWxlIGFuZCBpdHMgY29tcGxldGUgZGlyZWN0b3J5IGNoYWluIGJlZm9yZSBhIGNhbGxlcgogKiB0cnVzdHMgaXRzIGNvbnRlbnRzLiBUaGlzIGlzIGludGVudGlvbmFsbHkgbm9uLW11dGF0aW5nOiB1bnNhZmUgb3duZXJzaGlwLAogKiBtb2RlIGJpdHMsIEFDTHMsIGFsaWFzZXMsIG9yIGlkZW50aXR5IGNoYW5nZXMgZmFpbCBjbG9zZWQuCiAqLwpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYXNzZXJ0TG9jYWxQcml2YXRlRmlsZSgKICByZXF1ZXN0ZWRQYXRoLAogIHsKICAgIHRpbWVvdXRNcyA9IDYwXzAwMCwKICAgIGxhYmVsID0gIkFnZW5DIG9wZXJhdGlvbiIsCiAgICBkZWFkbGluZTogc3VwcGxpZWREZWFkbGluZSwKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgY29uc3QgY29udGV4dCA9IHsKICAgIGRlYWRsaW5lOiBNYXRoLm1pbigKICAgICAgc3VwcGxpZWREZWFkbGluZSA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksCiAgICAgIHBlcmZvcm1hbmNlLm5vdygpICsgdGltZW91dE1zLAogICAgKSwKICAgIGxhYmVsLAogICAgdGltZW91dE1zLAogIH07CiAgY29uc3QgYWJzb2x1dGUgPSByZXNvbHZlKHJlcXVlc3RlZFBhdGgpOwogIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoYWJzb2x1dGUpOwogIGNvbnN0IGNhbm9uaWNhbFBhcmVudCA9IGF3YWl0IGFzc2VydExvY2FsUHJpdmF0ZURpcmVjdG9yeShwYXJlbnQsIHsKICAgIHRpbWVvdXRNcywKICAgIGxhYmVsLAogICAgZGVhZGxpbmU6IGNvbnRleHQuZGVhZGxpbmUsCiAgfSk7CiAgaWYgKGNhbm9uaWNhbFBhcmVudCAhPT0gcGFyZW50KSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZmlsZSBwYXJlbnQgbXVzdCB1c2UgaXRzIGNhbm9uaWNhbCBwYXRoOiAke3BhcmVudH1gKTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IGJlZm9yZSA9IGF3YWl0IGxzdGF0KGFic29sdXRlLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoIWJlZm9yZS5pc0ZpbGUoKSB8fCBiZWZvcmUuaXNTeW1ib2xpY0xpbmsoKSB8fCBiZWZvcmUubmxpbmsgIT09IDFuKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZmlsZSBtdXN0IGJlIGEgcmVndWxhciBzaW5nbGUtbGluayBmaWxlOiAke2Fic29sdXRlfWApOwogIH0KICBpZGVudGl0eUZyb21TdGF0cyhiZWZvcmUsIGFic29sdXRlKTsKICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gIndpbjMyIikgewogICAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICAgIGlmIChjdXJyZW50VWlkICE9PSB1bmRlZmluZWQgJiYgYmVmb3JlLnVpZCAhPT0gQmlnSW50KGN1cnJlbnRVaWQpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlzIG5vdCBvd25lZCBieSB0aGUgY3VycmVudCB1c2VyOiAke2Fic29sdXRlfWApOwogICAgfQogICAgaWYgKChiZWZvcmUubW9kZSAmIDBvMDIybikgIT09IDBuKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlzIGdyb3VwL3dvcmxkLXdyaXRhYmxlOiAke2Fic29sdXRlfWApOwogICAgfQogIH0KICBjb25zdCBjYW5vbmljYWwgPSBhd2FpdCByZWFscGF0aChhYnNvbHV0ZSk7CiAgaWYgKGNhbm9uaWNhbCAhPT0gYWJzb2x1dGUpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIG11c3QgdXNlIGl0cyBjYW5vbmljYWwgcGF0aDogJHthYnNvbHV0ZX1gKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoW3sgcGF0aDogY2Fub25pY2FsLCByb2xlOiAiZmlsZSIgfV0sIGNvbnRleHQpOwogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eShjYW5vbmljYWwsICJmaWxlIiwgY29udGV4dCk7CiAgfQogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGNhbm9uaWNhbCk7CiAgY29uc3QgYWZ0ZXIgPSBhd2FpdCBsc3RhdChjYW5vbmljYWwsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICgKICAgICFhZnRlci5pc0ZpbGUoKSB8fCBhZnRlci5pc1N5bWJvbGljTGluaygpIHx8IGFmdGVyLm5saW5rICE9PSAxbiB8fAogICAgYWZ0ZXIuZGV2ICE9PSBiZWZvcmUuZGV2IHx8IGFmdGVyLmlubyAhPT0gYmVmb3JlLmlubwogICkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgaWRlbnRpdHkgY2hhbmdlZCBkdXJpbmcgdmFsaWRhdGlvbjogJHtjYW5vbmljYWx9YCk7CiAgfQogIHJldHVybiBjYW5vbmljYWw7Cn0KCmFzeW5jIGZ1bmN0aW9uIHByZXBhcmVMb2NrUGF0aChyZXF1ZXN0ZWRQYXRoLCBjb250ZXh0KSB7CiAgY29uc3QgYWJzb2x1dGUgPSByZXNvbHZlKHJlcXVlc3RlZFBhdGgpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGFic29sdXRlKTsKICBhd2FpdCBta2RpcihkaXJuYW1lKGFic29sdXRlKSwgeyByZWN1cnNpdmU6IHRydWUsIG1vZGU6IDBvNzAwIH0pOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGFic29sdXRlKTsKICBjb25zdCBwYXJlbnQgPSBhd2FpdCByZWFscGF0aChkaXJuYW1lKGFic29sdXRlKSk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IHZhbGlkYXRlZFBhcmVudCA9IGF3YWl0IGFzc2VydExvY2FsUHJpdmF0ZURpcmVjdG9yeShwYXJlbnQsIHsKICAgIHRpbWVvdXRNczogY29udGV4dC50aW1lb3V0TXMsCiAgICBsYWJlbDogY29udGV4dC5sYWJlbCwKICAgIGRlYWRsaW5lOiBjb250ZXh0LmRlYWRsaW5lLAogIH0pOwogIGlmICh2YWxpZGF0ZWRQYXJlbnQgIT09IHBhcmVudCkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBwYXJlbnQgbXVzdCB1c2UgaXRzIGNhbm9uaWNhbCBwYXRoOiAke3BhcmVudH1gKTsKICB9CiAgY29uc3QgcGFyZW50U3RhdHMgPSBhd2FpdCBsc3RhdChwYXJlbnQsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICghcGFyZW50U3RhdHMuaXNEaXJlY3RvcnkoKSB8fCBwYXJlbnRTdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIHBhcmVudCBpcyBub3QgYSByZWFsIGRpcmVjdG9yeTogJHtwYXJlbnR9YCk7CiAgfQogIGFzc2VydFBvc2l4T3duZXJzaGlwKHBhcmVudFN0YXRzLCBwYXJlbnQsICJwYXJlbnQiKTsKCiAgY29uc3QgcGF0aCA9IGpvaW4ocGFyZW50LCBiYXNlbmFtZShhYnNvbHV0ZSkpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIHRyeSB7CiAgICBjb25zdCBoYW5kbGUgPSBhd2FpdCBvcGVuKHBhdGgsICJ3eCIsIDBvNjAwKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGhhbmRsZS5jbG9zZSgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgYXdhaXQgaGFuZGxlLmNsb3NlKCkuY2F0Y2goKCkgPT4ge30pOwogICAgICB0aHJvdyBlcnJvcjsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgaWYgKGVycm9yPy5jb2RlICE9PSAiRUVYSVNUIikgdGhyb3cgZXJyb3I7CiAgfQogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIGNvbnN0IHBhdGhTdGF0cyA9IGF3YWl0IGxzdGF0KHBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHBhdGhTdGF0cywgcGF0aCk7CiAgYXNzZXJ0UG9zaXhPd25lcnNoaXAocGF0aFN0YXRzLCBwYXRoLCAiZmlsZSIpOwogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKHBhdGgpOwogIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQoY2Fub25pY2FsLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBhc3NlcnRSZWd1bGFyU2luZ2xlTGluayhzdGF0cywgY2Fub25pY2FsKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgY2Fub25pY2FsLCAiZmlsZSIpOwogIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAid2luMzIiKSB7CiAgICBhd2FpdCBjaG1vZChjYW5vbmljYWwsIDBvNjAwKTsKICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgICBhd2FpdCBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkoY2Fub25pY2FsLCAibG9jayBkYXRhYmFzZSBmaWxlIiwgY29udGV4dCk7CiAgICB9CiAgfSBlbHNlIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoWwogICAgICB7IHBhdGg6IHBhcmVudCwgcm9sZTogImxlYWZEaXJlY3RvcnkiIH0sCiAgICAgIHsgcGF0aDogY2Fub25pY2FsLCByb2xlOiAiZmlsZSIgfSwKICAgIF0sIGNvbnRleHQpOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGNvbnN0IHNlY3VyZWRTdGF0cyA9IGF3YWl0IGxzdGF0KGNhbm9uaWNhbCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHNlY3VyZWRTdGF0cywgY2Fub25pY2FsLCAiZmlsZSIpOwogIHJldHVybiB7CiAgICBwYXRoOiBjYW5vbmljYWwsCiAgICBwYXJlbnQsCiAgICBkZXY6IHNlY3VyZWRTdGF0cy5kZXYsCiAgICBpbm86IHNlY3VyZWRTdGF0cy5pbm8sCiAgICBpZGVudGl0eUtleTogaWRlbnRpdHlGcm9tU3RhdHMoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpLAogIH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJldmFsaWRhdGVQcmVwYXJlZExvY2socHJlcGFyZWQsIGNvbnRleHQpIHsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwcmVwYXJlZC5wYXRoKTsKICBjb25zdCBwYXJlbnRTdGF0cyA9IGF3YWl0IGxzdGF0KHByZXBhcmVkLnBhcmVudCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgaWYgKCFwYXJlbnRTdGF0cy5pc0RpcmVjdG9yeSgpIHx8IHBhcmVudFN0YXRzLmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgcGFyZW50IGlzIG5vIGxvbmdlciBhIHJlYWwgZGlyZWN0b3J5OiAke3ByZXBhcmVkLnBhcmVudH1gKTsKICB9CiAgYXNzZXJ0UG9zaXhPd25lcnNoaXAocGFyZW50U3RhdHMsIHByZXBhcmVkLnBhcmVudCwgInBhcmVudCIpOwogIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQocHJlcGFyZWQucGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc3RhdHMsIHByZXBhcmVkLnBhdGgpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHN0YXRzLCBwcmVwYXJlZC5wYXRoLCAiZmlsZSIpOwogIGlmIChzdGF0cy5kZXYgIT09IHByZXBhcmVkLmRldiB8fCBzdGF0cy5pbm8gIT09IHByZXBhcmVkLmlubykgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBpZGVudGl0eSBjaGFuZ2VkIGR1cmluZyBhY3F1aXNpdGlvbjogJHtwcmVwYXJlZC5wYXRofWApOwogIH0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gIndpbjMyIikgewogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eShbCiAgICAgIHsgcGF0aDogcHJlcGFyZWQucGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfSwKICAgICAgeyBwYXRoOiBwcmVwYXJlZC5wYXRoLCByb2xlOiAiZmlsZSIgfSwKICAgIF0sIGNvbnRleHQpOwogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eShwcmVwYXJlZC5wYXRoLCAibG9jayBkYXRhYmFzZSBmaWxlIiwgY29udGV4dCk7CiAgfQogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpOwp9CgpmdW5jdGlvbiBwcmFnbWFWYWx1ZShkYXRhYmFzZSwgcHJhZ21hKSB7CiAgY29uc3Qgcm93ID0gZGF0YWJhc2UucHJlcGFyZShgUFJBR01BICR7cHJhZ21hfWApLmdldCgpOwogIHJldHVybiByb3cgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IE9iamVjdC52YWx1ZXMocm93KVswXTsKfQoKZnVuY3Rpb24gcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCBwcmFnbWEpIHsKICBjb25zdCB2YWx1ZSA9IHByYWdtYVZhbHVlKGRhdGFiYXNlLCBwcmFnbWEpOwogIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICJudW1iZXIiID8gdmFsdWUgOiB1bmRlZmluZWQ7Cn0KCmZ1bmN0aW9uIHByYWdtYVRleHQoZGF0YWJhc2UsIHByYWdtYSkgewogIGNvbnN0IHZhbHVlID0gcHJhZ21hVmFsdWUoZGF0YWJhc2UsIHByYWdtYSk7CiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gInN0cmluZyIgPyB2YWx1ZS50b0xvd2VyQ2FzZSgpIDogdW5kZWZpbmVkOwp9CgpleHBvcnQgZnVuY3Rpb24gY29uZmlndXJlTG9jYWxTcWxpdGVMb2NrQ29ubmVjdGlvbihkYXRhYmFzZSkgewogIGRhdGFiYXNlLmV4ZWMoIlBSQUdNQSBidXN5X3RpbWVvdXQgPSAwIik7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIHRydXN0ZWRfc2NoZW1hID0gT0ZGIik7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIHN5bmNocm9ub3VzID0gRVhUUkEiKTsKICBkYXRhYmFzZS5lbmFibGVEZWZlbnNpdmUodHJ1ZSk7CiAgZGF0YWJhc2UuZW5hYmxlTG9hZEV4dGVuc2lvbihmYWxzZSk7CiAgaWYgKAogICAgcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAiYnVzeV90aW1lb3V0IikgIT09IDAgfHwKICAgIHByYWdtYU51bWJlcihkYXRhYmFzZSwgInRydXN0ZWRfc2NoZW1hIikgIT09IDAgfHwKICAgIHByYWdtYU51bWJlcihkYXRhYmFzZSwgInN5bmNocm9ub3VzIikgIT09IDMKICApIHsKICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFNRTGl0ZSBsb2NrIGNvbm5lY3Rpb24gaGFyZGVuaW5nIGRpZCBub3QgdGFrZSBlZmZlY3QiKTsKICB9Cn0KCmZ1bmN0aW9uIGluc3BlY3RMb2NrRGF0YWJhc2UoZGF0YWJhc2UsIHBhdGgpIHsKICBjb25zdCBhcHBsaWNhdGlvbklkID0gcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAiYXBwbGljYXRpb25faWQiKTsKICBpZiAoYXBwbGljYXRpb25JZCA9PT0gMCkgewogICAgY29uc3Qgcm93ID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCBjb3VudCgqKSBBUyBjb3VudCBGUk9NIHNxbGl0ZV9zY2hlbWEgV0hFUkUgbmFtZSBOT1QgTElLRSAnc3FsaXRlXyUnIiwKICAgICkuZ2V0KCk7CiAgICBpZiAocm93Py5jb3VudCAhPT0gMCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgICAgYGFnZW5jOiByZWZ1c2luZyB0byByZXVzZSBhbiB1bnJlbGF0ZWQgU1FMaXRlIGRhdGFiYXNlIGFzIGEgbG9jazogJHtwYXRofWAsCiAgICAgICk7CiAgICB9CiAgICByZXR1cm4gImVtcHR5IjsKICB9CiAgaWYgKGFwcGxpY2F0aW9uSWQgIT09IExPQ0tfQVBQTElDQVRJT05fSUQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaGFzIGFuIGluY29tcGF0aWJsZSBhcHBsaWNhdGlvbiBpZDogJHtwYXRofWApOwogIH0KICB0cnkgewogICAgY29uc3Qgc2NoZW1hID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCB0eXBlLCBzcWwgRlJPTSBzcWxpdGVfc2NoZW1hIFdIRVJFIG5hbWUgPSAnYWdlbmNfbG9jYWxfcHJvY2Vzc19sb2NrJyIsCiAgICApLmdldCgpOwogICAgY29uc3Qgb2JqZWN0cyA9IGRhdGFiYXNlLnByZXBhcmUoCiAgICAgICJTRUxFQ1QgY291bnQoKikgQVMgY291bnQgRlJPTSBzcWxpdGVfc2NoZW1hIFdIRVJFIG5hbWUgTk9UIExJS0UgJ3NxbGl0ZV8lJyIsCiAgICApLmdldCgpOwogICAgY29uc3Qgcm93cyA9IGRhdGFiYXNlLnByZXBhcmUoCiAgICAgICJTRUxFQ1Qgc2luZ2xldG9uLCBmb3JtYXRfdmVyc2lvbiBGUk9NIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayIsCiAgICApLmFsbCgpOwogICAgY29uc3Qgbm9ybWFsaXplZFNjaGVtYSA9IHR5cGVvZiBzY2hlbWE/LnNxbCA9PT0gInN0cmluZyIKICAgICAgPyBzY2hlbWEuc3FsLnJlcGxhY2UoL1xzKy9nLCAiICIpLnRyaW0oKQogICAgICA6IHVuZGVmaW5lZDsKICAgIGlmICgKICAgICAgc2NoZW1hPy50eXBlICE9PSAidGFibGUiIHx8CiAgICAgIG5vcm1hbGl6ZWRTY2hlbWEgIT09CiAgICAgICAgIkNSRUFURSBUQUJMRSBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKCBzaW5nbGV0b24gSU5URUdFUiBQUklNQVJZIEtFWSBDSEVDSyAoc2luZ2xldG9uID0gMSksIGZvcm1hdF92ZXJzaW9uIElOVEVHRVIgTk9UIE5VTEwgKSBTVFJJQ1QiIHx8CiAgICAgIG9iamVjdHM/LmNvdW50ICE9PSAxIHx8CiAgICAgIHJvd3MubGVuZ3RoICE9PSAxIHx8CiAgICAgIHJvd3NbMF0/LnNpbmdsZXRvbiAhPT0gMSB8fAogICAgICByb3dzWzBdPy5mb3JtYXRfdmVyc2lvbiAhPT0gTE9DS19GT1JNQVRfVkVSU0lPTgogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigiaW52YWxpZCBzZW50aW5lbCBzY2hlbWEiKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBoYXMgYW4gaW5jb21wYXRpYmxlIGZvcm1hdDogJHtwYXRofWAsIHsKICAgICAgY2F1c2U6IGVycm9yLAogICAgfSk7CiAgfQogIHJldHVybiAidmFsaWQiOwp9CgpmdW5jdGlvbiBidXN5VHJhbnNpdGlvbkVycm9yKHBhdGgsIG1vZGUpIHsKICByZXR1cm4gT2JqZWN0LmFzc2lnbigKICAgIG5ldyBFcnJvcihgYWdlbmM6IFNRTGl0ZSBsb2NrIGpvdXJuYWwgbW9kZSByZW1haW5lZCAke21vZGUgPz8gInVua25vd24ifTogJHtwYXRofWApLAogICAgeyBlcnJjb2RlOiBTUUxJVEVfQlVTWSB9LAogICk7Cn0KCmZ1bmN0aW9uIGJlZ2luQW5kVmFsaWRhdGVMb2NrKGRhdGFiYXNlLCBwYXRoKSB7CiAgZm9yIChsZXQgcGhhc2UgPSAwOyBwaGFzZSA8IDg7IHBoYXNlICs9IDEpIHsKICAgIGRhdGFiYXNlLmV4ZWMoIkJFR0lOIElNTUVESUFURSIpOwogICAgY29uc3Qgc3RhdGUgPSBpbnNwZWN0TG9ja0RhdGFiYXNlKGRhdGFiYXNlLCBwYXRoKTsKICAgIGNvbnN0IGpvdXJuYWxNb2RlID0gcHJhZ21hVGV4dChkYXRhYmFzZSwgImpvdXJuYWxfbW9kZSIpOwogICAgaWYgKGpvdXJuYWxNb2RlICE9PSAiZGVsZXRlIikgewogICAgICBkYXRhYmFzZS5leGVjKCJST0xMQkFDSyIpOwogICAgICBjb25zdCBzZWxlY3RlZCA9IHByYWdtYVRleHQoZGF0YWJhc2UsICJqb3VybmFsX21vZGU9REVMRVRFIik7CiAgICAgIGlmIChzZWxlY3RlZCAhPT0gImRlbGV0ZSIpIHRocm93IGJ1c3lUcmFuc2l0aW9uRXJyb3IocGF0aCwgc2VsZWN0ZWQpOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIGlmIChzdGF0ZSA9PT0gImVtcHR5IikgewogICAgICBkYXRhYmFzZS5leGVjKGAKICAgICAgICBQUkFHTUEgYXBwbGljYXRpb25faWQgPSAke0xPQ0tfQVBQTElDQVRJT05fSUR9OwogICAgICAgIENSRUFURSBUQUJMRSBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKAogICAgICAgICAgc2luZ2xldG9uIElOVEVHRVIgUFJJTUFSWSBLRVkgQ0hFQ0sgKHNpbmdsZXRvbiA9IDEpLAogICAgICAgICAgZm9ybWF0X3ZlcnNpb24gSU5URUdFUiBOT1QgTlVMTAogICAgICAgICkgU1RSSUNUOwogICAgICAgIElOU0VSVCBJTlRPIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayAoc2luZ2xldG9uLCBmb3JtYXRfdmVyc2lvbikKICAgICAgICBWQUxVRVMgKDEsICR7TE9DS19GT1JNQVRfVkVSU0lPTn0pOwogICAgICAgIENPTU1JVDsKICAgICAgYCk7CiAgICAgIGNvbnRpbnVlOwogICAgfQogICAgcmV0dXJuOwogIH0KICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGluaXRpYWxpemF0aW9uIGRpZCBub3QgY29udmVyZ2U6ICR7cGF0aH1gKTsKfQoKZnVuY3Rpb24gY2xvc2VEYXRhYmFzZShkYXRhYmFzZSkgewogIGlmICghZGF0YWJhc2U/LmlzT3BlbikgcmV0dXJuOwogIGNvbnN0IGVycm9ycyA9IFtdOwogIHRyeSB7CiAgICBpZiAoZGF0YWJhc2UuaXNUcmFuc2FjdGlvbikgZGF0YWJhc2UuZXhlYygiUk9MTEJBQ0siKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgZXJyb3JzLnB1c2goZXJyb3IpOwogIH0KICB0cnkgewogICAgZGF0YWJhc2UuY2xvc2UoKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgZXJyb3JzLnB1c2goZXJyb3IpOwogIH0KICBpZiAoZXJyb3JzLmxlbmd0aCA9PT0gMSkgdGhyb3cgZXJyb3JzWzBdOwogIGlmIChlcnJvcnMubGVuZ3RoID4gMSkgewogICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGVycm9ycywgImFnZW5jOiBmYWlsZWQgdG8gY2xvc2UgYSBsb2NhbCBwcm9jZXNzIGxvY2sgZGF0YWJhc2UiKTsKICB9Cn0KCmV4cG9ydCBmdW5jdGlvbiBpc1NxbGl0ZUJ1c3lFcnJvcihlcnJvcikgewogIHJldHVybiB0eXBlb2YgZXJyb3I/LmVycmNvZGUgPT09ICJudW1iZXIiICYmCiAgICAoZXJyb3IuZXJyY29kZSAmIDB4ZmYpID09PSBTUUxJVEVfQlVTWTsKfQoKYXN5bmMgZnVuY3Rpb24gd2FpdEZvckJ1c3lSZXRyeShjb250ZXh0LCBwYXRoLCBhdHRlbXB0LCBjYXVzZSkgewogIGNvbnN0IHJlbWFpbmluZyA9IHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KTsKICBpZiAocmVtYWluaW5nIDw9IDApIHRocm93IHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBjYXVzZSk7CiAgY29uc3QgZXhwb25lbnRpYWxDYXAgPSBNYXRoLm1pbihNQVhfQlVTWV9SRVRSWV9NUywgMiAqKiBNYXRoLm1pbihhdHRlbXB0LCA2KSk7CiAgY29uc3Qgaml0dGVyID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKGV4cG9uZW50aWFsQ2FwICsgMSkpKTsKICBhd2FpdCBkZWxheShNYXRoLm1pbihyZW1haW5pbmcsIGppdHRlcikpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgsIGNhdXNlKTsKfQoKYXN5bmMgZnVuY3Rpb24gYWNxdWlyZVNxbGl0ZURhdGFiYXNlKERhdGFiYXNlU3luYywgcHJlcGFyZWQsIGNvbnRleHQpIHsKICBsZXQgYXR0ZW1wdCA9IDA7CiAgbGV0IGxhc3RCdXN5OwogIHdoaWxlICh0cnVlKSB7CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwcmVwYXJlZC5wYXRoLCBsYXN0QnVzeSk7CiAgICBhd2FpdCByZXZhbGlkYXRlUHJlcGFyZWRMb2NrKHByZXBhcmVkLCBjb250ZXh0KTsKICAgIGxldCBkYXRhYmFzZTsKICAgIHRyeSB7CiAgICAgIGRhdGFiYXNlID0gbmV3IERhdGFiYXNlU3luYyhwcmVwYXJlZC5wYXRoLCB7CiAgICAgICAgYWxsb3dFeHRlbnNpb246IGZhbHNlLAogICAgICAgIHRpbWVvdXQ6IDAsCiAgICAgIH0pOwogICAgICBjb25maWd1cmVMb2NhbFNxbGl0ZUxvY2tDb25uZWN0aW9uKGRhdGFiYXNlKTsKICAgICAgYXdhaXQgcmV2YWxpZGF0ZVByZXBhcmVkTG9jayhwcmVwYXJlZCwgY29udGV4dCk7CiAgICAgIGJlZ2luQW5kVmFsaWRhdGVMb2NrKGRhdGFiYXNlLCBwcmVwYXJlZC5wYXRoKTsKICAgICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgbGFzdEJ1c3kpOwogICAgICByZXR1cm4gZGF0YWJhc2U7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBjb25zdCBjbGVhbnVwRXJyb3JzID0gW107CiAgICAgIGlmIChkYXRhYmFzZSAhPT0gdW5kZWZpbmVkKSB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGNsb3NlRGF0YWJhc2UoZGF0YWJhc2UpOwogICAgICAgIH0gY2F0Y2ggKGNsZWFudXBFcnJvcikgewogICAgICAgICAgY2xlYW51cEVycm9ycy5wdXNoKGNsZWFudXBFcnJvcik7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChjbGVhbnVwRXJyb3JzLmxlbmd0aCA+IDApIHsKICAgICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgICAgICBbZXJyb3IsIC4uLmNsZWFudXBFcnJvcnNdLAogICAgICAgICAgYGFnZW5jOiBsb2NrIGF0dGVtcHQgYW5kIGNsZWFudXAgYm90aCBmYWlsZWQgZm9yICR7cHJlcGFyZWQucGF0aH1gLAogICAgICAgICk7CiAgICAgIH0KICAgICAgaWYgKCFpc1NxbGl0ZUJ1c3lFcnJvcihlcnJvcikpIHRocm93IGVycm9yOwogICAgICBsYXN0QnVzeSA9IGVycm9yOwogICAgICBhdHRlbXB0ICs9IDE7CiAgICAgIGF3YWl0IHdhaXRGb3JCdXN5UmV0cnkoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgYXR0ZW1wdCwgbGFzdEJ1c3kpOwogICAgfQogIH0KfQoKZnVuY3Rpb24gcmVsZWFzZUFjcXVpcmVkKGFjcXVpcmVkLCBsYWJlbCkgewogIGNvbnN0IGVycm9ycyA9IFtdOwogIGZvciAoY29uc3QgaXRlbSBvZiBhY3F1aXJlZC50b1JldmVyc2VkKCkpIHsKICAgIHRyeSB7CiAgICAgIGNsb3NlRGF0YWJhc2UoaXRlbS5kYXRhYmFzZSk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgICB9CiAgICBpZiAoKCFpdGVtLmRhdGFiYXNlIHx8ICFpdGVtLmRhdGFiYXNlLmlzT3BlbikgJiYgIWl0ZW0uaW5Qcm9jZXNzUmVsZWFzZWQpIHsKICAgICAgdHJ5IHsKICAgICAgICBpdGVtLnJlbGVhc2VJblByb2Nlc3MoKTsKICAgICAgICBpdGVtLmluUHJvY2Vzc1JlbGVhc2VkID0gdHJ1ZTsKICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgICAgIH0KICAgIH0KICB9CiAgaWYgKGVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGVycm9yc1swXTsKICBpZiAoZXJyb3JzLmxlbmd0aCA+IDEpIHsKICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihlcnJvcnMsIGBhZ2VuYzogJHtsYWJlbH0gbG9jayByZWxlYXNlIGZhaWxlZGApOwogIH0KfQoKZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2tzKAogIHJlcXVlc3RlZFBhdGhzLAogIHsKICAgIHRpbWVvdXRNcyA9IDYwXzAwMCwKICAgIGxhYmVsID0gIkFnZW5DIG9wZXJhdGlvbiIsCiAgICBkZWFkbGluZTogc3VwcGxpZWREZWFkbGluZSwKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgaWYgKCFBcnJheS5pc0FycmF5KHJlcXVlc3RlZFBhdGhzKSkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBwYXRocyBtdXN0IGJlIGFuIGFycmF5Iik7CiAgfQogIGlmIChyZXF1ZXN0ZWRQYXRocy5sZW5ndGggPT09IDApIHJldHVybiAoKSA9PiB7fTsKCiAgY29uc3Qgc3RhcnRlZEF0ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgY29uc3QgY29udGV4dCA9IHsKICAgIGRlYWRsaW5lOiBNYXRoLm1pbigKICAgICAgc3VwcGxpZWREZWFkbGluZSA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksCiAgICAgIHN0YXJ0ZWRBdCArIHRpbWVvdXRNcywKICAgICksCiAgICBsYWJlbCwKICAgIHRpbWVvdXRNcywKICB9OwogIGNvbnN0IGZpcnN0RGlzcGxheVBhdGggPSByZXNvbHZlKHJlcXVlc3RlZFBhdGhzWzBdKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBmaXJzdERpc3BsYXlQYXRoKTsKCiAgY29uc3QgcHJlcGFyZWRCeUlkZW50aXR5ID0gbmV3IE1hcCgpOwogIGZvciAoY29uc3QgcmVxdWVzdGVkUGF0aCBvZiByZXF1ZXN0ZWRQYXRocykgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoKSk7CiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IHByZXBhcmVMb2NrUGF0aChyZXF1ZXN0ZWRQYXRoLCBjb250ZXh0KTsKICAgIHByZXBhcmVkQnlJZGVudGl0eS5zZXQocHJlcGFyZWQuaWRlbnRpdHlLZXksIHByZXBhcmVkKTsKICB9CiAgY29uc3QgcHJlcGFyZWRMb2NrcyA9IFsuLi5wcmVwYXJlZEJ5SWRlbnRpdHkudmFsdWVzKCldLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PgogICAgbGVmdC5pZGVudGl0eUtleSA8IHJpZ2h0LmlkZW50aXR5S2V5ID8gLTEgOiBsZWZ0LmlkZW50aXR5S2V5ID4gcmlnaHQuaWRlbnRpdHlLZXkgPyAxIDogMCk7CiAgY29uc3QgcGVuZGluZ0xvY2FsID0gW107CiAgY29uc3QgYWNxdWlyZWQgPSBbXTsKICBsZXQgY3VycmVudFBhdGggPSBwcmVwYXJlZExvY2tzWzBdPy5wYXRoID8/IGZpcnN0RGlzcGxheVBhdGg7CiAgdHJ5IHsKICAgIGZvciAoY29uc3QgcHJlcGFyZWQgb2YgcHJlcGFyZWRMb2NrcykgewogICAgICBjdXJyZW50UGF0aCA9IHByZXBhcmVkLnBhdGg7CiAgICAgIGNvbnN0IHJlbGVhc2UgPSBhd2FpdCBhY3F1aXJlSW5Qcm9jZXNzTG9jayhwcmVwYXJlZCwgY29udGV4dCk7CiAgICAgIHBlbmRpbmdMb2NhbC5wdXNoKHsgcHJlcGFyZWQsIHJlbGVhc2UgfSk7CiAgICB9CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjdXJyZW50UGF0aCk7CiAgICBjb25zdCB7IERhdGFiYXNlU3luYyB9ID0gYXdhaXQgaW1wb3J0KCJub2RlOnNxbGl0ZSIpOwogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgY3VycmVudFBhdGgpOwogICAgZm9yIChjb25zdCB7IHByZXBhcmVkLCByZWxlYXNlIH0gb2YgcGVuZGluZ0xvY2FsKSB7CiAgICAgIGN1cnJlbnRQYXRoID0gcHJlcGFyZWQucGF0aDsKICAgICAgY29uc3QgaXRlbSA9IHsKICAgICAgICBkYXRhYmFzZTogdW5kZWZpbmVkLAogICAgICAgIHJlbGVhc2VJblByb2Nlc3M6IHJlbGVhc2UsCiAgICAgICAgaW5Qcm9jZXNzUmVsZWFzZWQ6IGZhbHNlLAogICAgICB9OwogICAgICBhY3F1aXJlZC5wdXNoKGl0ZW0pOwogICAgICBpdGVtLmRhdGFiYXNlID0gYXdhaXQgYWNxdWlyZVNxbGl0ZURhdGFiYXNlKERhdGFiYXNlU3luYywgcHJlcGFyZWQsIGNvbnRleHQpOwogICAgfQogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBjb25zdCBjbGVhbnVwRXJyb3JzID0gW107CiAgICB0cnkgewogICAgICByZWxlYXNlQWNxdWlyZWQoYWNxdWlyZWQsIGxhYmVsKTsKICAgIH0gY2F0Y2ggKGNsZWFudXBFcnJvcikgewogICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgIH0KICAgIGZvciAoY29uc3QgeyByZWxlYXNlIH0gb2YgcGVuZGluZ0xvY2FsLnNsaWNlKGFjcXVpcmVkLmxlbmd0aCkudG9SZXZlcnNlZCgpKSB7CiAgICAgIHRyeSB7CiAgICAgICAgcmVsZWFzZSgpOwogICAgICB9IGNhdGNoIChjbGVhbnVwRXJyb3IpIHsKICAgICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgICAgfQogICAgfQogICAgY29uc3QgZm9ybWF0dGVkID0gaXNTcWxpdGVCdXN5RXJyb3IoZXJyb3IpCiAgICAgID8gdGltZW91dEVycm9yKGNvbnRleHQsIGN1cnJlbnRQYXRoLCBlcnJvcikKICAgICAgOiBlcnJvcjsKICAgIGlmIChjbGVhbnVwRXJyb3JzLmxlbmd0aCA+IDApIHsKICAgICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKAogICAgICAgIFtmb3JtYXR0ZWQsIC4uLmNsZWFudXBFcnJvcnNdLAogICAgICAgIGBhZ2VuYzogJHtsYWJlbH0gbG9jayBhY3F1aXNpdGlvbiBhbmQgcm9sbGJhY2sgYm90aCBmYWlsZWRgLAogICAgICApOwogICAgfQogICAgdGhyb3cgZm9ybWF0dGVkOwogIH0KCiAgbGV0IHJlbGVhc2VkID0gZmFsc2U7CiAgcmV0dXJuICgpID0+IHsKICAgIGlmIChyZWxlYXNlZCkgcmV0dXJuOwogICAgcmVsZWFzZUFjcXVpcmVkKGFjcXVpcmVkLCBsYWJlbCk7CiAgICByZWxlYXNlZCA9IGFjcXVpcmVkLmV2ZXJ5KChpdGVtKSA9PiBpdGVtLmluUHJvY2Vzc1JlbGVhc2VkKTsKICB9Owp9CgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYWNxdWlyZUxvY2FsU3FsaXRlTG9jayhwYXRoLCBvcHRpb25zKSB7CiAgcmV0dXJuIGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2tzKFtwYXRoXSwgb3B0aW9ucyk7Cn0K";
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
function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
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
  return exactKeys(value, [
    "schema", "artifactSha256", "artifactUrl", "sourceRepository", "sourceWorkflow",
    "sourceCommit", "sourceRef", "attestationUrl", "attestationSha256",
    "attestationBytes", "verificationPolicy",
  ]) && value.schema === "agenc-runtime-provenance/v1" &&
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
      strictRelativeRuntimeFile(path, binRel) && strictMarkerMatches(path) &&
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
const AGENC_GENERATED_WRAPPER_SOURCE_BASE64 = "Ly8gQnl0ZS1jYW5vbmljYWwgc3RhbmRhbG9uZS1pbnN0YWxsZXIgd3JhcHBlciBjb250cmFjdCBzaGFyZWQgYnkgdGhlIHJ1bnRpbWUKLy8gdXBkYXRlciBhbmQgYm90aCBlbWJlZGRlZCBpbnN0YWxsZXJzLiBQYXJzaW5nIGlzIGRlbGliZXJhdGVseSBmdWxsLWZpbGU6Ci8vIG1hcmtlciBzdWJzdHJpbmdzIG11c3QgbmV2ZXIgZ3JhbnQgb3duZXJzaGlwIG9mIGEgdXNlci1hdXRob3JlZCBleGVjdXRhYmxlLgoKaW1wb3J0IHsgaXNBYnNvbHV0ZSB9IGZyb20gIm5vZGU6cGF0aCI7CgpleHBvcnQgY29uc3QgR0VORVJBVEVEX1dSQVBQRVJfTUFYX0JZVEVTID0gNjQgKiAxMDI0Owpjb25zdCBQT1NJWF9XUkFQUEVSX1NJR05BVFVSRSA9ICJHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbC5zaCI7CmNvbnN0IENNRF9XUkFQUEVSX1NJR05BVFVSRSA9ICJHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbC5wczEiOwpjb25zdCBXUkFQUEVSX01FVEFEQVRBX1BSRUZJWCA9ICJBZ2VuQyB3cmFwcGVyIG1ldGFkYXRhIHYxOiI7CgpmdW5jdGlvbiB2YWxpZGF0ZVZhbHVlcyhraW5kLCB2YWx1ZXMpIHsKICBpZiAoIXZhbHVlcyB8fCB0eXBlb2YgdmFsdWVzICE9PSAib2JqZWN0IikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigid3JhcHBlciB2YWx1ZXMgbXVzdCBiZSBhbiBvYmplY3QiKTsKICB9CiAgZm9yIChjb25zdCBsYWJlbCBvZiBbIm5vZGVCaW4iLCAicnVudGltZUJpbiIsICJhZ2VuY0hvbWUiXSkgewogICAgY29uc3QgdmFsdWUgPSB2YWx1ZXNbbGFiZWxdOwogICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gInN0cmluZyIpIHRocm93IG5ldyBUeXBlRXJyb3IoYHdyYXBwZXIgJHtsYWJlbH0gbXVzdCBiZSBhIHN0cmluZ2ApOwogICAgaWYgKHZhbHVlLmluY2x1ZGVzKCJcMCIpKSB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgJHtsYWJlbH0gY29udGFpbnMgTlVMYCk7CiAgICBpZiAoa2luZCA9PT0gImNtZCIgJiYgL1siXHJcbl0vdS50ZXN0KHZhbHVlKSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYFdpbmRvd3Mgd3JhcHBlciAke2xhYmVsfSBjb250YWlucyBhbiB1bnN1cHBvcnRlZCBjaGFyYWN0ZXJgKTsKICAgIH0KICB9CiAgaWYgKCFpc0Fic29sdXRlKHZhbHVlcy5hZ2VuY0hvbWUpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoIndyYXBwZXIgQUdFTkNfSE9NRSBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGgiKTsKICB9Cn0KCmZ1bmN0aW9uIG1ldGFkYXRhRm9yKHZhbHVlcykgewogIHJldHVybiBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeSh7CiAgICBub2RlQmluOiB2YWx1ZXMubm9kZUJpbiwKICAgIHJ1bnRpbWVCaW46IHZhbHVlcy5ydW50aW1lQmluLAogICAgYWdlbmNIb21lOiB2YWx1ZXMuYWdlbmNIb21lLAogIH0pLCAidXRmOCIpLnRvU3RyaW5nKCJiYXNlNjR1cmwiKTsKfQoKZnVuY3Rpb24gcmVuZGVyTGVnYWN5T29tUG9zaXhXcmFwcGVyKHsgbm9kZUJpbiwgcnVudGltZUJpbiwgYWdlbmNIb21lIH0pIHsKICByZXR1cm4gWwogICAgIiMhL2Jpbi9zaCIsCiAgICBgIyAke1BPU0lYX1dSQVBQRVJfU0lHTkFUVVJFfSDigJQgcmV3cml0dGVuIG9uIGV2ZXJ5IGluc3RhbGwvdXBncmFkZS5gLAogICAgYGV4cG9ydCBBR0VOQ19IT01FPSJcJHtBR0VOQ19IT01FOi0ke2FnZW5jSG9tZX19ImAsCiAgICAiIyBPT00gc2VsZi1kaWFnbm9zaXM6IGhhdmUgVjggd3JpdGUgYSBoZWFwIHNuYXBzaG90IGZyb20gaW5zaWRlIHRoZSBHQyB3aGVuIiwKICAgICIjIHRoZSBoZWFwIG5lYXJzIGl0cyBsaW1pdCAocmVsaWFibGUgZXZlbiBpbiB0aGUgZW5kLXN0YWdlIEdDIHN0YWxsIHdoZXJlIEpTIiwKICAgICIjIHRpbWVycyBzdGFydmUpLCBpbnRvICRBR0VOQ19IT01FL29vbS1zbmFwc2hvdHMuIFRoZSBydW50aW1lIHBydW5lcyBvbGQiLAogICAgIiMgY2FwdHVyZXMgYW5kIHBvaW50cyBhdCBmcmVzaCBvbmVzIG9uIHRoZSBuZXh0IHN0YXJ0dXAuIFVzZXItcHJvdmlkZWQiLAogICAgIiMgTk9ERV9PUFRJT05TIHdpbjogb3VycyBhcmUgcHJlcGVuZGVkLCBhbmQgd2Ugc2tpcCBlbnRpcmVseSB3aGVuIHRoZSB1c2VyIiwKICAgICIjIGFscmVhZHkgdHVuZXMgaGVhcCBzbmFwc2hvdHMuIiwKICAgICdjYXNlICIgJHtOT0RFX09QVElPTlM6LX0gIiBpbicsCiAgICAiICAqaGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdCopIDogOzsiLAogICAgIiAgKikiLAogICAgJyAgICBta2RpciAtcCAiJHtBR0VOQ19IT01FfS9vb20tc25hcHNob3RzIiAyPi9kZXYvbnVsbCB8fCA6JywKICAgICcgICAgTk9ERV9PUFRJT05TPSItLWhlYXBzbmFwc2hvdC1uZWFyLWhlYXAtbGltaXQ9MSAtLWRpYWdub3N0aWMtZGlyPSR7QUdFTkNfSE9NRX0vb29tLXNuYXBzaG90cyAke05PREVfT1BUSU9OUzotfSInLAogICAgIiAgICBleHBvcnQgTk9ERV9PUFRJT05TIiwKICAgICIgICAgOzsiLAogICAgImVzYWMiLAogICAgYGV4ZWMgIiR7bm9kZUJpbn0iICIke3J1bnRpbWVCaW59IiAiJEAiYCwKICAgICIiLAogIF0uam9pbigiXG4iKTsKfQoKZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckdlbmVyYXRlZFdyYXBwZXJDb250ZW50KHsga2luZCwgbm9kZUJpbiwgcnVudGltZUJpbiwgYWdlbmNIb21lIH0pIHsKICBpZiAoa2luZCAhPT0gInBvc2l4IiAmJiBraW5kICE9PSAiY21kIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgdW5zdXBwb3J0ZWQgd3JhcHBlciBraW5kOiAke1N0cmluZyhraW5kKX1gKTsKICB9CiAgY29uc3QgdmFsdWVzID0geyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUgfTsKICB2YWxpZGF0ZVZhbHVlcyhraW5kLCB2YWx1ZXMpOwogIGNvbnN0IG1ldGFkYXRhID0gbWV0YWRhdGFGb3IodmFsdWVzKTsKICBpZiAoa2luZCA9PT0gImNtZCIpIHsKICAgIGNvbnN0IGJhdGNoID0gKHZhbHVlKSA9PiB2YWx1ZS5yZXBsYWNlQWxsKCIlIiwgIiUlIik7CiAgICByZXR1cm4gWwogICAgICAiQGVjaG8gb2ZmIiwKICAgICAgInNldGxvY2FsIERpc2FibGVEZWxheWVkRXhwYW5zaW9uIiwKICAgICAgYHJlbSAke0NNRF9XUkFQUEVSX1NJR05BVFVSRX0gLSByZXdyaXR0ZW4gb24gZXZlcnkgaW5zdGFsbC91cGdyYWRlLmAsCiAgICAgIGByZW0gJHtXUkFQUEVSX01FVEFEQVRBX1BSRUZJWH0gJHttZXRhZGF0YX1gLAogICAgICBgaWYgbm90IGRlZmluZWQgQUdFTkNfSE9NRSBzZXQgIkFHRU5DX0hPTUU9JHtiYXRjaChhZ2VuY0hvbWUpfSJgLAogICAgICBgIiR7YmF0Y2gobm9kZUJpbil9IiAiJHtiYXRjaChydW50aW1lQmluKX0iICUqYCwKICAgICAgIiIsCiAgICBdLmpvaW4oIlxyXG4iKTsKICB9CiAgY29uc3QgcXVvdGUgPSAodmFsdWUpID0+IGAnJHt2YWx1ZS5yZXBsYWNlQWxsKCInIiwgYCciJyInYCl9J2A7CiAgcmV0dXJuIFsKICAgICIjIS9iaW4vc2giLAogICAgYCMgJHtQT1NJWF9XUkFQUEVSX1NJR05BVFVSRX0g4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsL3VwZ3JhZGUuYCwKICAgIGAjICR7V1JBUFBFUl9NRVRBREFUQV9QUkVGSVh9ICR7bWV0YWRhdGF9YCwKICAgICdpZiBbIC16ICIke0FHRU5DX0hPTUU6LX0iIF07IHRoZW4nLAogICAgYCAgZXhwb3J0IEFHRU5DX0hPTUU9JHtxdW90ZShhZ2VuY0hvbWUpfWAsCiAgICAiZmkiLAogICAgIiMgQ2FwdHVyZSBvbmUgVjggbmVhci1oZWFwLWxpbWl0IHNuYXBzaG90IHVubGVzcyB0aGUgb3BlcmF0b3IgYWxyZWFkeSBjb25maWd1cmVkIGl0LiIsCiAgICAnY2FzZSAiICR7Tk9ERV9PUFRJT05TOi19ICIgaW4nLAogICAgIiAgKmhlYXBzbmFwc2hvdC1uZWFyLWhlYXAtbGltaXQqKSIsCiAgICBgICAgIGV4ZWMgJHtxdW90ZShub2RlQmluKX0gJHtxdW90ZShydW50aW1lQmluKX0gIiRAImAsCiAgICAiICAgIDs7IiwKICAgICIgICopIiwKICAgICcgICAgbWtkaXIgLXAgIiR7QUdFTkNfSE9NRX0vb29tLXNuYXBzaG90cyIgMj4vZGV2L251bGwgfHwgOicsCiAgICBgICAgIGV4ZWMgJHtxdW90ZShub2RlQmluKX0gLS1oZWFwc25hcHNob3QtbmVhci1oZWFwLWxpbWl0PTEgYCArCiAgICAgICctLWRpYWdub3N0aWMtZGlyPSIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiICcgKwogICAgICBgJHtxdW90ZShydW50aW1lQmluKX0gIiRAImAsCiAgICAiICAgIDs7IiwKICAgICJlc2FjIiwKICAgICIiLAogIF0uam9pbigiXG4iKTsKfQoKZnVuY3Rpb24gZGVjb2RlQ2Fub25pY2FsTWV0YWRhdGEoZW5jb2RlZCkgewogIHRyeSB7CiAgICBjb25zdCBieXRlcyA9IEJ1ZmZlci5mcm9tKGVuY29kZWQsICJiYXNlNjR1cmwiKTsKICAgIGlmIChieXRlcy50b1N0cmluZygiYmFzZTY0dXJsIikgIT09IGVuY29kZWQpIHJldHVybiB1bmRlZmluZWQ7CiAgICBjb25zdCBkZWNvZGVkID0gbmV3IFRleHREZWNvZGVyKCJ1dGYtOCIsIHsgZmF0YWw6IHRydWUgfSkuZGVjb2RlKGJ5dGVzKTsKICAgIGNvbnN0IHZhbHVlID0gSlNPTi5wYXJzZShkZWNvZGVkKTsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgIT09ICJvYmplY3QiIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdW5kZWZpbmVkOwogICAgaWYgKAogICAgICBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoICE9PSAzIHx8CiAgICAgIHR5cGVvZiB2YWx1ZS5ub2RlQmluICE9PSAic3RyaW5nIiB8fAogICAgICB0eXBlb2YgdmFsdWUucnVudGltZUJpbiAhPT0gInN0cmluZyIgfHwKICAgICAgdHlwZW9mIHZhbHVlLmFnZW5jSG9tZSAhPT0gInN0cmluZyIKICAgICkgcmV0dXJuIHVuZGVmaW5lZDsKICAgIHJldHVybiB7CiAgICAgIG5vZGVCaW46IHZhbHVlLm5vZGVCaW4sCiAgICAgIHJ1bnRpbWVCaW46IHZhbHVlLnJ1bnRpbWVCaW4sCiAgICAgIGFnZW5jSG9tZTogdmFsdWUuYWdlbmNIb21lLAogICAgfTsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpmdW5jdGlvbiBwYXJzZU1vZGVybihwYXRoLCBjb250ZW50KSB7CiAgY29uc3QgbWFya2VyID0gY29udGVudC5tYXRjaCgKICAgIC9eKCN8cmVtKSBBZ2VuQyB3cmFwcGVyIG1ldGFkYXRhIHYxOiAoW0EtWmEtejAtOV8tXSspXHI/JC9tdSwKICApOwogIGlmIChtYXJrZXIgPT09IG51bGwpIHJldHVybiB1bmRlZmluZWQ7CiAgY29uc3Qga2luZCA9IG1hcmtlclsxXSA9PT0gInJlbSIgPyAiY21kIiA6ICJwb3NpeCI7CiAgY29uc3QgdmFsdWVzID0gZGVjb2RlQ2Fub25pY2FsTWV0YWRhdGEobWFya2VyWzJdKTsKICBpZiAodmFsdWVzID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7CiAgdHJ5IHsKICAgIGNvbnN0IHdyYXBwZXIgPSB7IGtpbmQsIHBhdGgsIC4uLnZhbHVlcyB9OwogICAgcmV0dXJuIHJlbmRlckdlbmVyYXRlZFdyYXBwZXJDb250ZW50KHdyYXBwZXIpID09PSBjb250ZW50ID8gd3JhcHBlciA6IHVuZGVmaW5lZDsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpmdW5jdGlvbiBwYXJzZUxlZ2FjeShwYXRoLCBjb250ZW50KSB7CiAgY29uc3QgcG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKHBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogcG9zaXhbMV0sIG5vZGVCaW46IHBvc2l4WzJdLCBydW50aW1lQmluOiBwb3NpeFszXSB9OwogICAgdHJ5IHsKICAgICAgdmFsaWRhdGVWYWx1ZXMoInBvc2l4IiwgdmFsdWVzKTsKICAgICAgcmV0dXJuIHsga2luZDogInBvc2l4IiwgcGF0aCwgLi4udmFsdWVzIH07CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuIHVuZGVmaW5lZDsKICAgIH0KICB9CiAgLy8gMC42LjIgZGV2ZWxvcG1lbnQgbWFpbiBicmllZmx5IGVtaXR0ZWQgdGhpcyBleGFjdCBmdWxsLWZpbGUgd3JhcHBlciBiZWZvcmUKICAvLyBhY3RpdmF0aW9uIG93bmVyc2hpcCBiZWNhbWUgY2Fub25pY2FsLiBBY2NlcHRpbmcgb25seSBhIGJ5dGUtZm9yLWJ5dGUKICAvLyByZWNvbnN0cnVjdGlvbiBwcmVzZXJ2ZXMgdXBncmFkZXMgZnJvbSB0aGF0IHN1cmZhY2Ugd2l0aG91dCB0dXJuaW5nIHRoZQogIC8vIGhpc3RvcmljYWwgbWFya2VyIGludG8gYSBnZW5lcmFsIG93bmVyc2hpcCBvcmFjbGUuCiAgY29uc3Qgb29tUG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuW1xzXFNdKlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKG9vbVBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7CiAgICAgIGFnZW5jSG9tZTogb29tUG9zaXhbMV0sCiAgICAgIG5vZGVCaW46IG9vbVBvc2l4WzJdLAogICAgICBydW50aW1lQmluOiBvb21Qb3NpeFszXSwKICAgIH07CiAgICB0cnkgewogICAgICB2YWxpZGF0ZVZhbHVlcygicG9zaXgiLCB2YWx1ZXMpOwogICAgICBpZiAocmVuZGVyTGVnYWN5T29tUG9zaXhXcmFwcGVyKHZhbHVlcykgPT09IGNvbnRlbnQpIHsKICAgICAgICByZXR1cm4geyBraW5kOiAicG9zaXgiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICAgICAgfQogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiB1bmRlZmluZWQ7CiAgICB9CiAgfQogIGNvbnN0IGNtZCA9IGNvbnRlbnQubWF0Y2goCiAgICAvXkBlY2hvIG9mZihccj9cbilyZW0gR2VuZXJhdGVkIGJ5IEFnZW5DIGluc3RhbGxcLnBzMSAtIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cMWlmIG5vdCBkZWZpbmVkIEFHRU5DX0hPTUUgc2V0ICJBR0VOQ19IT01FPShbXiJcclxuXSspIlwxIihbXiJcclxuXSspIiAiKFteIlxyXG5dKykiICVcKlwxJC91LAogICk7CiAgaWYgKGNtZCA9PT0gbnVsbCkgcmV0dXJuIHVuZGVmaW5lZDsKICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogY21kWzJdLCBub2RlQmluOiBjbWRbM10sIHJ1bnRpbWVCaW46IGNtZFs0XSB9OwogIHRyeSB7CiAgICB2YWxpZGF0ZVZhbHVlcygiY21kIiwgdmFsdWVzKTsKICAgIHJldHVybiB7IGtpbmQ6ICJjbWQiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpleHBvcnQgZnVuY3Rpb24gcGFyc2VHZW5lcmF0ZWRXcmFwcGVyQ29udGVudChwYXRoLCBjb250ZW50KSB7CiAgaWYgKAogICAgdHlwZW9mIHBhdGggIT09ICJzdHJpbmciIHx8ICFpc0Fic29sdXRlKHBhdGgpIHx8CiAgICB0eXBlb2YgY29udGVudCAhPT0gInN0cmluZyIgfHwgQnVmZmVyLmJ5dGVMZW5ndGgoY29udGVudCwgInV0ZjgiKSA+IEdFTkVSQVRFRF9XUkFQUEVSX01BWF9CWVRFUwogICkgcmV0dXJuIG51bGw7CiAgcmV0dXJuIHBhcnNlTW9kZXJuKHBhdGgsIGNvbnRlbnQpID8/IHBhcnNlTGVnYWN5KHBhdGgsIGNvbnRlbnQpID8/IG51bGw7Cn0K";
let generatedWrapperModulePromise;
function loadGeneratedWrapperModule() {
  generatedWrapperModulePromise ??= import(
    `data:text/javascript;base64,${AGENC_GENERATED_WRAPPER_SOURCE_BASE64}`,
  );
  return generatedWrapperModulePromise;
}
// END GENERATED AGENC WRAPPER CONTRACT MODULE

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
function completeActivationTransaction(journalPath, parseGeneratedWrapperContent) {
  const raw = readOptionalFile(journalPath);
  if (raw === null) return;
  const transaction = validateActivationTransaction(raw, parseGeneratedWrapperContent);
  for (const entry of transaction.entries) {
    const current = readOptionalFile(entry.path);
    if (current !== entry.original && current !== entry.desired) {
      throw new Error(`wrapper changed outside interrupted activation: ${entry.path}`);
    }
  }
  for (const entry of transaction.entries) {
    if (readOptionalFile(entry.path) !== entry.desired) {
      replaceFileAtomically(entry.path, entry.desired, entry.mode);
    }
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
    { parseGeneratedWrapperContent },
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
  const desired = readFileSync(desiredPath, "utf8");
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
    completeActivationTransaction(journalPath, parseGeneratedWrapperContent);
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
    const transaction = {
      version: 1,
      targetVersion,
      entries: [{ path: wrapperPath, original, desired, mode: desiredWrapper.kind === "cmd" ? 0o644 : 0o755 }],
    };
    const serializedTransaction = `${JSON.stringify(transaction)}\n`;
    validateActivationTransaction(serializedTransaction, parseGeneratedWrapperContent);
    replaceFileAtomically(journalPath, serializedTransaction, 0o600);
    completeActivationTransaction(journalPath, parseGeneratedWrapperContent);
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
    if (!isAbsolute(extractionTool)) throw new Error("runtime extraction tool must be an absolute path");
    const extractionToolStat = lstatSync(extractionTool);
    if (!extractionToolStat.isFile() || extractionToolStat.isSymbolicLink()) {
      throw new Error("runtime extraction tool must be a regular file");
    }
    const extracted = spawnSync(extractionTool, ["-xzf", archivePath, "-C", stagingDir], { stdio: "inherit" });
    if (extracted.status !== 0) throw new Error(`tar extraction failed (${extracted.status ?? extracted.signal})`);
    if (!strictRelativeRuntimeFile(stagingDir, binRel)) {
      throw new Error("runtime entrypoint is not a contained regular file");
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
  });
  if (parseGeneratedWrapperContent(resolve(archivePath), content) === null) {
    throw new Error("rendered wrapper failed canonical validation");
  }
  writeFileSync(archivePath, content, {
    flag: "wx",
    mode: kind === "cmd" ? 0o644 : 0o755,
  });
}
async function main() {
  if (mode === "render-wrapper") await renderWrapperMain();
  else if (mode === "activate") await activationMain();
  else await runtimeMain();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
AGENC_RUNTIME_INSTALLER
RECOVERY_STATE="$(node "$RUNTIME_INSTALLER_JS" recover - "$INSTALL_DIR" "$BIN_REL" "$ARTIFACT_SHA" "$OS" \
  "$PROVENANCE_EXPECTATION_BASE64" "")" || \
  fail "runtime crash recovery failed"

if [ "$RECOVERY_STATE" = "ready" ]; then
  log "runtime ${VERSION} already installed (verified marker) — skipping download"
elif [ "$RECOVERY_STATE" = "missing" ]; then
  log "downloading runtime ${VERSION} (${OS}-${ARCH}/abi${ARTIFACT_ABI})..."
  TARBALL="$WORK/runtime.tar.gz"
  fetch_to "$ARTIFACT_URL" "$TARBALL" "$MAX_ARTIFACT_BYTES" "$ARTIFACT_BYTES" "$MANIFEST_TRUST" || \
    fail "bounded download failed: ${ARTIFACT_URL}"

  ACTUAL_SHA="$(sha256_of "$TARBALL")" || fail "sha256 computation failed"
  if [ "$ACTUAL_SHA" != "$ARTIFACT_SHA" ]; then
    fail "checksum mismatch for runtime tarball (expected ${ARTIFACT_SHA}, got ${ACTUAL_SHA}). Refusing to install."
  fi
  ACTUAL_BYTES="$(node -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).size))' "$TARBALL")" \
    || fail "byte-count computation failed"
  if [ "$ACTUAL_BYTES" != "$ARTIFACT_BYTES" ]; then
    fail "byte count mismatch for runtime tarball (expected ${ARTIFACT_BYTES}, got ${ACTUAL_BYTES}). Refusing to install."
  fi
  log "checksum verified"

  verify_official_provenance ||
    fail "official runtime provenance verification failed"

  # Validate every tar/PAX member before invoking tar, then acquire the same
  # per-artifact lock used by the npm launcher and `agenc update`. Extraction
  # happens in a unique sibling directory and is atomically promoted only
  # after the entrypoint and marker are complete.
  node "$RUNTIME_INSTALLER_JS" install "$TARBALL" "$INSTALL_DIR" "$BIN_REL" "$ARTIFACT_SHA" "$OS" \
    "$PROVENANCE_EXPECTATION_BASE64" "$PROVENANCE_RECEIPT_BASE64" "$SYSTEM_TAR" || \
    fail "runtime archive validation or installation failed"
  # AGENC_HOME holds auth tokens, the daemon cookie, and transcripts.
  chmod 700 "$AGENC_HOME_DIR"
  log "runtime ${VERSION} installed at ${INSTALL_DIR}"
else
  fail "runtime crash recovery returned an invalid state"
fi

# --- wrapper -----------------------------------------------------------------

BIN_DIR="${PREFIX}/bin"
WRAPPER="${BIN_DIR}/agenc"
PREFIX_WAS_PRESENT=0
[ -e "$PREFIX" ] && PREFIX_WAS_PRESENT=1
BIN_DIR_WAS_PRESENT=0
[ -e "$BIN_DIR" ] && BIN_DIR_WAS_PRESENT=1
mkdir -p "$BIN_DIR"
if [ "$PREFIX_WAS_PRESENT" -eq 0 ]; then
  chmod 700 "$PREFIX" || fail "could not secure new install prefix: $PREFIX"
fi
if [ "$BIN_DIR_WAS_PRESENT" -eq 0 ]; then
  chmod 700 "$BIN_DIR" || fail "could not secure new wrapper directory: $BIN_DIR"
fi
# Bake absolute node + runtime paths: user services (systemd/launchd) run with
# a minimal PATH where version-manager-installed node is not resolvable.
WRAPPER_TMP="${WORK}/agenc-wrapper"
node "$RUNTIME_INSTALLER_JS" render-wrapper "$WRAPPER_TMP" "$NODE_BIN" "$RUNTIME_BIN" "$AGENC_HOME_DIR" posix || \
  fail "could not render wrapper"
ALLOW_DOWNGRADE=false
[ -n "$PIN_VERSION" ] && ALLOW_DOWNGRADE=true
ACTIVATION_RESULT="$(node "$RUNTIME_INSTALLER_JS" activate "$WRAPPER_TMP" "$WRAPPER" "$AGENC_HOME_DIR" "$VERSION" "$ALLOW_DOWNGRADE")" || \
  fail "wrapper activation failed; any durable activation journal will resume on retry"
rm -f "$WRAPPER_TMP"
case "$ACTIVATION_RESULT" in
  retained\ *) log "kept newer active wrapper (${ACTIVATION_RESULT#retained }): ${WRAPPER}" ;;
  activated) log "installed wrapper: ${WRAPPER}" ;;
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
    log "daemon installed and started (systemd user service agenc-daemon)"
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
