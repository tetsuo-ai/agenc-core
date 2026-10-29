# AgenC one-line installer (Windows).
#
#   iwr -useb https://get.agenc.ag/install.ps1 | iex
#
# Same install contract as install.sh and the npm launcher's runtime-manager:
# downloads the win-<arch> runtime tarball from the release manifest, verifies
# its sha256, extracts to
# $env:AGENC_HOME\runtime\<version>\win-<arch>-native-node-abi-<abi>-sha256-<digest>\ with the
# .agenc-runtime-ok marker, and installs an agenc.cmd shim.
#
# Environment overrides:
#   AGENC_INSTALL_MANIFEST_URL  explicit HTTPS mirror or local file/path
#   AGENC_INSTALL_REPO          GitHub repo (default tetsuo-ai/agenc-releases)
#   AGENC_INSTALL_VERSION       pin a release version
#   AGENC_HOME                  runtime install root (default ~\.agenc)
#   AGENC_INSTALL_PREFIX        shim prefix (default $env:LOCALAPPDATA\agenc)
#   AGENC_NO_MODIFY_PATH=1      do not add <prefix>\bin to the user PATH
#
# The installer adds <prefix>\bin to the user PATH (HKCU\Environment) once,
# keeps the existing entries as they are, and never changes the machine PATH.
# Test seams: AGENC_INSTALL_PLATFORM / AGENC_INSTALL_ARCH override platform
# detection. AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE may point at a local copy of
# the exact pinned Node distribution; production bytes and sha256 still apply.

& {
$ErrorActionPreference = "Stop"
$priorNodeEnvironment = @{}
foreach ($name in @(
  "NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY",
  "PATH", "LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"
)) {
  $priorNodeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
try {

# Inline Node programs are part of the installer bootstrap. Remove ambient
# code-preload and TLS-disable controls before the first child starts. Keep
# reviewed enterprise CA and proxy settings, and opt Node into its documented
# environment-proxy mode.
[Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")
[Environment]::SetEnvironmentVariable("NODE_PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("NODE_TLS_REJECT_UNAUTHORIZED", $null, "Process")
[Environment]::SetEnvironmentVariable("LD_LIBRARY_PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("LD_PRELOAD", $null, "Process")
[Environment]::SetEnvironmentVariable("DYLD_LIBRARY_PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("DYLD_INSERT_LIBRARIES", $null, "Process")
$env:NODE_USE_ENV_PROXY = "1"
$SupportedNodeMajor = 26
$SupportedNodeMinor = 5
$SupportedNodeVersion = "26.12.1"
$LegacyBridgeNodeMajor = 25
$LegacyBridgeNodeMinor = 9
$MaxManifestBytes = 1MB
$MaxArtifactBytes = 256MB
$MaxSigstoreBundleBytes = 4MB
$MaxGhArchiveBytes = 64MB
$OfficialRepo = "tetsuo-ai/agenc-releases"
$ProvenanceSchema = "agenc-runtime-provenance/v1"
$DualProvenanceSchema = "agenc-runtime-provenance/v2"
$ProvenanceRepository = "tetsuo-ai/agenc-core"
$ProvenanceWorkflow = "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml"
$ProvenanceHostname = "github.com"
$ProvenanceOidcIssuer = "https://token.actions.githubusercontent.com"
$ProvenancePredicateType = "https://slsa.dev/provenance/v1"
$script:OfficialProvenanceReceiptBase64 = ""

function Write-Log([string]$msg) { Write-Host "agenc-install: $msg" }
function Fail([string]$msg) { throw "agenc-install: ERROR: $msg" }

# Windows PowerShell 5.1 and PowerShell before 7.3 pass each argument to a native program
# without escaping its embedded double quotes, so an inline Node script loses its string
# quotes. There, and only there, escape them the way the Windows command-line parser reads
# them back; newer PowerShell escapes arguments itself.
$EscapeNativeQuotes = ($null -eq (Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue)) -or
  ($PSNativeCommandArgumentPassing -eq "Legacy")
function ConvertTo-NativeArgument([string]$Value) {
  if (-not $EscapeNativeQuotes) { return $Value }
  # Legacy passing also drops an empty argument, which shifts every positional argument after it.
  if ($Value -eq "") { return '""' }
  $escaped = [regex]::Replace($Value, '(\\*)"', { param($m) $m.Groups[1].Value + $m.Groups[1].Value + '\"' })
  # Legacy passing quotes an argument that has whitespace; keep that closing quote a delimiter.
  if ($escaped -match '\s') {
    $escaped = [regex]::Replace($escaped, '(\\+)$', { param($m) $m.Groups[1].Value + $m.Groups[1].Value })
  }
  return $escaped
}
function ConvertTo-NativeArguments([object[]]$Values) {
  , @($Values | ForEach-Object { ConvertTo-NativeArgument ([string]$_) })
}
# Windows PowerShell's Set-Acl also writes the audit section, which needs a privilege a normal user
# lacks. There, persist only the owner and access rules this installer sets.
function Set-PrivateDirectoryAcl([string]$Path, [System.Security.AccessControl.DirectorySecurity]$Acl) {
  if ($PSVersionTable.PSEdition -eq "Desktop") {
    (Get-Item -LiteralPath $Path -Force).SetAccessControl($Acl)
  } else {
    Set-Acl -LiteralPath $Path -AclObject $Acl
  }
}

function Copy-PinnedBootstrapHttps(
  [string]$Url,
  [string]$Destination,
  [long]$ExactBytes
) {
  try { $uri = [Uri]$Url } catch { Fail "Node.js bootstrap URL is invalid" }
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -cne "https" -or
      $uri.UserInfo -or $uri.Fragment) {
    Fail "Node.js bootstrap URL must be canonical HTTPS"
  }
  Add-Type -AssemblyName System.Net.Http
  # The total deadline scales with the pinned byte count so slow links can
  # finish, mirroring the bounded-fetch contract: minimum sustained rate
  # 128 KiB/s plus 30s grace, never below 120s, test overrides only shorten.
  [long]$minimumSustainedBytesPerSecond = 131072
  [int]$defaultBootstrapTimeoutMs = [Math]::Max(
    120000,
    [int]([Math]::Ceiling($ExactBytes / [double]$minimumSustainedBytesPerSecond)) * 1000 + 30000
  )
  [int]$bootstrapTimeoutMs = $defaultBootstrapTimeoutMs
  if ($env:AGENC_INSTALL_TEST_BOOTSTRAP_TIMEOUT_MS) {
    [int]$parsedBootstrapTimeout = 0
    if (-not [int]::TryParse(
        $env:AGENC_INSTALL_TEST_BOOTSTRAP_TIMEOUT_MS,
        [ref]$parsedBootstrapTimeout
      ) -or $parsedBootstrapTimeout -lt 1 -or
        $parsedBootstrapTimeout -gt $defaultBootstrapTimeoutMs) {
      Fail "invalid Node.js bootstrap deadline"
    }
    $bootstrapTimeoutMs = $parsedBootstrapTimeout
  }
  [int]$bootstrapStallMs = 60000
  if ($env:AGENC_INSTALL_TEST_BOOTSTRAP_STALL_MS) {
    [int]$parsedBootstrapStall = 0
    if (-not [int]::TryParse(
        $env:AGENC_INSTALL_TEST_BOOTSTRAP_STALL_MS,
        [ref]$parsedBootstrapStall
      ) -or $parsedBootstrapStall -lt 1 -or $parsedBootstrapStall -gt 60000) {
      Fail "invalid Node.js bootstrap stall window"
    }
    $bootstrapStallMs = $parsedBootstrapStall
  }
  $deadlineAt = [DateTime]::UtcNow.AddMilliseconds($bootstrapTimeoutMs)
  $deadline = [System.Threading.CancellationTokenSource]::new()
  # One cancellation source covers every network wait: each wait is armed with
  # the smaller of the stall window and the remaining total budget, delivered
  # bytes rearm the stall, and nothing can extend the total deadline.
  $armDeadline = {
    [double]$remainingMs = ($deadlineAt - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMs -lt 1) { $remainingMs = 1 }
    $deadline.CancelAfter([int][Math]::Min([double]$bootstrapStallMs, $remainingMs))
  }
  & $armDeadline
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $true
  $handler.MaxAutomaticRedirections = 5
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
  $request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::Get,
    $uri
  )
  $null = $request.Headers.TryAddWithoutValidation("Accept-Encoding", "identity")
  $response = $null
  $inputStream = $null
  $outputStream = $null
  try {
    $response = $client.SendAsync(
      $request,
      [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
      $deadline.Token
    ).GetAwaiter().GetResult()
    $null = $response.EnsureSuccessStatusCode()
    if ($response.RequestMessage.RequestUri.Scheme -cne "https") {
      Fail "Node.js bootstrap redirect left HTTPS"
    }
    $declared = $response.Content.Headers.ContentLength
    if ($null -ne $declared -and [long]$declared -ne $ExactBytes) {
      Fail "Node.js bootstrap Content-Length mismatch"
    }
    $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $outputStream = [IO.FileStream]::new(
      $Destination,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $buffer = [byte[]]::new(65536)
    [long]$total = 0
    while (($read = $inputStream.ReadAsync(
        $buffer,
        0,
        $buffer.Length,
        $deadline.Token
      ).GetAwaiter().GetResult()) -gt 0) {
      & $armDeadline
      $total += $read
      if ($total -gt $ExactBytes) { Fail "Node.js bootstrap exceeds pinned byte count" }
      $outputStream.Write($buffer, 0, $read)
    }
    $outputStream.Flush($true)
    if ($total -ne $ExactBytes) {
      Fail "Node.js bootstrap byte count mismatch (expected $ExactBytes, got $total)"
    }
  } catch [System.OperationCanceledException] {
    if ([DateTime]::UtcNow -ge $deadlineAt) {
      Fail "Node.js bootstrap deadline exceeded after ${bootstrapTimeoutMs}ms"
    }
    Fail "Node.js bootstrap stalled: no bytes received for ${bootstrapStallMs}ms"
  } finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
    if ($response) { $response.Dispose() }
    $request.Dispose()
    $client.Dispose()
    $handler.Dispose()
    $deadline.Dispose()
  }
}

$BoundedFetch = @'
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
function byteLimiter(onChunk) {
  let count = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (onChunk !== undefined) onChunk();
      if (count > maximum) callback(new Error(`download exceeds ${maximum} byte limit`));
      else if (exact !== undefined && count > exact) {
        callback(new Error(`download exceeds declared ${exact} bytes`));
      } else callback(null, chunk);
    },
    flush(callback) {
      if (exact !== undefined && count !== exact) {
        callback(new Error(`download byte count mismatch (expected ${exact}, got ${count})`));
      } else callback();
    },
  });
}
function validateContentLength(response) {
  const value = response.headers.get("content-length");
  if (value === null) return;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid Content-Length");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid Content-Length");
  if (parsed > maximum) throw new Error(`Content-Length exceeds ${maximum} byte limit`);
  if (exact !== undefined && parsed !== exact) {
    throw new Error(`Content-Length mismatch (expected ${exact}, got ${parsed})`);
  }
}
(async () => {
  try {
    if (trustMode === "explicitLocal") {
      let sourcePath;
      if (/^file:/i.test(resource)) sourcePath = canonicalLocalFileUrlToPath(resource);
      else if (/^https?:/i.test(resource)) throw new Error("explicit local resources must use file URLs or paths");
      else sourcePath = resource;
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
        validateContentLength(response);
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
'@

$CanonicalLocalFileUrlValidator = @'
const { posix, win32 } = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const value = process.argv[2];
function canonicalLocalFileUrlToPath(input, platform = process.platform) {
  if (typeof input !== "string" || input !== input.trim() || /[\0\r\n]/.test(input) ||
      !input.startsWith("file:///")) {
    throw new Error("local artifact URL must be an authority-free file URL");
  }
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error("local artifact URL is invalid"); }
  if (parsed.protocol !== "file:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.host !== "") throw new Error("local artifact URL must not contain an authority");
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("local artifact URL must not contain a query or fragment");
  }
  if (parsed.href !== input) throw new Error("local artifact URL is not canonical");
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
  if (pathToFileURL(path, { windows }).href !== input) {
    throw new Error("local artifact URL does not round-trip canonically");
  }
  return path;
}
try { canonicalLocalFileUrlToPath(value); }
catch (error) { console.error(error.message); process.exitCode = 1; }
'@

function Copy-InstallerResource(
  [string]$Url,
  [string]$Destination,
  [long]$MaximumBytes,
  [string]$ExactBytes,
  [string]$TrustMode
) {
  $fetchArgs = ConvertTo-NativeArguments @($Url, $Destination, [string]$MaximumBytes, $ExactBytes, $TrustMode)
  $BoundedFetch | & node - @fetchArgs
  if ($LASTEXITCODE -ne 0) { Fail "bounded download failed: $Url" }
}

function Confirm-OfficialRuntimeProvenance(
  [string]$Tarball,
  [string]$ArtifactUrl,
  [string]$AttestationUrl,
  [string]$AttestationSha256,
  [long]$AttestationBytes,
  [string]$BuildProvenanceUrl,
  [string]$BuildProvenanceSha256,
  [long]$BuildProvenanceBytes,
  [string]$SourceCommit,
  [string]$SourceRef,
  [string]$Work,
  [string]$Architecture,
  [string]$ExpectedReceiptBase64
) {
  if ($manifestTrust -ne "official") { return }
  if (-not $SourceCommit -or -not $SourceRef) {
    Fail "official manifest did not provide source provenance"
  }
  if ($Architecture -ne "x64") {
    Fail "no pinned GitHub CLI is available for Windows $Architecture"
  }

  $ghVersion = "2.96.0"
  $ghFile = "gh_${ghVersion}_windows_amd64.zip"
  $ghSha = "c2d6acc935cd2f00e2144d7e036d5cd82e6b6bd5594e8c75aa75ef2a4ed6aac3"
  $ghBytes = 14821821
  $ghUrl = "https://github.com/cli/cli/releases/download/v$ghVersion/$ghFile"
  $ghArchive = Join-Path $Work $ghFile
  $ghRoot = Join-Path $Work "gh-verify"
  $ghConfigRoot = Join-Path $Work "gh-config"
  # The Windows zip holds LICENSE and bin/gh.exe at its root, with no versioned folder.
  $ghBinary = Join-Path $ghRoot "bin/gh.exe"
  $bundle = Join-Path $Work "runtime.sigstore.json"
  $buildBundle = Join-Path $Work "runtime.build.sigstore.json"
  $hasBuildProvenance = -not [string]::IsNullOrEmpty($BuildProvenanceUrl)

  Copy-InstallerResource $AttestationUrl $bundle $MaxSigstoreBundleBytes ([string]$AttestationBytes) "official"
  $bundleSha = (Get-FileHash -Algorithm SHA256 $bundle).Hash.ToLowerInvariant()
  if ($bundleSha -cne $AttestationSha256) {
    Fail "Sigstore bundle checksum mismatch (expected $AttestationSha256, got $bundleSha)"
  }
  if ($hasBuildProvenance) {
    Copy-InstallerResource $BuildProvenanceUrl $buildBundle $MaxSigstoreBundleBytes `
      ([string]$BuildProvenanceBytes) "official"
    $buildBundleSha = (Get-FileHash -Algorithm SHA256 $buildBundle).Hash.ToLowerInvariant()
    if ($buildBundleSha -cne $BuildProvenanceSha256) {
      Fail "build provenance bundle checksum mismatch (expected $BuildProvenanceSha256, got $buildBundleSha)"
    }
  }
  Copy-InstallerResource $ghUrl $ghArchive $MaxGhArchiveBytes ([string]$ghBytes) "official"
  $actualGhSha = (Get-FileHash -Algorithm SHA256 $ghArchive).Hash.ToLowerInvariant()
  if ($actualGhSha -cne $ghSha) {
    Fail "GitHub CLI checksum mismatch (expected $ghSha, got $actualGhSha)"
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ghArchive, $ghRoot)
  $ghItem = Get-Item -LiteralPath $ghBinary -Force -ErrorAction SilentlyContinue
  if (-not $ghItem -or $ghItem.PSIsContainer -or
      ($ghItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "pinned GitHub CLI archive did not contain the expected regular file"
  }

  Write-Log "verifying source-workflow provenance for $ArtifactUrl"
  New-Item -ItemType Directory -Path $ghConfigRoot | Out-Null
  $priorGhEnvironment = @{}
  foreach ($name in @(
    "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER",
    "GH_TELEMETRY", "DO_NOT_TRACK", "GH_SPINNER_DISABLED", "GH_DEBUG",
    "GH_PAGER", "PAGER"
  )) {
    $priorGhEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    $env:GH_CONFIG_DIR = $ghConfigRoot
    $env:GH_TOKEN = $null
    $env:GITHUB_TOKEN = $null
    $env:GH_ENTERPRISE_TOKEN = $null
    $env:GITHUB_ENTERPRISE_TOKEN = $null
    $env:GH_PROMPT_DISABLED = "true"
    $env:GH_NO_UPDATE_NOTIFIER = "1"
    $env:GH_TELEMETRY = "0"
    $env:DO_NOT_TRACK = "1"
    $env:GH_SPINNER_DISABLED = "1"
    $env:GH_DEBUG = $null
    $env:GH_PAGER = $null
    $env:PAGER = $null
    if ($hasBuildProvenance) {
      & $ghBinary attestation verify $Tarball `
        --bundle $buildBundle `
        --repo $ProvenanceRepository `
        --signer-workflow $ProvenanceWorkflow `
        --signer-digest $SourceCommit `
        --source-digest $SourceCommit `
        --source-ref "refs/heads/main" `
        --hostname $ProvenanceHostname `
        --cert-oidc-issuer $ProvenanceOidcIssuer `
        --predicate-type $ProvenancePredicateType `
        --deny-self-hosted-runners | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Fail "official runtime build provenance verification failed"
      }
    }
    & $ghBinary attestation verify $Tarball `
      --bundle $bundle `
      --repo $ProvenanceRepository `
      --signer-workflow $ProvenanceWorkflow `
      --signer-digest $SourceCommit `
      --source-digest $SourceCommit `
      --source-ref $SourceRef `
      --hostname $ProvenanceHostname `
      --cert-oidc-issuer $ProvenanceOidcIssuer `
      --predicate-type $ProvenancePredicateType `
      --deny-self-hosted-runners | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "official runtime provenance verification failed" }
  } finally {
    foreach ($name in $priorGhEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $priorGhEnvironment[$name], "Process")
    }
  }
  $postVerifyTarballSha = (Get-FileHash -Algorithm SHA256 $Tarball).Hash.ToLowerInvariant()
  if ($postVerifyTarballSha -cne [string]$artifact.sha256) {
    Fail "runtime tarball changed during provenance verification"
  }
  $postVerifyBundleSha = (Get-FileHash -Algorithm SHA256 $bundle).Hash.ToLowerInvariant()
  if ($postVerifyBundleSha -cne $bundleSha) {
    Fail "Sigstore bundle changed during provenance verification"
  }
  if ($hasBuildProvenance) {
    $postVerifyBuildBundleSha = (
      Get-FileHash -Algorithm SHA256 $buildBundle
    ).Hash.ToLowerInvariant()
    if ($postVerifyBuildBundleSha -cne $buildBundleSha) {
      Fail "build provenance bundle changed during provenance verification"
    }
  }
  $script:OfficialProvenanceReceiptBase64 = $ExpectedReceiptBase64
  Remove-Item -Force -LiteralPath $bundle, $buildBundle, $ghArchive -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force -LiteralPath $ghRoot, $ghConfigRoot -ErrorAction SilentlyContinue
  Write-Log "source-workflow provenance verified"
}

# --- prerequisites -----------------------------------------------------------

$actualWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$nodePlatform = if ($env:AGENC_INSTALL_PLATFORM) { $env:AGENC_INSTALL_PLATFORM } elseif ($actualWindows) {
  "win32"
} else {
  Fail "install.ps1 only supports Windows; use install.sh on Linux/macOS"
}
if ($nodePlatform -ne "win32") { Fail "unsupported operating-system platform: $nodePlatform" }
$arch = if ($env:AGENC_INSTALL_ARCH) { $env:AGENC_INSTALL_ARCH } else {
  switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    ([System.Runtime.InteropServices.Architecture]::X64) { "x64" }
    ([System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" }
    default { Fail "unsupported operating-system architecture" }
  }
}
if ($arch -notin @("x64", "arm64")) { Fail "unsupported operating-system architecture: $arch" }

function Test-NodeContract([string]$Path, [bool]$Legacy) {
  if (-not $Path) { return $false }
  $mode = if ($Legacy) { "legacy" } else { "modern" }
  & $Path -e (ConvertTo-NativeArgument @'
const [expectedPlatform, expectedArch, mode, allowOverride] = process.argv.slice(1);
const [major, minor] = process.versions.node.split(".").map(Number);
const legacy = mode === "legacy";
const versionOk = legacy ? major === 25 && minor >= 9 : major === 26 && minor >= 5;
const abiOk = legacy ? process.versions.modules === "141" : process.versions.modules === "147";
const platformOk = allowOverride === "true" || (
  process.platform === expectedPlatform && process.arch === expectedArch
);
if (!versionOk || !abiOk || process.versions.napi !== "10" || !platformOk) process.exit(1);
'@) $nodePlatform $arch $mode ([string][bool]($env:AGENC_INSTALL_PLATFORM -or $env:AGENC_INSTALL_ARCH)).ToLowerInvariant() `
    2>$null
  return $LASTEXITCODE -eq 0
}

$bootstrapWork = $null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeBin = if ($nodeCommand) { [string]$nodeCommand.Source } else { "" }
if ($env:AGENC_INSTALL_VERSION -ceq "0.7.2") {
  if (-not (Test-NodeContract $nodeBin $true)) {
    $found = if ($nodeBin) { (& $nodeBin -v 2>$null | Out-String).Trim() } else { "none" }
    Fail "The frozen v0.7.2 bridge requires Node.js >=$LegacyBridgeNodeMajor.$LegacyBridgeNodeMinor <26 on the host (ABI 141 / N-API 10), found $found."
  }
} elseif (-not (Test-NodeContract $nodeBin $false)) {
  if ($arch -ne "x64") {
    Fail "no pinned Node.js bootstrap distribution exists for win-$arch"
  }
  $nodeDistributionFile = "node-v26.12.1-win-x64.zip"
  $nodeDistributionSha256 = "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4"
  $nodeDistributionBytes = 41901456
  $bootstrapWork = Join-Path ([IO.Path]::GetTempPath()) "agenc-node-bootstrap-$PID-$([Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $bootstrapWork | Out-Null
  if ($actualWindows) {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $privateAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $privateAcl.SetOwner($currentSid)
    $privateAcl.SetAccessRuleProtection($true, $false)
    $privateRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $currentSid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $privateAcl.AddAccessRule($privateRule)
    Set-PrivateDirectoryAcl $bootstrapWork $privateAcl
  }
  $nodeDistributionArchive = Join-Path $bootstrapWork $nodeDistributionFile
  if ($env:AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE) {
    if (-not [IO.Path]::IsPathFullyQualified($env:AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE)) {
      Fail "AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE must be an absolute path"
    }
    $localNodeArchive = Get-Item -LiteralPath $env:AGENC_INSTALL_BOOTSTRAP_NODE_ARCHIVE -Force
    if (-not $localNodeArchive -or $localNodeArchive.PSIsContainer -or
        ($localNodeArchive.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "pinned local Node bootstrap archive is not a regular file"
    }
    Copy-Item -LiteralPath $localNodeArchive.FullName -Destination $nodeDistributionArchive
  } else {
    $nodeDistributionUrl =
      "https://nodejs.org/dist/v$SupportedNodeVersion/$nodeDistributionFile"
    Copy-PinnedBootstrapHttps `
      $nodeDistributionUrl `
      $nodeDistributionArchive `
      $nodeDistributionBytes
  }
  $nodeArchiveItem = Get-Item -LiteralPath $nodeDistributionArchive -Force
  if ($nodeArchiveItem.Length -ne $nodeDistributionBytes) {
    Fail "Node.js bootstrap byte count mismatch (expected $nodeDistributionBytes, got $($nodeArchiveItem.Length))"
  }
  $nodeArchiveSha = (Get-FileHash -Algorithm SHA256 $nodeDistributionArchive).Hash.ToLowerInvariant()
  if ($nodeArchiveSha -cne $nodeDistributionSha256) {
    Fail "Node.js bootstrap checksum mismatch"
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($nodeDistributionArchive, $bootstrapWork)
  $nodeBin = Join-Path $bootstrapWork "node-v26.12.1-win-x64\node.exe"
  if (-not (Test-Path -LiteralPath $nodeBin -PathType Leaf)) {
    Fail "pinned Node.js bootstrap executable is missing"
  }
  if (-not $actualWindows) {
    & /bin/chmod 700 $nodeBin
    if ($LASTEXITCODE -ne 0) { Fail "could not secure test-seam Node.js bootstrap" }
  }
  & $nodeBin -e (ConvertTo-NativeArgument @'
const allowOverride = process.argv[1] === "true";
if (process.versions.node !== "26.12.1" || process.versions.modules !== "147" ||
    process.versions.napi !== "10" || (!allowOverride && (
      process.platform !== "win32" || process.arch !== "x64"
    ))) process.exit(1);
'@) ([string][bool]($env:AGENC_INSTALL_PLATFORM -or $env:AGENC_INSTALL_ARCH)).ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) { Fail "pinned Node.js bootstrap identity is invalid" }
  if (-not $actualWindows) {
    $testSeamNode = Join-Path (Split-Path -Parent $nodeBin) "node"
    Copy-Item -LiteralPath $nodeBin -Destination $testSeamNode
    & /bin/chmod 700 $testSeamNode
    if ($LASTEXITCODE -ne 0) { Fail "could not prepare test-seam Node.js command" }
    Set-Alias -Name node -Value $testSeamNode -Scope Local
  }
  $env:Path = "$(Split-Path -Parent $nodeBin)$([IO.Path]::PathSeparator)$env:Path"
  Write-Log "using private Node.js $SupportedNodeVersion bootstrap for win-$arch"
}

$node = Get-Command node -ErrorAction Stop
$nodeBin = [string]$node.Source
$nodeMajor = [int](node -e (ConvertTo-NativeArgument "process.stdout.write(process.versions.node.split('.')[0])"))
$nodeModuleAbi = node -e (ConvertTo-NativeArgument "process.stdout.write(process.versions.modules)")
if ($nodeModuleAbi -notmatch "^[0-9]+$") { Fail "Node.js reported an invalid native module ABI: $nodeModuleAbi" }
$tarPath = if ($actualWindows) {
  $resolvedTar = & ([string]$node.Source) -e (ConvertTo-NativeArgument @'
const {
  closeSync, constants, fstatSync, lstatSync, openSync, realpathSync,
} = require("node:fs");
const { win32 } = require("node:path");
const namespaceRoot = String.raw`\\?\GLOBALROOT\SystemRoot`;
const invalidFileId = 0xffff_ffff_ffff_ffffn;
const systemRoot = realpathSync.native(namespaceRoot);
if (!/^[a-z]:\\/iu.test(systemRoot) || win32.normalize(systemRoot) !== systemRoot) {
  throw new Error("trusted Windows SystemRoot did not resolve to a canonical local DOS path");
}
const namespaceTar = win32.join(namespaceRoot, "System32", "tar.exe");
const candidateTar = win32.join(systemRoot, "System32", "tar.exe");
const identity = (path) => lstatSync(path, { bigint: true });
const valid = (metadata) => metadata.isFile() && !metadata.isSymbolicLink() &&
  metadata.dev > 0n && metadata.ino > 0n &&
  metadata.dev !== invalidFileId && metadata.ino !== invalidFileId;
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
let namespaceDescriptor;
let candidateDescriptor;
let operationError;
try {
  const namespaceBefore = identity(namespaceTar);
  const candidateBefore = identity(candidateTar);
  if (!valid(namespaceBefore) || !valid(candidateBefore)) {
    throw new Error("trusted Windows tar path is not a regular file with stable identity");
  }
  namespaceDescriptor = openSync(
    namespaceTar,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  candidateDescriptor = openSync(
    candidateTar,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const namespaceOpened = fstatSync(namespaceDescriptor, { bigint: true });
  const candidateOpened = fstatSync(candidateDescriptor, { bigint: true });
  const namespaceAfter = identity(namespaceTar);
  const candidateAfter = identity(candidateTar);
  if (![namespaceOpened, candidateOpened, namespaceAfter, candidateAfter].every(valid) ||
      !same(namespaceBefore, namespaceOpened) ||
      !same(namespaceOpened, namespaceAfter) ||
      !same(candidateBefore, candidateOpened) ||
      !same(candidateOpened, candidateAfter) ||
      !same(namespaceOpened, candidateOpened)) {
    throw new Error("trusted Windows tar DOS and GLOBALROOT identities do not match");
  }
} catch (error) {
  operationError = error;
}
const closeErrors = [];
for (const descriptor of [candidateDescriptor, namespaceDescriptor]) {
  if (descriptor === undefined) continue;
  try { closeSync(descriptor); } catch (error) { closeErrors.push(error); }
}
if (operationError !== undefined || closeErrors.length > 0) {
  throw new AggregateError(
    operationError === undefined ? closeErrors : [operationError, ...closeErrors],
    "trusted Windows tar identity validation failed",
  );
}
process.stdout.write(candidateTar);
'@)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$resolvedTar)) {
    Fail "the trusted operating-system tar executable is required (bundled with Windows 10 1803+)."
  }
  [string]$resolvedTar
} else {
  $tarCommand = Get-Command /usr/bin/tar -ErrorAction SilentlyContinue
  if (-not $tarCommand) { $tarCommand = Get-Command tar -ErrorAction SilentlyContinue }
  if ($tarCommand) { [string]$tarCommand.Source } else { "" }
}
if ($actualWindows) {
  & ([string]$node.Source) -e (ConvertTo-NativeArgument '
    const { lstatSync } = require("node:fs");
    const path = process.argv[1];
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) process.exit(1);
  ') $tarPath
  if ($LASTEXITCODE -ne 0) {
    Fail "the trusted operating-system tar executable is required (bundled with Windows 10 1803+)."
  }
} else {
  $tarItem = if ($tarPath) { Get-Item -LiteralPath $tarPath -Force -ErrorAction SilentlyContinue } else { $null }
  if (-not $tarItem -or $tarItem.PSIsContainer -or
      ($tarItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "the operating-system tar executable is required."
  }
  $tarPath = [string]$tarItem.FullName
}

if ($env:AGENC_INSTALL_REPO -and
    ($env:AGENC_INSTALL_REPO -notmatch "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" -or
     $env:AGENC_INSTALL_REPO -match "[`0`r`n]")) {
  Fail "release repository must be an owner/name using URL-safe characters"
}
if ($env:AGENC_INSTALL_VERSION -and
    ($env:AGENC_INSTALL_VERSION -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$" -or
     $env:AGENC_INSTALL_VERSION -match "[`0`r`n]")) {
  Fail "AGENC_INSTALL_VERSION must be a canonical semantic version"
}
if ($env:AGENC_INSTALL_VERSION -and $env:AGENC_INSTALL_VERSION -cne "0.7.2") {
  & $nodeBin -e (ConvertTo-NativeArgument @'
const version = process.argv[1];
const actual = version.split("-", 1)[0].split(".").map(BigInt);
const minimum = [0n, 11n, 2n];
for (let index = 0; index < minimum.length; index += 1) {
  if (actual[index] > minimum[index]) process.exit(0);
  if (actual[index] < minimum[index]) process.exit(1);
}
process.exit(0);
'@) $env:AGENC_INSTALL_VERSION
  if ($LASTEXITCODE -ne 0) {
    Fail "runtime $($env:AGENC_INSTALL_VERSION) has no supported standalone activation contract; use the frozen 0.7.2 bridge with host Node 25.9, or 0.11.2 and newer with private Node"
  }
}

# Establish the install identity before any manifest/network work. Relative
# homes are cwd-dependent; existing absolute aliases collapse to one real path.
$defaultProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if (-not $env:AGENC_HOME -and -not $defaultProfile) { Fail "could not resolve the Windows user profile known folder" }
$agencHome = if ($env:AGENC_HOME) { $env:AGENC_HOME } else { Join-Path $defaultProfile ".agenc" }
$CanonicalHome = @'
const { existsSync, lstatSync, mkdirSync, realpathSync } = require("node:fs");
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
process.stdout.write(canonical);
'@
$agencHome = (& node -e (ConvertTo-NativeArgument $CanonicalHome) $agencHome | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $agencHome) { Fail "could not establish canonical AGENC_HOME" }

$DirectoryIdentity = @'
const { lstatSync, realpathSync } = require("node:fs");
const { resolve } = require("node:path");
const requested = resolve(process.argv[1]);
const before = lstatSync(requested, { bigint: true });
if (!before.isDirectory() || before.isSymbolicLink()) {
  throw new Error(`installer private path is not a real directory: ${requested}`);
}
const canonical = realpathSync.native(requested);
const after = lstatSync(canonical, { bigint: true });
if (!after.isDirectory() || after.isSymbolicLink() ||
    before.dev !== after.dev || before.ino !== after.ino) {
  throw new Error(`installer private directory identity changed: ${requested}`);
}
process.stdout.write(JSON.stringify({
  path: canonical,
  dev: after.dev.toString(),
  ino: after.ino.toString(),
}));
'@

function Get-InstallerDirectoryIdentity([string]$Path) {
  $identityJson = (& node -e (ConvertTo-NativeArgument $DirectoryIdentity) $Path | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $identityJson) {
    Fail "could not establish private installer directory identity: $Path"
  }
  try { return ConvertFrom-Json -InputObject $identityJson }
  catch { Fail "private installer directory identity was invalid: $Path" }
}

function Test-InstallerDirectoryIdentity([string]$Path, $Expected) {
  if (-not $Expected) { return $false }
  try { $actual = Get-InstallerDirectoryIdentity $Path }
  catch { return $false }
  return $actual.path -ceq $Expected.path -and
    $actual.dev -ceq $Expected.dev -and $actual.ino -ceq $Expected.ino
}

function Protect-InstallerDirectory([string]$Path) {
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $privateAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $privateAcl.SetOwner($currentSid)
    $privateAcl.SetAccessRuleProtection($true, $false)
    $privateRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $currentSid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $privateAcl.AddAccessRule($privateRule)
    Set-PrivateDirectoryAcl $Path $privateAcl
  } else {
    & node -e (ConvertTo-NativeArgument 'require("node:fs").chmodSync(process.argv[1], 0o700)') $Path
    if ($LASTEXITCODE -ne 0) { Fail "could not secure installer private directory: $Path" }
  }
}

# A private canonical home prevents another local principal from replacing the
# validated temporary root between identity checks and child creation.
Protect-InstallerDirectory $agencHome
$agencHomeIdentity = Get-InstallerDirectoryIdentity $agencHome
$agencHome = [string]$agencHomeIdentity.path

# --- resolve manifest --------------------------------------------------------

$repo = if ($env:AGENC_INSTALL_REPO) { $env:AGENC_INSTALL_REPO } else { $OfficialRepo }
$manifestUrl = $env:AGENC_INSTALL_MANIFEST_URL
$manifestExplicit = [bool]$manifestUrl
if (-not $manifestUrl) {
  if ($env:AGENC_INSTALL_VERSION -ceq "0.7.2") {
    $manifestUrl = "https://github.com/$repo/releases/download/agenc-v0.7.2/agenc-runtime-manifest.json"
  } elseif ($env:AGENC_INSTALL_VERSION) {
    $manifestUrl = "https://github.com/$repo/releases/download/agenc-v$($env:AGENC_INSTALL_VERSION)/agenc-runtime-manifest-v2.json"
  } else {
    $manifestUrl = "https://github.com/$repo/releases/latest/download/agenc-runtime-manifest-v2.json"
  }
}
$expectedManifestRepo = if (-not $manifestExplicit) { $repo } else { "" }
$manifestTrust = if ($manifestUrl -match "^https://") {
  $legacyUrl = "https://github.com/$OfficialRepo/releases/download/agenc-v0.7.2/agenc-runtime-manifest.json"
  if ($repo -eq $OfficialRepo -and -not $manifestExplicit -and
      $env:AGENC_INSTALL_VERSION -ceq "0.7.2" -and $manifestUrl -ceq $legacyUrl) {
    "officialLegacy"
  } elseif ($repo -eq $OfficialRepo -and -not $manifestExplicit) { "official" }
  else { "explicitHttps" }
} elseif ($manifestUrl -match "^http://") {
  Fail "refusing non-HTTPS manifest URL: $manifestUrl"
} else { "explicitLocal" }
if ($manifestTrust -eq "official") {
  $expectedManifestUrl = if ($env:AGENC_INSTALL_VERSION) {
    "https://github.com/$OfficialRepo/releases/download/agenc-v$($env:AGENC_INSTALL_VERSION)/agenc-runtime-manifest-v2.json"
  } else {
    "https://github.com/$OfficialRepo/releases/latest/download/agenc-runtime-manifest-v2.json"
  }
  if ($manifestUrl -ne $expectedManifestUrl) { Fail "official manifest URL is not canonical" }
}

$workParent = Join-Path $agencHome ".installer-tmp"
$workParentCreated = $false
$workParentIdentity = $null
$work = $null
$workIdentity = $null
try {
  if (Test-Path -LiteralPath $workParent) {
    $existingWorkParent = Get-Item -LiteralPath $workParent -Force
    if (-not $existingWorkParent.PSIsContainer -or
        ($existingWorkParent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "private installer temporary parent is not a real directory"
    }
  } else {
    New-Item -ItemType Directory -Path $workParent | Out-Null
    $workParentCreated = $true
  }
  $workParentIdentity = Get-InstallerDirectoryIdentity $workParent
  $workParent = [string]$workParentIdentity.path
  Protect-InstallerDirectory $workParent
  if (-not (Test-InstallerDirectoryIdentity $workParent $workParentIdentity) -or
      -not (Test-InstallerDirectoryIdentity $agencHome $agencHomeIdentity)) {
    Fail "private installer temporary parent changed while it was secured"
  }

  $work = Join-Path $workParent "agenc-install-$PID-$([Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $work | Out-Null
  $workIdentity = Get-InstallerDirectoryIdentity $work
  $work = [string]$workIdentity.path
  Protect-InstallerDirectory $work
  if (-not (Test-InstallerDirectoryIdentity $work $workIdentity) -or
      -not (Test-InstallerDirectoryIdentity $workParent $workParentIdentity)) {
    Fail "private installer temporary root changed while it was secured"
  }

  $manifestFile = Join-Path $work "manifest.json"
  Write-Log "fetching release manifest: $manifestUrl"
  Copy-InstallerResource $manifestUrl $manifestFile $MaxManifestBytes "" $manifestTrust

  try {
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $manifestSource = [System.IO.File]::ReadAllText($manifestFile, $strictUtf8)
  } catch { Fail "runtime manifest is not valid UTF-8" }
  try { $manifest = $manifestSource | ConvertFrom-Json } catch { Fail "runtime manifest is not valid JSON" }
  if (-not $manifest -or $manifest -is [array]) { Fail "runtime manifest root is invalid" }

  function Test-ExactProperties($Value, [string[]]$Names) {
    if (-not $Value -or $Value -is [array]) { return $false }
    return (($Value.PSObject.Properties.Name -join "`0") -ceq ($Names -join "`0"))
  }
  function Test-JsonInteger($Value) {
    return $Value -is [int] -or $Value -is [long]
  }
  function Test-HasProperty($Value, [string]$Name) {
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
  }
  function Test-CleanString($Value) {
    return $Value -is [string] -and $Value -ceq $Value.Trim() -and $Value -notmatch "[`0`r`n]"
  }

  $legacy = [int]$manifest.manifestVersion -eq 1
  if ($legacy) {
    $bridgePlatforms = @("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-x64")
    $bridgeManifestUrl = "https://github.com/$OfficialRepo/releases/download/agenc-v0.7.2/agenc-runtime-manifest.json"
    if ($manifestTrust -ne "officialLegacy" -or $manifestUrl -cne $bridgeManifestUrl -or
        $env:AGENC_INSTALL_VERSION -cne "0.7.2" -or
        -not (Test-ExactProperties $manifest @("manifestVersion", "runtimeVersion", "releaseRepository", "releaseTag", "artifacts")) -or
        [string]$manifest.runtimeVersion -cne "0.7.2" -or
        [string]$manifest.releaseRepository -cne $OfficialRepo -or
        [string]$manifest.releaseTag -cne "agenc-v0.7.2" -or @($manifest.artifacts).Count -ne 5) {
      Fail "legacy manifest is not the exact frozen v0.7.2 bridge"
    }
    for ($index = 0; $index -lt 5; $index += 1) {
      $candidate = @($manifest.artifacts)[$index]
      $key = "$($candidate.platform)-$($candidate.arch)"
      $expectedUrl = "https://github.com/$OfficialRepo/releases/download/agenc-v0.7.2/agenc-runtime-0.7.2-$key-node25-abi141.tar.gz"
      if ($key -cne $bridgePlatforms[$index] -or
          -not (Test-ExactProperties $candidate @("platform", "arch", "runtimeVersion", "url", "sha256", "bytes", "bins")) -or
          -not (Test-ExactProperties $candidate.bins @("agenc")) -or
          [string]$candidate.runtimeVersion -cne "0.7.2" -or [string]$candidate.url -cne $expectedUrl -or
          -not (Test-CleanString $candidate.sha256) -or [string]$candidate.sha256 -notmatch "^[0-9a-f]{64}$" -or
          -not (Test-JsonInteger $candidate.bytes) -or
          [long]$candidate.bytes -le 0 -or [long]$candidate.bytes -gt $MaxArtifactBytes -or
          [string]$candidate.bins.agenc -cne "node_modules/@tetsuo-ai/runtime/bin/agenc") {
        Fail "legacy manifest artifact is invalid: $key"
      }
    }
    if ($nodeMajor -ne 25 -or [string]$nodeModuleAbi -cne "141" -or
        [string](node -e (ConvertTo-NativeArgument "process.stdout.write(process.versions.napi)")) -cne "10") {
      Fail "the frozen v0.7.2 bridge requires exact Node 25 ABI 141 / N-API 10"
    }
    $matches = @($manifest.artifacts | Where-Object { $_.platform -eq "win" -and $_.arch -eq $arch })
  } else {
    if ([int]$manifest.manifestVersion -ne 2) { Fail "unsupported runtime manifest version $($manifest.manifestVersion)" }
    if ($manifestTrust -eq "officialLegacy") {
      Fail "legacy manifest URL did not return the exact frozen v0.7.2 bridge"
    }
    if (-not (Test-CleanString $manifest.runtimeVersion) -or
        -not (Test-CleanString $manifest.releaseTag) -or
        -not (Test-CleanString $manifest.releaseRepository) -or
        [string]$manifest.runtimeVersion -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$" -or
        [string]$manifest.releaseTag -cne "agenc-v$($manifest.runtimeVersion)" -or
        [string]$manifest.releaseRepository -notmatch "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") {
      Fail "runtime manifest release identity is invalid"
    }
    $runtimeVersionMatch = [regex]::Match(
      [string]$manifest.runtimeVersion,
      "^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$"
    )
    $runtimeMajor = [System.Numerics.BigInteger]::Parse(
      $runtimeVersionMatch.Groups[1].Value
    )
    $runtimeMinor = [System.Numerics.BigInteger]::Parse(
      $runtimeVersionMatch.Groups[2].Value
    )
    $runtimePatch = [System.Numerics.BigInteger]::Parse(
      $runtimeVersionMatch.Groups[3].Value
    )
    if ($runtimeMajor -eq [System.Numerics.BigInteger]::Zero -and
        ($runtimeMinor -lt [System.Numerics.BigInteger]::Parse("11") -or
         ($runtimeMinor -eq [System.Numerics.BigInteger]::Parse("11") -and
          $runtimePatch -lt [System.Numerics.BigInteger]::Parse("2")))) {
      Fail "runtime $($manifest.runtimeVersion) has no supported standalone activation contract; use the frozen 0.7.2 bridge with host Node 25.9, or 0.11.2 and newer with private Node"
    }
    $requiresDualProvenance = (
      $runtimeMajor -gt [System.Numerics.BigInteger]::Zero -or
      (
        $runtimeMajor -eq [System.Numerics.BigInteger]::Zero -and
        $runtimeMinor -ge [System.Numerics.BigInteger]::Parse("13")
      )
    )
    if ($expectedManifestRepo -and [string]$manifest.releaseRepository -cne $expectedManifestRepo) {
      Fail "runtime manifest releaseRepository $($manifest.releaseRepository) does not match requested $expectedManifestRepo"
    }
    $allArtifacts = @($manifest.artifacts)
    if ($allArtifacts.Count -lt 1 -or $allArtifacts.Count -gt 128) {
      Fail "runtime manifest artifact collection is invalid"
    }
    $identities = @{}
    foreach ($candidate in $allArtifacts) {
      $identity = "$($candidate.platform)-$($candidate.arch)/abi$($candidate.nodeModuleAbi)"
      $expectedCandidateNode = if ([string]$candidate.platform -ceq "win") {
        "node_modules/.agenc-node/node.exe"
      } else {
        "node_modules/.agenc-node/bin/node"
      }
      if ($identity -notmatch "^(linux-(x64|arm64)|darwin-(x64|arm64)|win-x64)/abi[0-9]+$") {
        Fail "manifest artifact identity is invalid ($identity)"
      }
      if ($identities.ContainsKey($identity)) { Fail "duplicate runtime manifest artifact $identity" }
      $identities[$identity] = $true
      $candidateBytes = [string]$candidate.bytes
      if ([string]$candidate.runtimeVersion -cne [string]$manifest.runtimeVersion -or
          -not (Test-JsonInteger $candidate.nodeMajor) -or [long]$candidate.nodeMajor -lt 1 -or
          -not (Test-CleanString $candidate.nodeModuleAbi) -or
          [string]$candidate.nodeModuleAbi -notmatch "^[0-9]+$" -or
          -not (Test-CleanString $candidate.nodeApiVersion) -or
          [string]$candidate.nodeApiVersion -notmatch "^[0-9]+$" -or
          -not (Test-CleanString $candidate.sha256) -or [string]$candidate.sha256 -notmatch "^[0-9a-f]{64}$" -or
          -not (Test-JsonInteger $candidate.bytes) -or
          $candidateBytes -notmatch "^[1-9][0-9]*$" -or [long]$candidateBytes -gt $MaxArtifactBytes -or
          [string]$candidate.bins.agenc -cne "node_modules/@tetsuo-ai/runtime/bin/agenc" -or
          [string]$candidate.bins.node -cne $expectedCandidateNode -or
          (
            [string]$candidate.platform -ceq "linux" -and
            [string]$candidate.bins.nodeLibrary -cne "node_modules/.agenc-node/lib"
          ) -or
          (
            [string]$candidate.platform -cne "linux" -and
            (Test-HasProperty $candidate.bins "nodeLibrary")
          ) -or
          -not (Test-CleanString $candidate.url)) {
        Fail "manifest artifact identity is invalid ($identity)"
      }
      try { $candidateUri = [Uri]([string]$candidate.url) } catch { Fail "manifest artifact URL is invalid" }
      if (-not $candidateUri.IsAbsoluteUri) { Fail "manifest artifact URL is invalid" }
      if ($manifestTrust -eq "explicitLocal") {
        $CanonicalLocalFileUrlValidator | & node - ([string]$candidate.url)
        if ($LASTEXITCODE -ne 0) { Fail "explicit local manifests may only use canonical file artifact URLs" }
        if ((Test-HasProperty $candidate "attestationUrl") -or
            (Test-HasProperty $candidate "attestationSha256") -or
            (Test-HasProperty $candidate "attestationBytes") -or
            (Test-HasProperty $candidate "buildProvenanceUrl") -or
            (Test-HasProperty $candidate "buildProvenanceSha256") -or
            (Test-HasProperty $candidate "buildProvenanceBytes")) {
          Fail "explicit local runtime artifacts must not declare remote attestations"
        }
      } elseif ($candidateUri.Scheme -cne "https") {
        Fail "remote manifests may only reference HTTPS artifacts"
      }
      if ($manifestTrust -ne "explicitLocal") {
        $candidateName = "agenc-runtime-$($manifest.runtimeVersion)-$($candidate.platform)-$($candidate.arch)-node$($candidate.nodeMajor)-abi$($candidate.nodeModuleAbi).tar.gz"
        $expectedUrl = "https://github.com/$($manifest.releaseRepository)/releases/download/$($manifest.releaseTag)/$candidateName"
        if ([string]$candidate.url -cne $expectedUrl) { Fail "manifest artifact URL is not canonical" }
      }
      $hasAttestation = (Test-HasProperty $candidate "attestationUrl") -or
        (Test-HasProperty $candidate "attestationSha256") -or
        (Test-HasProperty $candidate "attestationBytes")
      if ($manifestTrust -eq "official" -or $hasAttestation) {
        if ([string]$candidate.attestationUrl -cne "$($candidate.url).sigstore.json") {
          Fail "runtime artifact attestation URL is not canonical"
        }
        if (-not (Test-CleanString $candidate.attestationSha256) -or
            [string]$candidate.attestationSha256 -notmatch "^[0-9a-f]{64}$") {
          Fail "runtime artifact attestation digest is invalid"
        }
        if (-not (Test-JsonInteger $candidate.attestationBytes) -or
            [long]$candidate.attestationBytes -le 0 -or
            [long]$candidate.attestationBytes -gt $MaxSigstoreBundleBytes) {
          Fail "runtime artifact attestation size is invalid"
        }
      }
      $hasBuildProvenance = (Test-HasProperty $candidate "buildProvenanceUrl") -or
        (Test-HasProperty $candidate "buildProvenanceSha256") -or
        (Test-HasProperty $candidate "buildProvenanceBytes")
      if (
        ($manifestTrust -eq "official" -and $requiresDualProvenance) -or
        $hasBuildProvenance
      ) {
        if ([string]$candidate.buildProvenanceUrl -cne "$($candidate.url).build.sigstore.json") {
          Fail "runtime artifact build provenance URL is not canonical"
        }
        if (-not (Test-CleanString $candidate.buildProvenanceSha256) -or
            [string]$candidate.buildProvenanceSha256 -notmatch "^[0-9a-f]{64}$") {
          Fail "runtime artifact build provenance digest is invalid"
        }
        if (-not (Test-JsonInteger $candidate.buildProvenanceBytes) -or
            [long]$candidate.buildProvenanceBytes -le 0 -or
            [long]$candidate.buildProvenanceBytes -gt $MaxSigstoreBundleBytes) {
          Fail "runtime artifact build provenance size is invalid"
        }
      }
      if ($manifestTrust -eq "official" -and [string]$manifest.releaseRepository -cne $OfficialRepo) {
        Fail "manifest release repository is not official"
      }
    }
    if ($manifestTrust -ne "explicitLocal") {
      $build = $manifest.build
      if (-not $build -or $build -is [array] -or
          [string]$build.sourceRef -cne "refs/tags/$($manifest.releaseTag)" -or
          -not (Test-CleanString $build.sourceCommit) -or [string]$build.sourceCommit -notmatch "^[0-9a-f]{40,64}$" -or
          -not (Test-JsonInteger $build.sourceDateEpoch) -or [long]$build.sourceDateEpoch -lt 0 -or
          -not (Test-CleanString $build.lockfileSha256) -or [string]$build.lockfileSha256 -notmatch "^[0-9a-f]{64}$" -or
          -not (Test-CleanString $build.nodeVersion) -or [string]$build.nodeVersion -notmatch "^v\d+\.\d+\.\d+$" -or
          -not (Test-JsonInteger $build.nodeMajor) -or [long]$build.nodeMajor -lt 1 -or
          -not (Test-CleanString $build.nodeModuleAbi) -or [string]$build.nodeModuleAbi -notmatch "^[0-9]+$" -or
          -not (Test-CleanString $build.nodeApiVersion) -or [string]$build.nodeApiVersion -notmatch "^[0-9]+$" -or
          -not (Test-CleanString $build.npmVersion) -or [string]$build.npmVersion -notmatch "^\d+\.\d+\.\d+$" -or
          [string]$build.artifactProfile -cne "release" -or
          [int](([string]$build.nodeVersion).Substring(1).Split(".")[0]) -ne [int]$build.nodeMajor) {
        Fail "runtime manifest build provenance is invalid"
      }
      $hasReleaseCandidate = Test-HasProperty $build "releaseCandidate"
      if (($manifestTrust -eq "official" -and $requiresDualProvenance) -or
          $hasReleaseCandidate) {
        $releaseCandidate = $build.releaseCandidate
        $expectedReleaseCandidateProperties = @(
          "workflow",
          "runId",
          "runAttempt",
          "runUrl",
          "phase",
          "sourceRef",
          "evidenceSha256"
        ) | Sort-Object -CaseSensitive
        $actualReleaseCandidateProperties = if ($releaseCandidate -is [pscustomobject]) {
          @($releaseCandidate.PSObject.Properties.Name) | Sort-Object -CaseSensitive
        } else {
          @()
        }
        if (-not ($releaseCandidate -is [pscustomobject]) -or
            ($actualReleaseCandidateProperties -join "`0") -cne
              ($expectedReleaseCandidateProperties -join "`0") -or
            [string]$releaseCandidate.workflow -cne "release-runtime.yml" -or
            -not (Test-JsonInteger $releaseCandidate.runId) -or
            [long]$releaseCandidate.runId -le 0 -or
            [long]$releaseCandidate.runId -gt 9007199254740991 -or
            -not (Test-JsonInteger $releaseCandidate.runAttempt) -or
            [long]$releaseCandidate.runAttempt -le 0 -or
            [long]$releaseCandidate.runAttempt -gt 9007199254740991 -or
            [string]$releaseCandidate.runUrl -cne
              "https://github.com/tetsuo-ai/agenc-core/actions/runs/$($releaseCandidate.runId)" -or
            [string]$releaseCandidate.phase -cne "candidate" -or
            [string]$releaseCandidate.sourceRef -cne "refs/heads/main" -or
            [string]$releaseCandidate.evidenceSha256 -cnotmatch "^[0-9a-f]{64}$" -or
            [string]$build.sourceCommit -cnotmatch "^[0-9a-f]{40}$") {
          Fail "runtime release candidate identity is invalid"
        }
      }
      foreach ($candidate in $allArtifacts) {
        if ([int]$candidate.nodeMajor -ne [int]$build.nodeMajor -or
            [string]$candidate.nodeModuleAbi -cne [string]$build.nodeModuleAbi -or
            [string]$candidate.nodeApiVersion -cne [string]$build.nodeApiVersion) {
          Fail "runtime manifest artifact disagrees with build provenance"
        }
      }
    }
    $matches = @($allArtifacts | Where-Object {
      $_.platform -eq "win" -and $_.arch -eq $arch
    })
  }
  if ($matches.Count -ne 1) {
    $have = ($manifest.artifacts | ForEach-Object { "$($_.platform)-$($_.arch)/abi$($_.nodeModuleAbi)" }) -join ", "
    if ($matches.Count -eq 0) { Fail "no runtime build for win-$arch (available: $have)" }
    Fail "duplicate runtime builds for win-$arch"
  }
  $artifact = $matches[0]
  $version = [string]$manifest.runtimeVersion
  $artifactBytes = [string]$artifact.bytes
  $artifactNodeMajor = if ($legacy) { 25 } else { [int]$artifact.nodeMajor }
  $artifactNodeApiVersion = if ($legacy) { "10" } else { [string]$artifact.nodeApiVersion }
  if ($version -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$" -or
      [string]$artifact.runtimeVersion -ne $version -or
      [string]$artifact.sha256 -notmatch "^[0-9a-f]{64}$" -or
      $artifactBytes -notmatch "^[1-9][0-9]*$" -or [long]$artifactBytes -gt $MaxArtifactBytes -or
      $artifactNodeApiVersion -notmatch "^[0-9]+$" -or
      $artifactNodeApiVersion -ne [string](node -e (ConvertTo-NativeArgument "process.stdout.write(process.versions.napi)")) -or
      [string]$artifact.bins.agenc -ne "node_modules/@tetsuo-ai/runtime/bin/agenc" -or
      (-not $legacy -and (
        $artifactNodeMajor -ne 26 -or [string]$artifact.nodeModuleAbi -cne "147" -or
        $artifactNodeApiVersion -cne "10" -or
        [string]$artifact.bins.node -cne "node_modules/.agenc-node/node.exe" -or
        (Test-HasProperty $artifact.bins "nodeLibrary")
      ))) {
    Fail "manifest artifact identity is invalid"
  }
  if ($artifactNodeMajor -ne $nodeMajor) {
    Fail "runtime requires Node $artifactNodeMajor.x; current Node is $nodeMajor.x"
  }
  if ($env:AGENC_INSTALL_VERSION -and $version -ne $env:AGENC_INSTALL_VERSION) {
    Fail "manifest runtime $version does not match pinned version $($env:AGENC_INSTALL_VERSION)"
  }
  $binRel = "node_modules/@tetsuo-ai/runtime/bin/agenc"

  $versionDir = Join-Path (Join-Path $agencHome "runtime") $version
  $artifactKey = "win-$arch-native-node-abi-$nodeModuleAbi"
  $installDir = Join-Path $versionDir "$artifactKey-sha256-$($artifact.sha256)"
  $marker = Join-Path $installDir ".agenc-runtime-ok"
  $runtimeBin = Join-Path $installDir ($binRel -replace "/", "\")
  $nodeBinRel = if ($legacy) { "" } else { [string]$artifact.bins.node }
  $nodeLibraryRel = ""
  $privateNodeBin = if ($legacy) {
    $nodeBin
  } else {
    Join-Path $installDir ($nodeBinRel -replace "/", "\")
  }
  # The private Node must be the exact Node the release manifest's build record
  # names, so a pinned older release keeps installing after this installer pins
  # a newer Node. A local manifest has no verified build record and uses the
  # installer's pin.
  $privateNodeVersion = if ($legacy) {
    ""
  } elseif ($manifestTrust -ne "explicitLocal") {
    ([string]$manifest.build.nodeVersion).Substring(1)
  } else {
    $SupportedNodeVersion
  }

  $provenanceExpectationBase64 = ""
  if ($manifestTrust -eq "official") {
    $hasBuildProvenance = Test-HasProperty $artifact "buildProvenanceUrl"
    $expectation = [ordered]@{
      schema = if ($hasBuildProvenance) { $DualProvenanceSchema } else { $ProvenanceSchema }
      artifactSha256 = [string]$artifact.sha256
      artifactUrl = [string]$artifact.url
      sourceRepository = $ProvenanceRepository
      sourceWorkflow = $ProvenanceWorkflow
      sourceCommit = [string]$manifest.build.sourceCommit
      sourceRef = [string]$manifest.build.sourceRef
      attestationUrl = [string]$artifact.attestationUrl
      attestationSha256 = [string]$artifact.attestationSha256
      attestationBytes = [long]$artifact.attestationBytes
    }
    if ($hasBuildProvenance) {
      $expectation["buildProvenanceUrl"] = [string]$artifact.buildProvenanceUrl
      $expectation["buildProvenanceSha256"] = [string]$artifact.buildProvenanceSha256
      $expectation["buildProvenanceBytes"] = [long]$artifact.buildProvenanceBytes
      $expectation["buildSourceRef"] = "refs/heads/main"
    }
    $expectation["verificationPolicy"] = [ordered]@{
      hostname = $ProvenanceHostname
      certOidcIssuer = $ProvenanceOidcIssuer
      predicateType = $ProvenancePredicateType
      denySelfHostedRunners = $true
    }
    $expectationJson = $expectation | ConvertTo-Json -Compress -Depth 5
    $provenanceExpectationBase64 = [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes($expectationJson)
    )
  }

  # --- download + verify + extract (idempotent via the marker contract) -----

  $RuntimeInstaller = @'
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
  return import("data:text/javascript;base64,Ly8gQ2xlYW51cCBpcyBkZWxpYmVyYXRlbHkgbWFjT1Mtb25seS4gS2VlcCBMaW51eC9XaW5kb3dzIGluc3RhbGwgc2VtYW50aWNzLgppbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tICJub2RlOmNoaWxkX3Byb2Nlc3MiOwppbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAibm9kZTpjcnlwdG8iOwppbXBvcnQgeyBjbG9zZVN5bmMsIGNvbnN0YW50cywgZmNobW9kU3luYywgZnN0YXRTeW5jLCBmc3luY1N5bmMsIGxzdGF0U3luYywgbWtkaXJTeW5jLCBvcGVuU3luYywgcmVhZEZpbGVTeW5jLAogIHJlYWRkaXJTeW5jLCByZWFscGF0aFN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYyB9IGZyb20gIm5vZGU6ZnMiOwppbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSAibm9kZTpwYXRoIjsKaW1wb3J0IHsgYWNxdWlyZUxvY2FsU3FsaXRlTG9jayB9IGZyb20gImRhdGE6dGV4dC9qYXZhc2NyaXB0O2Jhc2U2NCxMeThnUTNKdmMzTXRjSEp2WTJWemN5QnNiMk5oYkNCbWFXeGxjM2x6ZEdWdElHeHZZMnR6SUdKaFkydGxaQ0JpZVNCVFVVeHBkR1VuY3lCUFV5QnNiMk5yYVc1bklHeGhlV1Z5TGdvdkx3b3ZMeUJDUlVkSlRpQkpUVTFGUkVsQlZFVWdiM2R1Y3lCMGFHVWdkM0pwZEdWeUlISmxjMlZ5ZG1GMGFXOXVJR1p2Y2lCMGFHVWdZMkZzYkdWeUozTWdZM0pwZEdsallXd0tMeThnYzJWamRHbHZiaTRnVTFGTWFYUmxJSEpsYkdWaGMyVnpJR2wwSUc5dUlHTnNiM05sSUc5eUlIQnliMk5sYzNNZ1pHVmhkR2dzSUdsdVkyeDFaR2x1WnlCVFNVZExTVXhNTGdvdkx5QkJJSEJ5YjJObGMzTXRkMmxrWlNCR1NVWlBJSEpsWjJsemRISjVJSEJ5WlhabGJuUnpJR1IxY0d4cFkyRjBaU0J0YjJSMWJHVWdhVzV6ZEdGdVkyVnpJR1p5YjIwS0x5OGdZbXh2WTJ0cGJtY2diMjVsSUdGdWIzUm9aWElnYVc1emFXUmxJSE41Ym1Ob2NtOXViM1Z6SUZOUlRHbDBaU0JqWVd4c2N6c2dZM0p2YzNNdGNISnZZMlZ6Y3lCaWRYTjVDaTh2SUdOdmJuUmxiblJwYjI0Z2FYTWdjbVYwY21sbFpDQmhjM2x1WTJoeWIyNXZkWE5zZVNCaFoyRnBibk4wSUc5dVpTQnRiMjV2ZEc5dWFXTWdaR1ZoWkd4cGJtVXVDZ3BwYlhCdmNuUWdleUJsZUdWalJtbHNaU0I5SUdaeWIyMGdJbTV2WkdVNlkyaHBiR1JmY0hKdlkyVnpjeUk3Q21sdGNHOXlkQ0I3Q2lBZ1kyeHZjMlZUZVc1akxBb2dJR052Ym5OMFlXNTBjeUJoY3lCbWMwTnZibk4wWVc1MGN5d0tJQ0JtYzNSaGRGTjVibU1zQ2lBZ2JITjBZWFJUZVc1akxBb2dJRzl3Wlc1VGVXNWpMQW9nSUhKbFlXeHdZWFJvVTNsdVl5d0tmU0JtY205dElDSnViMlJsT21aeklqc0thVzF3YjNKMElIc0tJQ0JqYUcxdlpDd0tJQ0JzYzNSaGRDd0tJQ0J0YTJScGNpd0tJQ0J2Y0dWdUxBb2dJSEpsWVdSR2FXeGxMQW9nSUhKbFlXeHdZWFJvTEFwOUlHWnliMjBnSW01dlpHVTZabk12Y0hKdmJXbHpaWE1pT3dwcGJYQnZjblFnZXdvZ0lHSmhjMlZ1WVcxbExBb2dJR1JwY201aGJXVXNDaUFnYW05cGJpd0tJQ0J5WlhOdmJIWmxMQW9nSUhObGNDd0tJQ0IzYVc0ek1pd0tmU0JtY205dElDSnViMlJsT25CaGRHZ2lPd3BwYlhCdmNuUWdleUJ6WlhSVWFXMWxiM1YwSUdGeklHUmxiR0Y1SUgwZ1puSnZiU0FpYm05a1pUcDBhVzFsY25NdmNISnZiV2x6WlhNaU93b0tZMjl1YzNRZ1RFOURTMTlCVUZCTVNVTkJWRWxQVGw5SlJDQTlJREI0TkRFME56UmxORE03SUM4dklDSkJSMDVESWdwamIyNXpkQ0JNVDBOTFgwWlBVazFCVkY5V1JWSlRTVTlPSUQwZ01Uc0tZMjl1YzNRZ1UxRk1TVlJGWDBKVlUxa2dQU0ExT3dwamIyNXpkQ0JTUlVkSlUxUlNXVjlXUlZKVFNVOU9JRDBnTVRzS1kyOXVjM1FnVWtWSFNWTlVVbGxmVTFsTlFrOU1JRDBnVTNsdFltOXNMbVp2Y2lnaVFIUmxkSE4xYnkxaGFTOWhaMlZ1WXk1emNXeHBkR1V0Ykc5amF5MXlaV2RwYzNSeWVTSXBPd3BqYjI1emRDQk5RVmhmUWxWVFdWOVNSVlJTV1Y5TlV5QTlJRFV3T3dwamIyNXpkQ0JOUVZoZlZFbE5SVkpmUkVWTVFWbGZUVk1nUFNBeVh6RTBOMTgwT0ROZk5qUTNPd3BqYjI1emRDQkVRVkpYU1U1ZlJrbE1SVk5aVTFSRlRWOVFVazlDUlY5VVNVMUZUMVZVWDAxVElEMGdNbDh3TURBN0NtTnZibk4wSUZWT1UxVlFVRTlTVkVWRVgwWkpURVZmU1VSZk5qUWdQU0F3ZUdabVptWmZabVptWmw5bVptWm1YMlptWm1adU93cGpiMjV6ZENCWFNVNUVUMWRUWDFCQlZFaGZWRkpCVGxOUVQxSlVYMDFCV0Y5RFNFRlNVeUE5SURFMlh6TTRORHNLWTI5dWMzUWdWMGxPUkU5WFUxOVFRVlJJWDFSU1FVNVRVRTlTVkY5TlFWaGZSVTVVVWtsRlV5QTlJREV5T0RzS1kyOXVjM1FnVjBsT1JFOVhVMTlUV1ZOVVJVMWZVazlQVkNBOUlGTjBjbWx1Wnk1eVlYZGdYRncvWEVkTVQwSkJURkpQVDFSY1UzbHpkR1Z0VW05dmRHQTdDbU52Ym5OMElGZEpUa1JQVjFOZlJWaEZRMVZVUVVKTVJWOUdTVXhGVTFsVFZFVk5JRDBnZXdvZ0lHeHpkR0YwT2lBb2NHRjBhQ2tnUFQ0Z2JITjBZWFJUZVc1aktIQmhkR2dzSUhzZ1ltbG5hVzUwT2lCMGNuVmxJSDBwTEFvZ0lHOXdaVzQ2SUNod1lYUm9LU0E5UGlCdmNHVnVVM2x1WXlnS0lDQWdJSEJoZEdnc0NpQWdJQ0JtYzBOdmJuTjBZVzUwY3k1UFgxSkVUMDVNV1NCOElDaG1jME52Ym5OMFlXNTBjeTVQWDA1UFJrOU1URTlYSUQ4L0lEQXBMQW9nSUNrc0NpQWdabk4wWVhRNklDaGtaWE5qY21sd2RHOXlLU0E5UGlCbWMzUmhkRk41Ym1Nb1pHVnpZM0pwY0hSdmNpd2dleUJpYVdkcGJuUTZJSFJ5ZFdVZ2ZTa3NDaUFnWTJ4dmMyVTZJR05zYjNObFUzbHVZeXdLZlRzS1kyOXVjM1FnVEU5RFFVeGZSa2xNUlZOWlUxUkZUVjlVV1ZCRlV5QTlJRzVsZHlCVFpYUW9Xd29nSUNKaGNHWnpJaXdnSW1KallXTm9aV1p6SWl3Z0ltSjBjbVp6SWl3Z0ltVjRabUYwSWl3Z0ltVjRkRElpTENBaVpYaDBNeUlzSUNKbGVIUTBJaXdnSW1ZeVpuTWlMQW9nSUNKb1puTWlMQ0FpYUdaemNHeDFjeUlzSUNKcVpuTWlMQ0FpYlhOa2IzTWlMQ0FpYm1sc1puTXlJaXdnSW01MFpuTWlMQ0FpYm5SbWN6TWlMQ0FpYjNabGNteGhlU0lzQ2lBZ0luSmhiV1p6SWl3Z0luSmxhWE5sY21aeklpd2dJblJ0Y0daeklpd2dJblZpYVdaeklpd2dJblZtY3lJc0lDSjJabUYwSWl3Z0luaG1jeUlzSUNKNlpuTWlMQXBkS1RzS1kyOXVjM1FnUkVGU1YwbE9YMEZEVEY5U1JVRkVYMUpKUjBoVVV5QTlJRzVsZHlCVFpYUW9Xd29nSUNKeVpXRmtJaXdnSW14cGMzUWlMQ0FpYzJWaGNtTm9JaXdnSW1WNFpXTjFkR1VpTENBaWNtVmhaR0YwZEhJaUxDQWljbVZoWkdWNGRHRjBkSElpTENBaWNtVmhaSE5sWTNWeWFYUjVJaXdLWFNrN0NtTnZibk4wSUVSQlVsZEpUbDlCUTB4ZlNVNUlSVkpKVkVGT1EwVmZSa3hCUjFNZ1BTQnVaWGNnVTJWMEtGc0tJQ0FpWm1sc1pWOXBibWhsY21sMElpd2dJbVJwY21WamRHOXllVjlwYm1obGNtbDBJaXdnSW14cGJXbDBYMmx1YUdWeWFYUWlMQ0FpYjI1c2VWOXBibWhsY21sMElpd0tYU2s3Q21OdmJuTjBJRVJCVWxkSlRsOUJRMHhmVFZWVVFWUkpUMDVmVWtsSFNGUlRJRDBnYm1WM0lGTmxkQ2hiQ2lBZ0luZHlhWFJsSWl3Z0ltRndjR1Z1WkNJc0lDSmhaR1JmWm1sc1pTSXNJQ0poWkdSZmMzVmlaR2x5WldOMGIzSjVJaXdnSW1SbGJHVjBaU0lzSUNKa1pXeGxkR1ZmWTJocGJHUWlMQW9nSUNKM2NtbDBaV0YwZEhJaUxDQWlkM0pwZEdWbGVIUmhkSFJ5SWl3Z0luZHlhWFJsYzJWamRYSnBkSGtpTENBaVkyaHZkMjRpTEFwZEtUc0tZMjl1YzNRZ1JFRlNWMGxPWDBGRFRGOUxUazlYVGw5VVQwdEZUbE1nUFNCdVpYY2dVMlYwS0ZzS0lDQXVMaTVFUVZKWFNVNWZRVU5NWDFKRlFVUmZVa2xIU0ZSVExBb2dJQzR1TGtSQlVsZEpUbDlCUTB4ZlNVNUlSVkpKVkVGT1EwVmZSa3hCUjFNc0NpQWdMaTR1UkVGU1YwbE9YMEZEVEY5TlZWUkJWRWxQVGw5U1NVZElWRk1zQ2wwcE93cGpiMjV6ZENCRVFWSlhTVTVmUVVOTVgxWkZVa1JKUTFSZlEwRkRTRVZmVEVsTlNWUWdQU0ExTVRJN0NtTnZibk4wSUdSaGNuZHBia0ZqYkZabGNtUnBZM1J6SUQwZ2JtVjNJRTFoY0NncE93b0tZMjl1YzNRZ1YwbE9SRTlYVTE5VFJVTlZVa2xVV1Y5VFExSkpVRlFnUFNCVGRISnBibWN1Y21GM1lBb2tSWEp5YjNKQlkzUnBiMjVRY21WbVpYSmxibU5sSUQwZ0oxTjBiM0FuQ2lNZ1MyVmxjQ0IwYUdseklHUnBjbVZqZEMwdVRrVlVJRzl1YkhrNklHMXZaSFZzWlNCaGRYUnZiRzloWkNCallXNGdaWGhvWVhWemRDQjBhR1VnYzJoaGNtVmtJR3h2WTJzZ1pHVmhaR3hwYm1VdUNpUjBjbUZ1YzNCdmNuUWdQU0JiYzNSeWFXNW5YU1JsYm5ZNlFVZEZUa05mVEU5RFMxOVFRVlJJVXdwcFppQW9XM04wY21sdVoxMDZPa2x6VG5Wc2JFOXlSVzF3ZEhrb0pIUnlZVzV6Y0c5eWRDa2dMVzl5SUNSMGNtRnVjM0J2Y25RdVRHVnVaM1JvSUMxbmRDQWtlMWRKVGtSUFYxTmZVRUZVU0Y5VVVrRk9VMUJQVWxSZlRVRllYME5JUVZKVGZTa2dld29nSUhSb2NtOTNJQ2RwYm5aaGJHbGtJSEJ5YjNSbFkzUmxaQzF3WVhSb0lIUnlZVzV6Y0c5eWRDY0tmUW9rWlc1MGNtbGxjeUE5SUZ0emRISnBibWRiWFYwa2RISmhibk53YjNKMExsTndiR2wwS0Z0amFHRnlYVEV3S1FwcFppQW9KR1Z1ZEhKcFpYTXVRMjkxYm5RZ0xXeDBJREVnTFc5eUlDUmxiblJ5YVdWekxrTnZkVzUwSUMxbmRDQWtlMWRKVGtSUFYxTmZVRUZVU0Y5VVVrRk9VMUJQVWxSZlRVRllYMFZPVkZKSlJWTjlLU0I3Q2lBZ2RHaHliM2NnSjJsdWRtRnNhV1FnY0hKdmRHVmpkR1ZrTFhCaGRHZ2dkSEpoYm5Od2IzSjBKd3A5Q2lSamRYSnlaVzUwVTJsa0lEMGdXMU41YzNSbGJTNVRaV04xY21sMGVTNVFjbWx1WTJsd1lXd3VWMmx1Wkc5M2MwbGtaVzUwYVhSNVhUbzZSMlYwUTNWeWNtVnVkQ2dwTGxWelpYSXVWbUZzZFdVS0pIUnlkWE4wWldRZ1BTQkFLQW9nSUNSamRYSnlaVzUwVTJsa0xBb2dJQ2RUTFRFdE5TMHhPQ2NzQ2lBZ0oxTXRNUzAxTFRNeUxUVTBOQ2NzQ2lBZ0oxTXRNUzAxTFRnd0xUazFOakF3T0RnNE5TMHpOREU0TlRJeU5qUTVMVEU0TXpFd016Z3dORFF0TVRnMU16STVNall6TVMweU1qY3hORGM0TkRZMEp3b3BDaU1nVTNCbFkybG1hV01nYlhWMFlYUnBiMjRnY21sbmFIUnpJSEJzZFhNZ1IwVk9SVkpKUTE5WFVrbFVSU0JoYm1RZ1IwVk9SVkpKUTE5QlRFd3VDaVJzWldGbVRYVjBZWFJwYjI1TllYTnJJRDBnVzJsdWREWTBYVEV6TkRNd01qazFPVEFLSkdGdVkyVnpkRzl5VFhWMFlYUnBiMjVOWVhOcklEMGdXMmx1ZERZMFhURXpORE13TWprMU9EWUtabTl5WldGamFDQW9KR1Z1ZEhKNUlHbHVJQ1JsYm5SeWFXVnpLU0I3Q2lBZ0pITmxjR0Z5WVhSdmNpQTlJQ1JsYm5SeWVTNUpibVJsZUU5bUtGdGphR0Z5WFRVNEtRb2dJR2xtSUNna2MyVndZWEpoZEc5eUlDMXNkQ0F4SUMxdmNpQWtjMlZ3WVhKaGRHOXlJQzFsY1NBb0pHVnVkSEo1TGt4bGJtZDBhQ0F0SURFcEtTQjdDaUFnSUNCMGFISnZkeUFuYVc1MllXeHBaQ0J3Y205MFpXTjBaV1F0Y0dGMGFDQjBjbUZ1YzNCdmNuUW5DaUFnZlFvZ0lDUnliMnhsSUQwZ0pHVnVkSEo1TGxOMVluTjBjbWx1Wnlnd0xDQWtjMlZ3WVhKaGRHOXlLUW9nSUdsbUlDaEFLQ2RzWldGbVJHbHlaV04wYjNKNUp5d2dKMkZ1WTJWemRHOXlSR2x5WldOMGIzSjVKeXdnSjJacGJHVW5LU0F0Ym05MFkyOXVkR0ZwYm5NZ0pISnZiR1VwSUhzS0lDQWdJSFJvY205M0lDSnBiblpoYkdsa0lIQnliM1JsWTNSbFpDMXdZWFJvSUhKdmJHVTZJQ1J5YjJ4bElnb2dJSDBLSUNBa1pXNWpiMlJsWkZCaGRHZ2dQU0FrWlc1MGNua3VVM1ZpYzNSeWFXNW5LQ1J6WlhCaGNtRjBiM0lnS3lBeEtRb2dJR2xtSUNnb0pHVnVZMjlrWldSUVlYUm9Ma3hsYm1kMGFDQWxJRFFwSUMxdVpTQXdLU0I3SUhSb2NtOTNJQ2RwYm5aaGJHbGtJSEJ5YjNSbFkzUmxaQzF3WVhSb0lIUnlZVzV6Y0c5eWRDY2dmUW9nSUNSd1lYUm9RbmwwWlhNZ1BTQmJVM2x6ZEdWdExrTnZiblpsY25SZE9qcEdjbTl0UW1GelpUWTBVM1J5YVc1bktDUmxibU52WkdWa1VHRjBhQ2tLSUNCcFppQW9LQ1J3WVhSb1FubDBaWE11VEdWdVozUm9JQ1VnTWlrZ0xXNWxJREFwSUhzZ2RHaHliM2NnSjJsdWRtRnNhV1FnY0hKdmRHVmpkR1ZrTFhCaGRHZ2dkSEpoYm5Od2IzSjBKeUI5Q2lBZ2FXWWdLRnRUZVhOMFpXMHVRMjl1ZG1WeWRGMDZPbFJ2UW1GelpUWTBVM1J5YVc1bktDUndZWFJvUW5sMFpYTXBJQzFqYm1VZ0pHVnVZMjlrWldSUVlYUm9LU0I3Q2lBZ0lDQjBhSEp2ZHlBbmJtOXVMV05oYm05dWFXTmhiQ0J3Y205MFpXTjBaV1F0Y0dGMGFDQjBjbUZ1YzNCdmNuUW5DaUFnZlFvZ0lDUndZWFJvUTJoaGNtRmpkR1Z5Y3lBOUlGdGphR0Z5VzExZE9qcHVaWGNvVzJsdWRGMG9KSEJoZEdoQ2VYUmxjeTVNWlc1bmRHZ2dMeUF5S1NrS0lDQm1iM0lnS0NScGJtUmxlQ0E5SURBN0lDUnBibVJsZUNBdGJIUWdKSEJoZEdoRGFHRnlZV04wWlhKekxreGxibWQwYURzZ0pHbHVaR1Y0SUNzOUlERXBJSHNLSUNBZ0lDUmllWFJsVDJabWMyVjBJRDBnSkdsdVpHVjRJQ29nTWdvZ0lDQWdKR3h2ZDBKNWRHVWdQU0JiYVc1MFhTUndZWFJvUW5sMFpYTmJKR0o1ZEdWUFptWnpaWFJkQ2lBZ0lDQWthR2xuYUVKNWRHVWdQU0JiYVc1MFhTUndZWFJvUW5sMFpYTmJKR0o1ZEdWUFptWnpaWFFnS3lBeFhRb2dJQ0FnSkhCaGRHaERhR0Z5WVdOMFpYSnpXeVJwYm1SbGVGMGdQU0JiWTJoaGNsMG9KR3h2ZDBKNWRHVWdMV0p2Y2lBb0pHaHBaMmhDZVhSbElDMXphR3dnT0NrcENpQWdmUW9nSUNSeVpYRjFaWE4wWldRZ1BTQmJjM1J5YVc1blhUbzZibVYzS0NSd1lYUm9RMmhoY21GamRHVnljeWtLSUNBa2JYVjBZWFJwYjI1TllYTnJJRDBnYVdZZ0tDUnliMnhsSUMxbGNTQW5ZVzVqWlhOMGIzSkVhWEpsWTNSdmNua25LU0I3Q2lBZ0lDQWtZVzVqWlhOMGIzSk5kWFJoZEdsdmJrMWhjMnNLSUNCOUlHVnNjMlVnZXdvZ0lDQWdKR3hsWVdaTmRYUmhkR2x2YmsxaGMyc0tJQ0I5Q2lBZ0pHWjFiR3dnUFNCYlUzbHpkR1Z0TGtsUExsQmhkR2hkT2pwSFpYUkdkV3hzVUdGMGFDZ2tjbVZ4ZFdWemRHVmtLUW9nSUdsbUlDZ2tablZzYkM1VGRHRnlkSE5YYVhSb0tDZGNYQ2NwSUMxdmNpQWtablZzYkM1VGRHRnlkSE5YYVhSb0tDZGNYRDljSnlrZ0xXOXlJQ1JtZFd4c0xsTjBZWEowYzFkcGRHZ29KMXhjTGx3bktTa2dld29nSUNBZ2RHaHliM2NnSW01bGRIZHZjbXNnWVc1a0lHUmxkbWxqWlNCd1lYUm9jeUJoY21VZ2RXNXpkWEJ3YjNKMFpXUTZJQ1JtZFd4c0lnb2dJSDBLSUNBa1lYUjBjbWxpZFhSbGN5QTlJRnRUZVhOMFpXMHVTVTh1Um1sc1pWMDZPa2RsZEVGMGRISnBZblYwWlhNb0pHWjFiR3dwQ2lBZ2FXWWdLQ2drWVhSMGNtbGlkWFJsY3lBdFltRnVaQ0JiVTNsemRHVnRMa2xQTGtacGJHVkJkSFJ5YVdKMWRHVnpYVG82VW1Wd1lYSnpaVkJ2YVc1MEtTQXRibVVnTUNrZ2V3b2dJQ0FnZEdoeWIzY2dJbkpsY0dGeWMyVWdjRzlwYm5SeklHRnlaU0IxYm5OMWNIQnZjblJsWkRvZ0pHWjFiR3dpQ2lBZ2ZRb2dJQ1JwYzBScGNtVmpkRzl5ZVNBOUlDZ2tZWFIwY21saWRYUmxjeUF0WW1GdVpDQmJVM2x6ZEdWdExrbFBMa1pwYkdWQmRIUnlhV0oxZEdWelhUbzZSR2x5WldOMGIzSjVLU0F0Ym1VZ01Bb2dJR2xtSUNna2FYTkVhWEpsWTNSdmNua2dMVzVsSUNna2NtOXNaU0F0Ym1VZ0oyWnBiR1VuS1NrZ2V3b2dJQ0FnZEdoeWIzY2dJbkJ5YjNSbFkzUmxaQzF3WVhSb0lISnZiR1VnWkc5bGN5QnViM1FnYldGMFkyZ2dhWFJ6SUhSNWNHVTZJQ1JtZFd4c0lnb2dJSDBLSUNBa1pISnBkbVVnUFNCYlUzbHpkR1Z0TGtsUExrUnlhWFpsU1c1bWIxMDZPbTVsZHloYlUzbHpkR1Z0TGtsUExsQmhkR2hkT2pwSFpYUlFZWFJvVW05dmRDZ2tablZzYkNrcENpQWdhV1lnS0VBb01pd2dNeXdnTmlrZ0xXNXZkR052Ym5SaGFXNXpJRnRwYm5SZEpHUnlhWFpsTGtSeWFYWmxWSGx3WlNrZ2V3b2dJQ0FnZEdoeWIzY2dJbTV2Ymkxc2IyTmhiQ0JrY21sMlpTQnBjeUIxYm5OMWNIQnZjblJsWkRvZ0pHWjFiR3dpQ2lBZ2ZRb2dJR2xtSUNna1pISnBkbVV1UkhKcGRtVkdiM0p0WVhRZ0xXNWxJQ2RPVkVaVEp5a2dld29nSUNBZ2RHaHliM2NnSW1acGJHVnplWE4wWlcwZ1kyRnVibTkwSUdWdVptOXlZMlVnZEdobElISmxjWFZwY21Wa0lFRkRUQ0JqYjI1MGNtRmpkRG9nSkdaMWJHd2lDaUFnZlFvZ0lDUmhZMnhUWldOMGFXOXVjeUE5SUZ0VGVYTjBaVzB1VTJWamRYSnBkSGt1UVdOalpYTnpRMjl1ZEhKdmJDNUJZMk5sYzNORGIyNTBjbTlzVTJWamRHbHZibk5kT2pwUGQyNWxjaUF0WW05eUlGdFRlWE4wWlcwdVUyVmpkWEpwZEhrdVFXTmpaWE56UTI5dWRISnZiQzVCWTJObGMzTkRiMjUwY205c1UyVmpkR2x2Ym5OZE9qcEJZMk5sYzNNS0lDQnBaaUFvSkdselJHbHlaV04wYjNKNUtTQjdDaUFnSUNBa1lXTnNJRDBnVzFONWMzUmxiUzVKVHk1RWFYSmxZM1J2Y25sZE9qcEhaWFJCWTJObGMzTkRiMjUwY205c0tDUm1kV3hzTENBa1lXTnNVMlZqZEdsdmJuTXBDaUFnZlNCbGJITmxJSHNLSUNBZ0lDUmhZMndnUFNCYlUzbHpkR1Z0TGtsUExrWnBiR1ZkT2pwSFpYUkJZMk5sYzNORGIyNTBjbTlzS0NSbWRXeHNMQ0FrWVdOc1UyVmpkR2x2Ym5NcENpQWdmUW9nSUdsbUlDZ3RibTkwSUNSaFkyd3VRWEpsUVdOalpYTnpVblZzWlhORFlXNXZibWxqWVd3cElIc0tJQ0FnSUhSb2NtOTNJQ0p1YjI0dFkyRnViMjVwWTJGc0lFRkRUQ0JwY3lCMWJuTjFjSEJ2Y25SbFpEb2dKR1oxYkd3aUNpQWdmUW9nSUNSaWVYUmxjeUE5SUNSaFkyd3VSMlYwVTJWamRYSnBkSGxFWlhOamNtbHdkRzl5UW1sdVlYSjVSbTl5YlNncENpQWdKSEpoZHlBOUlGdFRlWE4wWlcwdVUyVmpkWEpwZEhrdVFXTmpaWE56UTI5dWRISnZiQzVTWVhkVFpXTjFjbWwwZVVSbGMyTnlhWEIwYjNKZE9qcHVaWGNvSkdKNWRHVnpMQ0F3S1FvZ0lHbG1JQ2drYm5Wc2JDQXRaWEVnSkhKaGR5NUVhWE5qY21WMGFXOXVZWEo1UVdOc0tTQjdDaUFnSUNCMGFISnZkeUFpYm5Wc2JDQkVRVU5NSUdseklIVnVjM1Z3Y0c5eWRHVmtPaUFrWm5Wc2JDSUtJQ0I5Q2lBZ0pHOTNibVZ5SUQwZ0pHRmpiQzVIWlhSUGQyNWxjaWhiVTNsemRHVnRMbE5sWTNWeWFYUjVMbEJ5YVc1amFYQmhiQzVUWldOMWNtbDBlVWxrWlc1MGFXWnBaWEpkS1M1V1lXeDFaUW9nSUdsbUlDZ2tkSEoxYzNSbFpDQXRibTkwWTI5dWRHRnBibk1nSkc5M2JtVnlLU0I3Q2lBZ0lDQjBhSEp2ZHlBaWRXNTBjblZ6ZEdWa0lHOTNibVZ5SUZOSlJDQnZiaUJzYjJOcklIQmhkR2c2SUNSbWRXeHNJZ29nSUgwS0lDQWtjblZzWlhNZ1BTQWtZV05zTGtkbGRFRmpZMlZ6YzFKMWJHVnpLQW9nSUNBZ0pIUnlkV1VzQ2lBZ0lDQWtkSEoxWlN3S0lDQWdJRnRUZVhOMFpXMHVVMlZqZFhKcGRIa3VVSEpwYm1OcGNHRnNMbE5sWTNWeWFYUjVTV1JsYm5ScFptbGxjbDBLSUNBcENpQWdabTl5WldGamFDQW9KSEoxYkdVZ2FXNGdKSEoxYkdWektTQjdDaUFnSUNCcFppQW9KSEoxYkdVdVFXTmpaWE56UTI5dWRISnZiRlI1Y0dVZ0xXNWxJRnRUZVhOMFpXMHVVMlZqZFhKcGRIa3VRV05qWlhOelEyOXVkSEp2YkM1QlkyTmxjM05EYjI1MGNtOXNWSGx3WlYwNk9rRnNiRzkzS1NCN0NpQWdJQ0FnSUdOdmJuUnBiblZsQ2lBZ0lDQjlDaUFnSUNBa2FXNW9aWEpwZEU5dWJIa2dQU0FvSkhKMWJHVXVVSEp2Y0dGbllYUnBiMjVHYkdGbmN5QXRZbUZ1WkNCYlUzbHpkR1Z0TGxObFkzVnlhWFI1TGtGalkyVnpjME52Ym5SeWIyd3VVSEp2Y0dGbllYUnBiMjVHYkdGbmMxMDZPa2x1YUdWeWFYUlBibXg1S1NBdGJtVWdNQW9nSUNBZ2FXWWdLQ1JwYm1obGNtbDBUMjVzZVNrZ2V3b2dJQ0FnSUNBa1kyaHBiR1JKYm1obGNtbDBZVzVqWlNBOUlGdFRlWE4wWlcwdVUyVmpkWEpwZEhrdVFXTmpaWE56UTI5dWRISnZiQzVKYm1obGNtbDBZVzVqWlVac1lXZHpYVG82VDJKcVpXTjBTVzVvWlhKcGRDQXRZbTl5SUZ0VGVYTjBaVzB1VTJWamRYSnBkSGt1UVdOalpYTnpRMjl1ZEhKdmJDNUpibWhsY21sMFlXNWpaVVpzWVdkelhUbzZRMjl1ZEdGcGJtVnlTVzVvWlhKcGRBb2dJQ0FnSUNBa2NtVmhZMmhsYzA1bGQwTm9hV3hrSUQwZ0tDUnlkV3hsTGtsdWFHVnlhWFJoYm1ObFJteGhaM01nTFdKaGJtUWdKR05vYVd4a1NXNW9aWEpwZEdGdVkyVXBJQzF1WlNBd0NpQWdJQ0FnSUdsbUlDZ2tjbTlzWlNBdGJtVWdKMnhsWVdaRWFYSmxZM1J2Y25rbklDMXZjaUF0Ym05MElDUnlaV0ZqYUdWelRtVjNRMmhwYkdRcElIc0tJQ0FnSUNBZ0lDQmpiMjUwYVc1MVpRb2dJQ0FnSUNCOUNpQWdJQ0I5Q2lBZ0lDQWtjMmxrSUQwZ0pISjFiR1V1U1dSbGJuUnBkSGxTWldabGNtVnVZMlV1Vm1Gc2RXVUtJQ0FnSUNSeWFXZG9kSE1nUFNBb1cybHVkRFkwWFNSeWRXeGxMa1pwYkdWVGVYTjBaVzFTYVdkb2RITXBJQzFpWVc1a0lGdHBiblEyTkYwME1qazBPVFkzTWprMUNpQWdJQ0JwWmlBb0pIUnlkWE4wWldRZ0xXNXZkR052Ym5SaGFXNXpJQ1J6YVdRZ0xXRnVaQ0FvS0NSeWFXZG9kSE1nTFdKaGJtUWdKRzExZEdGMGFXOXVUV0Z6YXlrZ0xXNWxJREFwS1NCN0NpQWdJQ0FnSUhSb2NtOTNJQ0oxYm5SeWRYTjBaV1FnYlhWMFlYUnBiMjRnUVVORklHOXVJR3h2WTJzZ2NHRjBhRG9nSkdaMWJHd2lDaUFnSUNCOUNpQWdmUXA5Q2x0RGIyNXpiMnhsWFRvNlQzVjBMbGR5YVhSbEtDZFBTeWNwQ21BN0NtTnZibk4wSUZkSlRrUlBWMU5mVTBWRFZWSkpWRmxmVTBOU1NWQlVYMEpCVTBVMk5DQTlJRUoxWm1abGNpNW1jbTl0S0FvZ0lGZEpUa1JQVjFOZlUwVkRWVkpKVkZsZlUwTlNTVkJVTEFvZ0lDSjFkR1l4Tm14bElpd0tLUzUwYjFOMGNtbHVaeWdpWW1GelpUWTBJaWs3Q2dwbGVIQnZjblFnWTJ4aGMzTWdURzlqWVd4VGNXeHBkR1ZNYjJOclZHbHRaVzkxZEVWeWNtOXlJR1Y0ZEdWdVpITWdSWEp5YjNJZ2V3b2dJR052Ym5OMGNuVmpkRzl5S0hzZ2NHRjBhQ3dnYkdGaVpXd3NJSFJwYldWdmRYUk5jeXdnWTJGMWMyVWdmU2tnZXdvZ0lDQWdjM1Z3WlhJb0NpQWdJQ0FnSUdCaFoyVnVZem9nSkh0c1lXSmxiSDBnZEdsdFpXUWdiM1YwSUdGbWRHVnlJQ1I3ZEdsdFpXOTFkRTF6ZlcxeklIZGhhWFJwYm1jZ1ptOXlJR3h2WTJGc0lIQnliMk5sYzNNZ2JHOWpheUFrZTNCaGRHaDlZQ3dLSUNBZ0lDQWdZMkYxYzJVZ1BUMDlJSFZ1WkdWbWFXNWxaQ0EvSUhWdVpHVm1hVzVsWkNBNklIc2dZMkYxYzJVZ2ZTd0tJQ0FnSUNrN0NpQWdJQ0IwYUdsekxtNWhiV1VnUFNBaVRHOWpZV3hUY1d4cGRHVk1iMk5yVkdsdFpXOTFkRVZ5Y205eUlqc0tJQ0FnSUhSb2FYTXVZMjlrWlNBOUlDSkJSMFZPUTE5TVQwTkxYMVJKVFVWUFZWUWlPd29nSUNBZ2RHaHBjeTV3WVhSb0lEMGdjR0YwYURzS0lDQWdJSFJvYVhNdWJHRmlaV3dnUFNCc1lXSmxiRHNLSUNBZ0lIUm9hWE11ZEdsdFpXOTFkRTF6SUQwZ2RHbHRaVzkxZEUxek93b2dJSDBLZlFvS1puVnVZM1JwYjI0Z2RHbHRaVzkxZEVWeWNtOXlLR052Ym5SbGVIUXNJSEJoZEdnc0lHTmhkWE5sS1NCN0NpQWdjbVYwZFhKdUlHNWxkeUJNYjJOaGJGTnhiR2wwWlV4dlkydFVhVzFsYjNWMFJYSnliM0lvZXdvZ0lDQWdjR0YwYUN3S0lDQWdJR3hoWW1Wc09pQmpiMjUwWlhoMExteGhZbVZzTEFvZ0lDQWdkR2x0Wlc5MWRFMXpPaUJqYjI1MFpYaDBMblJwYldWdmRYUk5jeXdLSUNBZ0lHTmhkWE5sTEFvZ0lIMHBPd3A5Q2dwbWRXNWpkR2x2YmlCeVpXMWhhVzVwYm1kTmFXeHNhWE5sWTI5dVpITW9ZMjl1ZEdWNGRDa2dld29nSUhKbGRIVnliaUJOWVhSb0xtWnNiMjl5S0dOdmJuUmxlSFF1WkdWaFpHeHBibVVnTFNCd1pYSm1iM0p0WVc1alpTNXViM2NvS1NrN0NuMEtDbVoxYm1OMGFXOXVJSFJvY205M1NXWkZlSEJwY21Wa0tHTnZiblJsZUhRc0lIQmhkR2dzSUdOaGRYTmxLU0I3Q2lBZ2FXWWdLSEpsYldGcGJtbHVaMDFwYkd4cGMyVmpiMjVrY3loamIyNTBaWGgwS1NBOFBTQXdLU0I3Q2lBZ0lDQjBhSEp2ZHlCMGFXMWxiM1YwUlhKeWIzSW9ZMjl1ZEdWNGRDd2djR0YwYUN3Z1kyRjFjMlVwT3dvZ0lIMEtmUW9LWm5WdVkzUnBiMjRnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2djR2hoYzJVcElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdjbVZ6ZFd4MElEMGdZMjl1ZEdWNGRDNXZibEJ5YjJkeVpYTnpQeTRvY0doaGMyVXBPd29nSUNBZ2FXWWdLSEpsYzNWc2RDQWhQVDBnZFc1a1pXWnBibVZrS1NCN0NpQWdJQ0FnSUhadmFXUWdVSEp2YldselpTNXlaWE52YkhabEtISmxjM1ZzZENrdVkyRjBZMmdvS0NrZ1BUNGdlMzBwT3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnZXdvZ0lDQWdMeThnUkdsaFoyNXZjM1JwWTNNZ2JYVnpkQ0J1WlhabGNpQmphR0Z1WjJVZ2JHOWpheUJoWTNGMWFYTnBkR2x2YmlCdmNpQnlaV3hsWVhObElITmxiV0Z1ZEdsamN5NEtJQ0I5Q24wS0NtWjFibU4wYVc5dUlIQnliMk5sYzNOTWIyTnJVbVZuYVhOMGNua29LU0I3Q2lBZ1kyOXVjM1FnWTNWeWNtVnVkQ0E5SUhCeWIyTmxjM05iVWtWSFNWTlVVbGxmVTFsTlFrOU1YVHNLSUNCcFppQW9ZM1Z5Y21WdWRDQWhQVDBnZFc1a1pXWnBibVZrS1NCN0NpQWdJQ0JwWmlBb0NpQWdJQ0FnSUdOMWNuSmxiblFnUFQwOUlHNTFiR3dnZkh3S0lDQWdJQ0FnZEhsd1pXOW1JR04xY25KbGJuUWdJVDA5SUNKdlltcGxZM1FpSUh4OENpQWdJQ0FnSUdOMWNuSmxiblF1ZG1WeWMybHZiaUFoUFQwZ1VrVkhTVk5VVWxsZlZrVlNVMGxQVGlCOGZBb2dJQ0FnSUNBaEtHTjFjbkpsYm5RdWJHOWphM01nYVc1emRHRnVZMlZ2WmlCTllYQXBDaUFnSUNBcElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0FvZ0lDQWdJQ0FnSUNKaFoyVnVZem9nYVc1amIyMXdZWFJwWW14bElIQnliMk5sYzNNdGQybGtaU0JUVVV4cGRHVWdiRzlqYXlCeVpXZHBjM1J5ZVNCcGN5QmhiSEpsWVdSNUlHbHVjM1JoYkd4bFpDSXNDaUFnSUNBZ0lDazdDaUFnSUNCOUNpQWdJQ0J5WlhSMWNtNGdZM1Z5Y21WdWREc0tJQ0I5Q2lBZ1kyOXVjM1FnWTNKbFlYUmxaQ0E5SUhzZ2RtVnljMmx2YmpvZ1VrVkhTVk5VVWxsZlZrVlNVMGxQVGl3Z2JHOWphM002SUc1bGR5Qk5ZWEFvS1NCOU93b2dJRTlpYW1WamRDNWtaV1pwYm1WUWNtOXdaWEowZVNod2NtOWpaWE56TENCU1JVZEpVMVJTV1Y5VFdVMUNUMHdzSUhzS0lDQWdJSFpoYkhWbE9pQmpjbVZoZEdWa0xBb2dJQ0FnWTI5dVptbG5kWEpoWW14bE9pQm1ZV3h6WlN3S0lDQWdJR1Z1ZFcxbGNtRmliR1U2SUdaaGJITmxMQW9nSUNBZ2QzSnBkR0ZpYkdVNklHWmhiSE5sTEFvZ0lIMHBPd29nSUhKbGRIVnliaUJqY21WaGRHVmtPd3A5Q2dwbWRXNWpkR2x2YmlCaFkzRjFhWEpsU1c1UWNtOWpaWE56VEc5amF5aHdjbVZ3WVhKbFpDd2dZMjl1ZEdWNGRDa2dld29nSUdOdmJuTjBJSEpsWjJsemRISjVJRDBnY0hKdlkyVnpjMHh2WTJ0U1pXZHBjM1J5ZVNncE93b2dJR052Ym5OMElHdGxlU0E5SUhCeVpYQmhjbVZrTG1sa1pXNTBhWFI1UzJWNU93b2dJR3hsZENCemRHRjBaU0E5SUhKbFoybHpkSEo1TG14dlkydHpMbWRsZENoclpYa3BPd29nSUdsbUlDaHpkR0YwWlNBOVBUMGdkVzVrWldacGJtVmtLU0I3Q2lBZ0lDQnpkR0YwWlNBOUlIc2diRzlqYTJWa09pQm1ZV3h6WlN3Z2QyRnBkR1Z5Y3pvZ1cxMGdmVHNLSUNBZ0lISmxaMmx6ZEhKNUxteHZZMnR6TG5ObGRDaHJaWGtzSUhOMFlYUmxLVHNLSUNCOUNnb2dJR052Ym5OMElHMWhhMlZTWld4bFlYTmxJRDBnS0NrZ1BUNGdld29nSUNBZ2JHVjBJSEpsYkdWaGMyVmtJRDBnWm1Gc2MyVTdDaUFnSUNCeVpYUjFjbTRnS0NrZ1BUNGdld29nSUNBZ0lDQnBaaUFvY21Wc1pXRnpaV1FwSUhKbGRIVnlianNLSUNBZ0lDQWdjbVZzWldGelpXUWdQU0IwY25WbE93b2dJQ0FnSUNCamIyNXpkQ0J1WlhoMElEMGdjM1JoZEdVdWQyRnBkR1Z5Y3k1emFHbG1kQ2dwT3dvZ0lDQWdJQ0JwWmlBb2JtVjRkQ0E5UFQwZ2RXNWtaV1pwYm1Wa0tTQjdDaUFnSUNBZ0lDQWdjM1JoZEdVdWJHOWphMlZrSUQwZ1ptRnNjMlU3Q2lBZ0lDQWdJQ0FnY21WbmFYTjBjbmt1Ykc5amEzTXVaR1ZzWlhSbEtHdGxlU2s3Q2lBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdZMnhsWVhKVWFXMWxiM1YwS0c1bGVIUXVkR2x0WlhJcE93b2dJQ0FnSUNBZ0lHNWxlSFF1Y21WemIyeDJaU2h0WVd0bFVtVnNaV0Z6WlNncEtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnZlRzS0lDQjlPd29LSUNCcFppQW9JWE4wWVhSbExteHZZMnRsWkNrZ2V3b2dJQ0FnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2djSEpsY0dGeVpXUXVjR0YwYUNrN0NpQWdJQ0J6ZEdGMFpTNXNiMk5yWldRZ1BTQjBjblZsT3dvZ0lDQWdjbVYwZFhKdUlGQnliMjFwYzJVdWNtVnpiMngyWlNodFlXdGxVbVZzWldGelpTZ3BLVHNLSUNCOUNnb2dJR052Ym5OMElISmxiV0ZwYm1sdVp5QTlJSEpsYldGcGJtbHVaMDFwYkd4cGMyVmpiMjVrY3loamIyNTBaWGgwS1RzS0lDQnBaaUFvY21WdFlXbHVhVzVuSUR3OUlEQXBJSHNLSUNBZ0lISmxkSFZ5YmlCUWNtOXRhWE5sTG5KbGFtVmpkQ2gwYVcxbGIzVjBSWEp5YjNJb1kyOXVkR1Y0ZEN3Z2NISmxjR0Z5WldRdWNHRjBhQ2twT3dvZ0lIMEtJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVZYWVdsMExDQnlaV3BsWTNSWFlXbDBLU0E5UGlCN0NpQWdJQ0JqYjI1emRDQjNZV2wwWlhJZ1BTQjdDaUFnSUNBZ0lISmxjMjlzZG1VNklISmxjMjlzZG1WWFlXbDBMQW9nSUNBZ0lDQjBhVzFsY2pvZ2RXNWtaV1pwYm1Wa0xBb2dJQ0FnZlRzS0lDQWdJR052Ym5OMElHRnliVlJwYldWdmRYUWdQU0FvS1NBOVBpQjdDaUFnSUNBZ0lHTnZibk4wSUdSbGJHRjVUWE1nUFNCeVpXMWhhVzVwYm1kTmFXeHNhWE5sWTI5dVpITW9ZMjl1ZEdWNGRDazdDaUFnSUNBZ0lHbG1JQ2hrWld4aGVVMXpJRHc5SURBcElIc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCcGJtUmxlQ0E5SUhOMFlYUmxMbmRoYVhSbGNuTXVhVzVrWlhoUFppaDNZV2wwWlhJcE93b2dJQ0FnSUNBZ0lHbG1JQ2hwYm1SbGVDQWhQVDBnTFRFcElITjBZWFJsTG5kaGFYUmxjbk11YzNCc2FXTmxLR2x1WkdWNExDQXhLVHNLSUNBZ0lDQWdJQ0J5WldwbFkzUlhZV2wwS0hScGJXVnZkWFJGY25KdmNpaGpiMjUwWlhoMExDQndjbVZ3WVhKbFpDNXdZWFJvS1NrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1T3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJSGRoYVhSbGNpNTBhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9ZWEp0VkdsdFpXOTFkQ3dnVFdGMGFDNXRhVzRvWkdWc1lYbE5jeXdnVFVGWVgxUkpUVVZTWDBSRlRFRlpYMDFUS1NrN0NpQWdJQ0I5T3dvZ0lDQWdjM1JoZEdVdWQyRnBkR1Z5Y3k1d2RYTm9LSGRoYVhSbGNpazdDaUFnSUNCaGNtMVVhVzFsYjNWMEtDazdDaUFnZlNrN0NuMEtDbVoxYm1OMGFXOXVJR1JsWTI5a1pVMXZkVzUwVUdGMGFDaDJZV3gxWlNrZ2V3b2dJSEpsZEhWeWJpQjJZV3gxWlM1eVpYQnNZV05sS0M5Y1hDaGJNQzAzWFhzemZTa3ZaeXdnS0Y5dFlYUmphQ3dnYjJOMFlXd3BJRDArQ2lBZ0lDQlRkSEpwYm1jdVpuSnZiVU5vWVhKRGIyUmxLRTUxYldKbGNpNXdZWEp6WlVsdWRDaHZZM1JoYkN3Z09Da3BLVHNLZlFvS1puVnVZM1JwYjI0Z2NHRjBhRWx6VjJsMGFHbHVLSEJoZEdnc0lHMXZkVzUwVUc5cGJuUXBJSHNLSUNCeVpYUjFjbTRnY0dGMGFDQTlQVDBnYlc5MWJuUlFiMmx1ZENCOGZBb2dJQ0FnY0dGMGFDNXpkR0Z5ZEhOWGFYUm9LRzF2ZFc1MFVHOXBiblFnUFQwOUlITmxjQ0EvSUcxdmRXNTBVRzlwYm5RZ09pQmdKSHR0YjNWdWRGQnZhVzUwZlNSN2MyVndmV0FwT3dwOUNncG1kVzVqZEdsdmJpQmxlR1ZqUm1sc1pWVjBaamdvWm1sc1pTd2dZWEpuY3l3Z2IzQjBhVzl1Y3l3Z1kyOXVkR1Y0ZEN3Z2NHRjBhQ2tnZXdvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpWSjFiaXdnY21WcVpXTjBVblZ1S1NBOVBpQjdDaUFnSUNCc1pYUWdaR1ZoWkd4cGJtVlVhVzFsY2pzS0lDQWdJR3hsZENCbGVIQnBjbVZrSUQwZ1ptRnNjMlU3Q2lBZ0lDQmpiMjV6ZENCamFHbHNaQ0E5SUdWNFpXTkdhV3hsS0FvZ0lDQWdJQ0JtYVd4bExBb2dJQ0FnSUNCaGNtZHpMQW9nSUNBZ0lDQjdJQzR1TG05d2RHbHZibk1zSUdWdVkyOWthVzVuT2lBaWRYUm1PQ0lnZlN3S0lDQWdJQ0FnS0dWeWNtOXlMQ0J6ZEdSdmRYUXNJSE4wWkdWeWNpa2dQVDRnZXdvZ0lDQWdJQ0FnSUdsbUlDaGtaV0ZrYkdsdVpWUnBiV1Z5SUNFOVBTQjFibVJsWm1sdVpXUXBJR05zWldGeVZHbHRaVzkxZENoa1pXRmtiR2x1WlZScGJXVnlLVHNLSUNBZ0lDQWdJQ0JwWmlBb1pYaHdhWEpsWkNrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUdsbUlDaGxjbkp2Y2lBaFBUMGdiblZzYkNrZ2V3b2dJQ0FnSUNBZ0lDQWdUMkpxWldOMExtRnpjMmxuYmlobGNuSnZjaXdnZXlCemRHUnZkWFFzSUhOMFpHVnljaUI5S1RzS0lDQWdJQ0FnSUNBZ0lISmxhbVZqZEZKMWJpaGxjbkp2Y2lrN0NpQWdJQ0FnSUNBZ0lDQnlaWFIxY200N0NpQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNBZ0lISmxjMjlzZG1WU2RXNG9leUJ6ZEdSdmRYUXNJSE4wWkdWeWNpQjlLVHNLSUNBZ0lDQWdmU3dLSUNBZ0lDazdDaUFnSUNCamIyNXpkQ0JoY20xRVpXRmtiR2x1WlNBOUlDZ3BJRDArSUhzS0lDQWdJQ0FnWTI5dWMzUWdjbVZ0WVdsdWFXNW5JRDBnY21WdFlXbHVhVzVuVFdsc2JHbHpaV052Ym1SektHTnZiblJsZUhRcE93b2dJQ0FnSUNCcFppQW9jbVZ0WVdsdWFXNW5JRHc5SURBcElIc0tJQ0FnSUNBZ0lDQmxlSEJwY21Wa0lEMGdkSEoxWlRzS0lDQWdJQ0FnSUNBdkx5QkJJR2hsYkhCbGNpQnpkSFZqYXlCcGJpQnJaWEp1Wld3Z1NTOVBJRzFoZVNCdVpYWmxjaUJsZUdsMExDQmxkbVZ1SUdGbWRHVnlJRk5KUjB0SlRFd3VDaUFnSUNBZ0lDQWdMeThnVTJWMGRHeGxJR0YwSUc5MWNpQmtaV0ZrYkdsdVpTQmhibVFnY21Wc1pXRnpaU0JsZG1WeWVTQmxkbVZ1ZEMxc2IyOXdJSEpsWm1WeVpXNWpaU0J5WVhSb1pYSUtJQ0FnSUNBZ0lDQXZMeUIwYUdGdUlIZGhhWFJwYm1jZ1ptOXlJR1Y0WldOR2FXeGxKM01nWlhocGRDOXpkR1JwYnkxamJHOXpaU0JqWVd4c1ltRmpheTRLSUNBZ0lDQWdJQ0J5WldwbFkzUlNkVzRvZEdsdFpXOTFkRVZ5Y205eUtHTnZiblJsZUhRc0lIQmhkR2dwS1RzS0lDQWdJQ0FnSUNCamFHbHNaQzVyYVd4c0tDSlRTVWRMU1V4TUlpazdDaUFnSUNBZ0lDQWdZMmhwYkdRdWMzUmthVzQvTG1SbGMzUnliM2tvS1RzS0lDQWdJQ0FnSUNCamFHbHNaQzV6ZEdSdmRYUS9MbVJsYzNSeWIza29LVHNLSUNBZ0lDQWdJQ0JqYUdsc1pDNXpkR1JsY25JL0xtUmxjM1J5YjNrb0tUc0tJQ0FnSUNBZ0lDQmphR2xzWkM1MWJuSmxaaWdwT3dvZ0lDQWdJQ0FnSUhKbGRIVnlianNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmtaV0ZrYkdsdVpWUnBiV1Z5SUQwZ2MyVjBWR2x0Wlc5MWRDZ0tJQ0FnSUNBZ0lDQmhjbTFFWldGa2JHbHVaU3dLSUNBZ0lDQWdJQ0JOWVhSb0xtMXBiaWh5WlcxaGFXNXBibWNzSUUxQldGOVVTVTFGVWw5RVJVeEJXVjlOVXlrc0NpQWdJQ0FnSUNrN0NpQWdJQ0I5T3dvZ0lDQWdZWEp0UkdWaFpHeHBibVVvS1RzS0lDQjlLVHNLZlFvS1puVnVZM1JwYjI0Z2JtOXliV0ZzYVhwbFZHbHRaV1JEYjIxdFlXNWtSWEp5YjNJb1pYSnliM0lzSUdOdmJuUmxlSFFzSUhCaGRHZ3BJSHNLSUNCcFppQW9DaUFnSUNCeVpXMWhhVzVwYm1kTmFXeHNhWE5sWTI5dVpITW9ZMjl1ZEdWNGRDa2dQRDBnTUNCOGZBb2dJQ0FnWlhKeWIzSS9MbU52WkdVZ1BUMDlJQ0pGVkVsTlJVUlBWVlFpSUh4OENpQWdJQ0JsY25KdmNqOHVhMmxzYkdWa0lEMDlQU0IwY25WbENpQWdLU0I3Q2lBZ0lDQnlaWFIxY200Z2RHbHRaVzkxZEVWeWNtOXlLR052Ym5SbGVIUXNJSEJoZEdnc0lHVnljbTl5S1RzS0lDQjlDaUFnY21WMGRYSnVJR1Z5Y205eU93cDlDZ3BtZFc1amRHbHZiaUIyWVd4cFpHRjBaVVJoY25kcGJrRmpiRXhwYzNScGJtY29jM1JrYjNWMExDQndZWFJvTENCeWIyeGxLU0I3Q2lBZ2FXWWdLSE4wWkc5MWRDNXBibU5zZFdSbGN5Z2lYSElpS1NrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2dSR0Z5ZDJsdUlFRkRUQ0JvWld4d1pYSWdjbVYwZFhKdVpXUWdibTl1TFdOaGJtOXVhV05oYkNCdmRYUndkWFFnWm05eUlDUjdjR0YwYUgxZ0tUc0tJQ0I5Q2lBZ1kyOXVjM1FnYkdsdVpYTWdQU0J6ZEdSdmRYUXVjM0JzYVhRb0lseHVJaWs3Q2lBZ2FXWWdLR3hwYm1WekxtRjBLQzB4S1NBOVBUMGdJaUlwSUd4cGJtVnpMbkJ2Y0NncE93b2dJR2xtSUNoc2FXNWxjeTVzWlc1bmRHZ2dQVDA5SURBZ2ZId2diR2x1WlhOYk1GMHViR1Z1WjNSb0lEMDlQU0F3S1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQkVZWEozYVc0Z1FVTk1JR2hsYkhCbGNpQnlaWFIxY201bFpDQnVieUJ0WlhSaFpHRjBZU0JtYjNJZ0pIdHdZWFJvZldBcE93b2dJSDBLSUNCc1pYUWdjSEpsZG1sdmRYTlBjbVJwYm1Gc0lEMGdMVEU3Q2lBZ2JHVjBJSE5oZDB4bFoyRmplVTkzYm1WeUlEMGdabUZzYzJVN0NpQWdabTl5SUNoamIyNXpkQ0JzYVc1bElHOW1JR3hwYm1WekxuTnNhV05sS0RFcEtTQjdDaUFnSUNCcFppQW9MMTVjY3lwdmQyNWxjanBjY3l0Y1V5NHFKQzkxTG5SbGMzUW9iR2x1WlNrZ0ppWWdJWE5oZDB4bFoyRmplVTkzYm1WeUlDWW1JSEJ5WlhacGIzVnpUM0prYVc1aGJDQTlQVDBnTFRFcElIc0tJQ0FnSUNBZ2MyRjNUR1ZuWVdONVQzZHVaWElnUFNCMGNuVmxPd29nSUNBZ0lDQmpiMjUwYVc1MVpUc0tJQ0FnSUgwS0lDQWdJR052Ym5OMElHMWhkR05vSUQwZ2JHbHVaUzV0WVhSamFDZ0tJQ0FnSUNBZ0wxNWNjeW9vWEdRcktUcGNjeXNvTGlzL0tWeHpLeWcvT2locGJtaGxjbWwwWldRcFhITXJLVDhvWVd4c2IzZDhaR1Z1ZVNsY2N5c29XMkV0ZWw5ZEt5Zy9PaXhiWVMxNlgxMHJLU29wWEhNcUpDOTFMQW9nSUNBZ0tUc0tJQ0FnSUdsbUlDaHRZWFJqYUNBOVBUMGdiblZzYkNrZ2V3b2dJQ0FnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJFWVhKM2FXNGdRVU5NSUdobGJIQmxjaUJ5WlhSMWNtNWxaQ0IxYm5KbFkyOW5ibWw2WldRZ2IzVjBjSFYwSUdadmNpQWtlM0JoZEdoOVlDazdDaUFnSUNCOUNpQWdJQ0JqYjI1emRDQnZjbVJwYm1Gc0lEMGdUblZ0WW1WeUtHMWhkR05vV3pGZEtUc0tJQ0FnSUdsbUlDZ2hUblZ0WW1WeUxtbHpVMkZtWlVsdWRHVm5aWElvYjNKa2FXNWhiQ2tnZkh3Z2IzSmthVzVoYkNBOFBTQndjbVYyYVc5MWMwOXlaR2x1WVd3cElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nUkdGeWQybHVJRUZEVENCb1pXeHdaWElnY21WMGRYSnVaV1FnYVc1MllXeHBaQ0JCUTBVZ2IzSmtaWEpwYm1jZ1ptOXlJQ1I3Y0dGMGFIMWdLVHNLSUNBZ0lIMEtJQ0FnSUhCeVpYWnBiM1Z6VDNKa2FXNWhiQ0E5SUc5eVpHbHVZV3c3Q2lBZ0lDQmpiMjV6ZENCaGMzTnZZMmxoZEdsdmJpQTlJRzFoZEdOb1d6UmRPd29nSUNBZ1kyOXVjM1FnZEc5clpXNXpJRDBnYldGMFkyaGJOVjB1YzNCc2FYUW9JaXdpS1RzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnZEc5clpXNGdiMllnZEc5clpXNXpLU0I3Q2lBZ0lDQWdJR2xtSUNnaFJFRlNWMGxPWDBGRFRGOUxUazlYVGw5VVQwdEZUbE11YUdGektIUnZhMlZ1S1NrZ2V3b2dJQ0FnSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUVSaGNuZHBiaUJCUTB3Z2FHVnNjR1Z5SUhKbGRIVnlibVZrSUhWdWEyNXZkMjRnY21sbmFIUWdKSHQwYjJ0bGJuMDZJQ1I3Y0dGMGFIMWdLVHNLSUNBZ0lDQWdmUW9nSUNBZ2ZRb2dJQ0FnYVdZZ0tBb2dJQ0FnSUNCaGMzTnZZMmxoZEdsdmJpQTlQVDBnSW1Gc2JHOTNJaUFtSmdvZ0lDQWdJQ0IwYjJ0bGJuTXVjMjl0WlNnb2RHOXJaVzRwSUQwK0lFUkJVbGRKVGw5QlEweGZUVlZVUVZSSlQwNWZVa2xIU0ZSVExtaGhjeWgwYjJ0bGJpa3BDaUFnSUNBcElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0FvZ0lDQWdJQ0FnSUdCaFoyVnVZem9nY0hKdmRHVmpkR1ZrSUNSN2NtOXNaWDBnYUdGeklHRWdiWFYwWVhScGIyNHRZMkZ3WVdKc1pTQkVZWEozYVc0Z1FVTk1PaUFrZTNCaGRHaDlZQ3dLSUNBZ0lDQWdLVHNLSUNBZ0lIMEtJQ0I5Q24wS0NtRnplVzVqSUdaMWJtTjBhVzl1SUdGemMyVnlkRVJoY25kcGJsQmhkR2hUWldOMWNtbDBlU2h3WVhSb0xDQnliMnhsTENCamIyNTBaWGgwS1NCN0NpQWdjbVYwZFhKdUlHRnpjMlZ5ZEVSaGNuZHBibEJoZEdoVFpXTjFjbWwwZVZkcGRHaEpUeWdLSUNBZ0lIQmhkR2dzQ2lBZ0lDQnliMnhsTEFvZ0lDQWdZMjl1ZEdWNGRDd0tJQ0FnSUdWNFpXTkdhV3hsVlhSbU9Dd0tJQ0FnSUNoallXNWthV1JoZEdVcElEMCtJR3h6ZEdGMEtHTmhibVJwWkdGMFpTd2dleUJpYVdkcGJuUTZJSFJ5ZFdVZ2ZTa3NDaUFnS1RzS2ZRb0tMeThnU0VaVEt5QnlaWEJ2Y25SeklHTm9ZVzVuWlNCMGFXMWxJR2x1SUhkb2IyeGxJSE5sWTI5dVpITXNJSE52SUdGdUlFRkRUQ0JsWkdsMElIZHBkR2hwYmlCMGFHVWdjMkZ0WlFvdkx5QnpaV052Ym1RZ1kyRnVJR3hsWVhabElIUm9aU0JwWkdWdWRHbDBlU0IxYm1Ob1lXNW5aV1F1SUU5dWJIa2djM1ZpTFhObFkyOXVaQ0JqYUdGdVoyVWdkR2x0WlhNZ1lYSmxDaTh2SUhCeVpXTnBjMlVnWlc1dmRXZG9JSFJ2SUdOaFkyaGxJR0VnZG1WeVpHbGpkQzRLWm5WdVkzUnBiMjRnYUdGelUzVmljMlZqYjI1a1EyaGhibWRsVkdsdFpTaHpkR0YwY3lrZ2V3b2dJR2xtSUNoMGVYQmxiMllnYzNSaGRITXVZM1JwYldWT2N5QTlQVDBnSW1KcFoybHVkQ0lwSUhKbGRIVnliaUJ6ZEdGMGN5NWpkR2x0WlU1eklDVWdNVjh3TURCZk1EQXdYekF3TUc0Z0lUMDlJREJ1T3dvZ0lISmxkSFZ5YmlCT2RXMWlaWEl1YVhOR2FXNXBkR1VvYzNSaGRITXVZM1JwYldWTmN5a2dKaVlnYzNSaGRITXVZM1JwYldWTmN5QWxJREV3TURBZ0lUMDlJREE3Q24wS0NtWjFibU4wYVc5dUlHUmhjbmRwYmtGamJFbGtaVzUwYVhSNUtITjBZWFJ6S1NCN0NpQWdjbVYwZFhKdUlGc0tJQ0FnSUhOMFlYUnpMbVJsZGl3Z2MzUmhkSE11YVc1dkxDQnpkR0YwY3k1amRHbHRaVTV6SUQ4L0lITjBZWFJ6TG1OMGFXMWxUWE1zQ2lBZ0lDQnpkR0YwY3k1dGIyUmxMQ0J6ZEdGMGN5NTFhV1FzSUhOMFlYUnpMbWRwWkN3S0lDQWdJSEJ5YjJObGMzTXVaMlYwZFdsa1B5NG9LU3dnY0hKdlkyVnpjeTVuWlhSbGRXbGtQeTRvS1N3S0lDQmRMbXB2YVc0b0lqb2lLVHNLZlFvS1lYTjVibU1nWm5WdVkzUnBiMjRnWVhOelpYSjBSR0Z5ZDJsdVVHRjBhRk5sWTNWeWFYUjVWMmwwYUVsUEtIQmhkR2dzSUhKdmJHVXNJR052Ym5SbGVIUXNJR3hwYzNSbGNpd2djM1JoZEZCaGRHZ3BJSHNLSUNCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0J3WVhSb0tUc0tJQ0F2THlCQklFUmhjbmRwYmlCQlEwd2daV1JwZENCaFpIWmhibU5sY3lCamRHbHRaUzRnVW1VdGMzUmhkQ0J2YmlCbGRtVnllU0JzYjI5cmRYQWdjMjhnWVc0Z2IyeGtDaUFnTHk4Z2MzVmpZMlZ6YzJaMWJDQjJaWEprYVdOMElHTmhibTV2ZENCaGRYUm9iM0pwZW1VZ1lTQmphR0Z1WjJWa0lHbHViMlJsTENCdmQyNWxjaXdnYjNJZ1FVTk1MZ29nSUdOdmJuTjBJR0psWm05eVpTQTlJR1JoY25kcGJrRmpiRWxrWlc1MGFYUjVLR0YzWVdsMElITjBZWFJRWVhSb0tIQmhkR2dwS1RzS0lDQmpiMjV6ZENCallXTm9aVXRsZVNBOUlHQWtlM0p2YkdWOVhEQWtlM0JoZEdoOVlEc0tJQ0JwWmlBb1pHRnlkMmx1UVdOc1ZtVnlaR2xqZEhNdVoyVjBLR05oWTJobFMyVjVLU0E5UFQwZ1ltVm1iM0psS1NCN0NpQWdJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQndZWFJvS1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ1pHRnlkMmx1UVdOc1ZtVnlaR2xqZEhNdVpHVnNaWFJsS0dOaFkyaGxTMlY1S1RzS0lDQnNaWFFnY21WemRXeDBPd29nSUhSeWVTQjdDaUFnSUNCeVpYTjFiSFFnUFNCaGQyRnBkQ0JzYVhOMFpYSW9DaUFnSUNBZ0lDSXZZbWx1TDJ4eklpd0tJQ0FnSUNBZ1d5SXRiR1JsY1NJc0lIQmhkR2hkTEFvZ0lDQWdJQ0I3Q2lBZ0lDQWdJQ0FnWlc1Mk9pQjdJRXhEWDBGTVREb2dJa01pSUgwc0NpQWdJQ0FnSUNBZ2JXRjRRblZtWm1WeU9pQXlOVFlnS2lBeE1ESTBMQW9nSUNBZ0lDQjlMQW9nSUNBZ0lDQmpiMjUwWlhoMExBb2dJQ0FnSUNCd1lYUm9MQW9nSUNBZ0tUc0tJQ0I5SUdOaGRHTm9JQ2hsY25KdmNpa2dld29nSUNBZ2RHaHliM2NnYm05eWJXRnNhWHBsVkdsdFpXUkRiMjF0WVc1a1JYSnliM0lvWlhKeWIzSXNJR052Ym5SbGVIUXNJSEJoZEdncE93b2dJSDBLSUNCcFppQW9jbVZ6ZFd4MExuTjBaR1Z5Y2lBaFBUMGdJaUlwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklFUmhjbmRwYmlCQlEwd2dhR1ZzY0dWeUlISmxkSFZ5Ym1Wa0lIVnVaWGh3WldOMFpXUWdaR2xoWjI1dmMzUnBZM01nWm05eUlDUjdjR0YwYUgxZ0tUc0tJQ0I5Q2lBZ2RtRnNhV1JoZEdWRVlYSjNhVzVCWTJ4TWFYTjBhVzVuS0hKbGMzVnNkQzV6ZEdSdmRYUXNJSEJoZEdnc0lISnZiR1VwT3dvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCaGRHZ3BPd29nSUM4dklFRWdjR0YwYUNCamFHRnVaMlZrSUhkb2FXeGxJR3h6SUhKaGJpQnRkWE4wSUc1bGRtVnlJSE5sWldRZ1lTQjJaWEprYVdOMElHWnZjaUJwZEhNZ2JtVjNJSE4wWVhSbExnb2dJR052Ym5OMElHRm1kR1Z5VTNSaGRITWdQU0JoZDJGcGRDQnpkR0YwVUdGMGFDaHdZWFJvS1RzS0lDQmpiMjV6ZENCaFpuUmxjaUE5SUdSaGNuZHBia0ZqYkVsa1pXNTBhWFI1S0dGbWRHVnlVM1JoZEhNcE93b2dJSFJvY205M1NXWkZlSEJwY21Wa0tHTnZiblJsZUhRc0lIQmhkR2dwT3dvZ0lHbG1JQ2hoWm5SbGNpQTlQVDBnWW1WbWIzSmxJQ1ltSUdoaGMxTjFZbk5sWTI5dVpFTm9ZVzVuWlZScGJXVW9ZV1owWlhKVGRHRjBjeWtwSUhzS0lDQWdJR2xtSUNoa1lYSjNhVzVCWTJ4V1pYSmthV04wY3k1emFYcGxJRDQ5SUVSQlVsZEpUbDlCUTB4ZlZrVlNSRWxEVkY5RFFVTklSVjlNU1UxSlZDa2dld29nSUNBZ0lDQmtZWEozYVc1QlkyeFdaWEprYVdOMGN5NWtaV3hsZEdVb1pHRnlkMmx1UVdOc1ZtVnlaR2xqZEhNdWEyVjVjeWdwTG01bGVIUW9LUzUyWVd4MVpTazdDaUFnSUNCOUNpQWdJQ0JrWVhKM2FXNUJZMnhXWlhKa2FXTjBjeTV6WlhRb1kyRmphR1ZMWlhrc0lHSmxabTl5WlNrN0NpQWdmUXA5Q2dwbWRXNWpkR2x2YmlCMGNuVnpkR1ZrVjJsdVpHOTNjMUJ2ZDJWeVUyaGxiR3hRWVhSb0tBb2dJR05oYm05dWFXTmhiR2w2WlNBOUlISmxZV3h3WVhSb1UzbHVZeTV1WVhScGRtVXNDaUFnWm1sc1pYTjVjM1JsYlNBOUlGZEpUa1JQVjFOZlJWaEZRMVZVUVVKTVJWOUdTVXhGVTFsVFZFVk5MQW9wSUhzS0lDQXZMeUJFWlhKcGRtVWdZU0JEY21WaGRHVlFjbTlqWlhOekxXTnZiWEJoZEdsaWJHVWdSRTlUSUhOd1pXeHNhVzVuSUdaeWIyMGdSMHhQUWtGTVVrOVBWQ3dnZEdobGJpQndjbTkyWlFvZ0lDOHZJR0p2ZEdnZ2MzQmxiR3hwYm1keklITjBhV3hzSUc1aGJXVWdkR2hsSUhOaGJXVWdjbVZuZFd4aGNpQnplWE4wWlcwZ1ptbHNaU0JpWldadmNtVWdiR0YxYm1Ob0xnb2dJR052Ym5OMElITjVjM1JsYlZKdmIzUWdQU0JqWVc1dmJtbGpZV3hwZW1Vb1YwbE9SRTlYVTE5VFdWTlVSVTFmVWs5UFZDazdDaUFnYVdZZ0tDRXZYbHRoTFhwZE9seGNMMmwxTG5SbGMzUW9jM2x6ZEdWdFVtOXZkQ2tnZkh3Z2QybHVNekl1Ym05eWJXRnNhWHBsS0hONWMzUmxiVkp2YjNRcElDRTlQU0J6ZVhOMFpXMVNiMjkwS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9JblJ5ZFhOMFpXUWdWMmx1Wkc5M2N5QlRlWE4wWlcxU2IyOTBJR1JwWkNCdWIzUWdjbVZ6YjJ4MlpTQjBieUJoSUdOaGJtOXVhV05oYkNCc2IyTmhiQ0JFVDFNZ2NHRjBhQ0lwT3dvZ0lIMEtJQ0JqYjI1emRDQjNiM0pyYVc1blJHbHlaV04wYjNKNUlEMGdkMmx1TXpJdWFtOXBiaWh6ZVhOMFpXMVNiMjkwTENBaVUzbHpkR1Z0TXpJaUtUc0tJQ0JqYjI1emRDQmxlR1ZqZFhSaFlteGxJRDBnZDJsdU16SXVhbTlwYmlnS0lDQWdJSGR2Y210cGJtZEVhWEpsWTNSdmNua3NDaUFnSUNBaVYybHVaRzkzYzFCdmQyVnlVMmhsYkd3aUxBb2dJQ0FnSW5ZeExqQWlMQW9nSUNBZ0luQnZkMlZ5YzJobGJHd3VaWGhsSWl3S0lDQXBPd29nSUdOdmJuTjBJRzVoYldWemNHRmpaVVY0WldOMWRHRmliR1VnUFNCM2FXNHpNaTVxYjJsdUtBb2dJQ0FnVjBsT1JFOVhVMTlUV1ZOVVJVMWZVazlQVkN3S0lDQWdJQ0pUZVhOMFpXMHpNaUlzQ2lBZ0lDQWlWMmx1Wkc5M2MxQnZkMlZ5VTJobGJHd2lMQW9nSUNBZ0luWXhMakFpTEFvZ0lDQWdJbkJ2ZDJWeWMyaGxiR3d1WlhobElpd0tJQ0FwT3dvZ0lIWmxjbWxtZVZkcGJtUnZkM05GZUdWamRYUmhZbXhsUVd4cFlYTmxjeWh1WVcxbGMzQmhZMlZGZUdWamRYUmhZbXhsTENCbGVHVmpkWFJoWW14bExDQm1hV3hsYzNsemRHVnRLVHNLSUNCeVpYUjFjbTRnZXdvZ0lDQWdjM2x6ZEdWdFVtOXZkQ3dLSUNBZ0lIZHZjbXRwYm1kRWFYSmxZM1J2Y25rc0NpQWdJQ0JsZUdWamRYUmhZbXhsTEFvZ0lIMDdDbjBLQ21aMWJtTjBhVzl1SUhabGNtbG1lVmRwYm1SdmQzTkZlR1ZqZFhSaFlteGxRV3hwWVhObGN5aHVZVzFsYzNCaFkyVkZlR1ZqZFhSaFlteGxMQ0JsZUdWamRYUmhZbXhsTENCbWFXeGxjM2x6ZEdWdEtTQjdDaUFnYkdWMElHNWhiV1Z6Y0dGalpVUmxjMk55YVhCMGIzSTdDaUFnYkdWMElHTmhibVJwWkdGMFpVUmxjMk55YVhCMGIzSTdDaUFnYkdWMElHOXdaWEpoZEdsdmJrVnljbTl5T3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdVlXMWxjM0JoWTJWQ1pXWnZjbVVnUFNCbWFXeGxjM2x6ZEdWdExteHpkR0YwS0c1aGJXVnpjR0ZqWlVWNFpXTjFkR0ZpYkdVcE93b2dJQ0FnWTI5dWMzUWdZMkZ1Wkdsa1lYUmxRbVZtYjNKbElEMGdabWxzWlhONWMzUmxiUzVzYzNSaGRDaGxlR1ZqZFhSaFlteGxLVHNLSUNBZ0lHRnpjMlZ5ZEZKbFozVnNZWEpYYVc1a2IzZHpSWGhsWTNWMFlXSnNaU2h1WVcxbGMzQmhZMlZDWldadmNtVXNJQ0pIVEU5Q1FVeFNUMDlVSUhCaGRHZ2lLVHNLSUNBZ0lHRnpjMlZ5ZEZKbFozVnNZWEpYYVc1a2IzZHpSWGhsWTNWMFlXSnNaU2hqWVc1a2FXUmhkR1ZDWldadmNtVXNJQ0pFVDFNZ2NHRjBhQ0lwT3dvZ0lDQWdibUZ0WlhOd1lXTmxSR1Z6WTNKcGNIUnZjaUE5SUdacGJHVnplWE4wWlcwdWIzQmxiaWh1WVcxbGMzQmhZMlZGZUdWamRYUmhZbXhsS1RzS0lDQWdJR05oYm1ScFpHRjBaVVJsYzJOeWFYQjBiM0lnUFNCbWFXeGxjM2x6ZEdWdExtOXdaVzRvWlhobFkzVjBZV0pzWlNrN0NpQWdJQ0JqYjI1emRDQnVZVzFsYzNCaFkyVlBjR1Z1WldRZ1BTQm1hV3hsYzNsemRHVnRMbVp6ZEdGMEtHNWhiV1Z6Y0dGalpVUmxjMk55YVhCMGIzSXBPd29nSUNBZ1kyOXVjM1FnWTJGdVpHbGtZWFJsVDNCbGJtVmtJRDBnWm1sc1pYTjVjM1JsYlM1bWMzUmhkQ2hqWVc1a2FXUmhkR1ZFWlhOamNtbHdkRzl5S1RzS0lDQWdJR052Ym5OMElHNWhiV1Z6Y0dGalpVRm1kR1Z5SUQwZ1ptbHNaWE41YzNSbGJTNXNjM1JoZENodVlXMWxjM0JoWTJWRmVHVmpkWFJoWW14bEtUc0tJQ0FnSUdOdmJuTjBJR05oYm1ScFpHRjBaVUZtZEdWeUlEMGdabWxzWlhONWMzUmxiUzVzYzNSaGRDaGxlR1ZqZFhSaFlteGxLVHNLSUNBZ0lHRnpjMlZ5ZEZKbFozVnNZWEpYYVc1a2IzZHpSWGhsWTNWMFlXSnNaU2h1WVcxbGMzQmhZMlZQY0dWdVpXUXNJQ0pIVEU5Q1FVeFNUMDlVSUdSbGMyTnlhWEIwYjNJaUtUc0tJQ0FnSUdGemMyVnlkRkpsWjNWc1lYSlhhVzVrYjNkelJYaGxZM1YwWVdKc1pTaGpZVzVrYVdSaGRHVlBjR1Z1WldRc0lDSkVUMU1nWkdWelkzSnBjSFJ2Y2lJcE93b2dJQ0FnWVhOelpYSjBVbVZuZFd4aGNsZHBibVJ2ZDNORmVHVmpkWFJoWW14bEtHNWhiV1Z6Y0dGalpVRm1kR1Z5TENBaVIweFBRa0ZNVWs5UFZDQndZWFJvSWlrN0NpQWdJQ0JoYzNObGNuUlNaV2QxYkdGeVYybHVaRzkzYzBWNFpXTjFkR0ZpYkdVb1kyRnVaR2xrWVhSbFFXWjBaWElzSUNKRVQxTWdjR0YwYUNJcE93b2dJQ0FnWm05eUlDaGpiMjV6ZENCcFpHVnVkR2wwZVNCdlppQmJDaUFnSUNBZ0lHNWhiV1Z6Y0dGalpVSmxabTl5WlN3S0lDQWdJQ0FnWTJGdVpHbGtZWFJsUW1WbWIzSmxMQW9nSUNBZ0lDQnVZVzFsYzNCaFkyVlBjR1Z1WldRc0NpQWdJQ0FnSUdOaGJtUnBaR0YwWlU5d1pXNWxaQ3dLSUNBZ0lDQWdibUZ0WlhOd1lXTmxRV1owWlhJc0NpQWdJQ0FnSUdOaGJtUnBaR0YwWlVGbWRHVnlMQW9nSUNBZ1hTa2dld29nSUNBZ0lDQnBaaUFvQ2lBZ0lDQWdJQ0FnYVdSbGJuUnBkSGt1WkdWMklEdzlJREJ1SUh4OElHbGtaVzUwYVhSNUxtbHVieUE4UFNBd2JpQjhmQW9nSUNBZ0lDQWdJR2xrWlc1MGFYUjVMbVJsZGlBOVBUMGdWVTVUVlZCUVQxSlVSVVJmUmtsTVJWOUpSRjgyTkNCOGZDQnBaR1Z1ZEdsMGVTNXBibThnUFQwOUlGVk9VMVZRVUU5U1ZFVkVYMFpKVEVWZlNVUmZOalFLSUNBZ0lDQWdLU0I3Q2lBZ0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLQ0owY25WemRHVmtJRmRwYm1SdmQzTWdjM2x6ZEdWdElHVjRaV04xZEdGaWJHVWdhV1JsYm5ScGRIa2dhWE1nZFc1aGRtRnBiR0ZpYkdVaUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnZlFvZ0lDQWdhV1lnS0FvZ0lDQWdJQ0FoYzJGdFpVWnBiR1ZKWkdWdWRHbDBlU2h1WVcxbGMzQmhZMlZDWldadmNtVXNJRzVoYldWemNHRmpaVTl3Wlc1bFpDa2dmSHdLSUNBZ0lDQWdJWE5oYldWR2FXeGxTV1JsYm5ScGRIa29ibUZ0WlhOd1lXTmxUM0JsYm1Wa0xDQnVZVzFsYzNCaFkyVkJablJsY2lrZ2ZId0tJQ0FnSUNBZ0lYTmhiV1ZHYVd4bFNXUmxiblJwZEhrb1kyRnVaR2xrWVhSbFFtVm1iM0psTENCallXNWthV1JoZEdWUGNHVnVaV1FwSUh4OENpQWdJQ0FnSUNGellXMWxSbWxzWlVsa1pXNTBhWFI1S0dOaGJtUnBaR0YwWlU5d1pXNWxaQ3dnWTJGdVpHbGtZWFJsUVdaMFpYSXBJSHg4Q2lBZ0lDQWdJQ0Z6WVcxbFJtbHNaVWxrWlc1MGFYUjVLRzVoYldWemNHRmpaVTl3Wlc1bFpDd2dZMkZ1Wkdsa1lYUmxUM0JsYm1Wa0tRb2dJQ0FnS1NCN0NpQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWdpZEhKMWMzUmxaQ0JYYVc1a2IzZHpJSE41YzNSbGJTQmxlR1ZqZFhSaFlteGxJR2xrWlc1MGFYUjVJRzFwYzIxaGRHTm9JaWs3Q2lBZ0lDQjlDaUFnZlNCallYUmphQ0FvWlhKeWIzSXBJSHNLSUNBZ0lHOXdaWEpoZEdsdmJrVnljbTl5SUQwZ1pYSnliM0k3Q2lBZ2ZRb2dJR052Ym5OMElHTnNiM05sUlhKeWIzSnpJRDBnVzEwN0NpQWdabTl5SUNoamIyNXpkQ0JrWlhOamNtbHdkRzl5SUc5bUlGdGpZVzVrYVdSaGRHVkVaWE5qY21sd2RHOXlMQ0J1WVcxbGMzQmhZMlZFWlhOamNtbHdkRzl5WFNrZ2V3b2dJQ0FnYVdZZ0tHUmxjMk55YVhCMGIzSWdQVDA5SUhWdVpHVm1hVzVsWkNrZ1kyOXVkR2x1ZFdVN0NpQWdJQ0IwY25rZ2V5Qm1hV3hsYzNsemRHVnRMbU5zYjNObEtHUmxjMk55YVhCMGIzSXBPeUI5SUdOaGRHTm9JQ2hsY25KdmNpa2dleUJqYkc5elpVVnljbTl5Y3k1d2RYTm9LR1Z5Y205eUtUc2dmUW9nSUgwS0lDQnBaaUFvYjNCbGNtRjBhVzl1UlhKeWIzSWdJVDA5SUhWdVpHVm1hVzVsWkNrZ2V3b2dJQ0FnYVdZZ0tHTnNiM05sUlhKeWIzSnpMbXhsYm1kMGFDQStJREFwSUhzS0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVGblozSmxaMkYwWlVWeWNtOXlLQW9nSUNBZ0lDQWdJRnR2Y0dWeVlYUnBiMjVGY25KdmNpd2dMaTR1WTJ4dmMyVkZjbkp2Y25OZExBb2dJQ0FnSUNBZ0lDSjBjblZ6ZEdWa0lGZHBibVJ2ZDNNZ1pYaGxZM1YwWVdKc1pTQjJZV3hwWkdGMGFXOXVJR0Z1WkNCamJHVmhiblZ3SUdKdmRHZ2dabUZwYkdWa0lpd0tJQ0FnSUNBZ0tUc0tJQ0FnSUgwS0lDQWdJSFJvY205M0lHOXdaWEpoZEdsdmJrVnljbTl5T3dvZ0lIMEtJQ0JwWmlBb1kyeHZjMlZGY25KdmNuTXViR1Z1WjNSb0lEMDlQU0F4S1NCMGFISnZkeUJqYkc5elpVVnljbTl5YzFzd1hUc0tJQ0JwWmlBb1kyeHZjMlZGY25KdmNuTXViR1Z1WjNSb0lENGdNU2tnZXdvZ0lDQWdkR2h5YjNjZ2JtVjNJRUZuWjNKbFoyRjBaVVZ5Y205eUtBb2dJQ0FnSUNCamJHOXpaVVZ5Y205eWN5d0tJQ0FnSUNBZ0luUnlkWE4wWldRZ1YybHVaRzkzY3lCbGVHVmpkWFJoWW14bElHUmxjMk55YVhCMGIzSWdZMnhsWVc1MWNDQm1ZV2xzWldRaUxBb2dJQ0FnS1RzS0lDQjlDbjBLQ21aMWJtTjBhVzl1SUdGemMyVnlkRkpsWjNWc1lYSlhhVzVrYjNkelJYaGxZM1YwWVdKc1pTaHBaR1Z1ZEdsMGVTd2djM0JsYkd4cGJtY3BJSHNLSUNCcFppQW9JV2xrWlc1MGFYUjVMbWx6Um1sc1pTZ3BJSHg4SUdsa1pXNTBhWFI1TG1selUzbHRZbTlzYVdOTWFXNXJLQ2twSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdkSEoxYzNSbFpDQlhhVzVrYjNkeklDUjdjM0JsYkd4cGJtZDlJR1Y0WldOMWRHRmliR1VnYVhNZ2JtOTBJR0VnY21WbmRXeGhjaUJ1YjI0dGJHbHVheUJtYVd4bFlDazdDaUFnZlFwOUNncG1kVzVqZEdsdmJpQnpZVzFsUm1sc1pVbGtaVzUwYVhSNUtHeGxablFzSUhKcFoyaDBLU0I3Q2lBZ2NtVjBkWEp1SUd4bFpuUXVaR1YySUQwOVBTQnlhV2RvZEM1a1pYWWdKaVlnYkdWbWRDNXBibThnUFQwOUlISnBaMmgwTG1sdWJ6c0tmUW9LWm5WdVkzUnBiMjRnZDJsdVpHOTNjMUJ2ZDJWeVUyaGxiR3hGYm5acGNtOXViV1Z1ZENod1lYUm9jeXdnZEhKMWMzUmxaRkJoZEdoeklEMGdkSEoxYzNSbFpGZHBibVJ2ZDNOUWIzZGxjbE5vWld4c1VHRjBhQ2dwS1NCN0NpQWdZMjl1YzNRZ2V5QnplWE4wWlcxU2IyOTBMQ0IzYjNKcmFXNW5SR2x5WldOMGIzSjVJSDBnUFNCMGNuVnpkR1ZrVUdGMGFITTdDaUFnTHk4Z2JHbGlkWFlnWm1sc2JITWdZU0JtYVhobFpDQnpaWFFnYjJZZ0luSmxjWFZwY21Wa0lpQlhhVzVrYjNkeklIWmhjbWxoWW14bGN5Qm1jbTl0SUhSb1pTQndZWEpsYm5RS0lDQXZMeUIzYUdWdUlIUm9aWGtnWVhKbElHRmljMlZ1ZEM0Z1JHVm1hVzVsSUdWMlpYSjVJRzl1WlNCemJ5QndiMmx6YjI1bFpDQmpZV3hzWlhJZ2MzUmhkR1VnWTJGdWJtOTBJR0psQ2lBZ0x5OGdjMmxzWlc1MGJIa2dhVzVvWlhKcGRHVmtJR2x1ZEc4Z2RHaGxJSFpoYkdsa1lYUnBiMjRnYUdWc2NHVnlMZ29nSUhKbGRIVnliaUI3Q2lBZ0lDQkJSMFZPUTE5TVQwTkxYMUJCVkVoVE9pQjNhVzVrYjNkelVHRjBhRlJ5WVc1emNHOXlkQ2h3WVhSb2N5a3NDaUFnSUNCQlVGQkVRVlJCT2lBaUlpd0tJQ0FnSUVOUFRWTlFSVU02SUNJaUxBb2dJQ0FnU0U5TlJVUlNTVlpGT2lBaUlpd0tJQ0FnSUVoUFRVVlFRVlJJT2lBaUlpd0tJQ0FnSUV4UFEwRk1RVkJRUkVGVVFUb2dJaUlzQ2lBZ0lDQk1UMGRQVGxORlVsWkZVam9nSWlJc0NpQWdJQ0JRUVZSSU9pQjNiM0pyYVc1blJHbHlaV04wYjNKNUxBb2dJQ0FnVUVGVVNFVllWRG9nSWk1RldFVWlMQW9nSUNBZ1VGTk5UMFJWVEVWUVFWUklPaUFpSWl3S0lDQWdJRk5aVTFSRlRVUlNTVlpGT2lBaUlpd0tJQ0FnSUZOWlUxUkZUVkpQVDFRNklITjVjM1JsYlZKdmIzUXNDaUFnSUNCVVJVMVFPaUIzYjNKcmFXNW5SR2x5WldOMGIzSjVMQW9nSUNBZ1ZFMVFPaUIzYjNKcmFXNW5SR2x5WldOMGIzSjVMQW9nSUNBZ1ZWTkZVa1JQVFVGSlRqb2dJaUlzQ2lBZ0lDQlZVMFZTVGtGTlJUb2dJaUlzQ2lBZ0lDQlZVMFZTVUZKUFJrbE1SVG9nZDI5eWEybHVaMFJwY21WamRHOXllU3dLSUNBZ0lGZEpUa1JKVWpvZ2MzbHpkR1Z0VW05dmRDd0tJQ0I5T3dwOUNncG1kVzVqZEdsdmJpQjNhVzVrYjNkelVHRjBhRlJ5WVc1emNHOXlkQ2hsYm5SeWFXVnpLU0I3Q2lBZ2FXWWdLQW9nSUNBZ0lVRnljbUY1TG1selFYSnlZWGtvWlc1MGNtbGxjeWtnZkh3S0lDQWdJR1Z1ZEhKcFpYTXViR1Z1WjNSb0lEd2dNU0I4ZkFvZ0lDQWdaVzUwY21sbGN5NXNaVzVuZEdnZ1BpQlhTVTVFVDFkVFgxQkJWRWhmVkZKQlRsTlFUMUpVWDAxQldGOUZUbFJTU1VWVENpQWdLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb0ltRm5aVzVqT2lCWGFXNWtiM2R6SUhCeWIzUmxZM1JsWkMxd1lYUm9JSFJ5WVc1emNHOXlkQ0JvWVhNZ1lXNGdhVzUyWVd4cFpDQmxiblJ5ZVNCamIzVnVkQ0lwT3dvZ0lIMEtJQ0JqYjI1emRDQnlaV052Y21SeklEMGdXMTA3Q2lBZ2JHVjBJSFJ5WVc1emNHOXlkRU5vWVhKeklEMGdNRHNLSUNCbWIzSWdLR052Ym5OMElHVnVkSEo1SUc5bUlHVnVkSEpwWlhNcElIc0tJQ0FnSUdOdmJuTjBJSEJoZEdnZ1BTQmxiblJ5ZVQ4dWNHRjBhRHNLSUNBZ0lHTnZibk4wSUhKdmJHVWdQU0JsYm5SeWVUOHVjbTlzWlRzS0lDQWdJR2xtSUNnS0lDQWdJQ0FnZEhsd1pXOW1JSEJoZEdnZ0lUMDlJQ0p6ZEhKcGJtY2lJSHg4Q2lBZ0lDQWdJSEJoZEdndWJHVnVaM1JvSUQwOVBTQXdJSHg4Q2lBZ0lDQWdJSEJoZEdndWJHVnVaM1JvSUQ0Z1YwbE9SRTlYVTE5UVFWUklYMVJTUVU1VFVFOVNWRjlOUVZoZlEwaEJVbE1nZkh3S0lDQWdJQ0FnS0hKdmJHVWdJVDA5SUNKc1pXRm1SR2x5WldOMGIzSjVJaUFtSmlCeWIyeGxJQ0U5UFNBaVlXNWpaWE4wYjNKRWFYSmxZM1J2Y25raUlDWW1JSEp2YkdVZ0lUMDlJQ0ptYVd4bElpa0tJQ0FnSUNrZ2V3b2dJQ0FnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvSW1GblpXNWpPaUJYYVc1a2IzZHpJSEJ5YjNSbFkzUmxaQzF3WVhSb0lIUnlZVzV6Y0c5eWRDQmxiblJ5ZVNCcGN5QnBiblpoYkdsa0lpazdDaUFnSUNCOUNpQWdJQ0JqYjI1emRDQnlaV052Y21RZ1BTQmdKSHR5YjJ4bGZUb2tlMEoxWm1abGNpNW1jbTl0S0hCaGRHZ3NJQ0oxZEdZeE5teGxJaWt1ZEc5VGRISnBibWNvSW1KaGMyVTJOQ0lwZldBN0NpQWdJQ0IwY21GdWMzQnZjblJEYUdGeWN5QXJQU0J5WldOdmNtUXViR1Z1WjNSb0lDc2dLSEpsWTI5eVpITXViR1Z1WjNSb0lEMDlQU0F3SUQ4Z01DQTZJREVwT3dvZ0lDQWdhV1lnS0hSeVlXNXpjRzl5ZEVOb1lYSnpJRDRnVjBsT1JFOVhVMTlRUVZSSVgxUlNRVTVUVUU5U1ZGOU5RVmhmUTBoQlVsTXBJSHNLSUNBZ0lDQWdkR2h5YjNjZ2JtVjNJRVZ5Y205eUtDSmhaMlZ1WXpvZ1YybHVaRzkzY3lCd2NtOTBaV04wWldRdGNHRjBhQ0IwY21GdWMzQnZjblFnWlhoalpXVmtjeUJwZEhNZ2JHbHRhWFFpS1RzS0lDQWdJSDBLSUNBZ0lISmxZMjl5WkhNdWNIVnphQ2h5WldOdmNtUXBPd29nSUgwS0lDQnlaWFIxY200Z2NtVmpiM0prY3k1cWIybHVLQ0pjYmlJcE93cDlDZ3BoYzNsdVl5Qm1kVzVqZEdsdmJpQmhjM05sY25SWGFXNWtiM2R6VUdGMGFGTmxZM1Z5YVhSNUtHVnVkSEpwWlhNc0lHTnZiblJsZUhRcElIc0tJQ0JqYjI1emRDQmthWE53YkdGNVVHRjBhQ0E5SUdWdWRISnBaWE11WVhRb0xURXBQeTV3WVhSb0lEOC9JQ0oxYm10dWIzZHVJanNLSUNCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0JrYVhOd2JHRjVVR0YwYUNrN0NpQWdZMjl1YzNRZ2RISjFjM1JsWkZCaGRHaHpJRDBnZEhKMWMzUmxaRmRwYm1SdmQzTlFiM2RsY2xOb1pXeHNVR0YwYUNncE93b2dJR052Ym5OMElIc2dkMjl5YTJsdVowUnBjbVZqZEc5eWVTd2daWGhsWTNWMFlXSnNaU0I5SUQwZ2RISjFjM1JsWkZCaGRHaHpPd29nSUd4bGRDQnlaWE4xYkhRN0NpQWdkSEo1SUhzS0lDQWdJSEpsYzNWc2RDQTlJR0YzWVdsMElHVjRaV05HYVd4bFZYUm1PQ2dLSUNBZ0lDQWdaWGhsWTNWMFlXSnNaU3dLSUNBZ0lDQWdXd29nSUNBZ0lDQWdJQ0l0VG05TWIyZHZJaXdLSUNBZ0lDQWdJQ0FpTFU1dlVISnZabWxzWlNJc0NpQWdJQ0FnSUNBZ0lpMU9iMjVKYm5SbGNtRmpkR2wyWlNJc0NpQWdJQ0FnSUNBZ0lpMUZibU52WkdWa1EyOXRiV0Z1WkNJc0NpQWdJQ0FnSUNBZ1YwbE9SRTlYVTE5VFJVTlZVa2xVV1Y5VFExSkpVRlJmUWtGVFJUWTBMQW9nSUNBZ0lDQmRMQW9nSUNBZ0lDQjdDaUFnSUNBZ0lDQWdZM2RrT2lCM2IzSnJhVzVuUkdseVpXTjBiM0o1TEFvZ0lDQWdJQ0FnSUdWdWRqb2dkMmx1Wkc5M2MxQnZkMlZ5VTJobGJHeEZiblpwY205dWJXVnVkQ2hsYm5SeWFXVnpMQ0IwY25WemRHVmtVR0YwYUhNcExBb2dJQ0FnSUNBZ0lHMWhlRUoxWm1abGNqb2dNVEF5TkNBcUlERXdNalFzQ2lBZ0lDQWdJQ0FnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzQ2lBZ0lDQWdJSDBzQ2lBZ0lDQWdJR052Ym5SbGVIUXNDaUFnSUNBZ0lHUnBjM0JzWVhsUVlYUm9MQW9nSUNBZ0tUc0tJQ0I5SUdOaGRHTm9JQ2hsY25KdmNpa2dld29nSUNBZ2RHaHliM2NnYm05eWJXRnNhWHBsVkdsdFpXUkRiMjF0WVc1a1JYSnliM0lvWlhKeWIzSXNJR052Ym5SbGVIUXNJR1JwYzNCc1lYbFFZWFJvS1RzS0lDQjlDaUFnYVdZZ0tISmxjM1ZzZEM1emRHUnZkWFFnSVQwOUlDSlBTeUlwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklGZHBibVJ2ZDNNZ2JHOWpheTF3WVhSb0lIWmhiR2xrWVhScGIyNGdjbVYwZFhKdVpXUWdZVzRnYVc1MllXeHBaQ0J5WlhOd2IyNXpaU0JtYjNJZ0pIdGthWE53YkdGNVVHRjBhSDFnS1RzS0lDQjlDaUFnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2daR2x6Y0d4aGVWQmhkR2dwT3dwOUNncG1kVzVqZEdsdmJpQjFibk4xY0hCdmNuUmxaRXh2WTJ0R2FXeGxjM2x6ZEdWdEtIQmhjbVZ1ZEN3Z1ptbHNaWE41YzNSbGJWUjVjR1VzSUdOaGRYTmxLU0I3Q2lBZ2NtVjBkWEp1SUc1bGR5QkZjbkp2Y2lnS0lDQWdJR0JoWjJWdVl6b2dibTl1TFd4dlkyRnNJRzl5SUhWdWEyNXZkMjRnYkc5amF5Qm1hV3hsYzNsemRHVnRJR2x6SUhWdWMzVndjRzl5ZEdWa0lDZ2tlMlpwYkdWemVYTjBaVzFVZVhCbElEOC9JQ0oxYm10dWIzZHVJbjBwT2lBa2UzQmhjbVZ1ZEgxZ0xBb2dJQ0FnWTJGMWMyVWdQVDA5SUhWdVpHVm1hVzVsWkNBL0lIVnVaR1ZtYVc1bFpDQTZJSHNnWTJGMWMyVWdmU3dLSUNBcE93cDlDZ3BoYzNsdVl5Qm1kVzVqZEdsdmJpQmhjM05sY25STWIyTmhiRVpwYkdWemVYTjBaVzBvY0dGeVpXNTBMQ0JqYjI1MFpYaDBLU0I3Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnY0dGeVpXNTBLVHNLSUNCc1pYUWdabWxzWlhONWMzUmxiVlI1Y0dVN0NpQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDSnNhVzUxZUNJcElIc0tJQ0FnSUdOdmJuTjBJRzF2ZFc1MGN5QTlJR0YzWVdsMElISmxZV1JHYVd4bEtDSXZjSEp2WXk5elpXeG1MMjF2ZFc1MGFXNW1ieUlzSUNKMWRHWTRJaWs3Q2lBZ0lDQjBhSEp2ZDBsbVJYaHdhWEpsWkNoamIyNTBaWGgwTENCd1lYSmxiblFwT3dvZ0lDQWdiR1YwSUd4dmJtZGxjM1FnUFNBdE1Uc0tJQ0FnSUdadmNpQW9ZMjl1YzNRZ2JHbHVaU0J2WmlCdGIzVnVkSE11YzNCc2FYUW9JbHh1SWlrcElIc0tJQ0FnSUNBZ1kyOXVjM1FnWm1sbGJHUnpJRDBnYkdsdVpTNXpjR3hwZENnaUlDSXBPd29nSUNBZ0lDQmpiMjV6ZENCelpYQmhjbUYwYjNKSmJtUmxlQ0E5SUdacFpXeGtjeTVwYm1SbGVFOW1LQ0l0SWlrN0NpQWdJQ0FnSUdsbUlDZ0tJQ0FnSUNBZ0lDQnpaWEJoY21GMGIzSkpibVJsZUNBOElEWWdmSHdLSUNBZ0lDQWdJQ0JtYVdWc1pITmJORjBnUFQwOUlIVnVaR1ZtYVc1bFpDQjhmQW9nSUNBZ0lDQWdJR1pwWld4a2MxdHpaWEJoY21GMGIzSkpibVJsZUNBcklERmRJRDA5UFNCMWJtUmxabWx1WldRS0lDQWdJQ0FnS1NCamIyNTBhVzUxWlRzS0lDQWdJQ0FnWTI5dWMzUWdiVzkxYm5SUWIybHVkQ0E5SUdSbFkyOWtaVTF2ZFc1MFVHRjBhQ2htYVdWc1pITmJORjBwT3dvZ0lDQWdJQ0JwWmlBb2NHRjBhRWx6VjJsMGFHbHVLSEJoY21WdWRDd2diVzkxYm5SUWIybHVkQ2tnSmlZZ2JXOTFiblJRYjJsdWRDNXNaVzVuZEdnZ1BpQnNiMjVuWlhOMEtTQjdDaUFnSUNBZ0lDQWdiRzl1WjJWemRDQTlJRzF2ZFc1MFVHOXBiblF1YkdWdVozUm9Pd29nSUNBZ0lDQWdJR1pwYkdWemVYTjBaVzFVZVhCbElEMGdabWxsYkdSelczTmxjR0Z5WVhSdmNrbHVaR1Y0SUNzZ01WMDdDaUFnSUNBZ0lIMEtJQ0FnSUgwS0lDQjlJR1ZzYzJVZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNKa1lYSjNhVzRpS1NCN0NpQWdJQ0JqYjI1emRDQndjbTlpWlZOMFlYSjBaV1JCZENBOUlIQmxjbVp2Y20xaGJtTmxMbTV2ZHlncE93b2dJQ0FnWTI5dWMzUWdjSEp2WW1WRVpXRmtiR2x1WlNBOUlFMWhkR2d1YldsdUtBb2dJQ0FnSUNCamIyNTBaWGgwTG1SbFlXUnNhVzVsTEFvZ0lDQWdJQ0J3Y205aVpWTjBZWEowWldSQmRDQXJJRVJCVWxkSlRsOUdTVXhGVTFsVFZFVk5YMUJTVDBKRlgxUkpUVVZQVlZSZlRWTXNDaUFnSUNBcE93b2dJQ0FnWTI5dWMzUWdjSEp2WW1WRGIyNTBaWGgwSUQwZ2V3b2dJQ0FnSUNBdUxpNWpiMjUwWlhoMExBb2dJQ0FnSUNCa1pXRmtiR2x1WlRvZ2NISnZZbVZFWldGa2JHbHVaU3dLSUNBZ0lDQWdkR2x0Wlc5MWRFMXpPaUJOWVhSb0xtMXBiaWdLSUNBZ0lDQWdJQ0JFUVZKWFNVNWZSa2xNUlZOWlUxUkZUVjlRVWs5Q1JWOVVTVTFGVDFWVVgwMVRMQW9nSUNBZ0lDQWdJRTFoZEdndWJXRjRLREVzSUUxaGRHZ3VZMlZwYkNod2NtOWlaVVJsWVdSc2FXNWxJQzBnY0hKdlltVlRkR0Z5ZEdWa1FYUXBLU3dLSUNBZ0lDQWdLU3dLSUNBZ0lDQWdiR0ZpWld3NklHQWtlMk52Ym5SbGVIUXViR0ZpWld4OUlDaHRZV05QVXlCc2IyTnJJR1pwYkdWemVYTjBaVzBnY0hKdlltVWdkbWxoSUM5aWFXNHZaR1lwWUN3S0lDQWdJSDA3Q2lBZ0lDQnNaWFFnY21WemRXeDBPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdMeThnVjJsMGFDQmhiaUJsZUdsemRHbHVaeUJrYVhKbFkzUnZjbmtnYjNCbGNtRnVaQ3dnWkdZZ1kyRnNiSE1nYzNSaGRHWnpJRzl1SUhSb1lYUWdjR0YwYUM0S0lDQWdJQ0FnTHk4Z0xWUWdabWxzZEdWeWN5Qm1YMlp6ZEhsd1pXNWhiV1VnWVdkaGFXNXpkQ0J2ZFhJZ1pYaGhZM1FnWVd4c2IzZHNhWE4wTENCcGJtTnNkV1JwYm1jZ2IyNEtJQ0FnSUNBZ0x5OGdjM1Z3Y0c5eWRHVmtJRzFoWTA5VElIWmxjbk5wYjI1eklIUm9ZWFFnWTJGdWJtOTBJSEJ5YVc1MElIUm9aU0IwZVhCbElIZHBkR2dnWkdZZ0xWa3VDaUFnSUNBZ0lDOHZJRTVsZG1WeUlIVnpaU0JoSUdKaGNtVWdiVzkxYm5RdlpHWWdiM0lnWkdZZ0xXdzZJSFZ1Y21Wc1lYUmxaQ0JtYVd4bGMzbHpkR1Z0Y3lCdFlYa2dZbVVnYzNSMVkyc3VDaUFnSUNBZ0lISmxjM1ZzZENBOUlHRjNZV2wwSUdWNFpXTkdhV3hsVlhSbU9DZ0tJQ0FnSUNBZ0lDQWlMMkpwYmk5a1ppSXNDaUFnSUNBZ0lDQWdXeUl0VUNJc0lDSXRWQ0lzSUZzdUxpNU1UME5CVEY5R1NVeEZVMWxUVkVWTlgxUlpVRVZUWFM1cWIybHVLQ0lzSWlrc0lIQmhjbVZ1ZEYwc0NpQWdJQ0FnSUNBZ2V5Qmxiblk2SUhzZ1RFTmZRVXhNT2lBaVF5SWdmU3dnYldGNFFuVm1abVZ5T2lBMk5DQXFJREV3TWpRZ2ZTd0tJQ0FnSUNBZ0lDQndjbTlpWlVOdmJuUmxlSFFzQ2lBZ0lDQWdJQ0FnY0dGeVpXNTBMQW9nSUNBZ0lDQXBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pYSnliM0lwSUhzS0lDQWdJQ0FnWTI5dWMzUWdibTl5YldGc2FYcGxaQ0E5SUc1dmNtMWhiR2w2WlZScGJXVmtRMjl0YldGdVpFVnljbTl5S0dWeWNtOXlMQ0J3Y205aVpVTnZiblJsZUhRc0lIQmhjbVZ1ZENrN0NpQWdJQ0FnSUdsbUlDaHViM0p0WVd4cGVtVmtJR2x1YzNSaGJtTmxiMllnVEc5allXeFRjV3hwZEdWTWIyTnJWR2x0Wlc5MWRFVnljbTl5S1NCMGFISnZkeUJ1YjNKdFlXeHBlbVZrT3dvZ0lDQWdJQ0IwYUhKdmR5QjFibk4xY0hCdmNuUmxaRXh2WTJ0R2FXeGxjM2x6ZEdWdEtIQmhjbVZ1ZEN3Z2RXNWtaV1pwYm1Wa0xDQnViM0p0WVd4cGVtVmtLVHNLSUNBZ0lIMEtJQ0FnSUhSb2NtOTNTV1pGZUhCcGNtVmtLSEJ5YjJKbFEyOXVkR1Y0ZEN3Z2NHRnlaVzUwS1RzS0lDQWdJR052Ym5OMElHeHBibVZ6SUQwZ2NtVnpkV3gwTG5OMFpHOTFkQzV6Y0d4cGRDZ2lYRzRpS1RzS0lDQWdJR2xtSUNoc2FXNWxjeTVoZENndE1Ta2dQVDA5SUNJaUtTQnNhVzVsY3k1d2IzQW9LVHNLSUNBZ0lHTnZibk4wSUhKdmR5QTlJR3hwYm1Weld6RmRQeTV0WVhSamFDZ3ZYaTRyVzF4MElGMHJYR1FyVzF4MElGMHJYR1FyVzF4MElGMHJMVDljWkN0YlhIUWdYU3RjWkNzbFcxeDBJRjByS0Z3dkxpb3BKQzkxS1RzS0lDQWdJQzh2SUZSb1pTQjBlWEJsSUhkaGN5QmphR1ZqYTJWa0lHSjVJR1JtSUc5dUlIUm9aU0J2Y0dWeVlXNWtJR2wwYzJWc1ppNGdSRzhnYm05MElHbHVabVZ5SUdsMElHWnliMjBLSUNBZ0lDOHZJSFJvWlNCd2NtbHVkR1ZrSUcxdmRXNTBJSEJ2YVc1ME9pQkJVRVpUSUdacGNtMXNhVzVyY3lCallXNGdiV0Z3SUM5VmMyVnljeUIwYnlCMGFHVWdSR0YwWVNCMmIyeDFiV1VLSUNBZ0lDOHZJRzF2ZFc1MFpXUWdZWFFnTDFONWMzUmxiUzlXYjJ4MWJXVnpMMFJoZEdFZ2QybDBhRzkxZENCamFHRnVaMmx1WnlCeVpXRnNjR0YwYUNndlZYTmxjbk12TGk0dUtTNEtJQ0FnSUdsbUlDZ0tJQ0FnSUNBZ2NtVnpkV3gwTG5OMFpHVnljaUFoUFQwZ0lpSWdmSHdnYkdsdVpYTXViR1Z1WjNSb0lDRTlQU0F5SUh4OENpQWdJQ0FnSUNFdlhrWnBiR1Z6ZVhOMFpXMWJYSFFnWFNzMU1USXRZbXh2WTJ0elcxeDBJRjByVlhObFpGdGNkQ0JkSzBGMllXbHNLRDg2WVdKc1pTay9XMXgwSUYwclEyRndZV05wZEhsYlhIUWdYU3ROYjNWdWRHVmtJRzl1SkM5MUxuUmxjM1FvYkdsdVpYTmJNRjBwSUh4OENpQWdJQ0FnSUhKdmR5QTlQU0J1ZFd4c0NpQWdJQ0FwSUhzS0lDQWdJQ0FnZEdoeWIzY2dkVzV6ZFhCd2IzSjBaV1JNYjJOclJtbHNaWE41YzNSbGJTaHdZWEpsYm5RcE93b2dJQ0FnZlFvZ0lDQWdjbVYwZFhKdU93b2dJSDBnWld4elpTQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0luZHBiak15SWlrZ2V3b2dJQ0FnWVhkaGFYUWdZWE56WlhKMFYybHVaRzkzYzFCaGRHaFRaV04xY21sMGVTaGJleUJ3WVhSb09pQndZWEpsYm5Rc0lISnZiR1U2SUNKc1pXRm1SR2x5WldOMGIzSjVJaUI5WFN3Z1kyOXVkR1Y0ZENrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlNCbGJITmxJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2lnS0lDQWdJQ0FnWUdGblpXNWpPaUJqWVc1dWIzUWdaWE4wWVdKc2FYTm9JR3h2WTJzZ1ptbHNaWE41YzNSbGJTQnNiMk5oYkdsMGVTQnZiaUFrZTNCeWIyTmxjM011Y0d4aGRHWnZjbTE5WUN3S0lDQWdJQ2s3Q2lBZ2ZRb2dJR2xtSUNobWFXeGxjM2x6ZEdWdFZIbHdaU0E5UFQwZ2RXNWtaV1pwYm1Wa0lIeDhJQ0ZNVDBOQlRGOUdTVXhGVTFsVFZFVk5YMVJaVUVWVExtaGhjeWhtYVd4bGMzbHpkR1Z0Vkhsd1pTa3BJSHNLSUNBZ0lIUm9jbTkzSUhWdWMzVndjRzl5ZEdWa1RHOWphMFpwYkdWemVYTjBaVzBvY0dGeVpXNTBMQ0JtYVd4bGMzbHpkR1Z0Vkhsd1pTazdDaUFnZlFwOUNnb3ZLaW9LSUNvZ1JYTjBZV0pzYVhOb0lIUm9ZWFFnWVc0Z1pYaHBjM1JwYm1jZ1pHbHlaV04wYjNKNUlHbHpJR0VnYkc5allXd3NJSEJ5YVhaaGRHVnNlU0J0ZFhSaFlteGxDaUFxSUdOdmIzSmthVzVoZEdsdmJpQmliM1Z1WkdGeWVTNGdWM0poY0hCbGNpQnlaWEJzWVdObGJXVnVkQ0IxYzJWeklHRWdjbVZuYVhOMGNua3RhRzl6ZEdWa0lGTlJUR2wwWlFvZ0tpQnNiMk5yTENCemJ5QmhJSE5vWVhKbFpDQnZjaUJoZEhSaFkydGxjaTEzY21sMFlXSnNaU0IzY21Gd2NHVnlJR1JwY21WamRHOXllU0IzYjNWc1pDQnZkR2hsY25kcGMyVUtJQ29nY0dWeWJXbDBJR055YjNOekxXaHZjM1FnY21GalpYTWdiM0lnY0dGMGFDQnpkV0p6ZEdsMGRYUnBiMjRnYjNWMGMybGtaU0IwYUdGMElHeHZZMnN1Q2lBcUx3cGxlSEJ2Y25RZ1lYTjVibU1nWm5WdVkzUnBiMjRnWVhOelpYSjBURzlqWVd4UWNtbDJZWFJsUkdseVpXTjBiM0o1S0FvZ0lISmxjWFZsYzNSbFpGQmhkR2dzQ2lBZ2V3b2dJQ0FnZEdsdFpXOTFkRTF6SUQwZ05qQmZNREF3TEFvZ0lDQWdiR0ZpWld3Z1BTQWlRV2RsYmtNZ2IzQmxjbUYwYVc5dUlpd0tJQ0FnSUdSbFlXUnNhVzVsT2lCemRYQndiR2xsWkVSbFlXUnNhVzVsTEFvZ0lDQWdZV3hzYjNkVWNuVnpkR1ZrVTNScFkydDVUR1ZoWmlBOUlHWmhiSE5sTEFvZ0lDQWdiMjVRY205bmNtVnpjeXdLSUNCOUlEMGdlMzBzQ2lrZ2V3b2dJR2xtSUNnaFRuVnRZbVZ5TG1selUyRm1aVWx1ZEdWblpYSW9kR2x0Wlc5MWRFMXpLU0I4ZkNCMGFXMWxiM1YwVFhNZ1BEMGdNQ2tnZXdvZ0lDQWdkR2h5YjNjZ2JtVjNJRlI1Y0dWRmNuSnZjaWdpYkc5amF5QjBhVzFsYjNWMFRYTWdiWFZ6ZENCaVpTQmhJSEJ2YzJsMGFYWmxJSE5oWm1VZ2FXNTBaV2RsY2lJcE93b2dJSDBLSUNCcFppQW9jM1Z3Y0d4cFpXUkVaV0ZrYkdsdVpTQWhQVDBnZFc1a1pXWnBibVZrSUNZbUlDRk9kVzFpWlhJdWFYTkdhVzVwZEdVb2MzVndjR3hwWldSRVpXRmtiR2x1WlNrcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCVWVYQmxSWEp5YjNJb0lteHZZMnNnWkdWaFpHeHBibVVnYlhWemRDQmlaU0JtYVc1cGRHVWlLVHNLSUNCOUNpQWdhV1lnS0hSNWNHVnZaaUJoYkd4dmQxUnlkWE4wWldSVGRHbGphM2xNWldGbUlDRTlQU0FpWW05dmJHVmhiaUlwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJVZVhCbFJYSnliM0lvSW1Gc2JHOTNWSEoxYzNSbFpGTjBhV05yZVV4bFlXWWdiWFZ6ZENCaVpTQmliMjlzWldGdUlpazdDaUFnZlFvZ0lHbG1JQ2h2YmxCeWIyZHlaWE56SUNFOVBTQjFibVJsWm1sdVpXUWdKaVlnZEhsd1pXOW1JRzl1VUhKdlozSmxjM01nSVQwOUlDSm1kVzVqZEdsdmJpSXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QlVlWEJsUlhKeWIzSW9JbXh2WTJzZ2IyNVFjbTluY21WemN5QnRkWE4wSUdKbElHRWdablZ1WTNScGIyNGlLVHNLSUNCOUNpQWdZMjl1YzNRZ1kyOXVkR1Y0ZENBOUlIc0tJQ0FnSUdSbFlXUnNhVzVsT2lCTllYUm9MbTFwYmlnS0lDQWdJQ0FnYzNWd2NHeHBaV1JFWldGa2JHbHVaU0EvUHlCT2RXMWlaWEl1VUU5VFNWUkpWa1ZmU1U1R1NVNUpWRmtzQ2lBZ0lDQWdJSEJsY21admNtMWhibU5sTG01dmR5Z3BJQ3NnZEdsdFpXOTFkRTF6TEFvZ0lDQWdLU3dLSUNBZ0lHeGhZbVZzTEFvZ0lDQWdkR2x0Wlc5MWRFMXpMQW9nSUNBZ2IyNVFjbTluY21WemN5d0tJQ0I5T3dvZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKd2NtbDJZWFJsSUdScGNtVmpkRzl5ZVNCMllXeHBaR0YwYVc5dUlITjBZWEowWldRaUtUc0tJQ0JqYjI1emRDQmhZbk52YkhWMFpTQTlJSEpsYzI5c2RtVW9jbVZ4ZFdWemRHVmtVR0YwYUNrN0NpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1lXSnpiMngxZEdVcE93b2dJR052Ym5OMElHTmhibTl1YVdOaGJDQTlJR0YzWVdsMElISmxZV3h3WVhSb0tHRmljMjlzZFhSbEtUc0tJQ0JqYjI1emRDQmhibU5sYzNSdmNuTWdQU0JiWFRzS0lDQm1iM0lnS0d4bGRDQmpkWEp5Wlc1MElEMGdZMkZ1YjI1cFkyRnNPeUE3SUdOMWNuSmxiblFnUFNCa2FYSnVZVzFsS0dOMWNuSmxiblFwS1NCN0NpQWdJQ0JoYm1ObGMzUnZjbk11Y0hWemFDaGpkWEp5Wlc1MEtUc0tJQ0FnSUdsbUlDaGthWEp1WVcxbEtHTjFjbkpsYm5RcElEMDlQU0JqZFhKeVpXNTBLU0JpY21WaGF6c0tJQ0I5Q2lBZ1kyOXVjM1FnWTNWeWNtVnVkRlZwWkNBOUlIQnliMk5sYzNNdVoyVjBkV2xrUHk0b0tUc0tJQ0JqYjI1emRDQmlaV1p2Y21WSlpHVnVkR2wwYVdWeklEMGdibVYzSUUxaGNDZ3BPd29nSUdadmNpQW9iR1YwSUdsdVpHVjRJRDBnTURzZ2FXNWtaWGdnUENCaGJtTmxjM1J2Y25NdWJHVnVaM1JvT3lCcGJtUmxlQ0FyUFNBeEtTQjdDaUFnSUNCamIyNXpkQ0J3WVhSb0lEMGdZVzVqWlhOMGIzSnpXMmx1WkdWNFhUc0tJQ0FnSUdOdmJuTjBJSE4wWVhSeklEMGdZWGRoYVhRZ2JITjBZWFFvY0dGMGFDd2dleUJpYVdkcGJuUTZJSFJ5ZFdVZ2ZTazdDaUFnSUNCcFppQW9JWE4wWVhSekxtbHpSR2x5WldOMGIzSjVLQ2tnZkh3Z2MzUmhkSE11YVhOVGVXMWliMnhwWTB4cGJtc29LU2tnZXdvZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQndjbTkwWldOMFpXUWdjR0YwYUNCaGJtTmxjM1J2Y2lCcGN5QnViM1FnWVNCeVpXRnNJR1JwY21WamRHOXllVG9nSkh0d1lYUm9mV0FwT3dvZ0lDQWdmUW9nSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNKM2FXNHpNaUlwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR1ZoWmlBOUlHbHVaR1Y0SUQwOVBTQXdPd29nSUNBZ0lDQmpiMjV6ZENCMGNuVnpkR1ZrVDNkdVpYSWdQU0J6ZEdGMGN5NTFhV1FnUFQwOUlEQnVJSHg4Q2lBZ0lDQWdJQ0FnS0dOMWNuSmxiblJWYVdRZ0lUMDlJSFZ1WkdWbWFXNWxaQ0FtSmlCemRHRjBjeTUxYVdRZ1BUMDlJRUpwWjBsdWRDaGpkWEp5Wlc1MFZXbGtLU2s3Q2lBZ0lDQWdJR052Ym5OMElITjBhV05yZVVKdmRXNWtZWEo1SUQwZ0tDRnNaV0ZtSUh4OElHRnNiRzkzVkhKMWMzUmxaRk4wYVdOcmVVeGxZV1lwSUNZbUNpQWdJQ0FnSUNBZ0tITjBZWFJ6TG0xdlpHVWdKaUF3YnpFd01EQnVLU0FoUFQwZ01HNGdKaVlnZEhKMWMzUmxaRTkzYm1WeU93b2dJQ0FnSUNCcFppQW9JWFJ5ZFhOMFpXUlBkMjVsY2lCOGZDQW9LSE4wWVhSekxtMXZaR1VnSmlBd2J6QXlNbTRwSUNFOVBTQXdiaUFtSmlBaGMzUnBZMnQ1UW05MWJtUmhjbmtwS1NCN0NpQWdJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0FvZ0lDQWdJQ0FnSUNBZ1lHRm5aVzVqT2lCd2NtOTBaV04wWldRZ1pHbHlaV04wYjNKNUlHTm9ZV2x1SUhCbGNtMXBkSE1nZFc1MGNuVnpkR1ZrSUcxMWRHRjBhVzl1T2lBa2UzQmhkR2g5T3lCZ0lDc0tJQ0FnSUNBZ0lDQWdJQ0p5WlcxdmRtVWdaM0p2ZFhBdmQyOXliR1FnZDNKcGRHVWdZV05qWlhOeklHSmxabTl5WlNCeVpYUnllV2x1WnlJc0NpQWdJQ0FnSUNBZ0tUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCcFppQW9DaUFnSUNBZ0lDQWdiR1ZoWmlBbUppQWhjM1JwWTJ0NVFtOTFibVJoY25rZ0ppWWdZM1Z5Y21WdWRGVnBaQ0FoUFQwZ2RXNWtaV1pwYm1Wa0lDWW1DaUFnSUNBZ0lDQWdjM1JoZEhNdWRXbGtJQ0U5UFNCQ2FXZEpiblFvWTNWeWNtVnVkRlZwWkNrS0lDQWdJQ0FnS1NCN0NpQWdJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nY0hKdmRHVmpkR1ZrSUdScGNtVmpkRzl5ZVNCcGN5QnViM1FnYjNkdVpXUWdZbmtnZEdobElHTjFjbkpsYm5RZ2RYTmxjam9nSkh0d1lYUm9mV0FwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQjlDaUFnSUNCaVpXWnZjbVZKWkdWdWRHbDBhV1Z6TG5ObGRDaHdZWFJvTENCN0lHUmxkam9nYzNSaGRITXVaR1YyTENCcGJtODZJSE4wWVhSekxtbHVieUI5S1RzS0lDQWdJR2xrWlc1MGFYUjVSbkp2YlZOMFlYUnpLSE4wWVhSekxDQndZWFJvS1RzS0lDQjlDaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ0ozYVc0ek1pSXBJSHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKWGFXNWtiM2R6SUdGdVkyVnpkRzl5SUVGRFRDQjJZV3hwWkdGMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNBZ0lHRjNZV2wwSUdGemMyVnlkRmRwYm1SdmQzTlFZWFJvVTJWamRYSnBkSGtvQ2lBZ0lDQWdJR0Z1WTJWemRHOXljeTV0WVhBb0tIQmhkR2dzSUdsdVpHVjRLU0E5UGlBb2V3b2dJQ0FnSUNBZ0lIQmhkR2dzQ2lBZ0lDQWdJQ0FnY205c1pUb2dhVzVrWlhnZ1BUMDlJREFnUHlBaWJHVmhaa1JwY21WamRHOXllU0lnT2lBaVlXNWpaWE4wYjNKRWFYSmxZM1J2Y25raUxBb2dJQ0FnSUNCOUtTa3NDaUFnSUNBZ0lHTnZiblJsZUhRc0NpQWdJQ0FwT3dvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsZHBibVJ2ZDNNZ1lXNWpaWE4wYjNJZ1FVTk1JSFpoYkdsa1lYUnBiMjRnWTI5dGNHeGxkR1VpS1RzS0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnWVhkaGFYUWdZWE56WlhKMFRHOWpZV3hHYVd4bGMzbHpkR1Z0S0dOaGJtOXVhV05oYkN3Z1kyOXVkR1Y0ZENrN0NpQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdJbVJoY25kcGJpSXBJSHNLSUNBZ0lDQWdabTl5SUNoc1pYUWdhVzVrWlhnZ1BTQXdPeUJwYm1SbGVDQThJR0Z1WTJWemRHOXljeTVzWlc1bmRHZzdJR2x1WkdWNElDczlJREVwSUhzS0lDQWdJQ0FnSUNCaGQyRnBkQ0JoYzNObGNuUkVZWEozYVc1UVlYUm9VMlZqZFhKcGRIa29DaUFnSUNBZ0lDQWdJQ0JoYm1ObGMzUnZjbk5iYVc1a1pYaGRMQW9nSUNBZ0lDQWdJQ0FnYVc1a1pYZ2dQVDA5SURBZ1B5QWliR1ZoWmlCa2FYSmxZM1J2Y25raUlEb2dJbUZ1WTJWemRHOXlJR1JwY21WamRHOXllU0lzQ2lBZ0lDQWdJQ0FnSUNCamIyNTBaWGgwTEFvZ0lDQWdJQ0FnSUNrN0NpQWdJQ0FnSUgwS0lDQWdJSDBLSUNCOUNpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1kyRnViMjVwWTJGc0tUc0tJQ0JtYjNJZ0tHTnZibk4wSUhCaGRHZ2diMllnWVc1alpYTjBiM0p6S1NCN0NpQWdJQ0JqYjI1emRDQmhablJsY2lBOUlHRjNZV2wwSUd4emRHRjBLSEJoZEdnc0lIc2dZbWxuYVc1ME9pQjBjblZsSUgwcE93b2dJQ0FnWTI5dWMzUWdZbVZtYjNKbElEMGdZbVZtYjNKbFNXUmxiblJwZEdsbGN5NW5aWFFvY0dGMGFDazdDaUFnSUNCcFppQW9DaUFnSUNBZ0lDRmhablJsY2k1cGMwUnBjbVZqZEc5eWVTZ3BJSHg4SUdGbWRHVnlMbWx6VTNsdFltOXNhV05NYVc1cktDa2dmSHdnWW1WbWIzSmxJRDA5UFNCMWJtUmxabWx1WldRZ2ZId0tJQ0FnSUNBZ1lXWjBaWEl1WkdWMklDRTlQU0JpWldadmNtVXVaR1YySUh4OElHRm1kR1Z5TG1sdWJ5QWhQVDBnWW1WbWIzSmxMbWx1YndvZ0lDQWdLU0I3Q2lBZ0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklIQnliM1JsWTNSbFpDQmthWEpsWTNSdmNua2dhV1JsYm5ScGRIa2dZMmhoYm1kbFpDQmtkWEpwYm1jZ2RtRnNhV1JoZEdsdmJqb2dKSHR3WVhSb2ZXQXBPd29nSUNBZ2ZRb2dJSDBLSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpY0hKcGRtRjBaU0JrYVhKbFkzUnZjbmtnZG1Gc2FXUmhkR2x2YmlCamIyMXdiR1YwWlNJcE93b2dJSEpsZEhWeWJpQmpZVzV2Ym1sallXdzdDbjBLQ21aMWJtTjBhVzl1SUdGemMyVnlkRkpsWjNWc1lYSlRhVzVuYkdWTWFXNXJLSE4wWVhSekxDQndZWFJvS1NCN0NpQWdhV1lnS0NGemRHRjBjeTVwYzBacGJHVW9LU0I4ZkNCemRHRjBjeTVwYzFONWJXSnZiR2xqVEdsdWF5Z3BLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCc2IyTnJJR1JoZEdGaVlYTmxJR2x6SUc1dmRDQmhJSEpsWjNWc1lYSWdabWxzWlRvZ0pIdHdZWFJvZldBcE93b2dJSDBLSUNCcFppQW9jM1JoZEhNdWJteHBibXNnSVQwOUlERnVLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCc2IyTnJJR1JoZEdGaVlYTmxJRzExYzNRZ2JtOTBJR2hoZG1VZ2FHRnlaQzFzYVc1cklHRnNhV0Z6WlhNNklDUjdjR0YwYUgxZ0tUc0tJQ0I5Q24wS0NtWjFibU4wYVc5dUlHbGtaVzUwYVhSNVJuSnZiVk4wWVhSektITjBZWFJ6TENCd1lYUm9LU0I3Q2lBZ2FXWWdLQW9nSUNBZ2MzUmhkSE11WkdWMklEMDlQU0F3YmlCOGZBb2dJQ0FnYzNSaGRITXVhVzV2SUQwOVBTQXdiaUI4ZkFvZ0lDQWdjM1JoZEhNdWFXNXZJRDA5UFNBdE1XNGdmSHdLSUNBZ0lFSnBaMGx1ZEM1aGMxVnBiblJPS0RZMExDQnpkR0YwY3k1cGJtOHBJRDA5UFNCVlRsTlZVRkJQVWxSRlJGOUdTVXhGWDBsRVh6WTBDaUFnS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQnNiMk5ySUdSaGRHRmlZWE5sSUdoaGN5QnVieUJ6ZEdGaWJHVWdabWxzWlhONWMzUmxiU0JwWkdWdWRHbDBlVG9nSkh0d1lYUm9mV0FwT3dvZ0lIMEtJQ0J5WlhSMWNtNGdZQ1I3YzNSaGRITXVaR1YyZlRva2UzTjBZWFJ6TG1sdWIzMWdPd3A5Q2dwbWRXNWpkR2x2YmlCaGMzTmxjblJRYjNOcGVFOTNibVZ5YzJocGNDaHpkR0YwY3l3Z2NHRjBhQ3dnYTJsdVpDa2dld29nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FpZDJsdU16SWlLU0J5WlhSMWNtNDdDaUFnWTI5dWMzUWdZM1Z5Y21WdWRGVnBaQ0E5SUhCeWIyTmxjM011WjJWMGRXbGtQeTRvS1RzS0lDQnBaaUFvWTNWeWNtVnVkRlZwWkNBaFBUMGdkVzVrWldacGJtVmtJQ1ltSUhOMFlYUnpMblZwWkNBaFBUMGdRbWxuU1c1MEtHTjFjbkpsYm5SVmFXUXBLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCc2IyTnJJR1JoZEdGaVlYTmxJQ1I3YTJsdVpIMGdhWE1nYm05MElHOTNibVZrSUdKNUlIUm9aU0JqZFhKeVpXNTBJSFZ6WlhJNklDUjdjR0YwYUgxZ0tUc0tJQ0I5Q2lBZ2FXWWdLQ2h6ZEdGMGN5NXRiMlJsSUNZZ01HOHdNakp1S1NBaFBUMGdNRzRwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklHeHZZMnNnWkdGMFlXSmhjMlVnSkh0cmFXNWtmU0JwY3lCbmNtOTFjQzkzYjNKc1pDMTNjbWwwWVdKc1pUb2dKSHR3WVhSb2ZXQXBPd29nSUgwS2ZRb0tMeW9xQ2lBcUlGWmhiR2xrWVhSbElHRWdjbVZuZFd4aGNpQm1hV3hsSUdGdVpDQnBkSE1nWTI5dGNHeGxkR1VnWkdseVpXTjBiM0o1SUdOb1lXbHVJR0psWm05eVpTQmhJR05oYkd4bGNnb2dLaUIwY25WemRITWdhWFJ6SUdOdmJuUmxiblJ6TGlCVWFHbHpJR2x6SUdsdWRHVnVkR2x2Ym1Gc2JIa2dibTl1TFcxMWRHRjBhVzVuT2lCMWJuTmhabVVnYjNkdVpYSnphR2x3TEFvZ0tpQnRiMlJsSUdKcGRITXNJRUZEVEhNc0lHRnNhV0Z6WlhNc0lHOXlJR2xrWlc1MGFYUjVJR05vWVc1blpYTWdabUZwYkNCamJHOXpaV1F1Q2lBcUx3cGxlSEJ2Y25RZ1lYTjVibU1nWm5WdVkzUnBiMjRnWVhOelpYSjBURzlqWVd4UWNtbDJZWFJsUm1sc1pTZ0tJQ0J5WlhGMVpYTjBaV1JRWVhSb0xBb2dJSHNLSUNBZ0lIUnBiV1Z2ZFhSTmN5QTlJRFl3WHpBd01Dd0tJQ0FnSUd4aFltVnNJRDBnSWtGblpXNURJRzl3WlhKaGRHbHZiaUlzQ2lBZ0lDQmtaV0ZrYkdsdVpUb2djM1Z3Y0d4cFpXUkVaV0ZrYkdsdVpTd0tJQ0FnSUc5dVVISnZaM0psYzNNc0NpQWdmU0E5SUh0OUxBb3BJSHNLSUNCcFppQW9JVTUxYldKbGNpNXBjMU5oWm1WSmJuUmxaMlZ5S0hScGJXVnZkWFJOY3lrZ2ZId2dkR2x0Wlc5MWRFMXpJRHc5SURBcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCVWVYQmxSWEp5YjNJb0lteHZZMnNnZEdsdFpXOTFkRTF6SUcxMWMzUWdZbVVnWVNCd2IzTnBkR2wyWlNCellXWmxJR2x1ZEdWblpYSWlLVHNLSUNCOUNpQWdhV1lnS0hOMWNIQnNhV1ZrUkdWaFpHeHBibVVnSVQwOUlIVnVaR1ZtYVc1bFpDQW1KaUFoVG5WdFltVnlMbWx6Um1sdWFYUmxLSE4xY0hCc2FXVmtSR1ZoWkd4cGJtVXBLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dWSGx3WlVWeWNtOXlLQ0pzYjJOcklHUmxZV1JzYVc1bElHMTFjM1FnWW1VZ1ptbHVhWFJsSWlrN0NpQWdmUW9nSUdsbUlDaHZibEJ5YjJkeVpYTnpJQ0U5UFNCMWJtUmxabWx1WldRZ0ppWWdkSGx3Wlc5bUlHOXVVSEp2WjNKbGMzTWdJVDA5SUNKbWRXNWpkR2x2YmlJcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCVWVYQmxSWEp5YjNJb0lteHZZMnNnYjI1UWNtOW5jbVZ6Y3lCdGRYTjBJR0psSUdFZ1puVnVZM1JwYjI0aUtUc0tJQ0I5Q2lBZ1kyOXVjM1FnWTI5dWRHVjRkQ0E5SUhzS0lDQWdJR1JsWVdSc2FXNWxPaUJOWVhSb0xtMXBiaWdLSUNBZ0lDQWdjM1Z3Y0d4cFpXUkVaV0ZrYkdsdVpTQS9QeUJPZFcxaVpYSXVVRTlUU1ZSSlZrVmZTVTVHU1U1SlZGa3NDaUFnSUNBZ0lIQmxjbVp2Y20xaGJtTmxMbTV2ZHlncElDc2dkR2x0Wlc5MWRFMXpMQW9nSUNBZ0tTd0tJQ0FnSUd4aFltVnNMQW9nSUNBZ2RHbHRaVzkxZEUxekxBb2dJQ0FnYjI1UWNtOW5jbVZ6Y3l3S0lDQjlPd29nSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0p3Y21sMllYUmxJR1pwYkdVZ2RtRnNhV1JoZEdsdmJpQnpkR0Z5ZEdWa0lpazdDaUFnWTI5dWMzUWdZV0p6YjJ4MWRHVWdQU0J5WlhOdmJIWmxLSEpsY1hWbGMzUmxaRkJoZEdncE93b2dJR052Ym5OMElIQmhjbVZ1ZENBOUlHUnBjbTVoYldVb1lXSnpiMngxZEdVcE93b2dJR052Ym5OMElHTmhibTl1YVdOaGJGQmhjbVZ1ZENBOUlHRjNZV2wwSUdGemMyVnlkRXh2WTJGc1VISnBkbUYwWlVScGNtVmpkRzl5ZVNod1lYSmxiblFzSUhzS0lDQWdJSFJwYldWdmRYUk5jeXdLSUNBZ0lHeGhZbVZzTEFvZ0lDQWdaR1ZoWkd4cGJtVTZJR052Ym5SbGVIUXVaR1ZoWkd4cGJtVXNDaUFnSUNBdUxpNG9iMjVRY205bmNtVnpjeUE5UFQwZ2RXNWtaV1pwYm1Wa0lEOGdlMzBnT2lCN0lHOXVVSEp2WjNKbGMzTWdmU2tzQ2lBZ2ZTazdDaUFnYVdZZ0tHTmhibTl1YVdOaGJGQmhjbVZ1ZENBaFBUMGdjR0Z5Wlc1MEtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJ3Y205MFpXTjBaV1FnWm1sc1pTQndZWEpsYm5RZ2JYVnpkQ0IxYzJVZ2FYUnpJR05oYm05dWFXTmhiQ0J3WVhSb09pQWtlM0JoY21WdWRIMWdLVHNLSUNCOUNpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1lXSnpiMngxZEdVcE93b2dJR052Ym5OMElHSmxabTl5WlNBOUlHRjNZV2wwSUd4emRHRjBLR0ZpYzI5c2RYUmxMQ0I3SUdKcFoybHVkRG9nZEhKMVpTQjlLVHNLSUNCcFppQW9JV0psWm05eVpTNXBjMFpwYkdVb0tTQjhmQ0JpWldadmNtVXVhWE5UZVcxaWIyeHBZMHhwYm1zb0tTQjhmQ0JpWldadmNtVXVibXhwYm1zZ0lUMDlJREZ1S1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQndjbTkwWldOMFpXUWdabWxzWlNCdGRYTjBJR0psSUdFZ2NtVm5kV3hoY2lCemFXNW5iR1V0YkdsdWF5Qm1hV3hsT2lBa2UyRmljMjlzZFhSbGZXQXBPd29nSUgwS0lDQnBaR1Z1ZEdsMGVVWnliMjFUZEdGMGN5aGlaV1p2Y21Vc0lHRmljMjlzZFhSbEtUc0tJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdJbmRwYmpNeUlpa2dld29nSUNBZ1kyOXVjM1FnWTNWeWNtVnVkRlZwWkNBOUlIQnliMk5sYzNNdVoyVjBkV2xrUHk0b0tUc0tJQ0FnSUdsbUlDaGpkWEp5Wlc1MFZXbGtJQ0U5UFNCMWJtUmxabWx1WldRZ0ppWWdZbVZtYjNKbExuVnBaQ0FoUFQwZ1FtbG5TVzUwS0dOMWNuSmxiblJWYVdRcEtTQjdDaUFnSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUhCeWIzUmxZM1JsWkNCbWFXeGxJR2x6SUc1dmRDQnZkMjVsWkNCaWVTQjBhR1VnWTNWeWNtVnVkQ0IxYzJWeU9pQWtlMkZpYzI5c2RYUmxmV0FwT3dvZ0lDQWdmUW9nSUNBZ2FXWWdLQ2hpWldadmNtVXViVzlrWlNBbUlEQnZNREl5YmlrZ0lUMDlJREJ1S1NCN0NpQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJSEJ5YjNSbFkzUmxaQ0JtYVd4bElHbHpJR2R5YjNWd0wzZHZjbXhrTFhkeWFYUmhZbXhsT2lBa2UyRmljMjlzZFhSbGZXQXBPd29nSUNBZ2ZRb2dJSDBLSUNCamIyNXpkQ0JqWVc1dmJtbGpZV3dnUFNCaGQyRnBkQ0J5WldGc2NHRjBhQ2hoWW5OdmJIVjBaU2s3Q2lBZ2FXWWdLR05oYm05dWFXTmhiQ0FoUFQwZ1lXSnpiMngxZEdVcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJSEJ5YjNSbFkzUmxaQ0JtYVd4bElHMTFjM1FnZFhObElHbDBjeUJqWVc1dmJtbGpZV3dnY0dGMGFEb2dKSHRoWW5OdmJIVjBaWDFnS1RzS0lDQjlDaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ0ozYVc0ek1pSXBJSHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKWGFXNWtiM2R6SUdacGJHVWdRVU5NSUhaaGJHbGtZWFJwYjI0Z2MzUmhjblJsWkNJcE93b2dJQ0FnWVhkaGFYUWdZWE56WlhKMFYybHVaRzkzYzFCaGRHaFRaV04xY21sMGVTaGJleUJ3WVhSb09pQmpZVzV2Ym1sallXd3NJSEp2YkdVNklDSm1hV3hsSWlCOVhTd2dZMjl1ZEdWNGRDazdDaUFnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpVjJsdVpHOTNjeUJtYVd4bElFRkRUQ0IyWVd4cFpHRjBhVzl1SUdOdmJYQnNaWFJsSWlrN0NpQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBaVpHRnlkMmx1SWlrZ2V3b2dJQ0FnWVhkaGFYUWdZWE56WlhKMFJHRnlkMmx1VUdGMGFGTmxZM1Z5YVhSNUtHTmhibTl1YVdOaGJDd2dJbVpwYkdVaUxDQmpiMjUwWlhoMEtUc0tJQ0I5Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnWTJGdWIyNXBZMkZzS1RzS0lDQmpiMjV6ZENCaFpuUmxjaUE5SUdGM1lXbDBJR3h6ZEdGMEtHTmhibTl1YVdOaGJDd2dleUJpYVdkcGJuUTZJSFJ5ZFdVZ2ZTazdDaUFnYVdZZ0tBb2dJQ0FnSVdGbWRHVnlMbWx6Um1sc1pTZ3BJSHg4SUdGbWRHVnlMbWx6VTNsdFltOXNhV05NYVc1cktDa2dmSHdnWVdaMFpYSXVibXhwYm1zZ0lUMDlJREZ1SUh4OENpQWdJQ0JoWm5SbGNpNWtaWFlnSVQwOUlHSmxabTl5WlM1a1pYWWdmSHdnWVdaMFpYSXVhVzV2SUNFOVBTQmlaV1p2Y21VdWFXNXZDaUFnS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQndjbTkwWldOMFpXUWdabWxzWlNCcFpHVnVkR2wwZVNCamFHRnVaMlZrSUdSMWNtbHVaeUIyWVd4cFpHRjBhVzl1T2lBa2UyTmhibTl1YVdOaGJIMWdLVHNLSUNCOUNpQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0luQnlhWFpoZEdVZ1ptbHNaU0IyWVd4cFpHRjBhVzl1SUdOdmJYQnNaWFJsSWlrN0NpQWdjbVYwZFhKdUlHTmhibTl1YVdOaGJEc0tmUW9LWVhONWJtTWdablZ1WTNScGIyNGdjSEpsY0dGeVpVeHZZMnRRWVhSb0tISmxjWFZsYzNSbFpGQmhkR2dzSUdOdmJuUmxlSFFwSUhzS0lDQmpiMjV6ZENCaFluTnZiSFYwWlNBOUlISmxjMjlzZG1Vb2NtVnhkV1Z6ZEdWa1VHRjBhQ2s3Q2lBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSW14dlkyc2djR0YwYUNCd2NtVndZWEpoZEdsdmJpQnpkR0Z5ZEdWa0lpazdDaUFnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2dZV0p6YjJ4MWRHVXBPd29nSUdGM1lXbDBJRzFyWkdseUtHUnBjbTVoYldVb1lXSnpiMngxZEdVcExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2diVzlrWlRvZ01HODNNREFnZlNrN0NpQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lteHZZMnNnY0dGeVpXNTBJR055WldGMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnWVdKemIyeDFkR1VwT3dvZ0lHTnZibk4wSUhCaGNtVnVkQ0E5SUdGM1lXbDBJSEpsWVd4d1lYUm9LR1JwY201aGJXVW9ZV0p6YjJ4MWRHVXBLVHNLSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpYkc5amF5QndZWEpsYm5RZ1kyRnViMjVwWTJGc2FYcGhkR2x2YmlCamIyMXdiR1YwWlNJcE93b2dJSFJvY205M1NXWkZlSEJwY21Wa0tHTnZiblJsZUhRc0lHRmljMjlzZFhSbEtUc0tJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWliRzlqYXlCd1lYSmxiblFnYzJWamRYSnBkSGtnZG1Gc2FXUmhkR2x2YmlCemRHRnlkR1ZrSWlrN0NpQWdZMjl1YzNRZ2RtRnNhV1JoZEdWa1VHRnlaVzUwSUQwZ1lYZGhhWFFnWVhOelpYSjBURzlqWVd4UWNtbDJZWFJsUkdseVpXTjBiM0o1S0hCaGNtVnVkQ3dnZXdvZ0lDQWdkR2x0Wlc5MWRFMXpPaUJqYjI1MFpYaDBMblJwYldWdmRYUk5jeXdLSUNBZ0lHeGhZbVZzT2lCamIyNTBaWGgwTG14aFltVnNMQW9nSUNBZ1pHVmhaR3hwYm1VNklHTnZiblJsZUhRdVpHVmhaR3hwYm1Vc0NpQWdJQ0F1TGk0b1kyOXVkR1Y0ZEM1dmJsQnliMmR5WlhOeklEMDlQU0IxYm1SbFptbHVaV1FLSUNBZ0lDQWdQeUI3ZlFvZ0lDQWdJQ0E2SUhzZ2IyNVFjbTluY21WemN6b2dZMjl1ZEdWNGRDNXZibEJ5YjJkeVpYTnpJSDBwTEFvZ0lIMHBPd29nSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pzYjJOcklIQmhjbVZ1ZENCelpXTjFjbWwwZVNCMllXeHBaR0YwYVc5dUlHTnZiWEJzWlhSbElpazdDaUFnYVdZZ0tIWmhiR2xrWVhSbFpGQmhjbVZ1ZENBaFBUMGdjR0Z5Wlc1MEtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJzYjJOcklHUmhkR0ZpWVhObElIQmhjbVZ1ZENCdGRYTjBJSFZ6WlNCcGRITWdZMkZ1YjI1cFkyRnNJSEJoZEdnNklDUjdjR0Z5Wlc1MGZXQXBPd29nSUgwS0lDQmpiMjV6ZENCd1lYSmxiblJUZEdGMGN5QTlJR0YzWVdsMElHeHpkR0YwS0hCaGNtVnVkQ3dnZXlCaWFXZHBiblE2SUhSeWRXVWdmU2s3Q2lBZ2FXWWdLQ0Z3WVhKbGJuUlRkR0YwY3k1cGMwUnBjbVZqZEc5eWVTZ3BJSHg4SUhCaGNtVnVkRk4wWVhSekxtbHpVM2x0WW05c2FXTk1hVzVyS0NrcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJR3h2WTJzZ1pHRjBZV0poYzJVZ2NHRnlaVzUwSUdseklHNXZkQ0JoSUhKbFlXd2daR2x5WldOMGIzSjVPaUFrZTNCaGNtVnVkSDFnS1RzS0lDQjlDaUFnWVhOelpYSjBVRzl6YVhoUGQyNWxjbk5vYVhBb2NHRnlaVzUwVTNSaGRITXNJSEJoY21WdWRDd2dJbkJoY21WdWRDSXBPd29LSUNCamIyNXpkQ0J3WVhSb0lEMGdhbTlwYmlod1lYSmxiblFzSUdKaGMyVnVZVzFsS0dGaWMyOXNkWFJsS1NrN0NpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NHRjBhQ2s3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUdoaGJtUnNaU0E5SUdGM1lXbDBJRzl3Wlc0b2NHRjBhQ3dnSW5kNElpd2dNRzgyTURBcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1lYZGhhWFFnYUdGdVpHeGxMbU5zYjNObEtDazdDaUFnSUNCOUlHTmhkR05vSUNobGNuSnZjaWtnZXdvZ0lDQWdJQ0JoZDJGcGRDQm9ZVzVrYkdVdVkyeHZjMlVvS1M1allYUmphQ2dvS1NBOVBpQjdmU2s3Q2lBZ0lDQWdJSFJvY205M0lHVnljbTl5T3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0dWeWNtOXlLU0I3Q2lBZ0lDQnBaaUFvWlhKeWIzSS9MbU52WkdVZ0lUMDlJQ0pGUlZoSlUxUWlLU0IwYUhKdmR5Qmxjbkp2Y2pzS0lDQjlDaUFnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbXh2WTJzZ1pHRjBZV0poYzJVZ1ptbHNaU0JqY21WaGRHbHZiaUJqYjIxd2JHVjBaU0lwT3dvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCaGRHZ3BPd29nSUdOdmJuTjBJSEJoZEdoVGRHRjBjeUE5SUdGM1lXbDBJR3h6ZEdGMEtIQmhkR2dzSUhzZ1ltbG5hVzUwT2lCMGNuVmxJSDBwT3dvZ0lHRnpjMlZ5ZEZKbFozVnNZWEpUYVc1bmJHVk1hVzVyS0hCaGRHaFRkR0YwY3l3Z2NHRjBhQ2s3Q2lBZ1lYTnpaWEowVUc5emFYaFBkMjVsY25Ob2FYQW9jR0YwYUZOMFlYUnpMQ0J3WVhSb0xDQWlabWxzWlNJcE93b2dJR052Ym5OMElHTmhibTl1YVdOaGJDQTlJR0YzWVdsMElISmxZV3h3WVhSb0tIQmhkR2dwT3dvZ0lHTnZibk4wSUhOMFlYUnpJRDBnWVhkaGFYUWdiSE4wWVhRb1kyRnViMjVwWTJGc0xDQjdJR0pwWjJsdWREb2dkSEoxWlNCOUtUc0tJQ0JoYzNObGNuUlNaV2QxYkdGeVUybHVaMnhsVEdsdWF5aHpkR0YwY3l3Z1kyRnViMjVwWTJGc0tUc0tJQ0JoYzNObGNuUlFiM05wZUU5M2JtVnljMmhwY0NoemRHRjBjeXdnWTJGdWIyNXBZMkZzTENBaVptbHNaU0lwT3dvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJQ0U5UFNBaWQybHVNeklpS1NCN0NpQWdJQ0JoZDJGcGRDQmphRzF2WkNoallXNXZibWxqWVd3c0lEQnZOakF3S1RzS0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQWlaR0Z5ZDJsdUlpa2dld29nSUNBZ0lDQmhkMkZwZENCaGMzTmxjblJFWVhKM2FXNVFZWFJvVTJWamRYSnBkSGtvWTJGdWIyNXBZMkZzTENBaWJHOWpheUJrWVhSaFltRnpaU0JtYVd4bElpd2dZMjl1ZEdWNGRDazdDaUFnSUNCOUNpQWdmU0JsYkhObElIc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pzYjJOcklHUmhkR0ZpWVhObElFRkRUQ0IyWVd4cFpHRjBhVzl1SUhOMFlYSjBaV1FpS1RzS0lDQWdJR0YzWVdsMElHRnpjMlZ5ZEZkcGJtUnZkM05RWVhSb1UyVmpkWEpwZEhrb1d3b2dJQ0FnSUNCN0lIQmhkR2c2SUhCaGNtVnVkQ3dnY205c1pUb2dJbXhsWVdaRWFYSmxZM1J2Y25raUlIMHNDaUFnSUNBZ0lIc2djR0YwYURvZ1kyRnViMjVwWTJGc0xDQnliMnhsT2lBaVptbHNaU0lnZlN3S0lDQWdJRjBzSUdOdmJuUmxlSFFwT3dvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lteHZZMnNnWkdGMFlXSmhjMlVnUVVOTUlIWmhiR2xrWVhScGIyNGdZMjl0Y0d4bGRHVWlLVHNLSUNCOUNpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1kyRnViMjVwWTJGc0tUc0tJQ0JqYjI1emRDQnpaV04xY21Wa1UzUmhkSE1nUFNCaGQyRnBkQ0JzYzNSaGRDaGpZVzV2Ym1sallXd3NJSHNnWW1sbmFXNTBPaUIwY25WbElIMHBPd29nSUdGemMyVnlkRkpsWjNWc1lYSlRhVzVuYkdWTWFXNXJLSE5sWTNWeVpXUlRkR0YwY3l3Z1kyRnViMjVwWTJGc0tUc0tJQ0JoYzNObGNuUlFiM05wZUU5M2JtVnljMmhwY0NoelpXTjFjbVZrVTNSaGRITXNJR05oYm05dWFXTmhiQ3dnSW1acGJHVWlLVHNLSUNCeVpYUjFjbTRnZXdvZ0lDQWdjR0YwYURvZ1kyRnViMjVwWTJGc0xBb2dJQ0FnY0dGeVpXNTBMQW9nSUNBZ1pHVjJPaUJ6WldOMWNtVmtVM1JoZEhNdVpHVjJMQW9nSUNBZ2FXNXZPaUJ6WldOMWNtVmtVM1JoZEhNdWFXNXZMQW9nSUNBZ2FXUmxiblJwZEhsTFpYazZJR2xrWlc1MGFYUjVSbkp2YlZOMFlYUnpLSE5sWTNWeVpXUlRkR0YwY3l3Z1kyRnViMjVwWTJGc0tTd0tJQ0I5T3dwOUNncGhjM2x1WXlCbWRXNWpkR2x2YmlCeVpYWmhiR2xrWVhSbFVISmxjR0Z5WldSTWIyTnJLQW9nSUhCeVpYQmhjbVZrTEFvZ0lHTnZiblJsZUhRc0NpQWdleUIyWVd4cFpHRjBaVmRwYm1SdmQzTkJZMndnUFNCbVlXeHpaU0I5SUQwZ2UzMHNDaWtnZXdvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCeVpYQmhjbVZrTG5CaGRHZ3BPd29nSUdOdmJuTjBJSEJoY21WdWRGTjBZWFJ6SUQwZ1lYZGhhWFFnYkhOMFlYUW9jSEpsY0dGeVpXUXVjR0Z5Wlc1MExDQjdJR0pwWjJsdWREb2dkSEoxWlNCOUtUc0tJQ0JwWmlBb0lYQmhjbVZ1ZEZOMFlYUnpMbWx6UkdseVpXTjBiM0o1S0NrZ2ZId2djR0Z5Wlc1MFUzUmhkSE11YVhOVGVXMWliMnhwWTB4cGJtc29LU2tnZXdvZ0lDQWdkR2h5YjNjZ2JtVjNJRVZ5Y205eUtHQmhaMlZ1WXpvZ2JHOWpheUJrWVhSaFltRnpaU0J3WVhKbGJuUWdhWE1nYm04Z2JHOXVaMlZ5SUdFZ2NtVmhiQ0JrYVhKbFkzUnZjbms2SUNSN2NISmxjR0Z5WldRdWNHRnlaVzUwZldBcE93b2dJSDBLSUNCaGMzTmxjblJRYjNOcGVFOTNibVZ5YzJocGNDaHdZWEpsYm5SVGRHRjBjeXdnY0hKbGNHRnlaV1F1Y0dGeVpXNTBMQ0FpY0dGeVpXNTBJaWs3Q2lBZ1kyOXVjM1FnYzNSaGRITWdQU0JoZDJGcGRDQnNjM1JoZENod2NtVndZWEpsWkM1d1lYUm9MQ0I3SUdKcFoybHVkRG9nZEhKMVpTQjlLVHNLSUNCaGMzTmxjblJTWldkMWJHRnlVMmx1WjJ4bFRHbHVheWh6ZEdGMGN5d2djSEpsY0dGeVpXUXVjR0YwYUNrN0NpQWdZWE56WlhKMFVHOXphWGhQZDI1bGNuTm9hWEFvYzNSaGRITXNJSEJ5WlhCaGNtVmtMbkJoZEdnc0lDSm1hV3hsSWlrN0NpQWdhV1lnS0hOMFlYUnpMbVJsZGlBaFBUMGdjSEpsY0dGeVpXUXVaR1YySUh4OElITjBZWFJ6TG1sdWJ5QWhQVDBnY0hKbGNHRnlaV1F1YVc1dktTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJzYjJOcklHUmhkR0ZpWVhObElHbGtaVzUwYVhSNUlHTm9ZVzVuWldRZ1pIVnlhVzVuSUdGamNYVnBjMmwwYVc5dU9pQWtlM0J5WlhCaGNtVmtMbkJoZEdoOVlDazdDaUFnZlFvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBaWQybHVNeklpSUNZbUlIWmhiR2xrWVhSbFYybHVaRzkzYzBGamJDa2dld29nSUNBZ1lYZGhhWFFnWVhOelpYSjBWMmx1Wkc5M2MxQmhkR2hUWldOMWNtbDBlU2hiQ2lBZ0lDQWdJSHNnY0dGMGFEb2djSEpsY0dGeVpXUXVjR0Z5Wlc1MExDQnliMnhsT2lBaWJHVmhaa1JwY21WamRHOXllU0lnZlN3S0lDQWdJQ0FnZXlCd1lYUm9PaUJ3Y21Wd1lYSmxaQzV3WVhSb0xDQnliMnhsT2lBaVptbHNaU0lnZlN3S0lDQWdJRjBzSUdOdmJuUmxlSFFwT3dvZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSW1SaGNuZHBiaUlwSUhzS0lDQWdJR0YzWVdsMElHRnpjMlZ5ZEVSaGNuZHBibEJoZEdoVFpXTjFjbWwwZVNod2NtVndZWEpsWkM1d1lYUm9MQ0FpYkc5amF5QmtZWFJoWW1GelpTQm1hV3hsSWl3Z1kyOXVkR1Y0ZENrN0NpQWdmUW9nSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJSEJ5WlhCaGNtVmtMbkJoZEdncE93cDlDZ3BtZFc1amRHbHZiaUJ3Y21GbmJXRldZV3gxWlNoa1lYUmhZbUZ6WlN3Z2NISmhaMjFoS1NCN0NpQWdZMjl1YzNRZ2NtOTNJRDBnWkdGMFlXSmhjMlV1Y0hKbGNHRnlaU2hnVUZKQlIwMUJJQ1I3Y0hKaFoyMWhmV0FwTG1kbGRDZ3BPd29nSUhKbGRIVnliaUJ5YjNjZ1BUMDlJSFZ1WkdWbWFXNWxaQ0EvSUhWdVpHVm1hVzVsWkNBNklFOWlhbVZqZEM1MllXeDFaWE1vY205M0tWc3dYVHNLZlFvS1puVnVZM1JwYjI0Z2NISmhaMjFoVG5WdFltVnlLR1JoZEdGaVlYTmxMQ0J3Y21GbmJXRXBJSHNLSUNCamIyNXpkQ0IyWVd4MVpTQTlJSEJ5WVdkdFlWWmhiSFZsS0dSaGRHRmlZWE5sTENCd2NtRm5iV0VwT3dvZ0lISmxkSFZ5YmlCMGVYQmxiMllnZG1Gc2RXVWdQVDA5SUNKdWRXMWlaWElpSUQ4Z2RtRnNkV1VnT2lCMWJtUmxabWx1WldRN0NuMEtDbVoxYm1OMGFXOXVJSEJ5WVdkdFlWUmxlSFFvWkdGMFlXSmhjMlVzSUhCeVlXZHRZU2tnZXdvZ0lHTnZibk4wSUhaaGJIVmxJRDBnY0hKaFoyMWhWbUZzZFdVb1pHRjBZV0poYzJVc0lIQnlZV2R0WVNrN0NpQWdjbVYwZFhKdUlIUjVjR1Z2WmlCMllXeDFaU0E5UFQwZ0luTjBjbWx1WnlJZ1B5QjJZV3gxWlM1MGIweHZkMlZ5UTJGelpTZ3BJRG9nZFc1a1pXWnBibVZrT3dwOUNncGxlSEJ2Y25RZ1puVnVZM1JwYjI0Z1kyOXVabWxuZFhKbFRHOWpZV3hUY1d4cGRHVk1iMk5yUTI5dWJtVmpkR2x2Ymloa1lYUmhZbUZ6WlNrZ2V3b2dJR1JoZEdGaVlYTmxMbVY0WldNb0lsQlNRVWROUVNCaWRYTjVYM1JwYldWdmRYUWdQU0F3SWlrN0NpQWdaR0YwWVdKaGMyVXVaWGhsWXlnaVVGSkJSMDFCSUhSeWRYTjBaV1JmYzJOb1pXMWhJRDBnVDBaR0lpazdDaUFnWkdGMFlXSmhjMlV1WlhobFl5Z2lVRkpCUjAxQklITjVibU5vY205dWIzVnpJRDBnUlZoVVVrRWlLVHNLSUNCa1lYUmhZbUZ6WlM1bGJtRmliR1ZFWldabGJuTnBkbVVvZEhKMVpTazdDaUFnWkdGMFlXSmhjMlV1Wlc1aFlteGxURzloWkVWNGRHVnVjMmx2YmlobVlXeHpaU2s3Q2lBZ2FXWWdLQW9nSUNBZ2NISmhaMjFoVG5WdFltVnlLR1JoZEdGaVlYTmxMQ0FpWW5WemVWOTBhVzFsYjNWMElpa2dJVDA5SURBZ2ZId0tJQ0FnSUhCeVlXZHRZVTUxYldKbGNpaGtZWFJoWW1GelpTd2dJblJ5ZFhOMFpXUmZjMk5vWlcxaElpa2dJVDA5SURBZ2ZId0tJQ0FnSUhCeVlXZHRZVTUxYldKbGNpaGtZWFJoWW1GelpTd2dJbk41Ym1Ob2NtOXViM1Z6SWlrZ0lUMDlJRE1LSUNBcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWdpWVdkbGJtTTZJRk5SVEdsMFpTQnNiMk5ySUdOdmJtNWxZM1JwYjI0Z2FHRnlaR1Z1YVc1bklHUnBaQ0J1YjNRZ2RHRnJaU0JsWm1abFkzUWlLVHNLSUNCOUNuMEtDbVoxYm1OMGFXOXVJR2x1YzNCbFkzUk1iMk5yUkdGMFlXSmhjMlVvWkdGMFlXSmhjMlVzSUhCaGRHZ3BJSHNLSUNCamIyNXpkQ0JoY0hCc2FXTmhkR2x2Ymtsa0lEMGdjSEpoWjIxaFRuVnRZbVZ5S0dSaGRHRmlZWE5sTENBaVlYQndiR2xqWVhScGIyNWZhV1FpS1RzS0lDQnBaaUFvWVhCd2JHbGpZWFJwYjI1SlpDQTlQVDBnTUNrZ2V3b2dJQ0FnWTI5dWMzUWdjbTkzSUQwZ1pHRjBZV0poYzJVdWNISmxjR0Z5WlNnS0lDQWdJQ0FnSWxORlRFVkRWQ0JqYjNWdWRDZ3FLU0JCVXlCamIzVnVkQ0JHVWs5TklITnhiR2wwWlY5elkyaGxiV0VnVjBoRlVrVWdibUZ0WlNCT1QxUWdURWxMUlNBbmMzRnNhWFJsWHlVbklpd0tJQ0FnSUNrdVoyVjBLQ2s3Q2lBZ0lDQnBaaUFvY205M1B5NWpiM1Z1ZENBaFBUMGdNQ2tnZXdvZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9DaUFnSUNBZ0lDQWdZR0ZuWlc1ak9pQnlaV1oxYzJsdVp5QjBieUJ5WlhWelpTQmhiaUIxYm5KbGJHRjBaV1FnVTFGTWFYUmxJR1JoZEdGaVlYTmxJR0Z6SUdFZ2JHOWphem9nSkh0d1lYUm9mV0FzQ2lBZ0lDQWdJQ2s3Q2lBZ0lDQjlDaUFnSUNCeVpYUjFjbTRnSW1WdGNIUjVJanNLSUNCOUNpQWdhV1lnS0dGd2NHeHBZMkYwYVc5dVNXUWdJVDA5SUV4UFEwdGZRVkJRVEVsRFFWUkpUMDVmU1VRcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJR3h2WTJzZ1pHRjBZV0poYzJVZ2FHRnpJR0Z1SUdsdVkyOXRjR0YwYVdKc1pTQmhjSEJzYVdOaGRHbHZiaUJwWkRvZ0pIdHdZWFJvZldBcE93b2dJSDBLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYzJOb1pXMWhJRDBnWkdGMFlXSmhjMlV1Y0hKbGNHRnlaU2dLSUNBZ0lDQWdJbE5GVEVWRFZDQjBlWEJsTENCemNXd2dSbEpQVFNCemNXeHBkR1ZmYzJOb1pXMWhJRmRJUlZKRklHNWhiV1VnUFNBbllXZGxibU5mYkc5allXeGZjSEp2WTJWemMxOXNiMk5ySnlJc0NpQWdJQ0FwTG1kbGRDZ3BPd29nSUNBZ1kyOXVjM1FnYjJKcVpXTjBjeUE5SUdSaGRHRmlZWE5sTG5CeVpYQmhjbVVvQ2lBZ0lDQWdJQ0pUUlV4RlExUWdZMjkxYm5Rb0tpa2dRVk1nWTI5MWJuUWdSbEpQVFNCemNXeHBkR1ZmYzJOb1pXMWhJRmRJUlZKRklHNWhiV1VnVGs5VUlFeEpTMFVnSjNOeGJHbDBaVjhsSnlJc0NpQWdJQ0FwTG1kbGRDZ3BPd29nSUNBZ1kyOXVjM1FnY205M2N5QTlJR1JoZEdGaVlYTmxMbkJ5WlhCaGNtVW9DaUFnSUNBZ0lDSlRSVXhGUTFRZ2MybHVaMnhsZEc5dUxDQm1iM0p0WVhSZmRtVnljMmx2YmlCR1VrOU5JR0ZuWlc1algyeHZZMkZzWDNCeWIyTmxjM05mYkc5amF5SXNDaUFnSUNBcExtRnNiQ2dwT3dvZ0lDQWdZMjl1YzNRZ2JtOXliV0ZzYVhwbFpGTmphR1Z0WVNBOUlIUjVjR1Z2WmlCelkyaGxiV0UvTG5OeGJDQTlQVDBnSW5OMGNtbHVaeUlLSUNBZ0lDQWdQeUJ6WTJobGJXRXVjM0ZzTG5KbGNHeGhZMlVvTDF4ekt5OW5MQ0FpSUNJcExuUnlhVzBvS1FvZ0lDQWdJQ0E2SUhWdVpHVm1hVzVsWkRzS0lDQWdJR2xtSUNnS0lDQWdJQ0FnYzJOb1pXMWhQeTUwZVhCbElDRTlQU0FpZEdGaWJHVWlJSHg4Q2lBZ0lDQWdJRzV2Y20xaGJHbDZaV1JUWTJobGJXRWdJVDA5Q2lBZ0lDQWdJQ0FnSWtOU1JVRlVSU0JVUVVKTVJTQmhaMlZ1WTE5c2IyTmhiRjl3Y205alpYTnpYMnh2WTJzZ0tDQnphVzVuYkdWMGIyNGdTVTVVUlVkRlVpQlFVa2xOUVZKWklFdEZXU0JEU0VWRFN5QW9jMmx1WjJ4bGRHOXVJRDBnTVNrc0lHWnZjbTFoZEY5MlpYSnphVzl1SUVsT1ZFVkhSVklnVGs5VUlFNVZURXdnS1NCVFZGSkpRMVFpSUh4OENpQWdJQ0FnSUc5aWFtVmpkSE0vTG1OdmRXNTBJQ0U5UFNBeElIeDhDaUFnSUNBZ0lISnZkM011YkdWdVozUm9JQ0U5UFNBeElIeDhDaUFnSUNBZ0lISnZkM05iTUYwL0xuTnBibWRzWlhSdmJpQWhQVDBnTVNCOGZBb2dJQ0FnSUNCeWIzZHpXekJkUHk1bWIzSnRZWFJmZG1WeWMybHZiaUFoUFQwZ1RFOURTMTlHVDFKTlFWUmZWa1ZTVTBsUFRnb2dJQ0FnS1NCN0NpQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWdpYVc1MllXeHBaQ0J6Wlc1MGFXNWxiQ0J6WTJobGJXRWlLVHNLSUNBZ0lIMEtJQ0I5SUdOaGRHTm9JQ2hsY25KdmNpa2dld29nSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nYkc5amF5QmtZWFJoWW1GelpTQm9ZWE1nWVc0Z2FXNWpiMjF3WVhScFlteGxJR1p2Y20xaGREb2dKSHR3WVhSb2ZXQXNJSHNLSUNBZ0lDQWdZMkYxYzJVNklHVnljbTl5TEFvZ0lDQWdmU2s3Q2lBZ2ZRb2dJSEpsZEhWeWJpQWlkbUZzYVdRaU93cDlDZ3BtZFc1amRHbHZiaUJpZFhONVZISmhibk5wZEdsdmJrVnljbTl5S0hCaGRHZ3NJRzF2WkdVcElIc0tJQ0J5WlhSMWNtNGdUMkpxWldOMExtRnpjMmxuYmlnS0lDQWdJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJRk5SVEdsMFpTQnNiMk5ySUdwdmRYSnVZV3dnYlc5a1pTQnlaVzFoYVc1bFpDQWtlMjF2WkdVZ1B6OGdJblZ1YTI1dmQyNGlmVG9nSkh0d1lYUm9mV0FwTEFvZ0lDQWdleUJsY25KamIyUmxPaUJUVVV4SlZFVmZRbFZUV1NCOUxBb2dJQ2s3Q24wS0NtWjFibU4wYVc5dUlHSmxaMmx1UVc1a1ZtRnNhV1JoZEdWTWIyTnJLR1JoZEdGaVlYTmxMQ0J3WVhSb0xDQmpiMjUwWlhoMEtTQjdDaUFnWm05eUlDaHNaWFFnY0doaGMyVWdQU0F3T3lCd2FHRnpaU0E4SURnN0lIQm9ZWE5sSUNzOUlERXBJSHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnZEhKaGJuTmhZM1JwYjI0Z1ltVm5hVzRnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdaR0YwWVdKaGMyVXVaWGhsWXlnaVFrVkhTVTRnU1UxTlJVUkpRVlJGSWlrN0NpQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElIUnlZVzV6WVdOMGFXOXVJR0psWjJsdUlHTnZiWEJzWlhSbElpazdDaUFnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpVTFGTWFYUmxJR3h2WTJzZ1pHRjBZV0poYzJVZ2FXNXpjR1ZqZEdsdmJpQnpkR0Z5ZEdWa0lpazdDaUFnSUNCamIyNXpkQ0J6ZEdGMFpTQTlJR2x1YzNCbFkzUk1iMk5yUkdGMFlXSmhjMlVvWkdGMFlXSmhjMlVzSUhCaGRHZ3BPd29nSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSWxOUlRHbDBaU0JzYjJOcklHUmhkR0ZpWVhObElHbHVjM0JsWTNScGIyNGdZMjl0Y0d4bGRHVWlLVHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnYW05MWNtNWhiQ0J0YjJSbElHbHVjM0JsWTNScGIyNGdjM1JoY25SbFpDSXBPd29nSUNBZ1kyOXVjM1FnYW05MWNtNWhiRTF2WkdVZ1BTQndjbUZuYldGVVpYaDBLR1JoZEdGaVlYTmxMQ0FpYW05MWNtNWhiRjl0YjJSbElpazdDaUFnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpVTFGTWFYUmxJR3B2ZFhKdVlXd2diVzlrWlNCcGJuTndaV04wYVc5dUlHTnZiWEJzWlhSbElpazdDaUFnSUNCcFppQW9hbTkxY201aGJFMXZaR1VnSVQwOUlDSmtaV3hsZEdVaUtTQjdDaUFnSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnYW05MWNtNWhiQ0J0YjJSbElISmxjMlYwSUhOMFlYSjBaV1FpS1RzS0lDQWdJQ0FnWkdGMFlXSmhjMlV1WlhobFl5Z2lVazlNVEVKQlEwc2lLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVnNaV04wWldRZ1BTQndjbUZuYldGVVpYaDBLR1JoZEdGaVlYTmxMQ0FpYW05MWNtNWhiRjl0YjJSbFBVUkZURVZVUlNJcE93b2dJQ0FnSUNCcFppQW9jMlZzWldOMFpXUWdJVDA5SUNKa1pXeGxkR1VpS1NCMGFISnZkeUJpZFhONVZISmhibk5wZEdsdmJrVnljbTl5S0hCaGRHZ3NJSE5sYkdWamRHVmtLVHNLSUNBZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCcWIzVnlibUZzSUcxdlpHVWdjbVZ6WlhRZ1kyOXRjR3hsZEdVaUtUc0tJQ0FnSUNBZ1kyOXVkR2x1ZFdVN0NpQWdJQ0I5Q2lBZ0lDQnBaaUFvYzNSaGRHVWdQVDA5SUNKbGJYQjBlU0lwSUhzS0lDQWdJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQnNiMk5ySUdSaGRHRmlZWE5sSUdsdWFYUnBZV3hwZW1GMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNBZ0lDQWdaR0YwWVdKaGMyVXVaWGhsWXloZ0NpQWdJQ0FnSUNBZ1VGSkJSMDFCSUdGd2NHeHBZMkYwYVc5dVgybGtJRDBnSkh0TVQwTkxYMEZRVUV4SlEwRlVTVTlPWDBsRWZUc0tJQ0FnSUNBZ0lDQkRVa1ZCVkVVZ1ZFRkNURVVnWVdkbGJtTmZiRzlqWVd4ZmNISnZZMlZ6YzE5c2IyTnJJQ2dLSUNBZ0lDQWdJQ0FnSUhOcGJtZHNaWFJ2YmlCSlRsUkZSMFZTSUZCU1NVMUJVbGtnUzBWWklFTklSVU5MSUNoemFXNW5iR1YwYjI0Z1BTQXhLU3dLSUNBZ0lDQWdJQ0FnSUdadmNtMWhkRjkyWlhKemFXOXVJRWxPVkVWSFJWSWdUazlVSUU1VlRFd0tJQ0FnSUNBZ0lDQXBJRk5VVWtsRFZEc0tJQ0FnSUNBZ0lDQkpUbE5GVWxRZ1NVNVVUeUJoWjJWdVkxOXNiMk5oYkY5d2NtOWpaWE56WDJ4dlkyc2dLSE5wYm1kc1pYUnZiaXdnWm05eWJXRjBYM1psY25OcGIyNHBDaUFnSUNBZ0lDQWdWa0ZNVlVWVElDZ3hMQ0FrZTB4UFEwdGZSazlTVFVGVVgxWkZVbE5KVDA1OUtUc0tJQ0FnSUNBZ0lDQkRUMDFOU1ZRN0NpQWdJQ0FnSUdBcE93b2dJQ0FnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpVTFGTWFYUmxJR3h2WTJzZ1pHRjBZV0poYzJVZ2FXNXBkR2xoYkdsNllYUnBiMjRnWTI5dGNHeGxkR1VpS1RzS0lDQWdJQ0FnWTI5dWRHbHVkV1U3Q2lBZ0lDQjlDaUFnSUNCeVpYUjFjbTQ3Q2lBZ2ZRb2dJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklHeHZZMnNnWkdGMFlXSmhjMlVnYVc1cGRHbGhiR2w2WVhScGIyNGdaR2xrSUc1dmRDQmpiMjUyWlhKblpUb2dKSHR3WVhSb2ZXQXBPd3A5Q2dwbWRXNWpkR2x2YmlCamJHOXpaVVJoZEdGaVlYTmxLR1JoZEdGaVlYTmxLU0I3Q2lBZ2FXWWdLQ0ZrWVhSaFltRnpaVDh1YVhOUGNHVnVLU0J5WlhSMWNtNDdDaUFnWTI5dWMzUWdaWEp5YjNKeklEMGdXMTA3Q2lBZ2RISjVJSHNLSUNBZ0lHbG1JQ2hrWVhSaFltRnpaUzVwYzFSeVlXNXpZV04wYVc5dUtTQmtZWFJoWW1GelpTNWxlR1ZqS0NKU1QweE1Ra0ZEU3lJcE93b2dJSDBnWTJGMFkyZ2dLR1Z5Y205eUtTQjdDaUFnSUNCbGNuSnZjbk11Y0hWemFDaGxjbkp2Y2lrN0NpQWdmUW9nSUhSeWVTQjdDaUFnSUNCa1lYUmhZbUZ6WlM1amJHOXpaU2dwT3dvZ0lIMGdZMkYwWTJnZ0tHVnljbTl5S1NCN0NpQWdJQ0JsY25KdmNuTXVjSFZ6YUNobGNuSnZjaWs3Q2lBZ2ZRb2dJR2xtSUNobGNuSnZjbk11YkdWdVozUm9JRDA5UFNBeEtTQjBhSEp2ZHlCbGNuSnZjbk5iTUYwN0NpQWdhV1lnS0dWeWNtOXljeTVzWlc1bmRHZ2dQaUF4S1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUVdkbmNtVm5ZWFJsUlhKeWIzSW9aWEp5YjNKekxDQWlZV2RsYm1NNklHWmhhV3hsWkNCMGJ5QmpiRzl6WlNCaElHeHZZMkZzSUhCeWIyTmxjM01nYkc5amF5QmtZWFJoWW1GelpTSXBPd29nSUgwS2ZRb0taWGh3YjNKMElHWjFibU4wYVc5dUlHbHpVM0ZzYVhSbFFuVnplVVZ5Y205eUtHVnljbTl5S1NCN0NpQWdjbVYwZFhKdUlIUjVjR1Z2WmlCbGNuSnZjajh1WlhKeVkyOWtaU0E5UFQwZ0ltNTFiV0psY2lJZ0ppWUtJQ0FnSUNobGNuSnZjaTVsY25KamIyUmxJQ1lnTUhobVppa2dQVDA5SUZOUlRFbFVSVjlDVlZOWk93cDlDZ3BoYzNsdVl5Qm1kVzVqZEdsdmJpQjNZV2wwUm05eVFuVnplVkpsZEhKNUtHTnZiblJsZUhRc0lIQmhkR2dzSUdGMGRHVnRjSFFzSUdOaGRYTmxLU0I3Q2lBZ1kyOXVjM1FnY21WdFlXbHVhVzVuSUQwZ2NtVnRZV2x1YVc1blRXbHNiR2x6WldOdmJtUnpLR052Ym5SbGVIUXBPd29nSUdsbUlDaHlaVzFoYVc1cGJtY2dQRDBnTUNrZ2RHaHliM2NnZEdsdFpXOTFkRVZ5Y205eUtHTnZiblJsZUhRc0lIQmhkR2dzSUdOaGRYTmxLVHNLSUNCamIyNXpkQ0JsZUhCdmJtVnVkR2xoYkVOaGNDQTlJRTFoZEdndWJXbHVLRTFCV0Y5Q1ZWTlpYMUpGVkZKWlgwMVRMQ0F5SUNvcUlFMWhkR2d1YldsdUtHRjBkR1Z0Y0hRc0lEWXBLVHNLSUNCamIyNXpkQ0JxYVhSMFpYSWdQU0JOWVhSb0xtMWhlQ2d4TENCTllYUm9MbVpzYjI5eUtFMWhkR2d1Y21GdVpHOXRLQ2tnS2lBb1pYaHdiMjVsYm5ScFlXeERZWEFnS3lBeEtTa3BPd29nSUdOdmJuTjBJSGRoYVhSTmN5QTlJRTFoZEdndWJXbHVLSEpsYldGcGJtbHVaeXdnYW1sMGRHVnlLVHNLSUNCamIyNXpkQ0J6YVdkdVlXd2dQU0JqYjI1MFpYaDBMbkpsZEhKNVYyRnJaVk5wWjI1aGJEc0tJQ0JwWmlBb2MybG5ibUZzSUQwOVBTQjFibVJsWm1sdVpXUWdmSHdnWTI5dWRHVjRkQzV5WlhSeWVWZGhhMlZEYjI1emRXMWxaQ2tnZXdvZ0lDQWdZWGRoYVhRZ1pHVnNZWGtvZDJGcGRFMXpLVHNLSUNCOUlHVnNjMlVnZXdvZ0lDQWdMeThnUVNCb2FXNTBJRzl1YkhrZ2MyaHZjblJsYm5NZ2IyNWxJSE5zWldWd0xpQlVhR1VnYm1WNGRDQmhkSFJsYlhCMElHMTFjM1FnYzNScGJHd2dkbUZzYVdSaGRHVUtJQ0FnSUM4dklIUm9aU0J3WVhSb0lHRnVaQ0JoWTNGMWFYSmxJSFJvWlNCVFVVeHBkR1VnZEhKaGJuTmhZM1JwYjI0Z1lXZGhhVzV6ZENCMGFHVWdjMkZ0WlNCa1pXRmtiR2x1WlM0S0lDQWdJR3hsZENCMGFXMWxjanNLSUNBZ0lHeGxkQ0IzWVd0bE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1lYZGhhWFFnYm1WM0lGQnliMjFwYzJVb0tISmxjMjlzZG1VcElEMCtJSHNLSUNBZ0lDQWdJQ0IzWVd0bElEMGdLQ2tnUFQ0Z2V3b2dJQ0FnSUNBZ0lDQWdZMjl1ZEdWNGRDNXlaWFJ5ZVZkaGEyVkRiMjV6ZFcxbFpDQTlJSFJ5ZFdVN0NpQWdJQ0FnSUNBZ0lDQnlaWE52YkhabEtDazdDaUFnSUNBZ0lDQWdmVHNLSUNBZ0lDQWdJQ0IwYVcxbGNpQTlJSE5sZEZScGJXVnZkWFFvY21WemIyeDJaU3dnZDJGcGRFMXpLVHNLSUNBZ0lDQWdJQ0J6YVdkdVlXd3VZV1JrUlhabGJuUk1hWE4wWlc1bGNpZ2lZV0p2Y25RaUxDQjNZV3RsTENCN0lHOXVZMlU2SUhSeWRXVWdmU2s3Q2lBZ0lDQWdJQ0FnTHk4Z1EyOTJaWEp6SUhKbFlXUnBibVZ6Y3lCaVpXWnZjbVVnYzNWaWMyTnlhWEIwYVc5dUlHRnpJSGRsYkd3Z1lYTWdZbVZtYjNKbElHRmpjWFZwYzJsMGFXOXVMZ29nSUNBZ0lDQWdJR2xtSUNoemFXZHVZV3d1WVdKdmNuUmxaQ2tnZDJGclpTZ3BPd29nSUNBZ0lDQWdJSEpsY0c5eWRGQnliMmR5WlhOektHTnZiblJsZUhRc0lDSlRVVXhwZEdVZ1luVnplU0J5WlhSeWVTQjNZV2wwSUhOMFlYSjBaV1FpS1RzS0lDQWdJQ0FnZlNrN0NpQWdJQ0I5SUdacGJtRnNiSGtnZXdvZ0lDQWdJQ0JqYkdWaGNsUnBiV1Z2ZFhRb2RHbHRaWElwT3dvZ0lDQWdJQ0JwWmlBb2QyRnJaU0FoUFQwZ2RXNWtaV1pwYm1Wa0tTQnphV2R1WVd3dWNtVnRiM1psUlhabGJuUk1hWE4wWlc1bGNpZ2lZV0p2Y25RaUxDQjNZV3RsS1RzS0lDQWdJSDBLSUNCOUNpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NHRjBhQ3dnWTJGMWMyVXBPd3A5Q2dwaGMzbHVZeUJtZFc1amRHbHZiaUJoWTNGMWFYSmxVM0ZzYVhSbFJHRjBZV0poYzJVb1JHRjBZV0poYzJWVGVXNWpMQ0J3Y21Wd1lYSmxaQ3dnWTI5dWRHVjRkQ2tnZXdvZ0lHeGxkQ0JoZEhSbGJYQjBJRDBnTURzS0lDQnNaWFFnYkdGemRFSjFjM2s3Q2lBZ2QyaHBiR1VnS0hSeWRXVXBJSHNLSUNBZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCeVpYQmhjbVZrTG5CaGRHZ3NJR3hoYzNSQ2RYTjVLVHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnY0hKbExXOXdaVzRnYkc5amF5QjJZV3hwWkdGMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNBZ0lHRjNZV2wwSUhKbGRtRnNhV1JoZEdWUWNtVndZWEpsWkV4dlkyc29jSEpsY0dGeVpXUXNJR052Ym5SbGVIUXNJSHNLSUNBZ0lDQWdMeThnVkdobElHTnlaV0YwYVc5dUlIQmhkR2dnWVd4eVpXRmtlU0IyWVd4cFpHRjBaV1FnZEdobElHTnZiWEJzWlhSbElHRnVZMlZ6ZEc5eUlHTm9ZV2x1SUdGdVpBb2dJQ0FnSUNBdkx5QjBhR1VnWlhoaFkzUWdjR0Z5Wlc1MEwyWnBiR1VnUVVOTWN5NGdVbVYyWVd4cFpHRjBaU0JCUTB4eklHRm1kR1Z5SUdOdmJuUmxiblJwYjI0Z1ltVmpZWFZ6WlFvZ0lDQWdJQ0F2THlCaGJtOTBhR1Z5SUdodmJHUmxjaUJoYm1RZ1lXNGdkVzVpYjNWdVpHVmtJR2x1ZEdWeWRtRnNJR2hoZG1VZ1kzSnZjM05sWkNCMGFHbHpJR0YwZEdWdGNIUXVDaUFnSUNBZ0lIWmhiR2xrWVhSbFYybHVaRzkzYzBGamJEb2dZWFIwWlcxd2RDQStJREFzQ2lBZ0lDQjlLVHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnY0hKbExXOXdaVzRnYkc5amF5QjJZV3hwWkdGMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ0lDQnNaWFFnWkdGMFlXSmhjMlU3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElHUmhkR0ZpWVhObElHOXdaVzRnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdJQ0JrWVhSaFltRnpaU0E5SUc1bGR5QkVZWFJoWW1GelpWTjVibU1vY0hKbGNHRnlaV1F1Y0dGMGFDd2dld29nSUNBZ0lDQWdJR0ZzYkc5M1JYaDBaVzV6YVc5dU9pQm1ZV3h6WlN3S0lDQWdJQ0FnSUNCMGFXMWxiM1YwT2lBd0xBb2dJQ0FnSUNCOUtUc0tJQ0FnSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSWxOUlRHbDBaU0JrWVhSaFltRnpaU0J2Y0dWdUlHTnZiWEJzWlhSbElpazdDaUFnSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnWTI5dWJtVmpkR2x2YmlCb1lYSmtaVzVwYm1jZ2MzUmhjblJsWkNJcE93b2dJQ0FnSUNCamIyNW1hV2QxY21WTWIyTmhiRk54YkdsMFpVeHZZMnREYjI1dVpXTjBhVzl1S0dSaGRHRmlZWE5sS1RzS0lDQWdJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQmpiMjV1WldOMGFXOXVJR2hoY21SbGJtbHVaeUJqYjIxd2JHVjBaU0lwT3dvZ0lDQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElIQnZjM1F0YjNCbGJpQnNiMk5ySUhaaGJHbGtZWFJwYjI0Z2MzUmhjblJsWkNJcE93b2dJQ0FnSUNCaGQyRnBkQ0J5WlhaaGJHbGtZWFJsVUhKbGNHRnlaV1JNYjJOcktIQnlaWEJoY21Wa0xDQmpiMjUwWlhoMEtUc0tJQ0FnSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSWxOUlRHbDBaU0J3YjNOMExXOXdaVzRnYkc5amF5QjJZV3hwWkdGMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ0lDQWdJR0psWjJsdVFXNWtWbUZzYVdSaGRHVk1iMk5yS0dSaGRHRmlZWE5sTENCd2NtVndZWEpsWkM1d1lYUm9MQ0JqYjI1MFpYaDBLVHNLSUNBZ0lDQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NISmxjR0Z5WldRdWNHRjBhQ3dnYkdGemRFSjFjM2twT3dvZ0lDQWdJQ0J5WlhSMWNtNGdaR0YwWVdKaGMyVTdDaUFnSUNCOUlHTmhkR05vSUNobGNuSnZjaWtnZXdvZ0lDQWdJQ0JqYjI1emRDQmpiR1ZoYm5Wd1JYSnliM0p6SUQwZ1cxMDdDaUFnSUNBZ0lHbG1JQ2hrWVhSaFltRnpaU0FoUFQwZ2RXNWtaV1pwYm1Wa0tTQjdDaUFnSUNBZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnSUNBZ0lHTnNiM05sUkdGMFlXSmhjMlVvWkdGMFlXSmhjMlVwT3dvZ0lDQWdJQ0FnSUgwZ1kyRjBZMmdnS0dOc1pXRnVkWEJGY25KdmNpa2dld29nSUNBZ0lDQWdJQ0FnWTJ4bFlXNTFjRVZ5Y205eWN5NXdkWE5vS0dOc1pXRnVkWEJGY25KdmNpazdDaUFnSUNBZ0lDQWdmUW9nSUNBZ0lDQjlDaUFnSUNBZ0lHbG1JQ2hqYkdWaGJuVndSWEp5YjNKekxteGxibWQwYUNBK0lEQXBJSHNLSUNBZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUVdkbmNtVm5ZWFJsUlhKeWIzSW9DaUFnSUNBZ0lDQWdJQ0JiWlhKeWIzSXNJQzR1TG1Oc1pXRnVkWEJGY25KdmNuTmRMQW9nSUNBZ0lDQWdJQ0FnWUdGblpXNWpPaUJzYjJOcklHRjBkR1Z0Y0hRZ1lXNWtJR05zWldGdWRYQWdZbTkwYUNCbVlXbHNaV1FnWm05eUlDUjdjSEpsY0dGeVpXUXVjR0YwYUgxZ0xBb2dJQ0FnSUNBZ0lDazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2FXWWdLQ0ZwYzFOeGJHbDBaVUoxYzNsRmNuSnZjaWhsY25KdmNpa3BJSFJvY205M0lHVnljbTl5T3dvZ0lDQWdJQ0JzWVhOMFFuVnplU0E5SUdWeWNtOXlPd29nSUNBZ0lDQmhkSFJsYlhCMElDczlJREU3Q2lBZ0lDQWdJR0YzWVdsMElIZGhhWFJHYjNKQ2RYTjVVbVYwY25rb1kyOXVkR1Y0ZEN3Z2NISmxjR0Z5WldRdWNHRjBhQ3dnWVhSMFpXMXdkQ3dnYkdGemRFSjFjM2twT3dvZ0lDQWdmUW9nSUgwS2ZRb0tablZ1WTNScGIyNGdjbVZzWldGelpVRmpjWFZwY21Wa0tHRmpjWFZwY21Wa0xDQnNZV0psYkNrZ2V3b2dJR052Ym5OMElHVnljbTl5Y3lBOUlGdGRPd29nSUdadmNpQW9ZMjl1YzNRZ2FYUmxiU0J2WmlCaFkzRjFhWEpsWkM1MGIxSmxkbVZ5YzJWa0tDa3BJSHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR05zYjNObFJHRjBZV0poYzJVb2FYUmxiUzVrWVhSaFltRnpaU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxjbkp2Y2lrZ2V3b2dJQ0FnSUNCbGNuSnZjbk11Y0hWemFDaGxjbkp2Y2lrN0NpQWdJQ0I5Q2lBZ0lDQnBaaUFvS0NGcGRHVnRMbVJoZEdGaVlYTmxJSHg4SUNGcGRHVnRMbVJoZEdGaVlYTmxMbWx6VDNCbGJpa2dKaVlnSVdsMFpXMHVhVzVRY205alpYTnpVbVZzWldGelpXUXBJSHNLSUNBZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnSUNCcGRHVnRMbkpsYkdWaGMyVkpibEJ5YjJObGMzTW9LVHNLSUNBZ0lDQWdJQ0JwZEdWdExtbHVVSEp2WTJWemMxSmxiR1ZoYzJWa0lEMGdkSEoxWlRzS0lDQWdJQ0FnZlNCallYUmphQ0FvWlhKeWIzSXBJSHNLSUNBZ0lDQWdJQ0JsY25KdmNuTXVjSFZ6YUNobGNuSnZjaWs3Q2lBZ0lDQWdJSDBLSUNBZ0lIMEtJQ0I5Q2lBZ2FXWWdLR1Z5Y205eWN5NXNaVzVuZEdnZ1BUMDlJREVwSUhSb2NtOTNJR1Z5Y205eWMxc3dYVHNLSUNCcFppQW9aWEp5YjNKekxteGxibWQwYUNBK0lERXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkJaMmR5WldkaGRHVkZjbkp2Y2lobGNuSnZjbk1zSUdCaFoyVnVZem9nSkh0c1lXSmxiSDBnYkc5amF5QnlaV3hsWVhObElHWmhhV3hsWkdBcE93b2dJSDBLZlFvS1pYaHdiM0owSUdGemVXNWpJR1oxYm1OMGFXOXVJR0ZqY1hWcGNtVk1iMk5oYkZOeGJHbDBaVXh2WTJ0ektBb2dJSEpsY1hWbGMzUmxaRkJoZEdoekxBb2dJSHNLSUNBZ0lIUnBiV1Z2ZFhSTmN5QTlJRFl3WHpBd01Dd0tJQ0FnSUd4aFltVnNJRDBnSWtGblpXNURJRzl3WlhKaGRHbHZiaUlzQ2lBZ0lDQmtaV0ZrYkdsdVpUb2djM1Z3Y0d4cFpXUkVaV0ZrYkdsdVpTd0tJQ0FnSUc5dVVISnZaM0psYzNNc0NpQWdJQ0J5WlhSeWVWZGhhMlZUYVdkdVlXd3NDaUFnZlNBOUlIdDlMQW9wSUhzS0lDQnBaaUFvSVU1MWJXSmxjaTVwYzFOaFptVkpiblJsWjJWeUtIUnBiV1Z2ZFhSTmN5a2dmSHdnZEdsdFpXOTFkRTF6SUR3OUlEQXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QlVlWEJsUlhKeWIzSW9JbXh2WTJzZ2RHbHRaVzkxZEUxeklHMTFjM1FnWW1VZ1lTQndiM05wZEdsMlpTQnpZV1psSUdsdWRHVm5aWElpS1RzS0lDQjlDaUFnYVdZZ0tITjFjSEJzYVdWa1JHVmhaR3hwYm1VZ0lUMDlJSFZ1WkdWbWFXNWxaQ0FtSmlBaFRuVnRZbVZ5TG1selJtbHVhWFJsS0hOMWNIQnNhV1ZrUkdWaFpHeHBibVVwS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnVkhsd1pVVnljbTl5S0NKc2IyTnJJR1JsWVdSc2FXNWxJRzExYzNRZ1ltVWdabWx1YVhSbElpazdDaUFnZlFvZ0lHbG1JQ2doUVhKeVlYa3VhWE5CY25KaGVTaHlaWEYxWlhOMFpXUlFZWFJvY3lrcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCVWVYQmxSWEp5YjNJb0lteHZZMnNnY0dGMGFITWdiWFZ6ZENCaVpTQmhiaUJoY25KaGVTSXBPd29nSUgwS0lDQnBaaUFvYjI1UWNtOW5jbVZ6Y3lBaFBUMGdkVzVrWldacGJtVmtJQ1ltSUhSNWNHVnZaaUJ2YmxCeWIyZHlaWE56SUNFOVBTQWlablZ1WTNScGIyNGlLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dWSGx3WlVWeWNtOXlLQ0pzYjJOcklHOXVVSEp2WjNKbGMzTWdiWFZ6ZENCaVpTQmhJR1oxYm1OMGFXOXVJaWs3Q2lBZ2ZRb2dJR2xtSUNoeVpYUnllVmRoYTJWVGFXZHVZV3dnSVQwOUlIVnVaR1ZtYVc1bFpDQW1KaUFoS0hKbGRISjVWMkZyWlZOcFoyNWhiQ0JwYm5OMFlXNWpaVzltSUVGaWIzSjBVMmxuYm1Gc0tTa2dld29nSUNBZ2RHaHliM2NnYm1WM0lGUjVjR1ZGY25KdmNpZ2liRzlqYXlCeVpYUnllVmRoYTJWVGFXZHVZV3dnYlhWemRDQmlaU0JoYmlCQlltOXlkRk5wWjI1aGJDSXBPd29nSUgwS0lDQnBaaUFvY21WeGRXVnpkR1ZrVUdGMGFITXViR1Z1WjNSb0lEMDlQU0F3S1NCeVpYUjFjbTRnS0NrZ1BUNGdlMzA3Q2dvZ0lHTnZibk4wSUhOMFlYSjBaV1JCZENBOUlIQmxjbVp2Y20xaGJtTmxMbTV2ZHlncE93b2dJR052Ym5OMElHTnZiblJsZUhRZ1BTQjdDaUFnSUNCa1pXRmtiR2x1WlRvZ1RXRjBhQzV0YVc0b0NpQWdJQ0FnSUhOMWNIQnNhV1ZrUkdWaFpHeHBibVVnUHo4Z1RuVnRZbVZ5TGxCUFUwbFVTVlpGWDBsT1JrbE9TVlJaTEFvZ0lDQWdJQ0J6ZEdGeWRHVmtRWFFnS3lCMGFXMWxiM1YwVFhNc0NpQWdJQ0FwTEFvZ0lDQWdiR0ZpWld3c0NpQWdJQ0IwYVcxbGIzVjBUWE1zQ2lBZ0lDQnZibEJ5YjJkeVpYTnpMQW9nSUNBZ2NtVjBjbmxYWVd0bFUybG5ibUZzTEFvZ0lDQWdjbVYwY25sWFlXdGxRMjl1YzNWdFpXUTZJR1poYkhObExBb2dJSDA3Q2lBZ1kyOXVjM1FnWm1seWMzUkVhWE53YkdGNVVHRjBhQ0E5SUhKbGMyOXNkbVVvY21WeGRXVnpkR1ZrVUdGMGFITmJNRjBwT3dvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUdacGNuTjBSR2x6Y0d4aGVWQmhkR2dwT3dvS0lDQmpiMjV6ZENCd2NtVndZWEpsWkVKNVNXUmxiblJwZEhrZ1BTQnVaWGNnVFdGd0tDazdDaUFnWm05eUlDaGpiMjV6ZENCeVpYRjFaWE4wWldSUVlYUm9JRzltSUhKbGNYVmxjM1JsWkZCaGRHaHpLU0I3Q2lBZ0lDQjBhSEp2ZDBsbVJYaHdhWEpsWkNoamIyNTBaWGgwTENCeVpYTnZiSFpsS0hKbGNYVmxjM1JsWkZCaGRHZ3BLVHNLSUNBZ0lHTnZibk4wSUhCeVpYQmhjbVZrSUQwZ1lYZGhhWFFnY0hKbGNHRnlaVXh2WTJ0UVlYUm9LSEpsY1hWbGMzUmxaRkJoZEdnc0lHTnZiblJsZUhRcE93b2dJQ0FnY0hKbGNHRnlaV1JDZVVsa1pXNTBhWFI1TG5ObGRDaHdjbVZ3WVhKbFpDNXBaR1Z1ZEdsMGVVdGxlU3dnY0hKbGNHRnlaV1FwT3dvZ0lIMEtJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWliRzlqYXlCd1lYUm9JSEJ5WlhCaGNtRjBhVzl1SUdOdmJYQnNaWFJsSWlrN0NpQWdZMjl1YzNRZ2NISmxjR0Z5WldSTWIyTnJjeUE5SUZzdUxpNXdjbVZ3WVhKbFpFSjVTV1JsYm5ScGRIa3VkbUZzZFdWektDbGRMbk52Y25Rb0tHeGxablFzSUhKcFoyaDBLU0E5UGdvZ0lDQWdiR1ZtZEM1cFpHVnVkR2wwZVV0bGVTQThJSEpwWjJoMExtbGtaVzUwYVhSNVMyVjVJRDhnTFRFZ09pQnNaV1owTG1sa1pXNTBhWFI1UzJWNUlENGdjbWxuYUhRdWFXUmxiblJwZEhsTFpYa2dQeUF4SURvZ01DazdDaUFnWTI5dWMzUWdjR1Z1WkdsdVoweHZZMkZzSUQwZ1cxMDdDaUFnWTI5dWMzUWdZV054ZFdseVpXUWdQU0JiWFRzS0lDQnNaWFFnWTNWeWNtVnVkRkJoZEdnZ1BTQndjbVZ3WVhKbFpFeHZZMnR6V3pCZFB5NXdZWFJvSUQ4L0lHWnBjbk4wUkdsemNHeGhlVkJoZEdnN0NpQWdkSEo1SUhzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnY0hKbGNHRnlaV1FnYjJZZ2NISmxjR0Z5WldSTWIyTnJjeWtnZXdvZ0lDQWdJQ0JqZFhKeVpXNTBVR0YwYUNBOUlIQnlaWEJoY21Wa0xuQmhkR2c3Q2lBZ0lDQWdJR052Ym5OMElISmxiR1ZoYzJVZ1BTQmhkMkZwZENCaFkzRjFhWEpsU1c1UWNtOWpaWE56VEc5amF5aHdjbVZ3WVhKbFpDd2dZMjl1ZEdWNGRDazdDaUFnSUNBZ0lIQmxibVJwYm1kTWIyTmhiQzV3ZFhOb0tIc2djSEpsY0dGeVpXUXNJSEpsYkdWaGMyVWdmU2s3Q2lBZ0lDQjlDaUFnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpYVc0dGNISnZZMlZ6Y3lCc2IyTnJJR0ZqY1hWcGMybDBhVzl1SUdOdmJYQnNaWFJsSWlrN0NpQWdJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQmpkWEp5Wlc1MFVHRjBhQ2s3Q2lBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUcxdlpIVnNaU0JwYlhCdmNuUWdjM1JoY25SbFpDSXBPd29nSUNBZ1kyOXVjM1FnZXlCRVlYUmhZbUZ6WlZONWJtTWdmU0E5SUdGM1lXbDBJR2x0Y0c5eWRDZ2libTlrWlRwemNXeHBkR1VpS1RzS0lDQWdJSEpsY0c5eWRGQnliMmR5WlhOektHTnZiblJsZUhRc0lDSlRVVXhwZEdVZ2JXOWtkV3hsSUdsdGNHOXlkQ0JqYjIxd2JHVjBaU0lwT3dvZ0lDQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1kzVnljbVZ1ZEZCaGRHZ3BPd29nSUNBZ1ptOXlJQ2hqYjI1emRDQjdJSEJ5WlhCaGNtVmtMQ0J5Wld4bFlYTmxJSDBnYjJZZ2NHVnVaR2x1WjB4dlkyRnNLU0I3Q2lBZ0lDQWdJR04xY25KbGJuUlFZWFJvSUQwZ2NISmxjR0Z5WldRdWNHRjBhRHNLSUNBZ0lDQWdZMjl1YzNRZ2FYUmxiU0E5SUhzS0lDQWdJQ0FnSUNCa1lYUmhZbUZ6WlRvZ2RXNWtaV1pwYm1Wa0xBb2dJQ0FnSUNBZ0lISmxiR1ZoYzJWSmJsQnliMk5sYzNNNklISmxiR1ZoYzJVc0NpQWdJQ0FnSUNBZ2FXNVFjbTlqWlhOelVtVnNaV0Z6WldRNklHWmhiSE5sTEFvZ0lDQWdJQ0I5T3dvZ0lDQWdJQ0JoWTNGMWFYSmxaQzV3ZFhOb0tHbDBaVzBwT3dvZ0lDQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElIUnlZVzV6WVdOMGFXOXVJR0ZqY1hWcGMybDBhVzl1SUhOMFlYSjBaV1FpS1RzS0lDQWdJQ0FnYVhSbGJTNWtZWFJoWW1GelpTQTlJR0YzWVdsMElHRmpjWFZwY21WVGNXeHBkR1ZFWVhSaFltRnpaU2hFWVhSaFltRnpaVk41Ym1Nc0lIQnlaWEJoY21Wa0xDQmpiMjUwWlhoMEtUc0tJQ0FnSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSWxOUlRHbDBaU0IwY21GdWMyRmpkR2x2YmlCaFkzRjFhWE5wZEdsdmJpQmpiMjF3YkdWMFpTSXBPd29nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dLR1Z5Y205eUtTQjdDaUFnSUNCamIyNXpkQ0JqYkdWaGJuVndSWEp5YjNKeklEMGdXMTA3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0J5Wld4bFlYTmxRV054ZFdseVpXUW9ZV054ZFdseVpXUXNJR3hoWW1Wc0tUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dOc1pXRnVkWEJGY25KdmNpa2dld29nSUNBZ0lDQmpiR1ZoYm5Wd1JYSnliM0p6TG5CMWMyZ29ZMnhsWVc1MWNFVnljbTl5S1RzS0lDQWdJSDBLSUNBZ0lHWnZjaUFvWTI5dWMzUWdleUJ5Wld4bFlYTmxJSDBnYjJZZ2NHVnVaR2x1WjB4dlkyRnNMbk5zYVdObEtHRmpjWFZwY21Wa0xteGxibWQwYUNrdWRHOVNaWFpsY25ObFpDZ3BLU0I3Q2lBZ0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUNBZ2NtVnNaV0Z6WlNncE93b2dJQ0FnSUNCOUlHTmhkR05vSUNoamJHVmhiblZ3UlhKeWIzSXBJSHNLSUNBZ0lDQWdJQ0JqYkdWaGJuVndSWEp5YjNKekxuQjFjMmdvWTJ4bFlXNTFjRVZ5Y205eUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnZlFvZ0lDQWdZMjl1YzNRZ1ptOXliV0YwZEdWa0lEMGdhWE5UY1d4cGRHVkNkWE41UlhKeWIzSW9aWEp5YjNJcENpQWdJQ0FnSUQ4Z2RHbHRaVzkxZEVWeWNtOXlLR052Ym5SbGVIUXNJR04xY25KbGJuUlFZWFJvTENCbGNuSnZjaWtLSUNBZ0lDQWdPaUJsY25KdmNqc0tJQ0FnSUdsbUlDaGpiR1ZoYm5Wd1JYSnliM0p6TG14bGJtZDBhQ0ErSURBcElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFRm5aM0psWjJGMFpVVnljbTl5S0FvZ0lDQWdJQ0FnSUZ0bWIzSnRZWFIwWldRc0lDNHVMbU5zWldGdWRYQkZjbkp2Y25OZExBb2dJQ0FnSUNBZ0lHQmhaMlZ1WXpvZ0pIdHNZV0psYkgwZ2JHOWpheUJoWTNGMWFYTnBkR2x2YmlCaGJtUWdjbTlzYkdKaFkyc2dZbTkwYUNCbVlXbHNaV1JnTEFvZ0lDQWdJQ0FwT3dvZ0lDQWdmUW9nSUNBZ2RHaHliM2NnWm05eWJXRjBkR1ZrT3dvZ0lIMEtDaUFnYkdWMElISmxiR1ZoYzJWa0lEMGdabUZzYzJVN0NpQWdjbVYwZFhKdUlDZ3BJRDArSUhzS0lDQWdJR2xtSUNoeVpXeGxZWE5sWkNrZ2NtVjBkWEp1T3dvZ0lDQWdjbVZzWldGelpVRmpjWFZwY21Wa0tHRmpjWFZwY21Wa0xDQnNZV0psYkNrN0NpQWdJQ0J5Wld4bFlYTmxaQ0E5SUdGamNYVnBjbVZrTG1WMlpYSjVLQ2hwZEdWdEtTQTlQaUJwZEdWdExtbHVVSEp2WTJWemMxSmxiR1ZoYzJWa0tUc0tJQ0I5T3dwOUNncGxlSEJ2Y25RZ1lYTjVibU1nWm5WdVkzUnBiMjRnWVdOeGRXbHlaVXh2WTJGc1UzRnNhWFJsVEc5amF5aHdZWFJvTENCdmNIUnBiMjV6S1NCN0NpQWdjbVYwZFhKdUlHRmpjWFZwY21WTWIyTmhiRk54YkdsMFpVeHZZMnR6S0Z0d1lYUm9YU3dnYjNCMGFXOXVjeWs3Q24wSyI7Cgpjb25zdCB2ZXJzaW9uUGF0dGVybiA9IC9eXGQrXC5cZCtcLlxkKyg/Oi1bMC05QS1aYS16Li1dKyk/JC87CmZ1bmN0aW9uIHByaXZhdGVEaXJlY3RvcnkocGF0aCwgcmVwYWlyV3JpdGFibGUgPSBmYWxzZSkgewogIG1rZGlyU3luYyhwYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgbW9kZTogMG83MDAgfSk7CiAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhwYXRoKTsKICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkoKSB8fCBzdGF0LmlzU3ltYm9saWNMaW5rKCkgfHwgcmVhbHBhdGhTeW5jKHBhdGgpICE9PSBwYXRoIHx8CiAgICAgIHN0YXQudWlkICE9PSBwcm9jZXNzLmdldHVpZCgpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHJ1bnRpbWUgbWFpbnRlbmFuY2UgZGlyZWN0b3J5IGlzIHVuc2FmZTogJHtwYXRofWApOwogIH0KICBpZiAoKHN0YXQubW9kZSAmIDBvMDIyKSAhPT0gMCkgewogICAgaWYgKCFyZXBhaXJXcml0YWJsZSkgdGhyb3cgbmV3IEVycm9yKGBydW50aW1lIG1haW50ZW5hbmNlIGRpcmVjdG9yeSBpcyB3cml0YWJsZTogJHtwYXRofWApOwogICAgY29uc3QgZmQgPSBvcGVuU3luYyhwYXRoLCBjb25zdGFudHMuT19SRE9OTFkgfCBjb25zdGFudHMuT19ESVJFQ1RPUlkgfCBjb25zdGFudHMuT19OT0ZPTExPVyk7CiAgICB0cnkgewogICAgICBjb25zdCBvcGVuZWQgPSBmc3RhdFN5bmMoZmQpOwogICAgICBpZiAob3BlbmVkLmRldiAhPT0gc3RhdC5kZXYgfHwgb3BlbmVkLmlubyAhPT0gc3RhdC5pbm8pIHRocm93IG5ldyBFcnJvcigibWFpbnRlbmFuY2UgZGlyZWN0b3J5IGlkZW50aXR5IGNoYW5nZWQiKTsKICAgICAgZmNobW9kU3luYyhmZCwgMG83MDApOwogICAgfSBmaW5hbGx5IHsgY2xvc2VTeW5jKGZkKTsgfQogIH0KfQpmdW5jdGlvbiBhdG9taWNKc29uKHBhdGgsIHZhbHVlKSB7CiAgY29uc3QgdGVtcG9yYXJ5ID0gYCR7cGF0aH0uJHtwcm9jZXNzLnBpZH0tJHtyYW5kb21VVUlEKCl9YDsKICB0cnkgewogICAgY29uc3QgZmQgPSBvcGVuU3luYyh0ZW1wb3JhcnksICJ3eCIsIDBvNjAwKTsKICAgIHRyeSB7IHdyaXRlRmlsZVN5bmMoZmQsIEpTT04uc3RyaW5naWZ5KHZhbHVlKSArICJcbiIpOyBmc3luY1N5bmMoZmQpOyB9CiAgICBmaW5hbGx5IHsgY2xvc2VTeW5jKGZkKTsgfQogICAgcmVuYW1lU3luYyh0ZW1wb3JhcnksIHBhdGgpOwogICAgY29uc3QgcGFyZW50ID0gb3BlblN5bmMoZGlybmFtZShwYXRoKSwgInIiKTsKICAgIHRyeSB7IGZzeW5jU3luYyhwYXJlbnQpOyB9IGZpbmFsbHkgeyBjbG9zZVN5bmMocGFyZW50KTsgfQogIH0gZmluYWxseSB7IHJtU3luYyh0ZW1wb3JhcnksIHsgZm9yY2U6IHRydWUgfSk7IH0KfQpmdW5jdGlvbiBsaXZlKHBpZCkgewogIHRyeSB7IHByb2Nlc3Mua2lsbChwaWQsIDApOyByZXR1cm4gdHJ1ZTsgfQogIGNhdGNoIChlcnJvcikgeyByZXR1cm4gZXJyb3IuY29kZSAhPT0gIkVTUkNIIjsgfQp9CgovLyBUaGUgc2FtZSBsb2NrIHNlcmlhbGl6ZXMgbGVhc2UgY3JlYXRpb24gYW5kIGNsZWFudXAuIEEgbGVhc2Ugc3BhbnMgbmV0d29yawovLyBkb3dubG9hZCwgdmVyaWZpY2F0aW9uLCBleHRyYWN0aW9uIGFuZCBhY3RpdmF0aW9uLCBpbmNsdWRpbmcgdGhlaXIgbG9jayBnYXBzLgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYmVnaW5SdW50aW1lVXBkYXRlKGhvbWUsIHBpZCA9IHByb2Nlc3MucGlkKSB7CiAgY29uc3Qgcm9vdCA9IGpvaW4ocmVhbHBhdGhTeW5jKGhvbWUpLCAicnVudGltZSIpOwogIHByaXZhdGVEaXJlY3Rvcnkocm9vdCwgdHJ1ZSk7CiAgY29uc3QgcmVsZWFzZSA9IGF3YWl0IGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2soam9pbihyb290LCAiLm1haW50ZW5hbmNlLWxvY2suc3FsaXRlIiksIHsKICAgIGxhYmVsOiAicnVudGltZSBtYWludGVuYW5jZSIsIHRpbWVvdXRNczogNjBfMDAwLAogIH0pOwogIHRyeSB7CiAgICBjb25zdCBkaXJlY3RvcnkgPSBqb2luKHJvb3QsICIudXBkYXRlLWxlYXNlcyIpOwogICAgcHJpdmF0ZURpcmVjdG9yeShkaXJlY3RvcnkpOwogICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihwaWQpIHx8IHBpZCA8PSAwKSB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgdXBkYXRlIHBpZCIpOwogICAgY29uc3QgcGF0aCA9IGpvaW4oZGlyZWN0b3J5LCBgJHtwaWR9LSR7cmFuZG9tVVVJRCgpfS5qc29uYCk7CiAgICBhdG9taWNKc29uKHBhdGgsIHsgcGlkIH0pOwogICAgcmV0dXJuIHBhdGg7CiAgfSBmaW5hbGx5IHsgcmVsZWFzZSgpOyB9Cn0KZXhwb3J0IGZ1bmN0aW9uIGVuZFJ1bnRpbWVVcGRhdGUobGVhc2UpIHsgcm1TeW5jKGxlYXNlLCB7IGZvcmNlOiB0cnVlIH0pOyB9CgpleHBvcnQgZnVuY3Rpb24gcmVjb3JkUnVudGltZUFjdGl2YXRpb24oaG9tZSwgY3VycmVudCwgcHJldmlvdXMpIHsKICBpZiAoIXZlcnNpb25QYXR0ZXJuLnRlc3QoY3VycmVudCkgfHwgKHByZXZpb3VzICE9PSB1bmRlZmluZWQgJiYgIXZlcnNpb25QYXR0ZXJuLnRlc3QocHJldmlvdXMpKSkgewogICAgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHJ1bnRpbWUgYWN0aXZhdGlvbiBoaXN0b3J5Iik7CiAgfQogIGNvbnN0IHBhdGggPSBqb2luKGhvbWUsICJydW50aW1lIiwgIi5hY3RpdmF0aW9uLWhpc3RvcnkuanNvbiIpOwogIGxldCBvbGQ7CiAgdHJ5IHsgb2xkID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgInV0ZjgiKSk7IH0KICBjYXRjaCAoZXJyb3IpIHsgaWYgKGVycm9yLmNvZGUgIT09ICJFTk9FTlQiKSB0aHJvdyBlcnJvcjsgfQogIC8vIFJlaW5zdGFsbGluZyB0aGUgY3VycmVudCByZWxlYXNlIG11c3Qgbm90IGZvcmdldCB0aGUgcm9sbGJhY2sgdmVyc2lvbi4KICBpZiAocHJldmlvdXMgPT09IGN1cnJlbnQgfHwgcHJldmlvdXMgPT09IHVuZGVmaW5lZCkgewogICAgcHJldmlvdXMgPSBvbGQ/LmN1cnJlbnQgPT09IGN1cnJlbnQgPyBvbGQucHJldmlvdXMgOiBvbGQ/LmN1cnJlbnQ7CiAgfQogIGlmIChvbGQ/LmN1cnJlbnQgPT09IGN1cnJlbnQgJiYgb2xkPy5wcmV2aW91cyA9PT0gcHJldmlvdXMpIHJldHVybiBmYWxzZTsKICBhdG9taWNKc29uKHBhdGgsIHsgY3VycmVudCwgLi4uKHByZXZpb3VzID09PSB1bmRlZmluZWQgPyB7fSA6IHsgcHJldmlvdXMgfSkgfSk7CiAgcmV0dXJuIHRydWU7Cn0KCi8vIEluY2x1ZGUgY29tbWFuZCBsaW5lcyAoSlMgZW50cnlwb2ludHMpIGFuZCBvcGVuIGZpbGVzLCBleGVjdXRhYmxlIG1hcHBpbmdzLAovLyBuYXRpdmUgYWRkb25zIGFuZCBjd2QuIEEgZmFpbGVkIG9yIHRydW5jYXRlZCBpbnZlbnRvcnkgZGlzYWJsZXMgYWxsIGNsZWFudXAuCmV4cG9ydCBmdW5jdGlvbiBydW50aW1lUHJvY2Vzc0ludmVudG9yeShyb290KSB7CiAgY29uc3QgcHMgPSBzcGF3blN5bmMoIi9iaW4vcHMiLCBbIi1heHd3IiwgIi1vIiwgInBpZD0sY29tbWFuZD0iXSwgewogICAgZW5jb2Rpbmc6ICJ1dGY4IiwgdGltZW91dDogMTVfMDAwLCBtYXhCdWZmZXI6IDE2ICogMTAyNCAqIDEwMjQsCiAgfSk7CiAgY29uc3QgZmlsZXMgPSBzcGF3blN5bmMoIi91c3Ivc2Jpbi9sc29mIiwgWyItblAiLCAiLUZwbiIsICIrRCIsIHJvb3RdLCB7CiAgICBlbmNvZGluZzogInV0ZjgiLCB0aW1lb3V0OiAzMF8wMDAsIG1heEJ1ZmZlcjogMzIgKiAxMDI0ICogMTAyNCwKICB9KTsKICBpZiAocHMuZXJyb3IgfHwgcHMuc3RhdHVzICE9PSAwIHx8IGZpbGVzLmVycm9yIHx8CiAgICAgIChmaWxlcy5zdGF0dXMgIT09IDAgJiYgZmlsZXMuc3RhdHVzICE9PSAxKSB8fAogICAgICBmaWxlcy5zdGRlcnIgIT09ICIiKSB0aHJvdyBuZXcgRXJyb3IoImNhbm5vdCBlc3RhYmxpc2ggcnVubmluZyBydW50aW1lIHVzYWdlIik7CiAgcmV0dXJuIHBzLnN0ZG91dCArICJcbiIgKyBmaWxlcy5zdGRvdXQ7Cn0KZnVuY3Rpb24gdHJlZUJ5dGVzKHBhdGgpIHsKICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKHBhdGgpOwogIGlmIChzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHJldHVybiBzdGF0LnNpemU7CiAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkpIHJldHVybiBzdGF0LnNpemU7CiAgcmV0dXJuIHJlYWRkaXJTeW5jKHBhdGgpLnJlZHVjZSgoc3VtLCBuYW1lKSA9PiBzdW0gKyB0cmVlQnl0ZXMoam9pbihwYXRoLCBuYW1lKSksIDApOwp9CgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJ1bmVSdW50aW1lcyhob21lLCB7IGludmVudG9yeSA9IHJ1bnRpbWVQcm9jZXNzSW52ZW50b3J5LCBjaGVja3BvaW50ID0gKCkgPT4ge30gfSA9IHt9KSB7CiAgY29uc3Qgcm9vdCA9IGpvaW4ocmVhbHBhdGhTeW5jKGhvbWUpLCAicnVudGltZSIpOwogIHByaXZhdGVEaXJlY3Rvcnkocm9vdCk7CiAgY29uc3QgcmVsZWFzZSA9IGF3YWl0IGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2soam9pbihyb290LCAiLm1haW50ZW5hbmNlLWxvY2suc3FsaXRlIiksIHsKICAgIGxhYmVsOiAicnVudGltZSBtYWludGVuYW5jZSIsIHRpbWVvdXRNczogNjBfMDAwLAogIH0pOwogIGxldCByZWxlYXNlQWN0aXZhdGlvbjsKICBjb25zdCByZXN1bHQgPSB7IHJlbW92ZWQ6IFtdLCBmcmVlZEJ5dGVzOiAwLCBza2lwcGVkOiB1bmRlZmluZWQgfTsKICB0cnkgewogICAgcmVsZWFzZUFjdGl2YXRpb24gPSBhd2FpdCBhY3F1aXJlTG9jYWxTcWxpdGVMb2NrKGpvaW4ocm9vdCwgIi5hY3RpdmF0aW9uLWxvY2suc3FsaXRlIiksIHsKICAgICAgbGFiZWw6ICJydW50aW1lIHBydW5lIGFjdGl2YXRpb24iLCB0aW1lb3V0TXM6IDYwXzAwMCwKICAgIH0pOwogICAgaWYgKGV4aXN0c1N5bmMoam9pbihyb290LCAiLmFjdGl2YXRpb24tdHJhbnNhY3Rpb24uanNvbiIpKSkgewogICAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6ICJhY3RpdmF0aW9uIHJlY292ZXJ5IHBlbmRpbmciIH07CiAgICB9CiAgICBjb25zdCBsZWFzZXMgPSBqb2luKHJvb3QsICIudXBkYXRlLWxlYXNlcyIpOwogICAgaWYgKGV4aXN0c1N5bmMobGVhc2VzKSkgewogICAgICBwcml2YXRlRGlyZWN0b3J5KGxlYXNlcyk7CiAgICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhsZWFzZXMpKSB7CiAgICAgICAgY29uc3QgcGF0aCA9IGpvaW4obGVhc2VzLCBuYW1lKTsKICAgICAgICBpZiAoIWxzdGF0U3luYyhwYXRoKS5pc0ZpbGUoKSB8fCBsc3RhdFN5bmMocGF0aCkuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiAidW5yZWNvZ25pemVkIHVwZGF0ZSBsZWFzZSIgfTsKICAgICAgICB9CiAgICAgICAgY29uc3QgbGVhc2UgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCAidXRmOCIpKTsKICAgICAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGxlYXNlLnBpZCkgfHwgbGVhc2UucGlkIDw9IDAgfHwgbGl2ZShsZWFzZS5waWQpKSB7CiAgICAgICAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6ICJ1cGRhdGUgaW4gcHJvZ3Jlc3MiIH07CiAgICAgICAgfQogICAgICAgIHJtU3luYyhwYXRoKTsKICAgICAgfQogICAgfQogICAgY29uc3QgaGlzdG9yeSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgIi5hY3RpdmF0aW9uLWhpc3RvcnkuanNvbiIpLCAidXRmOCIpKTsKICAgIGlmICghdmVyc2lvblBhdHRlcm4udGVzdChoaXN0b3J5LmN1cnJlbnQpIHx8ICF2ZXJzaW9uUGF0dGVybi50ZXN0KGhpc3RvcnkucHJldmlvdXMpKSB7CiAgICAgIHJldHVybiB7IC4uLnJlc3VsdCwgc2tpcHBlZDogInR3byBzdWNjZXNzZnVsIGFjdGl2YXRpb25zIG5vdCByZWNvcmRlZCIgfTsKICAgIH0KICAgIGNvbnN0IHVzYWdlID0gaW52ZW50b3J5KHJvb3QpOwogICAgLy8gT2xkZXIgdXBkYXRlciBiaW5hcmllcyBwcmVkYXRlIGxlYXNlcy4gVGhlaXIgZnVsbCBjb21tYW5kIGxpbmUgc3RpbGwKICAgIC8vIGlkZW50aWZpZXMgYW4gdXBkYXRlIG9mIHRoaXMgaG9tZS4gRXhjbHVkZSB0aGlzIGNvbXBsZXRlZCB1cGRhdGVyIGl0c2VsZi4KICAgIGlmICh1c2FnZS5zcGxpdCgiXG4iKS5zb21lKChsaW5lKSA9PiB7CiAgICAgIGNvbnN0IGNvbW1hbmQgPSAvXlxzKihcZCspXHMrKC4rKSQvLmV4ZWMobGluZSk7CiAgICAgIHJldHVybiBjb21tYW5kICE9PSBudWxsICYmIE51bWJlcihjb21tYW5kWzFdKSAhPT0gcHJvY2Vzcy5waWQgJiYKICAgICAgICBjb21tYW5kWzJdLmluY2x1ZGVzKHJvb3QgKyAiLyIpICYmIC9cL2FnZW5jKD86XC5qcyk/XHMrdXBkYXRlKD86XHN8JCkvLnRlc3QoY29tbWFuZFsyXSk7CiAgICB9KSkgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiAib2xkZXIgdXBkYXRlciBpbiBwcm9ncmVzcyIgfTsKICAgIGZvciAoY29uc3QgdmVyc2lvbiBvZiByZWFkZGlyU3luYyhyb290KSkgewogICAgICBpZiAoIXZlcnNpb25QYXR0ZXJuLnRlc3QodmVyc2lvbikpIGNvbnRpbnVlOwogICAgICBjb25zdCBwYXRoID0gam9pbihyb290LCB2ZXJzaW9uKTsKICAgICAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhwYXRoKTsKICAgICAgaWYgKHN0YXQuaXNEaXJlY3RvcnkoKSAmJiAhc3RhdC5pc1N5bWJvbGljTGluaygpICYmCiAgICAgICAgICByZWFkZGlyU3luYyhwYXRoKS5zb21lKChuYW1lKSA9PiBuYW1lLnN0YXJ0c1dpdGgoIi4iKSkpIHsKICAgICAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6ICJydW50aW1lIGV4dHJhY3Rpb24gb3IgcmVjb3ZlcnkgcGVuZGluZyIgfTsKICAgICAgfQogICAgfQogICAgY29uc3QgcHJ1bmVKb3VybmFsID0gam9pbihyb290LCAiLnBydW5lLXRyYW5zYWN0aW9uLmpzb24iKTsKICAgIGNvbnN0IHJlbW92ZVRyZWUgPSAodmVyc2lvbiwgdHJlZU5hbWUsIHF1YXJhbnRpbmVOYW1lLCByZWNvdmVyaW5nID0gZmFsc2UpID0+IHsKICAgICAgaWYgKCF2ZXJzaW9uUGF0dGVybi50ZXN0KHZlcnNpb24pIHx8CiAgICAgICAgICAhL14oPzpkYXJ3aW58bGludXh8d2luKS0oPzphcm02NHx4NjQpLSg/Om5hdGl2ZXxnbGliYyktbm9kZS1hYmktXGQrLXNoYTI1Ni1bYS1mMC05XXs2NH0kLy50ZXN0KHRyZWVOYW1lKSB8fAogICAgICAgICAgIS9eXC5wcnVuZS1bYS1mMC05LV17MzZ9JC8udGVzdChxdWFyYW50aW5lTmFtZSkpIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgcHJ1bmUgam91cm5hbCIpOwogICAgICB9CiAgICAgIGNvbnN0IHZlcnNpb25EaXIgPSBqb2luKHJvb3QsIHZlcnNpb24pLCB0cmVlID0gam9pbih2ZXJzaW9uRGlyLCB0cmVlTmFtZSk7CiAgICAgIGNvbnN0IHF1YXJhbnRpbmUgPSBqb2luKHJvb3QsIHF1YXJhbnRpbmVOYW1lKTsKICAgICAgY29uc3Qgc3luY1BhcmVudHMgPSAoKSA9PiB7CiAgICAgICAgZm9yIChjb25zdCBwYXRoIG9mIFt2ZXJzaW9uRGlyLCByb290XSkgewogICAgICAgICAgY29uc3QgZmQgPSBvcGVuU3luYyhwYXRoLCAiciIpOwogICAgICAgICAgdHJ5IHsgZnN5bmNTeW5jKGZkKTsgfSBmaW5hbGx5IHsgY2xvc2VTeW5jKGZkKTsgfQogICAgICAgIH0KICAgICAgfTsKICAgICAgY29uc3QgcmVzdG9yZSA9ICgpID0+IHsKICAgICAgICBpZiAoZXhpc3RzU3luYyhxdWFyYW50aW5lKSkgewogICAgICAgICAgaWYgKGV4aXN0c1N5bmModHJlZSkpIHRocm93IG5ldyBFcnJvcigicmV0YWluZWQgcnVudGltZSBoYXMgYSBwZW5kaW5nIHF1YXJhbnRpbmUgY29weSIpOwogICAgICAgICAgcmVuYW1lU3luYyhxdWFyYW50aW5lLCB0cmVlKTsKICAgICAgICAgIHN5bmNQYXJlbnRzKCk7CiAgICAgICAgfQogICAgICAgIHJtU3luYyhwcnVuZUpvdXJuYWwsIHsgZm9yY2U6IHRydWUgfSk7CiAgICAgIH07CiAgICAgIGlmICh2ZXJzaW9uID09PSBoaXN0b3J5LmN1cnJlbnQgfHwgdmVyc2lvbiA9PT0gaGlzdG9yeS5wcmV2aW91cykgewogICAgICAgIGlmIChyZWNvdmVyaW5nKSByZXN0b3JlKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IGJ1c3kgPSAoc25hcHNob3QpID0+IFt2ZXJzaW9uRGlyLCBxdWFyYW50aW5lXS5zb21lKChwYXRoKSA9PgogICAgICAgIHNuYXBzaG90LmluY2x1ZGVzKHBhdGggKyAiLyIpIHx8IHNuYXBzaG90LmluY2x1ZGVzKHBhdGggKyAiXG4iKSk7CiAgICAgIGlmIChidXN5KGludmVudG9yeShyb290KSkpIHsKICAgICAgICBpZiAocmVjb3ZlcmluZykgcmVzdG9yZSgpOwogICAgICAgIHRocm93IG5ldyBFcnJvcigicnVudGltZSBiZWNhbWUgYnVzeSBiZWZvcmUgcHJ1bmluZyIpOwogICAgICB9CiAgICAgIGlmIChsc3RhdFN5bmModmVyc2lvbkRpcikuaXNTeW1ib2xpY0xpbmsoKSkgdGhyb3cgbmV3IEVycm9yKCJwcnVuZSBwYXJlbnQgY2hhbmdlZCBpZGVudGl0eSIpOwogICAgICBmb3IgKGNvbnN0IHBhdGggb2YgW3RyZWUsIHF1YXJhbnRpbmVdKSB7CiAgICAgICAgaWYgKGV4aXN0c1N5bmMocGF0aCkgJiYgKCFsc3RhdFN5bmMocGF0aCkuaXNEaXJlY3RvcnkoKSB8fCBsc3RhdFN5bmMocGF0aCkuaXNTeW1ib2xpY0xpbmsoKSkpIHsKICAgICAgICAgIHRocm93IG5ldyBFcnJvcigicHJ1bmUgdHJlZSBjaGFuZ2VkIGlkZW50aXR5Iik7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICghcmVjb3ZlcmluZykgYXRvbWljSnNvbihwcnVuZUpvdXJuYWwsIHsgdmVyc2lvbiwgdHJlZU5hbWUsIHF1YXJhbnRpbmVOYW1lIH0pOwogICAgICBjaGVja3BvaW50KCJwcnVuZS1yZWNvcmRlZCIpOwogICAgICBpZiAoZXhpc3RzU3luYyh0cmVlKSkgewogICAgICAgIGlmIChleGlzdHNTeW5jKHF1YXJhbnRpbmUpKSB0aHJvdyBuZXcgRXJyb3IoImFtYmlndW91cyBwcnVuZSByZWNvdmVyeSBzdGF0ZSIpOwogICAgICAgIHJlbmFtZVN5bmModHJlZSwgcXVhcmFudGluZSk7CiAgICAgICAgc3luY1BhcmVudHMoKTsKICAgICAgfQogICAgICBjaGVja3BvaW50KCJwcnVuZS1xdWFyYW50aW5lZCIpOwogICAgICAvLyBDbG9zZSB0aGUgbGF1bmNoLXZlcnN1cy1zY2FuIHJhY2U6IG9yaWdpbmFsIGxhdW5jaCBwYXRocyBhcmUgbm93IGFic2VudC4KICAgICAgLy8gQSBwcm9jZXNzIHRoYXQgZW50ZXJlZCBiZWZvcmUgcmVuYW1lIGlzIHZpc2libGUgYnkgaXRzIG9sZCBhcmd2LCBvcGVuCiAgICAgIC8vIGRlc2NyaXB0b3JzLCBleGVjdXRhYmxlIG1hcHBpbmcgb3IgY3dkLiBSZXN0b3JlIGl0cyB0cmVlIGluc3RlYWQuCiAgICAgIGxldCBhZnRlclJlbmFtZTsKICAgICAgdHJ5IHsgYWZ0ZXJSZW5hbWUgPSBpbnZlbnRvcnkocm9vdCk7IH0KICAgICAgY2F0Y2ggKGVycm9yKSB7IHJlc3RvcmUoKTsgdGhyb3cgZXJyb3I7IH0KICAgICAgaWYgKGJ1c3koYWZ0ZXJSZW5hbWUpKSB7CiAgICAgICAgcmVzdG9yZSgpOwogICAgICAgIHRocm93IG5ldyBFcnJvcigicnVudGltZSBiZWNhbWUgYnVzeSBkdXJpbmcgcHJ1bmluZyIpOwogICAgICB9CiAgICAgIGNvbnN0IGJ5dGVzID0gZXhpc3RzU3luYyhxdWFyYW50aW5lKSA/IHRyZWVCeXRlcyhxdWFyYW50aW5lKSA6IDA7CiAgICAgIHJtU3luYyhxdWFyYW50aW5lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7CiAgICAgIGNoZWNrcG9pbnQoInBydW5lLXJlbW92ZWQiKTsKICAgICAgcm1TeW5jKHBydW5lSm91cm5hbCk7CiAgICAgIHN5bmNQYXJlbnRzKCk7CiAgICAgIHJlc3VsdC5yZW1vdmVkLnB1c2godHJlZSk7CiAgICAgIHJlc3VsdC5mcmVlZEJ5dGVzICs9IGJ5dGVzOwogICAgfTsKICAgIGlmIChleGlzdHNTeW5jKHBydW5lSm91cm5hbCkpIHsKICAgICAgaWYgKCFsc3RhdFN5bmMocHJ1bmVKb3VybmFsKS5pc0ZpbGUoKSB8fCBsc3RhdFN5bmMocHJ1bmVKb3VybmFsKS5pc1N5bWJvbGljTGluaygpKSB0aHJvdyBuZXcgRXJyb3IoInVuc2FmZSBwcnVuZSBqb3VybmFsIik7CiAgICAgIGNvbnN0IHBlbmRpbmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwcnVuZUpvdXJuYWwsICJ1dGY4IikpOwogICAgICByZW1vdmVUcmVlKHBlbmRpbmcudmVyc2lvbiwgcGVuZGluZy50cmVlTmFtZSwgcGVuZGluZy5xdWFyYW50aW5lTmFtZSwgdHJ1ZSk7CiAgICB9CiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhZGRpclN5bmMocm9vdCkpIHsKICAgICAgaWYgKCF2ZXJzaW9uUGF0dGVybi50ZXN0KG5hbWUpIHx8IG5hbWUgPT09IGhpc3RvcnkuY3VycmVudCB8fCBuYW1lID09PSBoaXN0b3J5LnByZXZpb3VzKSBjb250aW51ZTsKICAgICAgY29uc3QgcGF0aCA9IGpvaW4ocm9vdCwgbmFtZSk7CiAgICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMocGF0aCk7CiAgICAgIGlmICghc3RhdC5pc0RpcmVjdG9yeSgpIHx8IHN0YXQuaXNTeW1ib2xpY0xpbmsoKSB8fCBzdGF0LnVpZCAhPT0gcHJvY2Vzcy5nZXR1aWQoKSkgY29udGludWU7CiAgICAgIC8vIFByZXNlcnZlIGludGVycnVwdGVkIGV4dHJhY3Rpb24vYmFja3VwIHRyZWVzIGFuZCB0aGVpciBwZXJzaXN0ZW50IGxvY2sKICAgICAgLy8gaWRlbnRpdGllcy4gTmV2ZXIgcmVtb3ZlIHRoZSB2ZXJzaW9uIGRpcmVjdG9yeSBvciBTUUxpdGUgbG9jayBmaWxlcy4KICAgICAgY29uc3QgY2hpbGRyZW4gPSByZWFkZGlyU3luYyhwYXRoKTsKICAgICAgaWYgKGNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC5zdGFydHNXaXRoKCIuIikpKSBjb250aW51ZTsKICAgICAgaWYgKHVzYWdlLmluY2x1ZGVzKHBhdGggKyAiLyIpIHx8IHVzYWdlLmluY2x1ZGVzKHBhdGggKyAiXG4iKSkgY29udGludWU7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHsKICAgICAgICBpZiAoIS9eKD86ZGFyd2lufGxpbnV4fHdpbiktKD86YXJtNjR8eDY0KS0oPzpuYXRpdmV8Z2xpYmMpLW5vZGUtYWJpLVxkKy1zaGEyNTYtW2EtZjAtOV17NjR9JC8udGVzdChjaGlsZCkpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHRyZWUgPSBqb2luKHBhdGgsIGNoaWxkKTsKICAgICAgICBjb25zdCB0cmVlU3RhdCA9IGxzdGF0U3luYyh0cmVlKTsKICAgICAgICBpZiAoIXRyZWVTdGF0LmlzRGlyZWN0b3J5KCkgfHwgdHJlZVN0YXQuaXNTeW1ib2xpY0xpbmsoKSkgY29udGludWU7CiAgICAgICAgY29uc3QgbWFya2VyID0gam9pbih0cmVlLCAiLmFnZW5jLXJ1bnRpbWUtb2siKTsKICAgICAgICBpZiAoIWV4aXN0c1N5bmMobWFya2VyKSB8fCBsc3RhdFN5bmMobWFya2VyKS5pc1N5bWJvbGljTGluaygpIHx8CiAgICAgICAgICAgIHJlYWRGaWxlU3luYyhtYXJrZXIsICJ1dGY4IikudHJpbSgpICE9PSBjaGlsZC5zbGljZSgtNjQpKSBjb250aW51ZTsKICAgICAgICAvLyBBIGR1cmFibGUgcGVyLXRyZWUgam91cm5hbCBtYWtlcyBpbnRlcnJ1cHRlZCByZWN1cnNpdmUgcmVtb3ZhbAogICAgICAgIC8vIHJldHJ5YWJsZSBldmVuIGlmIHRoZSBtYXJrZXIgd2FzIHJlbW92ZWQgYmVmb3JlIHRoZSBjcmFzaC4KICAgICAgICByZW1vdmVUcmVlKG5hbWUsIGNoaWxkLCBgLnBydW5lLSR7cmFuZG9tVVVJRCgpfWApOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gcmVzdWx0OwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6IGVycm9yLm1lc3NhZ2UgfTsKICB9IGZpbmFsbHkgeyByZWxlYXNlQWN0aXZhdGlvbj8uKCk7IHJlbGVhc2UoKTsgfQp9Cg==");
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
'@
  $runtimeInstallerPath = Join-Path $work "runtime-installer.cjs"
  Set-Content -LiteralPath $runtimeInstallerPath -Value $RuntimeInstaller -Encoding UTF8
  $prefix = if ($env:AGENC_INSTALL_PREFIX) { $env:AGENC_INSTALL_PREFIX } else { Join-Path $env:LOCALAPPDATA "agenc" }
  $prefix = [System.IO.Path]::GetFullPath($prefix)
  $binDir = Join-Path $prefix "bin"
  $wrapperDirectoryResult = (& node $runtimeInstallerPath prepare-wrapper-directories `
    $prefix $binDir "false" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail "could not prepare secure wrapper directory: $binDir" }
  if ($wrapperDirectoryResult -notin @("ready", "repaired")) {
    Fail "wrapper directory preparation returned an invalid result"
  }

  $recoverArgs = ConvertTo-NativeArguments @($runtimeInstallerPath, "recover", "-", $installDir, $binRel,
    ([string]$artifact.sha256), "win", $provenanceExpectationBase64, "", "", $nodeBinRel, $nodeLibraryRel)
  $recoveryState = (& node @recoverArgs | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail "runtime crash recovery failed" }

  if ($recoveryState -eq "ready") {
    Write-Log "runtime $version already installed (verified marker) - skipping download"
  } elseif ($recoveryState -eq "missing") {
    Write-Log "downloading runtime $version (win-$arch/abi$nodeModuleAbi)..."
    $tarball = Join-Path $work "runtime.tar.gz"
    Copy-InstallerResource ([string]$artifact.url) $tarball $MaxArtifactBytes $artifactBytes $manifestTrust
    $actual = (Get-FileHash -Algorithm SHA256 $tarball).Hash.ToLowerInvariant()
    if ($actual -ne $artifact.sha256) {
      Fail "checksum mismatch for runtime tarball (expected $($artifact.sha256), got $actual). Refusing to install."
    }
    $actualBytes = (Get-Item -LiteralPath $tarball).Length
    if ([string]$actualBytes -ne $artifactBytes) {
      Fail "byte count mismatch for runtime tarball (expected $artifactBytes, got $actualBytes). Refusing to install."
    }
    Write-Log "checksum verified"
    Confirm-OfficialRuntimeProvenance `
      $tarball `
      ([string]$artifact.url) `
      ([string]$artifact.attestationUrl) `
      ([string]$artifact.attestationSha256) `
      ([long]$artifact.attestationBytes) `
      ([string]$artifact.buildProvenanceUrl) `
      ([string]$artifact.buildProvenanceSha256) `
      ([long]$artifact.buildProvenanceBytes) `
      ([string]$manifest.build.sourceCommit) `
      ([string]$manifest.build.sourceRef) `
      $work `
      $arch `
      $provenanceExpectationBase64
    $installArgs = ConvertTo-NativeArguments @($runtimeInstallerPath, "install", $tarball, $installDir, $binRel,
      ([string]$artifact.sha256), "win", $provenanceExpectationBase64,
      $script:OfficialProvenanceReceiptBase64, $tarPath, $nodeBinRel, $nodeLibraryRel)
    & node @installArgs
    if ($LASTEXITCODE -ne 0) { Fail "runtime archive validation or installation failed" }
    Write-Log "runtime $version installed at $installDir"
  } else {
    Fail "runtime crash recovery returned an invalid state"
  }

  # --- shim ------------------------------------------------------------------

  if (-not $legacy) {
    & $privateNodeBin -e (ConvertTo-NativeArgument @'
const allowOverride = process.argv[1] === "true";
const expectedVersion = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) ||
    process.versions.node !== expectedVersion || process.versions.modules !== "147" ||
    process.versions.napi !== "10" || (!allowOverride && (
      process.platform !== "win32" || process.arch !== "x64"
    ))) process.exit(1);
'@) ([string][bool]($env:AGENC_INSTALL_PLATFORM -or $env:AGENC_INSTALL_ARCH)).ToLowerInvariant() $privateNodeVersion
    if ($LASTEXITCODE -ne 0) { Fail "installed private Node.js identity is invalid" }
  }

  $shim = Join-Path $binDir "agenc.cmd"
  $shimTemp = Join-Path $work "agenc-wrapper.cmd"
  & node $runtimeInstallerPath render-wrapper $shimTemp $privateNodeBin $runtimeBin $agencHome "cmd"
  if ($LASTEXITCODE -ne 0) { Fail "could not render shim" }
  $allowDowngrade = if ($env:AGENC_INSTALL_VERSION) { "true" } else { "false" }
  $activationResult = (& node $runtimeInstallerPath activate $shimTemp $shim $agencHome $version $allowDowngrade | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail "shim activation failed; any durable activation journal will resume on retry" }
  Remove-Item -Force -LiteralPath $shimTemp -ErrorAction SilentlyContinue
  if ($activationResult -match "^retained (.+)$") {
    Write-Log "kept newer active shim ($($Matches[1])): $shim"
  } elseif ($activationResult -eq "activated") {
    Write-Log "installed shim: $shim"
  } else {
    Fail "shim activation returned an invalid result"
  }

  # BEGIN AGENC USER PATH
  # PATH entries match case-insensitively, ignoring surrounding spaces,
  # trailing slashes and %VARIABLE% spelling. A longer path that only
  # contains the directory is a different entry.
  function ConvertTo-AgencPathEntryKey([string]$Entry) {
    $expanded = [Environment]::ExpandEnvironmentVariables($Entry.Trim()).Trim()
    return $expanded.TrimEnd([char[]]@('\', '/'))
  }
  function Test-AgencPathEntry([string]$PathValue, [string]$Directory) {
    $wanted = ConvertTo-AgencPathEntryKey $Directory
    foreach ($entry in $PathValue.Split(';')) {
      if (-not $entry.Trim()) { continue }
      $key = ConvertTo-AgencPathEntryKey $entry
      if ([string]::Equals($key, $wanted, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
  }
  # Returns PathValue with Directory appended, or $null when Directory is
  # already an entry. The existing value is kept unchanged as the prefix.
  function Get-AgencPathWithEntry([string]$PathValue, [string]$Directory) {
    if (Test-AgencPathEntry $PathValue $Directory) { return $null }
    if (-not $PathValue.Trim()) { return $Directory }
    if ($PathValue.EndsWith(";")) { return "$PathValue$Directory" }
    return "$PathValue;$Directory"
  }
  function Test-AgencModifyPathAllowed([string]$OptOut) {
    return $OptOut.Trim() -notin @("1", "true", "yes")
  }
  # Appends Directory to the user Path in HKCU\Environment. It reads the raw
  # value and writes it back with the same registry type, so REG_EXPAND_SZ
  # entries such as %USERPROFILE%\... stay unexpanded. The machine Path is
  # never read or written. KeyPath exists for tests.
  function Add-AgencUserPathEntry([string]$Directory, [string]$KeyPath = "Environment") {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($KeyPath)
    try {
      $current = $key.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $updated = Get-AgencPathWithEntry ([string]$current) $Directory
      if ($null -eq $updated) { return $false }
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      if ($null -ne $current) { $kind = $key.GetValueKind("Path") }
      if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
          $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
        throw "the user Path has registry type $kind"
      }
      $key.SetValue("Path", $updated, $kind)
      return $true
    } finally {
      $key.Close()
    }
  }
  # Tells Explorer and new terminals that the user environment changed, as
  # [Environment]::SetEnvironmentVariable does after its registry write.
  function Send-AgencEnvironmentChange {
    if (-not ("AgencInstall.EnvironmentNotice" -as [type])) {
      Add-Type -Namespace AgencInstall -Name EnvironmentNotice -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam,
  string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][AgencInstall.EnvironmentNotice]::SendMessageTimeout(
      [IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 1000, [ref]$result)
  }
  # END AGENC USER PATH

  if ($actualWindows -and (Test-AgencModifyPathAllowed $env:AGENC_NO_MODIFY_PATH)) {
    # The shim is installed, so a PATH write failure only costs the shortcut.
    $pathAdded = $false
    try {
      $pathAdded = Add-AgencUserPathEntry $binDir
    } catch {
      Write-Log "could not add $binDir to your user PATH ($($_.Exception.Message)); run agenc as $shim"
    }
    if ($pathAdded) {
      try { Send-AgencEnvironmentChange } catch { }
      Write-Log "added $binDir to your user PATH; open a new terminal to use agenc"
    }
    # The outer finally restores the caller's PATH. Include binDir in it so
    # the session that ran the installer can run agenc too.
    $sessionPath = Get-AgencPathWithEntry ([string]$priorNodeEnvironment["PATH"]) $binDir
    if ($null -ne $sessionPath) { $priorNodeEnvironment["PATH"] = $sessionPath }
  } elseif ($actualWindows -and
      -not (Test-AgencPathEntry ([string][Environment]::GetEnvironmentVariable("Path", "User")) $binDir)) {
    Write-Log "AGENC_NO_MODIFY_PATH is set, so $binDir was not added to your PATH; run agenc as $shim"
  }

  $systemRoot = [Environment]::GetEnvironmentVariable("SystemRoot")
  if (-not $systemRoot -or $systemRoot -notmatch '^[A-Za-z]:[\\/]') {
    $systemRoot = "C:\Windows"
  }
  $cmdExe = ($systemRoot.TrimEnd("\", "/") + "\System32\cmd.exe") -replace "/", "\"
  $accountUser = [Environment]::GetEnvironmentVariable("USERNAME")
  if (-not $accountUser) { $accountUser = [Environment]::GetEnvironmentVariable("USER") }
  $accountDomain = [Environment]::GetEnvironmentVariable("USERDOMAIN")
  if (-not $accountUser) { Fail "USERNAME is not set; refusing to generate a WinSW service without an installing user" }
  if ($accountUser.EndsWith('$') -or $accountUser -match '^(?i:SYSTEM|LocalSystem|LocalService|NetworkService)$') {
    Fail "service account must be the installing user, not LocalSystem, LocalService, NetworkService, or a machine account"
  }
  $account = if ($accountDomain) { "$accountDomain\$accountUser" } else { ".\$accountUser" }
  $xmlPath = Join-Path $prefix "agenc-daemon.xml"
  # BEGIN AGENC WINSW RENDERER
  $RenderWinSW = @'
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, win32 } = require("node:path");
const [commandPrompt, launcher, agencHome, accountUsername, outputPath] = process.argv.slice(1);
function fail(message) {
  console.error(message);
  process.exit(1);
}
function escapeXmlAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function isAbsoluteServicePath(value) {
  return typeof value === "string" && value !== "agenc" && win32.isAbsolute(value)
    && !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && !value.includes("\"");
}
if (!isAbsoluteServicePath(commandPrompt) || !/(?:^|[\\/])cmd\.exe$/i.test(commandPrompt)) {
  fail("commandPrompt must be an absolute cmd.exe path");
}
if (!isAbsoluteServicePath(launcher) || !/(?:^|[\\/])agenc\.cmd$/i.test(launcher)) {
  fail("launcher must be an absolute agenc.cmd path");
}
if (!isAbsoluteServicePath(agencHome)) fail("AGENC_HOME must be an absolute path");
if (!isAbsoluteServicePath(outputPath)) fail("WinSW output path must be absolute");
const account = String(accountUsername || "").trim().replaceAll("/", "\\");
if (!account || /^(localsystem|system|nt authority\\system|\.\\system)$/i.test(account)) {
  fail("service account must be the installing user, not LocalSystem");
}
const separator = account.lastIndexOf("\\");
const domain = separator === -1 ? "" : account.slice(0, separator);
const user = separator === -1 ? account : account.slice(separator + 1);
if (!domain || !user || user.endsWith("$") || /^(localsystem|system|localservice|networkservice)$/i.test(user)) {
  fail("service account must be the installing user, not LocalSystem, LocalService, NetworkService, or a machine account");
}
const args = `/d /v:off /s /c ""${String(launcher).replaceAll("%", "%%")}" daemon start --foreground"`;
const xml = [
  "<service>",
  "  <id>agenc-daemon</id>",
  "  <name>AgenC Daemon</name>",
  "  <description>Runs the local AgenC daemon control plane for the installing user's AGENC_HOME.</description>",
  `  <executable>${escapeXmlAttr(commandPrompt)}</executable>`,
  `  <arguments>${escapeXmlAttr(args)}</arguments>`,
  `  <workingdirectory>${escapeXmlAttr(agencHome)}</workingdirectory>`,
  `  <env name="AGENC_HOME" value="${escapeXmlAttr(agencHome)}"/>`,
  '  <env name="NODE_ENV" value="production"/>',
  "  <serviceaccount>",
  `    <domain>${escapeXmlAttr(domain)}</domain>`,
  `    <user>${escapeXmlAttr(user)}</user>`,
  "    <allowservicelogon>true</allowservicelogon>",
  "  </serviceaccount>",
  "  <startmode>Automatic</startmode>",
  '  <onfailure action="restart" delay="5 sec"/>',
  '  <log mode="roll-by-size">',
  "    <sizeThreshold>10240</sizeThreshold>",
  "    <keepFiles>5</keepFiles>",
  "  </log>",
  "</service>",
  "",
].join("\n");
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, xml, { encoding: "utf8" });
process.stdout.write(outputPath);
'@
  # END AGENC WINSW RENDERER
  $xmlResult = (& node -e (ConvertTo-NativeArgument $RenderWinSW) $cmdExe $shim $agencHome $account $xmlPath | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $xmlResult) { Fail "could not generate the WinSW service definition" }
  Write-Log "wrote WinSW 2.12.0 service definition: $xmlPath (service install is a separate WinSW step)"
  Write-Log "WinSW 2.12.0 is pinned. Do not use install /p. Confirm SERVICE_START_NAME with sc.exe qc agenc-daemon before start"

  Write-Log "install complete"
  Write-Host ""
  Write-Host "  AgenC $version installed."
  Write-Host ""
  Write-Host "  Next steps:"
  Write-Host "    $shim                      # start the interactive TUI"
  Write-Host "    $shim doctor               # verify the installation"
  Write-Host "    $shim daemon start         # start the daemon without a Windows service"
  Write-Host "    $shim daemon install-service  # regenerate the WinSW XML"
  Write-Host "    # WinSW install/start/stop/restart is a separate elevated step; see docs/install.md"
  Write-Host ""
} finally {
  $parentUnchanged = $workParentIdentity -and
    (Test-InstallerDirectoryIdentity $workParent $workParentIdentity)
  if ($work -and $workIdentity -and $parentUnchanged -and
      (Test-InstallerDirectoryIdentity $work $workIdentity)) {
    Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
  }
  if ($workParentCreated -and $parentUnchanged -and
      (Test-InstallerDirectoryIdentity $agencHome $agencHomeIdentity)) {
    $remaining = @(Get-ChildItem -LiteralPath $workParent -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
      Remove-Item -Force -LiteralPath $workParent -ErrorAction SilentlyContinue
    }
  }
}
} finally {
  if ($bootstrapWork -and (Test-Path -LiteralPath $bootstrapWork)) {
    Remove-Item -Recurse -Force -LiteralPath $bootstrapWork -ErrorAction SilentlyContinue
  }
  foreach ($name in $priorNodeEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $priorNodeEnvironment[$name], "Process")
  }
}
}
