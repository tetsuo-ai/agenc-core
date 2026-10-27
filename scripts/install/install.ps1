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
const AGENC_SQLITE_LOCK_SOURCE_BASE64 = "Ly8gQ3Jvc3MtcHJvY2VzcyBsb2NhbCBmaWxlc3lzdGVtIGxvY2tzIGJhY2tlZCBieSBTUUxpdGUncyBPUyBsb2NraW5nIGxheWVyLgovLwovLyBCRUdJTiBJTU1FRElBVEUgb3ducyB0aGUgd3JpdGVyIHJlc2VydmF0aW9uIGZvciB0aGUgY2FsbGVyJ3MgY3JpdGljYWwKLy8gc2VjdGlvbi4gU1FMaXRlIHJlbGVhc2VzIGl0IG9uIGNsb3NlIG9yIHByb2Nlc3MgZGVhdGgsIGluY2x1ZGluZyBTSUdLSUxMLgovLyBBIHByb2Nlc3Mtd2lkZSBGSUZPIHJlZ2lzdHJ5IHByZXZlbnRzIGR1cGxpY2F0ZSBtb2R1bGUgaW5zdGFuY2VzIGZyb20KLy8gYmxvY2tpbmcgb25lIGFub3RoZXIgaW5zaWRlIHN5bmNocm9ub3VzIFNRTGl0ZSBjYWxsczsgY3Jvc3MtcHJvY2VzcyBidXN5Ci8vIGNvbnRlbnRpb24gaXMgcmV0cmllZCBhc3luY2hyb25vdXNseSBhZ2FpbnN0IG9uZSBtb25vdG9uaWMgZGVhZGxpbmUuCgppbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gIm5vZGU6Y2hpbGRfcHJvY2VzcyI7CmltcG9ydCB7CiAgY2xvc2VTeW5jLAogIGNvbnN0YW50cyBhcyBmc0NvbnN0YW50cywKICBmc3RhdFN5bmMsCiAgbHN0YXRTeW5jLAogIG9wZW5TeW5jLAogIHJlYWxwYXRoU3luYywKfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsKICBjaG1vZCwKICBsc3RhdCwKICBta2RpciwKICBvcGVuLAogIHJlYWRGaWxlLAogIHJlYWxwYXRoLAp9IGZyb20gIm5vZGU6ZnMvcHJvbWlzZXMiOwppbXBvcnQgewogIGJhc2VuYW1lLAogIGRpcm5hbWUsCiAgam9pbiwKICByZXNvbHZlLAogIHNlcCwKICB3aW4zMiwKfSBmcm9tICJub2RlOnBhdGgiOwppbXBvcnQgeyBzZXRUaW1lb3V0IGFzIGRlbGF5IH0gZnJvbSAibm9kZTp0aW1lcnMvcHJvbWlzZXMiOwoKY29uc3QgTE9DS19BUFBMSUNBVElPTl9JRCA9IDB4NDE0NzRlNDM7IC8vICJBR05DIgpjb25zdCBMT0NLX0ZPUk1BVF9WRVJTSU9OID0gMTsKY29uc3QgU1FMSVRFX0JVU1kgPSA1Owpjb25zdCBSRUdJU1RSWV9WRVJTSU9OID0gMTsKY29uc3QgUkVHSVNUUllfU1lNQk9MID0gU3ltYm9sLmZvcigiQHRldHN1by1haS9hZ2VuYy5zcWxpdGUtbG9jay1yZWdpc3RyeSIpOwpjb25zdCBNQVhfQlVTWV9SRVRSWV9NUyA9IDUwOwpjb25zdCBNQVhfVElNRVJfREVMQVlfTVMgPSAyXzE0N180ODNfNjQ3Owpjb25zdCBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0ID0gMHhmZmZmX2ZmZmZfZmZmZl9mZmZmbjsKY29uc3QgV0lORE9XU19QQVRIX1RSQU5TUE9SVF9NQVhfQ0hBUlMgPSAxNl8zODQ7CmNvbnN0IFdJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0VOVFJJRVMgPSAxMjg7CmNvbnN0IFdJTkRPV1NfU1lTVEVNX1JPT1QgPSBTdHJpbmcucmF3YFxcP1xHTE9CQUxST09UXFN5c3RlbVJvb3RgOwpjb25zdCBXSU5ET1dTX0VYRUNVVEFCTEVfRklMRVNZU1RFTSA9IHsKICBsc3RhdDogKHBhdGgpID0+IGxzdGF0U3luYyhwYXRoLCB7IGJpZ2ludDogdHJ1ZSB9KSwKICBvcGVuOiAocGF0aCkgPT4gb3BlblN5bmMoCiAgICBwYXRoLAogICAgZnNDb25zdGFudHMuT19SRE9OTFkgfCAoZnNDb25zdGFudHMuT19OT0ZPTExPVyA/PyAwKSwKICApLAogIGZzdGF0OiAoZGVzY3JpcHRvcikgPT4gZnN0YXRTeW5jKGRlc2NyaXB0b3IsIHsgYmlnaW50OiB0cnVlIH0pLAogIGNsb3NlOiBjbG9zZVN5bmMsCn07CmNvbnN0IExPQ0FMX0ZJTEVTWVNURU1fVFlQRVMgPSBuZXcgU2V0KFsKICAiYXBmcyIsICJiY2FjaGVmcyIsICJidHJmcyIsICJleGZhdCIsICJleHQyIiwgImV4dDMiLCAiZXh0NCIsICJmMmZzIiwKICAiaGZzIiwgImhmc3BsdXMiLCAiamZzIiwgIm1zZG9zIiwgIm5pbGZzMiIsICJudGZzIiwgIm50ZnMzIiwgIm92ZXJsYXkiLAogICJyYW1mcyIsICJyZWlzZXJmcyIsICJ0bXBmcyIsICJ1YmlmcyIsICJ1ZnMiLCAidmZhdCIsICJ4ZnMiLCAiemZzIiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfUkVBRF9SSUdIVFMgPSBuZXcgU2V0KFsKICAicmVhZCIsICJsaXN0IiwgInNlYXJjaCIsICJleGVjdXRlIiwgInJlYWRhdHRyIiwgInJlYWRleHRhdHRyIiwgInJlYWRzZWN1cml0eSIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX0lOSEVSSVRBTkNFX0ZMQUdTID0gbmV3IFNldChbCiAgImZpbGVfaW5oZXJpdCIsICJkaXJlY3RvcnlfaW5oZXJpdCIsICJsaW1pdF9pbmhlcml0IiwgIm9ubHlfaW5oZXJpdCIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX01VVEFUSU9OX1JJR0hUUyA9IG5ldyBTZXQoWwogICJ3cml0ZSIsICJhcHBlbmQiLCAiYWRkX2ZpbGUiLCAiYWRkX3N1YmRpcmVjdG9yeSIsICJkZWxldGUiLCAiZGVsZXRlX2NoaWxkIiwKICAid3JpdGVhdHRyIiwgIndyaXRlZXh0YXR0ciIsICJ3cml0ZXNlY3VyaXR5IiwgImNob3duIiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfS05PV05fVE9LRU5TID0gbmV3IFNldChbCiAgLi4uREFSV0lOX0FDTF9SRUFEX1JJR0hUUywKICAuLi5EQVJXSU5fQUNMX0lOSEVSSVRBTkNFX0ZMQUdTLAogIC4uLkRBUldJTl9BQ0xfTVVUQVRJT05fUklHSFRTLApdKTsKY29uc3QgREFSV0lOX0FDTF9WRVJESUNUX0NBQ0hFX0xJTUlUID0gNTEyOwpjb25zdCBkYXJ3aW5BY2xWZXJkaWN0cyA9IG5ldyBNYXAoKTsKCmNvbnN0IFdJTkRPV1NfU0VDVVJJVFlfU0NSSVBUID0gU3RyaW5nLnJhd2AKJEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJwojIEtlZXAgdGhpcyBkaXJlY3QtLk5FVCBvbmx5OiBtb2R1bGUgYXV0b2xvYWQgY2FuIGV4aGF1c3QgdGhlIHNoYXJlZCBsb2NrIGRlYWRsaW5lLgokdHJhbnNwb3J0ID0gW3N0cmluZ10kZW52OkFHRU5DX0xPQ0tfUEFUSFMKaWYgKFtzdHJpbmddOjpJc051bGxPckVtcHR5KCR0cmFuc3BvcnQpIC1vciAkdHJhbnNwb3J0Lkxlbmd0aCAtZ3QgJHtXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSU30pIHsKICB0aHJvdyAnaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnCn0KJGVudHJpZXMgPSBbc3RyaW5nW11dJHRyYW5zcG9ydC5TcGxpdChbY2hhcl0xMCkKaWYgKCRlbnRyaWVzLkNvdW50IC1sdCAxIC1vciAkZW50cmllcy5Db3VudCAtZ3QgJHtXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9FTlRSSUVTfSkgewogIHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcKfQokY3VycmVudFNpZCA9IFtTeXN0ZW0uU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NJZGVudGl0eV06OkdldEN1cnJlbnQoKS5Vc2VyLlZhbHVlCiR0cnVzdGVkID0gQCgKICAkY3VycmVudFNpZCwKICAnUy0xLTUtMTgnLAogICdTLTEtNS0zMi01NDQnLAogICdTLTEtNS04MC05NTYwMDg4ODUtMzQxODUyMjY0OS0xODMxMDM4MDQ0LTE4NTMyOTI2MzEtMjI3MTQ3ODQ2NCcKKQojIFNwZWNpZmljIG11dGF0aW9uIHJpZ2h0cyBwbHVzIEdFTkVSSUNfV1JJVEUgYW5kIEdFTkVSSUNfQUxMLgokbGVhZk11dGF0aW9uTWFzayA9IFtpbnQ2NF0xMzQzMDI5NTkwCiRhbmNlc3Rvck11dGF0aW9uTWFzayA9IFtpbnQ2NF0xMzQzMDI5NTg2CmZvcmVhY2ggKCRlbnRyeSBpbiAkZW50cmllcykgewogICRzZXBhcmF0b3IgPSAkZW50cnkuSW5kZXhPZihbY2hhcl01OCkKICBpZiAoJHNlcGFyYXRvciAtbHQgMSAtb3IgJHNlcGFyYXRvciAtZXEgKCRlbnRyeS5MZW5ndGggLSAxKSkgewogICAgdGhyb3cgJ2ludmFsaWQgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0JwogIH0KICAkcm9sZSA9ICRlbnRyeS5TdWJzdHJpbmcoMCwgJHNlcGFyYXRvcikKICBpZiAoQCgnbGVhZkRpcmVjdG9yeScsICdhbmNlc3RvckRpcmVjdG9yeScsICdmaWxlJykgLW5vdGNvbnRhaW5zICRyb2xlKSB7CiAgICB0aHJvdyAiaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCByb2xlOiAkcm9sZSIKICB9CiAgJGVuY29kZWRQYXRoID0gJGVudHJ5LlN1YnN0cmluZygkc2VwYXJhdG9yICsgMSkKICBpZiAoKCRlbmNvZGVkUGF0aC5MZW5ndGggJSA0KSAtbmUgMCkgeyB0aHJvdyAnaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnIH0KICAkcGF0aEJ5dGVzID0gW1N5c3RlbS5Db252ZXJ0XTo6RnJvbUJhc2U2NFN0cmluZygkZW5jb2RlZFBhdGgpCiAgaWYgKCgkcGF0aEJ5dGVzLkxlbmd0aCAlIDIpIC1uZSAwKSB7IHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcgfQogIGlmIChbU3lzdGVtLkNvbnZlcnRdOjpUb0Jhc2U2NFN0cmluZygkcGF0aEJ5dGVzKSAtY25lICRlbmNvZGVkUGF0aCkgewogICAgdGhyb3cgJ25vbi1jYW5vbmljYWwgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0JwogIH0KICAkcGF0aENoYXJhY3RlcnMgPSBbY2hhcltdXTo6bmV3KFtpbnRdKCRwYXRoQnl0ZXMuTGVuZ3RoIC8gMikpCiAgZm9yICgkaW5kZXggPSAwOyAkaW5kZXggLWx0ICRwYXRoQ2hhcmFjdGVycy5MZW5ndGg7ICRpbmRleCArPSAxKSB7CiAgICAkYnl0ZU9mZnNldCA9ICRpbmRleCAqIDIKICAgICRsb3dCeXRlID0gW2ludF0kcGF0aEJ5dGVzWyRieXRlT2Zmc2V0XQogICAgJGhpZ2hCeXRlID0gW2ludF0kcGF0aEJ5dGVzWyRieXRlT2Zmc2V0ICsgMV0KICAgICRwYXRoQ2hhcmFjdGVyc1skaW5kZXhdID0gW2NoYXJdKCRsb3dCeXRlIC1ib3IgKCRoaWdoQnl0ZSAtc2hsIDgpKQogIH0KICAkcmVxdWVzdGVkID0gW3N0cmluZ106Om5ldygkcGF0aENoYXJhY3RlcnMpCiAgJG11dGF0aW9uTWFzayA9IGlmICgkcm9sZSAtZXEgJ2FuY2VzdG9yRGlyZWN0b3J5JykgewogICAgJGFuY2VzdG9yTXV0YXRpb25NYXNrCiAgfSBlbHNlIHsKICAgICRsZWFmTXV0YXRpb25NYXNrCiAgfQogICRmdWxsID0gW1N5c3RlbS5JTy5QYXRoXTo6R2V0RnVsbFBhdGgoJHJlcXVlc3RlZCkKICBpZiAoJGZ1bGwuU3RhcnRzV2l0aCgnXFwnKSAtb3IgJGZ1bGwuU3RhcnRzV2l0aCgnXFw/XCcpIC1vciAkZnVsbC5TdGFydHNXaXRoKCdcXC5cJykpIHsKICAgIHRocm93ICJuZXR3b3JrIGFuZCBkZXZpY2UgcGF0aHMgYXJlIHVuc3VwcG9ydGVkOiAkZnVsbCIKICB9CiAgJGF0dHJpYnV0ZXMgPSBbU3lzdGVtLklPLkZpbGVdOjpHZXRBdHRyaWJ1dGVzKCRmdWxsKQogIGlmICgoJGF0dHJpYnV0ZXMgLWJhbmQgW1N5c3RlbS5JTy5GaWxlQXR0cmlidXRlc106OlJlcGFyc2VQb2ludCkgLW5lIDApIHsKICAgIHRocm93ICJyZXBhcnNlIHBvaW50cyBhcmUgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICAkaXNEaXJlY3RvcnkgPSAoJGF0dHJpYnV0ZXMgLWJhbmQgW1N5c3RlbS5JTy5GaWxlQXR0cmlidXRlc106OkRpcmVjdG9yeSkgLW5lIDAKICBpZiAoJGlzRGlyZWN0b3J5IC1uZSAoJHJvbGUgLW5lICdmaWxlJykpIHsKICAgIHRocm93ICJwcm90ZWN0ZWQtcGF0aCByb2xlIGRvZXMgbm90IG1hdGNoIGl0cyB0eXBlOiAkZnVsbCIKICB9CiAgJGRyaXZlID0gW1N5c3RlbS5JTy5Ecml2ZUluZm9dOjpuZXcoW1N5c3RlbS5JTy5QYXRoXTo6R2V0UGF0aFJvb3QoJGZ1bGwpKQogIGlmIChAKDIsIDMsIDYpIC1ub3Rjb250YWlucyBbaW50XSRkcml2ZS5Ecml2ZVR5cGUpIHsKICAgIHRocm93ICJub24tbG9jYWwgZHJpdmUgaXMgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICBpZiAoJGRyaXZlLkRyaXZlRm9ybWF0IC1uZSAnTlRGUycpIHsKICAgIHRocm93ICJmaWxlc3lzdGVtIGNhbm5vdCBlbmZvcmNlIHRoZSByZXF1aXJlZCBBQ0wgY29udHJhY3Q6ICRmdWxsIgogIH0KICAkYWNsU2VjdGlvbnMgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFNlY3Rpb25zXTo6T3duZXIgLWJvciBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFNlY3Rpb25zXTo6QWNjZXNzCiAgaWYgKCRpc0RpcmVjdG9yeSkgewogICAgJGFjbCA9IFtTeXN0ZW0uSU8uRGlyZWN0b3J5XTo6R2V0QWNjZXNzQ29udHJvbCgkZnVsbCwgJGFjbFNlY3Rpb25zKQogIH0gZWxzZSB7CiAgICAkYWNsID0gW1N5c3RlbS5JTy5GaWxlXTo6R2V0QWNjZXNzQ29udHJvbCgkZnVsbCwgJGFjbFNlY3Rpb25zKQogIH0KICBpZiAoLW5vdCAkYWNsLkFyZUFjY2Vzc1J1bGVzQ2Fub25pY2FsKSB7CiAgICB0aHJvdyAibm9uLWNhbm9uaWNhbCBBQ0wgaXMgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICAkYnl0ZXMgPSAkYWNsLkdldFNlY3VyaXR5RGVzY3JpcHRvckJpbmFyeUZvcm0oKQogICRyYXcgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuUmF3U2VjdXJpdHlEZXNjcmlwdG9yXTo6bmV3KCRieXRlcywgMCkKICBpZiAoJG51bGwgLWVxICRyYXcuRGlzY3JldGlvbmFyeUFjbCkgewogICAgdGhyb3cgIm51bGwgREFDTCBpcyB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRvd25lciA9ICRhY2wuR2V0T3duZXIoW1N5c3RlbS5TZWN1cml0eS5QcmluY2lwYWwuU2VjdXJpdHlJZGVudGlmaWVyXSkuVmFsdWUKICBpZiAoJHRydXN0ZWQgLW5vdGNvbnRhaW5zICRvd25lcikgewogICAgdGhyb3cgInVudHJ1c3RlZCBvd25lciBTSUQgb24gbG9jayBwYXRoOiAkZnVsbCIKICB9CiAgJHJ1bGVzID0gJGFjbC5HZXRBY2Nlc3NSdWxlcygKICAgICR0cnVlLAogICAgJHRydWUsCiAgICBbU3lzdGVtLlNlY3VyaXR5LlByaW5jaXBhbC5TZWN1cml0eUlkZW50aWZpZXJdCiAgKQogIGZvcmVhY2ggKCRydWxlIGluICRydWxlcykgewogICAgaWYgKCRydWxlLkFjY2Vzc0NvbnRyb2xUeXBlIC1uZSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFR5cGVdOjpBbGxvdykgewogICAgICBjb250aW51ZQogICAgfQogICAgJGluaGVyaXRPbmx5ID0gKCRydWxlLlByb3BhZ2F0aW9uRmxhZ3MgLWJhbmQgW1N5c3RlbS5TZWN1cml0eS5BY2Nlc3NDb250cm9sLlByb3BhZ2F0aW9uRmxhZ3NdOjpJbmhlcml0T25seSkgLW5lIDAKICAgIGlmICgkaW5oZXJpdE9ubHkpIHsKICAgICAgJGNoaWxkSW5oZXJpdGFuY2UgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106Ok9iamVjdEluaGVyaXQgLWJvciBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106OkNvbnRhaW5lckluaGVyaXQKICAgICAgJHJlYWNoZXNOZXdDaGlsZCA9ICgkcnVsZS5Jbmhlcml0YW5jZUZsYWdzIC1iYW5kICRjaGlsZEluaGVyaXRhbmNlKSAtbmUgMAogICAgICBpZiAoJHJvbGUgLW5lICdsZWFmRGlyZWN0b3J5JyAtb3IgLW5vdCAkcmVhY2hlc05ld0NoaWxkKSB7CiAgICAgICAgY29udGludWUKICAgICAgfQogICAgfQogICAgJHNpZCA9ICRydWxlLklkZW50aXR5UmVmZXJlbmNlLlZhbHVlCiAgICAkcmlnaHRzID0gKFtpbnQ2NF0kcnVsZS5GaWxlU3lzdGVtUmlnaHRzKSAtYmFuZCBbaW50NjRdNDI5NDk2NzI5NQogICAgaWYgKCR0cnVzdGVkIC1ub3Rjb250YWlucyAkc2lkIC1hbmQgKCgkcmlnaHRzIC1iYW5kICRtdXRhdGlvbk1hc2spIC1uZSAwKSkgewogICAgICB0aHJvdyAidW50cnVzdGVkIG11dGF0aW9uIEFDRSBvbiBsb2NrIHBhdGg6ICRmdWxsIgogICAgfQogIH0KfQpbQ29uc29sZV06Ok91dC5Xcml0ZSgnT0snKQpgOwpjb25zdCBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVF9CQVNFNjQgPSBCdWZmZXIuZnJvbSgKICBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVCwKICAidXRmMTZsZSIsCikudG9TdHJpbmcoImJhc2U2NCIpOwoKZXhwb3J0IGNsYXNzIExvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciBleHRlbmRzIEVycm9yIHsKICBjb25zdHJ1Y3Rvcih7IHBhdGgsIGxhYmVsLCB0aW1lb3V0TXMsIGNhdXNlIH0pIHsKICAgIHN1cGVyKAogICAgICBgYWdlbmM6ICR7bGFiZWx9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNc31tcyB3YWl0aW5nIGZvciBsb2NhbCBwcm9jZXNzIGxvY2sgJHtwYXRofWAsCiAgICAgIGNhdXNlID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB7IGNhdXNlIH0sCiAgICApOwogICAgdGhpcy5uYW1lID0gIkxvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciI7CiAgICB0aGlzLmNvZGUgPSAiQUdFTkNfTE9DS19USU1FT1VUIjsKICAgIHRoaXMucGF0aCA9IHBhdGg7CiAgICB0aGlzLmxhYmVsID0gbGFiZWw7CiAgICB0aGlzLnRpbWVvdXRNcyA9IHRpbWVvdXRNczsKICB9Cn0KCmZ1bmN0aW9uIHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIHJldHVybiBuZXcgTG9jYWxTcWxpdGVMb2NrVGltZW91dEVycm9yKHsKICAgIHBhdGgsCiAgICBsYWJlbDogY29udGV4dC5sYWJlbCwKICAgIHRpbWVvdXRNczogY29udGV4dC50aW1lb3V0TXMsCiAgICBjYXVzZSwKICB9KTsKfQoKZnVuY3Rpb24gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpIHsKICByZXR1cm4gTWF0aC5mbG9vcihjb250ZXh0LmRlYWRsaW5lIC0gcGVyZm9ybWFuY2Uubm93KCkpOwp9CgpmdW5jdGlvbiB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIGlmIChyZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCkgPD0gMCkgewogICAgdGhyb3cgdGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgsIGNhdXNlKTsKICB9Cn0KCmZ1bmN0aW9uIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsIHBoYXNlKSB7CiAgdHJ5IHsKICAgIGNvbnN0IHJlc3VsdCA9IGNvbnRleHQub25Qcm9ncmVzcz8uKHBoYXNlKTsKICAgIGlmIChyZXN1bHQgIT09IHVuZGVmaW5lZCkgewogICAgICB2b2lkIFByb21pc2UucmVzb2x2ZShyZXN1bHQpLmNhdGNoKCgpID0+IHt9KTsKICAgIH0KICB9IGNhdGNoIHsKICAgIC8vIERpYWdub3N0aWNzIG11c3QgbmV2ZXIgY2hhbmdlIGxvY2sgYWNxdWlzaXRpb24gb3IgcmVsZWFzZSBzZW1hbnRpY3MuCiAgfQp9CgpmdW5jdGlvbiBwcm9jZXNzTG9ja1JlZ2lzdHJ5KCkgewogIGNvbnN0IGN1cnJlbnQgPSBwcm9jZXNzW1JFR0lTVFJZX1NZTUJPTF07CiAgaWYgKGN1cnJlbnQgIT09IHVuZGVmaW5lZCkgewogICAgaWYgKAogICAgICBjdXJyZW50ID09PSBudWxsIHx8CiAgICAgIHR5cGVvZiBjdXJyZW50ICE9PSAib2JqZWN0IiB8fAogICAgICBjdXJyZW50LnZlcnNpb24gIT09IFJFR0lTVFJZX1ZFUlNJT04gfHwKICAgICAgIShjdXJyZW50LmxvY2tzIGluc3RhbmNlb2YgTWFwKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigKICAgICAgICAiYWdlbmM6IGluY29tcGF0aWJsZSBwcm9jZXNzLXdpZGUgU1FMaXRlIGxvY2sgcmVnaXN0cnkgaXMgYWxyZWFkeSBpbnN0YWxsZWQiLAogICAgICApOwogICAgfQogICAgcmV0dXJuIGN1cnJlbnQ7CiAgfQogIGNvbnN0IGNyZWF0ZWQgPSB7IHZlcnNpb246IFJFR0lTVFJZX1ZFUlNJT04sIGxvY2tzOiBuZXcgTWFwKCkgfTsKICBPYmplY3QuZGVmaW5lUHJvcGVydHkocHJvY2VzcywgUkVHSVNUUllfU1lNQk9MLCB7CiAgICB2YWx1ZTogY3JlYXRlZCwKICAgIGNvbmZpZ3VyYWJsZTogZmFsc2UsCiAgICBlbnVtZXJhYmxlOiBmYWxzZSwKICAgIHdyaXRhYmxlOiBmYWxzZSwKICB9KTsKICByZXR1cm4gY3JlYXRlZDsKfQoKZnVuY3Rpb24gYWNxdWlyZUluUHJvY2Vzc0xvY2socHJlcGFyZWQsIGNvbnRleHQpIHsKICBjb25zdCByZWdpc3RyeSA9IHByb2Nlc3NMb2NrUmVnaXN0cnkoKTsKICBjb25zdCBrZXkgPSBwcmVwYXJlZC5pZGVudGl0eUtleTsKICBsZXQgc3RhdGUgPSByZWdpc3RyeS5sb2Nrcy5nZXQoa2V5KTsKICBpZiAoc3RhdGUgPT09IHVuZGVmaW5lZCkgewogICAgc3RhdGUgPSB7IGxvY2tlZDogZmFsc2UsIHdhaXRlcnM6IFtdIH07CiAgICByZWdpc3RyeS5sb2Nrcy5zZXQoa2V5LCBzdGF0ZSk7CiAgfQoKICBjb25zdCBtYWtlUmVsZWFzZSA9ICgpID0+IHsKICAgIGxldCByZWxlYXNlZCA9IGZhbHNlOwogICAgcmV0dXJuICgpID0+IHsKICAgICAgaWYgKHJlbGVhc2VkKSByZXR1cm47CiAgICAgIHJlbGVhc2VkID0gdHJ1ZTsKICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLndhaXRlcnMuc2hpZnQoKTsKICAgICAgaWYgKG5leHQgPT09IHVuZGVmaW5lZCkgewogICAgICAgIHN0YXRlLmxvY2tlZCA9IGZhbHNlOwogICAgICAgIHJlZ2lzdHJ5LmxvY2tzLmRlbGV0ZShrZXkpOwogICAgICB9IGVsc2UgewogICAgICAgIGNsZWFyVGltZW91dChuZXh0LnRpbWVyKTsKICAgICAgICBuZXh0LnJlc29sdmUobWFrZVJlbGVhc2UoKSk7CiAgICAgIH0KICAgIH07CiAgfTsKCiAgaWYgKCFzdGF0ZS5sb2NrZWQpIHsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpOwogICAgc3RhdGUubG9ja2VkID0gdHJ1ZTsKICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUobWFrZVJlbGVhc2UoKSk7CiAgfQoKICBjb25zdCByZW1haW5pbmcgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgaWYgKHJlbWFpbmluZyA8PSAwKSB7CiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QodGltZW91dEVycm9yKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpKTsKICB9CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlV2FpdCwgcmVqZWN0V2FpdCkgPT4gewogICAgY29uc3Qgd2FpdGVyID0gewogICAgICByZXNvbHZlOiByZXNvbHZlV2FpdCwKICAgICAgdGltZXI6IHVuZGVmaW5lZCwKICAgIH07CiAgICBjb25zdCBhcm1UaW1lb3V0ID0gKCkgPT4gewogICAgICBjb25zdCBkZWxheU1zID0gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpOwogICAgICBpZiAoZGVsYXlNcyA8PSAwKSB7CiAgICAgICAgY29uc3QgaW5kZXggPSBzdGF0ZS53YWl0ZXJzLmluZGV4T2Yod2FpdGVyKTsKICAgICAgICBpZiAoaW5kZXggIT09IC0xKSBzdGF0ZS53YWl0ZXJzLnNwbGljZShpbmRleCwgMSk7CiAgICAgICAgcmVqZWN0V2FpdCh0aW1lb3V0RXJyb3IoY29udGV4dCwgcHJlcGFyZWQucGF0aCkpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICB3YWl0ZXIudGltZXIgPSBzZXRUaW1lb3V0KGFybVRpbWVvdXQsIE1hdGgubWluKGRlbGF5TXMsIE1BWF9USU1FUl9ERUxBWV9NUykpOwogICAgfTsKICAgIHN0YXRlLndhaXRlcnMucHVzaCh3YWl0ZXIpOwogICAgYXJtVGltZW91dCgpOwogIH0pOwp9CgpmdW5jdGlvbiBkZWNvZGVNb3VudFBhdGgodmFsdWUpIHsKICByZXR1cm4gdmFsdWUucmVwbGFjZSgvXFwoWzAtN117M30pL2csIChfbWF0Y2gsIG9jdGFsKSA9PgogICAgU3RyaW5nLmZyb21DaGFyQ29kZShOdW1iZXIucGFyc2VJbnQob2N0YWwsIDgpKSk7Cn0KCmZ1bmN0aW9uIHBhdGhJc1dpdGhpbihwYXRoLCBtb3VudFBvaW50KSB7CiAgcmV0dXJuIHBhdGggPT09IG1vdW50UG9pbnQgfHwKICAgIHBhdGguc3RhcnRzV2l0aChtb3VudFBvaW50ID09PSBzZXAgPyBtb3VudFBvaW50IDogYCR7bW91bnRQb2ludH0ke3NlcH1gKTsKfQoKZnVuY3Rpb24gZXhlY0ZpbGVVdGY4KGZpbGUsIGFyZ3MsIG9wdGlvbnMsIGNvbnRleHQsIHBhdGgpIHsKICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmVSdW4sIHJlamVjdFJ1bikgPT4gewogICAgbGV0IGRlYWRsaW5lVGltZXI7CiAgICBsZXQgZXhwaXJlZCA9IGZhbHNlOwogICAgY29uc3QgY2hpbGQgPSBleGVjRmlsZSgKICAgICAgZmlsZSwKICAgICAgYXJncywKICAgICAgeyAuLi5vcHRpb25zLCBlbmNvZGluZzogInV0ZjgiIH0sCiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHsKICAgICAgICBpZiAoZGVhZGxpbmVUaW1lciAhPT0gdW5kZWZpbmVkKSBjbGVhclRpbWVvdXQoZGVhZGxpbmVUaW1lcik7CiAgICAgICAgaWYgKGV4cGlyZWQpIHsKICAgICAgICAgIHJlamVjdFJ1bih0aW1lb3V0RXJyb3IoY29udGV4dCwgcGF0aCwgZXJyb3IgPz8gdW5kZWZpbmVkKSk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGlmIChlcnJvciAhPT0gbnVsbCkgewogICAgICAgICAgT2JqZWN0LmFzc2lnbihlcnJvciwgeyBzdGRvdXQsIHN0ZGVyciB9KTsKICAgICAgICAgIHJlamVjdFJ1bihlcnJvcik7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIHJlc29sdmVSdW4oeyBzdGRvdXQsIHN0ZGVyciB9KTsKICAgICAgfSwKICAgICk7CiAgICBjb25zdCBhcm1EZWFkbGluZSA9ICgpID0+IHsKICAgICAgY29uc3QgcmVtYWluaW5nID0gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpOwogICAgICBpZiAocmVtYWluaW5nIDw9IDApIHsKICAgICAgICBleHBpcmVkID0gdHJ1ZTsKICAgICAgICBjaGlsZC5raWxsKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGRlYWRsaW5lVGltZXIgPSBzZXRUaW1lb3V0KAogICAgICAgIGFybURlYWRsaW5lLAogICAgICAgIE1hdGgubWluKHJlbWFpbmluZywgTUFYX1RJTUVSX0RFTEFZX01TKSwKICAgICAgKTsKICAgIH07CiAgICBhcm1EZWFkbGluZSgpOwogIH0pOwp9CgpmdW5jdGlvbiBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgcGF0aCkgewogIGlmICgKICAgIHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KSA8PSAwIHx8CiAgICBlcnJvcj8uY29kZSA9PT0gIkVUSU1FRE9VVCIgfHwKICAgIGVycm9yPy5raWxsZWQgPT09IHRydWUKICApIHsKICAgIHJldHVybiB0aW1lb3V0RXJyb3IoY29udGV4dCwgcGF0aCwgZXJyb3IpOwogIH0KICByZXR1cm4gZXJyb3I7Cn0KCmZ1bmN0aW9uIHZhbGlkYXRlRGFyd2luQWNsTGlzdGluZyhzdGRvdXQsIHBhdGgsIHJvbGUpIHsKICBpZiAoc3Rkb3V0LmluY2x1ZGVzKCJcciIpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCBub24tY2Fub25pY2FsIG91dHB1dCBmb3IgJHtwYXRofWApOwogIH0KICBjb25zdCBsaW5lcyA9IHN0ZG91dC5zcGxpdCgiXG4iKTsKICBpZiAobGluZXMuYXQoLTEpID09PSAiIikgbGluZXMucG9wKCk7CiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCB8fCBsaW5lc1swXS5sZW5ndGggPT09IDApIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIG5vIG1ldGFkYXRhIGZvciAke3BhdGh9YCk7CiAgfQogIGxldCBwcmV2aW91c09yZGluYWwgPSAtMTsKICBsZXQgc2F3TGVnYWN5T3duZXIgPSBmYWxzZTsKICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMuc2xpY2UoMSkpIHsKICAgIGlmICgvXlxzKm93bmVyOlxzK1xTLiokL3UudGVzdChsaW5lKSAmJiAhc2F3TGVnYWN5T3duZXIgJiYgcHJldmlvdXNPcmRpbmFsID09PSAtMSkgewogICAgICBzYXdMZWdhY3lPd25lciA9IHRydWU7CiAgICAgIGNvbnRpbnVlOwogICAgfQogICAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKAogICAgICAvXlxzKihcZCspOlxzKyguKz8pXHMrKD86KGluaGVyaXRlZClccyspPyhhbGxvd3xkZW55KVxzKyhbYS16X10rKD86LFthLXpfXSspKilccyokL3UsCiAgICApOwogICAgaWYgKG1hdGNoID09PSBudWxsKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIHVucmVjb2duaXplZCBvdXRwdXQgZm9yICR7cGF0aH1gKTsKICAgIH0KICAgIGNvbnN0IG9yZGluYWwgPSBOdW1iZXIobWF0Y2hbMV0pOwogICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihvcmRpbmFsKSB8fCBvcmRpbmFsIDw9IHByZXZpb3VzT3JkaW5hbCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCBpbnZhbGlkIEFDRSBvcmRlcmluZyBmb3IgJHtwYXRofWApOwogICAgfQogICAgcHJldmlvdXNPcmRpbmFsID0gb3JkaW5hbDsKICAgIGNvbnN0IGFzc29jaWF0aW9uID0gbWF0Y2hbNF07CiAgICBjb25zdCB0b2tlbnMgPSBtYXRjaFs1XS5zcGxpdCgiLCIpOwogICAgZm9yIChjb25zdCB0b2tlbiBvZiB0b2tlbnMpIHsKICAgICAgaWYgKCFEQVJXSU5fQUNMX0tOT1dOX1RPS0VOUy5oYXModG9rZW4pKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgdW5rbm93biByaWdodCAke3Rva2VufTogJHtwYXRofWApOwogICAgICB9CiAgICB9CiAgICBpZiAoCiAgICAgIGFzc29jaWF0aW9uID09PSAiYWxsb3ciICYmCiAgICAgIHRva2Vucy5zb21lKCh0b2tlbikgPT4gREFSV0lOX0FDTF9NVVRBVElPTl9SSUdIVFMuaGFzKHRva2VuKSkKICAgICkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgICAgYGFnZW5jOiBwcm90ZWN0ZWQgJHtyb2xlfSBoYXMgYSBtdXRhdGlvbi1jYXBhYmxlIERhcndpbiBBQ0w6ICR7cGF0aH1gLAogICAgICApOwogICAgfQogIH0KfQoKYXN5bmMgZnVuY3Rpb24gYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5KHBhdGgsIHJvbGUsIGNvbnRleHQpIHsKICByZXR1cm4gYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5V2l0aElPKAogICAgcGF0aCwKICAgIHJvbGUsCiAgICBjb250ZXh0LAogICAgZXhlY0ZpbGVVdGY4LAogICAgKGNhbmRpZGF0ZSkgPT4gbHN0YXQoY2FuZGlkYXRlLCB7IGJpZ2ludDogdHJ1ZSB9KSwKICApOwp9CgovLyBIRlMrIHJlcG9ydHMgY2hhbmdlIHRpbWUgaW4gd2hvbGUgc2Vjb25kcywgc28gYW4gQUNMIGVkaXQgd2l0aGluIHRoZSBzYW1lCi8vIHNlY29uZCBjYW4gbGVhdmUgdGhlIGlkZW50aXR5IHVuY2hhbmdlZC4gT25seSBzdWItc2Vjb25kIGNoYW5nZSB0aW1lcyBhcmUKLy8gcHJlY2lzZSBlbm91Z2ggdG8gY2FjaGUgYSB2ZXJkaWN0LgpmdW5jdGlvbiBoYXNTdWJzZWNvbmRDaGFuZ2VUaW1lKHN0YXRzKSB7CiAgaWYgKHR5cGVvZiBzdGF0cy5jdGltZU5zID09PSAiYmlnaW50IikgcmV0dXJuIHN0YXRzLmN0aW1lTnMgJSAxXzAwMF8wMDBfMDAwbiAhPT0gMG47CiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShzdGF0cy5jdGltZU1zKSAmJiBzdGF0cy5jdGltZU1zICUgMTAwMCAhPT0gMDsKfQoKZnVuY3Rpb24gZGFyd2luQWNsSWRlbnRpdHkoc3RhdHMpIHsKICByZXR1cm4gWwogICAgc3RhdHMuZGV2LCBzdGF0cy5pbm8sIHN0YXRzLmN0aW1lTnMgPz8gc3RhdHMuY3RpbWVNcywKICAgIHN0YXRzLm1vZGUsIHN0YXRzLnVpZCwgc3RhdHMuZ2lkLAogICAgcHJvY2Vzcy5nZXR1aWQ/LigpLCBwcm9jZXNzLmdldGV1aWQ/LigpLAogIF0uam9pbigiOiIpOwp9Cgphc3luYyBmdW5jdGlvbiBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHlXaXRoSU8ocGF0aCwgcm9sZSwgY29udGV4dCwgbGlzdGVyLCBzdGF0UGF0aCkgewogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIC8vIEEgRGFyd2luIEFDTCBlZGl0IGFkdmFuY2VzIGN0aW1lLiBSZS1zdGF0IG9uIGV2ZXJ5IGxvb2t1cCBzbyBhbiBvbGQKICAvLyBzdWNjZXNzZnVsIHZlcmRpY3QgY2Fubm90IGF1dGhvcml6ZSBhIGNoYW5nZWQgaW5vZGUsIG93bmVyLCBvciBBQ0wuCiAgY29uc3QgYmVmb3JlID0gZGFyd2luQWNsSWRlbnRpdHkoYXdhaXQgc3RhdFBhdGgocGF0aCkpOwogIGNvbnN0IGNhY2hlS2V5ID0gYCR7cm9sZX1cMCR7cGF0aH1gOwogIGlmIChkYXJ3aW5BY2xWZXJkaWN0cy5nZXQoY2FjaGVLZXkpID09PSBiZWZvcmUpIHsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogICAgcmV0dXJuOwogIH0KICBkYXJ3aW5BY2xWZXJkaWN0cy5kZWxldGUoY2FjaGVLZXkpOwogIGxldCByZXN1bHQ7CiAgdHJ5IHsKICAgIHJlc3VsdCA9IGF3YWl0IGxpc3RlcigKICAgICAgIi9iaW4vbHMiLAogICAgICBbIi1sZGVxIiwgcGF0aF0sCiAgICAgIHsKICAgICAgICBlbnY6IHsgTENfQUxMOiAiQyIgfSwKICAgICAgICBtYXhCdWZmZXI6IDI1NiAqIDEwMjQsCiAgICAgIH0sCiAgICAgIGNvbnRleHQsCiAgICAgIHBhdGgsCiAgICApOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgcGF0aCk7CiAgfQogIGlmIChyZXN1bHQuc3RkZXJyICE9PSAiIikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgdW5leHBlY3RlZCBkaWFnbm9zdGljcyBmb3IgJHtwYXRofWApOwogIH0KICB2YWxpZGF0ZURhcndpbkFjbExpc3RpbmcocmVzdWx0LnN0ZG91dCwgcGF0aCwgcm9sZSk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7CiAgLy8gQSBwYXRoIGNoYW5nZWQgd2hpbGUgbHMgcmFuIG11c3QgbmV2ZXIgc2VlZCBhIHZlcmRpY3QgZm9yIGl0cyBuZXcgc3RhdGUuCiAgY29uc3QgYWZ0ZXJTdGF0cyA9IGF3YWl0IHN0YXRQYXRoKHBhdGgpOwogIGNvbnN0IGFmdGVyID0gZGFyd2luQWNsSWRlbnRpdHkoYWZ0ZXJTdGF0cyk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7CiAgaWYgKGFmdGVyID09PSBiZWZvcmUgJiYgaGFzU3Vic2Vjb25kQ2hhbmdlVGltZShhZnRlclN0YXRzKSkgewogICAgaWYgKGRhcndpbkFjbFZlcmRpY3RzLnNpemUgPj0gREFSV0lOX0FDTF9WRVJESUNUX0NBQ0hFX0xJTUlUKSB7CiAgICAgIGRhcndpbkFjbFZlcmRpY3RzLmRlbGV0ZShkYXJ3aW5BY2xWZXJkaWN0cy5rZXlzKCkubmV4dCgpLnZhbHVlKTsKICAgIH0KICAgIGRhcndpbkFjbFZlcmRpY3RzLnNldChjYWNoZUtleSwgYmVmb3JlKTsKICB9Cn0KCmZ1bmN0aW9uIHRydXN0ZWRXaW5kb3dzUG93ZXJTaGVsbFBhdGgoCiAgY2Fub25pY2FsaXplID0gcmVhbHBhdGhTeW5jLm5hdGl2ZSwKICBmaWxlc3lzdGVtID0gV0lORE9XU19FWEVDVVRBQkxFX0ZJTEVTWVNURU0sCikgewogIC8vIERlcml2ZSBhIENyZWF0ZVByb2Nlc3MtY29tcGF0aWJsZSBET1Mgc3BlbGxpbmcgZnJvbSBHTE9CQUxST09ULCB0aGVuIHByb3ZlCiAgLy8gYm90aCBzcGVsbGluZ3Mgc3RpbGwgbmFtZSB0aGUgc2FtZSByZWd1bGFyIHN5c3RlbSBmaWxlIGJlZm9yZSBsYXVuY2guCiAgY29uc3Qgc3lzdGVtUm9vdCA9IGNhbm9uaWNhbGl6ZShXSU5ET1dTX1NZU1RFTV9ST09UKTsKICBpZiAoIS9eW2Etel06XFwvaXUudGVzdChzeXN0ZW1Sb290KSB8fCB3aW4zMi5ub3JtYWxpemUoc3lzdGVtUm9vdCkgIT09IHN5c3RlbVJvb3QpIHsKICAgIHRocm93IG5ldyBFcnJvcigidHJ1c3RlZCBXaW5kb3dzIFN5c3RlbVJvb3QgZGlkIG5vdCByZXNvbHZlIHRvIGEgY2Fub25pY2FsIGxvY2FsIERPUyBwYXRoIik7CiAgfQogIGNvbnN0IHdvcmtpbmdEaXJlY3RvcnkgPSB3aW4zMi5qb2luKHN5c3RlbVJvb3QsICJTeXN0ZW0zMiIpOwogIGNvbnN0IGV4ZWN1dGFibGUgPSB3aW4zMi5qb2luKAogICAgd29ya2luZ0RpcmVjdG9yeSwKICAgICJXaW5kb3dzUG93ZXJTaGVsbCIsCiAgICAidjEuMCIsCiAgICAicG93ZXJzaGVsbC5leGUiLAogICk7CiAgY29uc3QgbmFtZXNwYWNlRXhlY3V0YWJsZSA9IHdpbjMyLmpvaW4oCiAgICBXSU5ET1dTX1NZU1RFTV9ST09ULAogICAgIlN5c3RlbTMyIiwKICAgICJXaW5kb3dzUG93ZXJTaGVsbCIsCiAgICAidjEuMCIsCiAgICAicG93ZXJzaGVsbC5leGUiLAogICk7CiAgdmVyaWZ5V2luZG93c0V4ZWN1dGFibGVBbGlhc2VzKG5hbWVzcGFjZUV4ZWN1dGFibGUsIGV4ZWN1dGFibGUsIGZpbGVzeXN0ZW0pOwogIHJldHVybiB7CiAgICBzeXN0ZW1Sb290LAogICAgd29ya2luZ0RpcmVjdG9yeSwKICAgIGV4ZWN1dGFibGUsCiAgfTsKfQoKZnVuY3Rpb24gdmVyaWZ5V2luZG93c0V4ZWN1dGFibGVBbGlhc2VzKG5hbWVzcGFjZUV4ZWN1dGFibGUsIGV4ZWN1dGFibGUsIGZpbGVzeXN0ZW0pIHsKICBsZXQgbmFtZXNwYWNlRGVzY3JpcHRvcjsKICBsZXQgY2FuZGlkYXRlRGVzY3JpcHRvcjsKICBsZXQgb3BlcmF0aW9uRXJyb3I7CiAgdHJ5IHsKICAgIGNvbnN0IG5hbWVzcGFjZUJlZm9yZSA9IGZpbGVzeXN0ZW0ubHN0YXQobmFtZXNwYWNlRXhlY3V0YWJsZSk7CiAgICBjb25zdCBjYW5kaWRhdGVCZWZvcmUgPSBmaWxlc3lzdGVtLmxzdGF0KGV4ZWN1dGFibGUpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKG5hbWVzcGFjZUJlZm9yZSwgIkdMT0JBTFJPT1QgcGF0aCIpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGNhbmRpZGF0ZUJlZm9yZSwgIkRPUyBwYXRoIik7CiAgICBuYW1lc3BhY2VEZXNjcmlwdG9yID0gZmlsZXN5c3RlbS5vcGVuKG5hbWVzcGFjZUV4ZWN1dGFibGUpOwogICAgY2FuZGlkYXRlRGVzY3JpcHRvciA9IGZpbGVzeXN0ZW0ub3BlbihleGVjdXRhYmxlKTsKICAgIGNvbnN0IG5hbWVzcGFjZU9wZW5lZCA9IGZpbGVzeXN0ZW0uZnN0YXQobmFtZXNwYWNlRGVzY3JpcHRvcik7CiAgICBjb25zdCBjYW5kaWRhdGVPcGVuZWQgPSBmaWxlc3lzdGVtLmZzdGF0KGNhbmRpZGF0ZURlc2NyaXB0b3IpOwogICAgY29uc3QgbmFtZXNwYWNlQWZ0ZXIgPSBmaWxlc3lzdGVtLmxzdGF0KG5hbWVzcGFjZUV4ZWN1dGFibGUpOwogICAgY29uc3QgY2FuZGlkYXRlQWZ0ZXIgPSBmaWxlc3lzdGVtLmxzdGF0KGV4ZWN1dGFibGUpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKG5hbWVzcGFjZU9wZW5lZCwgIkdMT0JBTFJPT1QgZGVzY3JpcHRvciIpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGNhbmRpZGF0ZU9wZW5lZCwgIkRPUyBkZXNjcmlwdG9yIik7CiAgICBhc3NlcnRSZWd1bGFyV2luZG93c0V4ZWN1dGFibGUobmFtZXNwYWNlQWZ0ZXIsICJHTE9CQUxST09UIHBhdGgiKTsKICAgIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShjYW5kaWRhdGVBZnRlciwgIkRPUyBwYXRoIik7CiAgICBmb3IgKGNvbnN0IGlkZW50aXR5IG9mIFsKICAgICAgbmFtZXNwYWNlQmVmb3JlLAogICAgICBjYW5kaWRhdGVCZWZvcmUsCiAgICAgIG5hbWVzcGFjZU9wZW5lZCwKICAgICAgY2FuZGlkYXRlT3BlbmVkLAogICAgICBuYW1lc3BhY2VBZnRlciwKICAgICAgY2FuZGlkYXRlQWZ0ZXIsCiAgICBdKSB7CiAgICAgIGlmICgKICAgICAgICBpZGVudGl0eS5kZXYgPD0gMG4gfHwgaWRlbnRpdHkuaW5vIDw9IDBuIHx8CiAgICAgICAgaWRlbnRpdHkuZGV2ID09PSBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0IHx8IGlkZW50aXR5LmlubyA9PT0gVU5TVVBQT1JURURfRklMRV9JRF82NAogICAgICApIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInRydXN0ZWQgV2luZG93cyBzeXN0ZW0gZXhlY3V0YWJsZSBpZGVudGl0eSBpcyB1bmF2YWlsYWJsZSIpOwogICAgICB9CiAgICB9CiAgICBpZiAoCiAgICAgICFzYW1lRmlsZUlkZW50aXR5KG5hbWVzcGFjZUJlZm9yZSwgbmFtZXNwYWNlT3BlbmVkKSB8fAogICAgICAhc2FtZUZpbGVJZGVudGl0eShuYW1lc3BhY2VPcGVuZWQsIG5hbWVzcGFjZUFmdGVyKSB8fAogICAgICAhc2FtZUZpbGVJZGVudGl0eShjYW5kaWRhdGVCZWZvcmUsIGNhbmRpZGF0ZU9wZW5lZCkgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkoY2FuZGlkYXRlT3BlbmVkLCBjYW5kaWRhdGVBZnRlcikgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkobmFtZXNwYWNlT3BlbmVkLCBjYW5kaWRhdGVPcGVuZWQpCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJ0cnVzdGVkIFdpbmRvd3Mgc3lzdGVtIGV4ZWN1dGFibGUgaWRlbnRpdHkgbWlzbWF0Y2giKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgb3BlcmF0aW9uRXJyb3IgPSBlcnJvcjsKICB9CiAgY29uc3QgY2xvc2VFcnJvcnMgPSBbXTsKICBmb3IgKGNvbnN0IGRlc2NyaXB0b3Igb2YgW2NhbmRpZGF0ZURlc2NyaXB0b3IsIG5hbWVzcGFjZURlc2NyaXB0b3JdKSB7CiAgICBpZiAoZGVzY3JpcHRvciA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTsKICAgIHRyeSB7IGZpbGVzeXN0ZW0uY2xvc2UoZGVzY3JpcHRvcik7IH0gY2F0Y2ggKGVycm9yKSB7IGNsb3NlRXJyb3JzLnB1c2goZXJyb3IpOyB9CiAgfQogIGlmIChvcGVyYXRpb25FcnJvciAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAoY2xvc2VFcnJvcnMubGVuZ3RoID4gMCkgewogICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgICAgW29wZXJhdGlvbkVycm9yLCAuLi5jbG9zZUVycm9yc10sCiAgICAgICAgInRydXN0ZWQgV2luZG93cyBleGVjdXRhYmxlIHZhbGlkYXRpb24gYW5kIGNsZWFudXAgYm90aCBmYWlsZWQiLAogICAgICApOwogICAgfQogICAgdGhyb3cgb3BlcmF0aW9uRXJyb3I7CiAgfQogIGlmIChjbG9zZUVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGNsb3NlRXJyb3JzWzBdOwogIGlmIChjbG9zZUVycm9ycy5sZW5ndGggPiAxKSB7CiAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgIGNsb3NlRXJyb3JzLAogICAgICAidHJ1c3RlZCBXaW5kb3dzIGV4ZWN1dGFibGUgZGVzY3JpcHRvciBjbGVhbnVwIGZhaWxlZCIsCiAgICApOwogIH0KfQoKZnVuY3Rpb24gYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGlkZW50aXR5LCBzcGVsbGluZykgewogIGlmICghaWRlbnRpdHkuaXNGaWxlKCkgfHwgaWRlbnRpdHkuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGB0cnVzdGVkIFdpbmRvd3MgJHtzcGVsbGluZ30gZXhlY3V0YWJsZSBpcyBub3QgYSByZWd1bGFyIG5vbi1saW5rIGZpbGVgKTsKICB9Cn0KCmZ1bmN0aW9uIHNhbWVGaWxlSWRlbnRpdHkobGVmdCwgcmlnaHQpIHsKICByZXR1cm4gbGVmdC5kZXYgPT09IHJpZ2h0LmRldiAmJiBsZWZ0LmlubyA9PT0gcmlnaHQuaW5vOwp9CgpmdW5jdGlvbiB3aW5kb3dzUG93ZXJTaGVsbEVudmlyb25tZW50KHBhdGhzLCB0cnVzdGVkUGF0aHMgPSB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKCkpIHsKICBjb25zdCB7IHN5c3RlbVJvb3QsIHdvcmtpbmdEaXJlY3RvcnkgfSA9IHRydXN0ZWRQYXRoczsKICAvLyBsaWJ1diBmaWxscyBhIGZpeGVkIHNldCBvZiAicmVxdWlyZWQiIFdpbmRvd3MgdmFyaWFibGVzIGZyb20gdGhlIHBhcmVudAogIC8vIHdoZW4gdGhleSBhcmUgYWJzZW50LiBEZWZpbmUgZXZlcnkgb25lIHNvIHBvaXNvbmVkIGNhbGxlciBzdGF0ZSBjYW5ub3QgYmUKICAvLyBzaWxlbnRseSBpbmhlcml0ZWQgaW50byB0aGUgdmFsaWRhdGlvbiBoZWxwZXIuCiAgcmV0dXJuIHsKICAgIEFHRU5DX0xPQ0tfUEFUSFM6IHdpbmRvd3NQYXRoVHJhbnNwb3J0KHBhdGhzKSwKICAgIEFQUERBVEE6ICIiLAogICAgQ09NU1BFQzogIiIsCiAgICBIT01FRFJJVkU6ICIiLAogICAgSE9NRVBBVEg6ICIiLAogICAgTE9DQUxBUFBEQVRBOiAiIiwKICAgIExPR09OU0VSVkVSOiAiIiwKICAgIFBBVEg6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBQQVRIRVhUOiAiLkVYRSIsCiAgICBQU01PRFVMRVBBVEg6ICIiLAogICAgU1lTVEVNRFJJVkU6ICIiLAogICAgU1lTVEVNUk9PVDogc3lzdGVtUm9vdCwKICAgIFRFTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBUTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBVU0VSRE9NQUlOOiAiIiwKICAgIFVTRVJOQU1FOiAiIiwKICAgIFVTRVJQUk9GSUxFOiB3b3JraW5nRGlyZWN0b3J5LAogICAgV0lORElSOiBzeXN0ZW1Sb290LAogIH07Cn0KCmZ1bmN0aW9uIHdpbmRvd3NQYXRoVHJhbnNwb3J0KGVudHJpZXMpIHsKICBpZiAoCiAgICAhQXJyYXkuaXNBcnJheShlbnRyaWVzKSB8fAogICAgZW50cmllcy5sZW5ndGggPCAxIHx8CiAgICBlbnRyaWVzLmxlbmd0aCA+IFdJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0VOVFJJRVMKICApIHsKICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFdpbmRvd3MgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0IGhhcyBhbiBpbnZhbGlkIGVudHJ5IGNvdW50Iik7CiAgfQogIGNvbnN0IHJlY29yZHMgPSBbXTsKICBsZXQgdHJhbnNwb3J0Q2hhcnMgPSAwOwogIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykgewogICAgY29uc3QgcGF0aCA9IGVudHJ5Py5wYXRoOwogICAgY29uc3Qgcm9sZSA9IGVudHJ5Py5yb2xlOwogICAgaWYgKAogICAgICB0eXBlb2YgcGF0aCAhPT0gInN0cmluZyIgfHwKICAgICAgcGF0aC5sZW5ndGggPT09IDAgfHwKICAgICAgcGF0aC5sZW5ndGggPiBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSUyB8fAogICAgICAocm9sZSAhPT0gImxlYWZEaXJlY3RvcnkiICYmIHJvbGUgIT09ICJhbmNlc3RvckRpcmVjdG9yeSIgJiYgcm9sZSAhPT0gImZpbGUiKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFdpbmRvd3MgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0IGVudHJ5IGlzIGludmFsaWQiKTsKICAgIH0KICAgIGNvbnN0IHJlY29yZCA9IGAke3JvbGV9OiR7QnVmZmVyLmZyb20ocGF0aCwgInV0ZjE2bGUiKS50b1N0cmluZygiYmFzZTY0Iil9YDsKICAgIHRyYW5zcG9ydENoYXJzICs9IHJlY29yZC5sZW5ndGggKyAocmVjb3Jkcy5sZW5ndGggPT09IDAgPyAwIDogMSk7CiAgICBpZiAodHJhbnNwb3J0Q2hhcnMgPiBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSUykgewogICAgICB0aHJvdyBuZXcgRXJyb3IoImFnZW5jOiBXaW5kb3dzIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCBleGNlZWRzIGl0cyBsaW1pdCIpOwogICAgfQogICAgcmVjb3Jkcy5wdXNoKHJlY29yZCk7CiAgfQogIHJldHVybiByZWNvcmRzLmpvaW4oIlxuIik7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoZW50cmllcywgY29udGV4dCkgewogIGNvbnN0IGRpc3BsYXlQYXRoID0gZW50cmllcy5hdCgtMSk/LnBhdGggPz8gInVua25vd24iOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGRpc3BsYXlQYXRoKTsKICBjb25zdCB0cnVzdGVkUGF0aHMgPSB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKCk7CiAgY29uc3QgeyB3b3JraW5nRGlyZWN0b3J5LCBleGVjdXRhYmxlIH0gPSB0cnVzdGVkUGF0aHM7CiAgbGV0IHJlc3VsdDsKICB0cnkgewogICAgcmVzdWx0ID0gYXdhaXQgZXhlY0ZpbGVVdGY4KAogICAgICBleGVjdXRhYmxlLAogICAgICBbCiAgICAgICAgIi1Ob0xvZ28iLAogICAgICAgICItTm9Qcm9maWxlIiwKICAgICAgICAiLU5vbkludGVyYWN0aXZlIiwKICAgICAgICAiLUVuY29kZWRDb21tYW5kIiwKICAgICAgICBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVF9CQVNFNjQsCiAgICAgIF0sCiAgICAgIHsKICAgICAgICBjd2Q6IHdvcmtpbmdEaXJlY3RvcnksCiAgICAgICAgZW52OiB3aW5kb3dzUG93ZXJTaGVsbEVudmlyb25tZW50KGVudHJpZXMsIHRydXN0ZWRQYXRocyksCiAgICAgICAgbWF4QnVmZmVyOiAxMDI0ICogMTAyNCwKICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSwKICAgICAgfSwKICAgICAgY29udGV4dCwKICAgICAgZGlzcGxheVBhdGgsCiAgICApOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgZGlzcGxheVBhdGgpOwogIH0KICBpZiAocmVzdWx0LnN0ZG91dCAhPT0gIk9LIikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogV2luZG93cyBsb2NrLXBhdGggdmFsaWRhdGlvbiByZXR1cm5lZCBhbiBpbnZhbGlkIHJlc3BvbnNlIGZvciAke2Rpc3BsYXlQYXRofWApOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBkaXNwbGF5UGF0aCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydExvY2FsRmlsZXN5c3RlbShwYXJlbnQsIGNvbnRleHQpIHsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXJlbnQpOwogIGxldCBmaWxlc3lzdGVtVHlwZTsKICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImxpbnV4IikgewogICAgY29uc3QgbW91bnRzID0gYXdhaXQgcmVhZEZpbGUoIi9wcm9jL3NlbGYvbW91bnRpbmZvIiwgInV0ZjgiKTsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhcmVudCk7CiAgICBsZXQgbG9uZ2VzdCA9IC0xOwogICAgZm9yIChjb25zdCBsaW5lIG9mIG1vdW50cy5zcGxpdCgiXG4iKSkgewogICAgICBjb25zdCBmaWVsZHMgPSBsaW5lLnNwbGl0KCIgIik7CiAgICAgIGNvbnN0IHNlcGFyYXRvckluZGV4ID0gZmllbGRzLmluZGV4T2YoIi0iKTsKICAgICAgaWYgKAogICAgICAgIHNlcGFyYXRvckluZGV4IDwgNiB8fAogICAgICAgIGZpZWxkc1s0XSA9PT0gdW5kZWZpbmVkIHx8CiAgICAgICAgZmllbGRzW3NlcGFyYXRvckluZGV4ICsgMV0gPT09IHVuZGVmaW5lZAogICAgICApIGNvbnRpbnVlOwogICAgICBjb25zdCBtb3VudFBvaW50ID0gZGVjb2RlTW91bnRQYXRoKGZpZWxkc1s0XSk7CiAgICAgIGlmIChwYXRoSXNXaXRoaW4ocGFyZW50LCBtb3VudFBvaW50KSAmJiBtb3VudFBvaW50Lmxlbmd0aCA+IGxvbmdlc3QpIHsKICAgICAgICBsb25nZXN0ID0gbW91bnRQb2ludC5sZW5ndGg7CiAgICAgICAgZmlsZXN5c3RlbVR5cGUgPSBmaWVsZHNbc2VwYXJhdG9ySW5kZXggKyAxXTsKICAgICAgfQogICAgfQogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGxldCBzdGRvdXQ7CiAgICB0cnkgewogICAgICAoeyBzdGRvdXQgfSA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgiL3NiaW4vbW91bnQiLCBbXSwgewogICAgICAgIGVudjogeyBMQ19BTEw6ICJDIiB9LAogICAgICAgIG1heEJ1ZmZlcjogNCAqIDEwMjQgKiAxMDI0LAogICAgICB9LCBjb250ZXh0LCBwYXJlbnQpKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHRocm93IG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBjb250ZXh0LCBwYXJlbnQpOwogICAgfQogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGFyZW50KTsKICAgIGxldCBsb25nZXN0ID0gLTE7CiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3Rkb3V0LnNwbGl0KCJcbiIpKSB7CiAgICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgvIG9uICguKykgXCgoW14sXSspLyk7CiAgICAgIGlmIChtYXRjaCA9PT0gbnVsbCkgY29udGludWU7CiAgICAgIGNvbnN0IG1vdW50UG9pbnQgPSBkZWNvZGVNb3VudFBhdGgobWF0Y2hbMV0pOwogICAgICBpZiAocGF0aElzV2l0aGluKHBhcmVudCwgbW91bnRQb2ludCkgJiYgbW91bnRQb2ludC5sZW5ndGggPiBsb25nZXN0KSB7CiAgICAgICAgbG9uZ2VzdCA9IG1vdW50UG9pbnQubGVuZ3RoOwogICAgICAgIGZpbGVzeXN0ZW1UeXBlID0gbWF0Y2hbMl07CiAgICAgIH0KICAgIH0KICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoW3sgcGF0aDogcGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfV0sIGNvbnRleHQpOwogICAgcmV0dXJuOwogIH0gZWxzZSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogY2Fubm90IGVzdGFibGlzaCBsb2NrIGZpbGVzeXN0ZW0gbG9jYWxpdHkgb24gJHtwcm9jZXNzLnBsYXRmb3JtfWAsCiAgICApOwogIH0KICBpZiAoZmlsZXN5c3RlbVR5cGUgPT09IHVuZGVmaW5lZCB8fCAhTE9DQUxfRklMRVNZU1RFTV9UWVBFUy5oYXMoZmlsZXN5c3RlbVR5cGUpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogbm9uLWxvY2FsIG9yIHVua25vd24gbG9jayBmaWxlc3lzdGVtIGlzIHVuc3VwcG9ydGVkICgke2ZpbGVzeXN0ZW1UeXBlID8/ICJ1bmtub3duIn0pOiAke3BhcmVudH1gLAogICAgKTsKICB9Cn0KCi8qKgogKiBFc3RhYmxpc2ggdGhhdCBhbiBleGlzdGluZyBkaXJlY3RvcnkgaXMgYSBsb2NhbCwgcHJpdmF0ZWx5IG11dGFibGUKICogY29vcmRpbmF0aW9uIGJvdW5kYXJ5LiBXcmFwcGVyIHJlcGxhY2VtZW50IHVzZXMgYSByZWdpc3RyeS1ob3N0ZWQgU1FMaXRlCiAqIGxvY2ssIHNvIGEgc2hhcmVkIG9yIGF0dGFja2VyLXdyaXRhYmxlIHdyYXBwZXIgZGlyZWN0b3J5IHdvdWxkIG90aGVyd2lzZQogKiBwZXJtaXQgY3Jvc3MtaG9zdCByYWNlcyBvciBwYXRoIHN1YnN0aXR1dGlvbiBvdXRzaWRlIHRoYXQgbG9jay4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhc3NlcnRMb2NhbFByaXZhdGVEaXJlY3RvcnkoCiAgcmVxdWVzdGVkUGF0aCwKICB7CiAgICB0aW1lb3V0TXMgPSA2MF8wMDAsCiAgICBsYWJlbCA9ICJBZ2VuQyBvcGVyYXRpb24iLAogICAgZGVhZGxpbmU6IHN1cHBsaWVkRGVhZGxpbmUsCiAgICBhbGxvd1RydXN0ZWRTdGlja3lMZWFmID0gZmFsc2UsCiAgICBvblByb2dyZXNzLAogIH0gPSB7fSwKKSB7CiAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcih0aW1lb3V0TXMpIHx8IHRpbWVvdXRNcyA8PSAwKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIHRpbWVvdXRNcyBtdXN0IGJlIGEgcG9zaXRpdmUgc2FmZSBpbnRlZ2VyIik7CiAgfQogIGlmIChzdXBwbGllZERlYWRsaW5lICE9PSB1bmRlZmluZWQgJiYgIU51bWJlci5pc0Zpbml0ZShzdXBwbGllZERlYWRsaW5lKSkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBkZWFkbGluZSBtdXN0IGJlIGZpbml0ZSIpOwogIH0KICBpZiAodHlwZW9mIGFsbG93VHJ1c3RlZFN0aWNreUxlYWYgIT09ICJib29sZWFuIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigiYWxsb3dUcnVzdGVkU3RpY2t5TGVhZiBtdXN0IGJlIGJvb2xlYW4iKTsKICB9CiAgaWYgKG9uUHJvZ3Jlc3MgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb25Qcm9ncmVzcyAhPT0gImZ1bmN0aW9uIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBvblByb2dyZXNzIG11c3QgYmUgYSBmdW5jdGlvbiIpOwogIH0KICBjb25zdCBjb250ZXh0ID0gewogICAgZGVhZGxpbmU6IE1hdGgubWluKAogICAgICBzdXBwbGllZERlYWRsaW5lID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwKICAgICAgcGVyZm9ybWFuY2Uubm93KCkgKyB0aW1lb3V0TXMsCiAgICApLAogICAgbGFiZWwsCiAgICB0aW1lb3V0TXMsCiAgICBvblByb2dyZXNzLAogIH07CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgInByaXZhdGUgZGlyZWN0b3J5IHZhbGlkYXRpb24gc3RhcnRlZCIpOwogIGNvbnN0IGFic29sdXRlID0gcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgY29uc3QgY2Fub25pY2FsID0gYXdhaXQgcmVhbHBhdGgoYWJzb2x1dGUpOwogIGNvbnN0IGFuY2VzdG9ycyA9IFtdOwogIGZvciAobGV0IGN1cnJlbnQgPSBjYW5vbmljYWw7IDsgY3VycmVudCA9IGRpcm5hbWUoY3VycmVudCkpIHsKICAgIGFuY2VzdG9ycy5wdXNoKGN1cnJlbnQpOwogICAgaWYgKGRpcm5hbWUoY3VycmVudCkgPT09IGN1cnJlbnQpIGJyZWFrOwogIH0KICBjb25zdCBjdXJyZW50VWlkID0gcHJvY2Vzcy5nZXR1aWQ/LigpOwogIGNvbnN0IGJlZm9yZUlkZW50aXRpZXMgPSBuZXcgTWFwKCk7CiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGFuY2VzdG9ycy5sZW5ndGg7IGluZGV4ICs9IDEpIHsKICAgIGNvbnN0IHBhdGggPSBhbmNlc3RvcnNbaW5kZXhdOwogICAgY29uc3Qgc3RhdHMgPSBhd2FpdCBsc3RhdChwYXRoLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICAgIGlmICghc3RhdHMuaXNEaXJlY3RvcnkoKSB8fCBzdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBwYXRoIGFuY2VzdG9yIGlzIG5vdCBhIHJlYWwgZGlyZWN0b3J5OiAke3BhdGh9YCk7CiAgICB9CiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gIndpbjMyIikgewogICAgICBjb25zdCBsZWFmID0gaW5kZXggPT09IDA7CiAgICAgIGNvbnN0IHRydXN0ZWRPd25lciA9IHN0YXRzLnVpZCA9PT0gMG4gfHwKICAgICAgICAoY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmIHN0YXRzLnVpZCA9PT0gQmlnSW50KGN1cnJlbnRVaWQpKTsKICAgICAgY29uc3Qgc3RpY2t5Qm91bmRhcnkgPSAoIWxlYWYgfHwgYWxsb3dUcnVzdGVkU3RpY2t5TGVhZikgJiYKICAgICAgICAoc3RhdHMubW9kZSAmIDBvMTAwMG4pICE9PSAwbiAmJiB0cnVzdGVkT3duZXI7CiAgICAgIGlmICghdHJ1c3RlZE93bmVyIHx8ICgoc3RhdHMubW9kZSAmIDBvMDIybikgIT09IDBuICYmICFzdGlja3lCb3VuZGFyeSkpIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgICAgICBgYWdlbmM6IHByb3RlY3RlZCBkaXJlY3RvcnkgY2hhaW4gcGVybWl0cyB1bnRydXN0ZWQgbXV0YXRpb246ICR7cGF0aH07IGAgKwogICAgICAgICAgInJlbW92ZSBncm91cC93b3JsZCB3cml0ZSBhY2Nlc3MgYmVmb3JlIHJldHJ5aW5nIiwKICAgICAgICApOwogICAgICB9CiAgICAgIGlmICgKICAgICAgICBsZWFmICYmICFzdGlja3lCb3VuZGFyeSAmJiBjdXJyZW50VWlkICE9PSB1bmRlZmluZWQgJiYKICAgICAgICBzdGF0cy51aWQgIT09IEJpZ0ludChjdXJyZW50VWlkKQogICAgICApIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZGlyZWN0b3J5IGlzIG5vdCBvd25lZCBieSB0aGUgY3VycmVudCB1c2VyOiAke3BhdGh9YCk7CiAgICAgIH0KICAgIH0KICAgIGJlZm9yZUlkZW50aXRpZXMuc2V0KHBhdGgsIHsgZGV2OiBzdGF0cy5kZXYsIGlubzogc3RhdHMuaW5vIH0pOwogICAgaWRlbnRpdHlGcm9tU3RhdHMoc3RhdHMsIHBhdGgpOwogIH0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gIndpbjMyIikgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIldpbmRvd3MgYW5jZXN0b3IgQUNMIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eSgKICAgICAgYW5jZXN0b3JzLm1hcCgocGF0aCwgaW5kZXgpID0+ICh7CiAgICAgICAgcGF0aCwKICAgICAgICByb2xlOiBpbmRleCA9PT0gMCA/ICJsZWFmRGlyZWN0b3J5IiA6ICJhbmNlc3RvckRpcmVjdG9yeSIsCiAgICAgIH0pKSwKICAgICAgY29udGV4dCwKICAgICk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiV2luZG93cyBhbmNlc3RvciBBQ0wgdmFsaWRhdGlvbiBjb21wbGV0ZSIpOwogIH0gZWxzZSB7CiAgICBhd2FpdCBhc3NlcnRMb2NhbEZpbGVzeXN0ZW0oY2Fub25pY2FsLCBjb250ZXh0KTsKICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgYW5jZXN0b3JzLmxlbmd0aDsgaW5kZXggKz0gMSkgewogICAgICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eSgKICAgICAgICAgIGFuY2VzdG9yc1tpbmRleF0sCiAgICAgICAgICBpbmRleCA9PT0gMCA/ICJsZWFmIGRpcmVjdG9yeSIgOiAiYW5jZXN0b3IgZGlyZWN0b3J5IiwKICAgICAgICAgIGNvbnRleHQsCiAgICAgICAgKTsKICAgICAgfQogICAgfQogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGZvciAoY29uc3QgcGF0aCBvZiBhbmNlc3RvcnMpIHsKICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBjb25zdCBiZWZvcmUgPSBiZWZvcmVJZGVudGl0aWVzLmdldChwYXRoKTsKICAgIGlmICgKICAgICAgIWFmdGVyLmlzRGlyZWN0b3J5KCkgfHwgYWZ0ZXIuaXNTeW1ib2xpY0xpbmsoKSB8fCBiZWZvcmUgPT09IHVuZGVmaW5lZCB8fAogICAgICBhZnRlci5kZXYgIT09IGJlZm9yZS5kZXYgfHwgYWZ0ZXIuaW5vICE9PSBiZWZvcmUuaW5vCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGRpcmVjdG9yeSBpZGVudGl0eSBjaGFuZ2VkIGR1cmluZyB2YWxpZGF0aW9uOiAke3BhdGh9YCk7CiAgICB9CiAgfQogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJwcml2YXRlIGRpcmVjdG9yeSB2YWxpZGF0aW9uIGNvbXBsZXRlIik7CiAgcmV0dXJuIGNhbm9uaWNhbDsKfQoKZnVuY3Rpb24gYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc3RhdHMsIHBhdGgpIHsKICBpZiAoIXN0YXRzLmlzRmlsZSgpIHx8IHN0YXRzLmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaXMgbm90IGEgcmVndWxhciBmaWxlOiAke3BhdGh9YCk7CiAgfQogIGlmIChzdGF0cy5ubGluayAhPT0gMW4pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgbXVzdCBub3QgaGF2ZSBoYXJkLWxpbmsgYWxpYXNlczogJHtwYXRofWApOwogIH0KfQoKZnVuY3Rpb24gaWRlbnRpdHlGcm9tU3RhdHMoc3RhdHMsIHBhdGgpIHsKICBpZiAoCiAgICBzdGF0cy5kZXYgPT09IDBuIHx8CiAgICBzdGF0cy5pbm8gPT09IDBuIHx8CiAgICBzdGF0cy5pbm8gPT09IC0xbiB8fAogICAgQmlnSW50LmFzVWludE4oNjQsIHN0YXRzLmlubykgPT09IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQKICApIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaGFzIG5vIHN0YWJsZSBmaWxlc3lzdGVtIGlkZW50aXR5OiAke3BhdGh9YCk7CiAgfQogIHJldHVybiBgJHtzdGF0cy5kZXZ9OiR7c3RhdHMuaW5vfWA7Cn0KCmZ1bmN0aW9uIGFzc2VydFBvc2l4T3duZXJzaGlwKHN0YXRzLCBwYXRoLCBraW5kKSB7CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHJldHVybjsKICBjb25zdCBjdXJyZW50VWlkID0gcHJvY2Vzcy5nZXR1aWQ/LigpOwogIGlmIChjdXJyZW50VWlkICE9PSB1bmRlZmluZWQgJiYgc3RhdHMudWlkICE9PSBCaWdJbnQoY3VycmVudFVpZCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgJHtraW5kfSBpcyBub3Qgb3duZWQgYnkgdGhlIGN1cnJlbnQgdXNlcjogJHtwYXRofWApOwogIH0KICBpZiAoKHN0YXRzLm1vZGUgJiAwbzAyMm4pICE9PSAwbikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSAke2tpbmR9IGlzIGdyb3VwL3dvcmxkLXdyaXRhYmxlOiAke3BhdGh9YCk7CiAgfQp9CgovKioKICogVmFsaWRhdGUgYSByZWd1bGFyIGZpbGUgYW5kIGl0cyBjb21wbGV0ZSBkaXJlY3RvcnkgY2hhaW4gYmVmb3JlIGEgY2FsbGVyCiAqIHRydXN0cyBpdHMgY29udGVudHMuIFRoaXMgaXMgaW50ZW50aW9uYWxseSBub24tbXV0YXRpbmc6IHVuc2FmZSBvd25lcnNoaXAsCiAqIG1vZGUgYml0cywgQUNMcywgYWxpYXNlcywgb3IgaWRlbnRpdHkgY2hhbmdlcyBmYWlsIGNsb3NlZC4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhc3NlcnRMb2NhbFByaXZhdGVGaWxlKAogIHJlcXVlc3RlZFBhdGgsCiAgewogICAgdGltZW91dE1zID0gNjBfMDAwLAogICAgbGFiZWwgPSAiQWdlbkMgb3BlcmF0aW9uIiwKICAgIGRlYWRsaW5lOiBzdXBwbGllZERlYWRsaW5lLAogICAgb25Qcm9ncmVzcywKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgaWYgKG9uUHJvZ3Jlc3MgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb25Qcm9ncmVzcyAhPT0gImZ1bmN0aW9uIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBvblByb2dyZXNzIG11c3QgYmUgYSBmdW5jdGlvbiIpOwogIH0KICBjb25zdCBjb250ZXh0ID0gewogICAgZGVhZGxpbmU6IE1hdGgubWluKAogICAgICBzdXBwbGllZERlYWRsaW5lID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwKICAgICAgcGVyZm9ybWFuY2Uubm93KCkgKyB0aW1lb3V0TXMsCiAgICApLAogICAgbGFiZWwsCiAgICB0aW1lb3V0TXMsCiAgICBvblByb2dyZXNzLAogIH07CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgInByaXZhdGUgZmlsZSB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUocmVxdWVzdGVkUGF0aCk7CiAgY29uc3QgcGFyZW50ID0gZGlybmFtZShhYnNvbHV0ZSk7CiAgY29uc3QgY2Fub25pY2FsUGFyZW50ID0gYXdhaXQgYXNzZXJ0TG9jYWxQcml2YXRlRGlyZWN0b3J5KHBhcmVudCwgewogICAgdGltZW91dE1zLAogICAgbGFiZWwsCiAgICBkZWFkbGluZTogY29udGV4dC5kZWFkbGluZSwKICAgIC4uLihvblByb2dyZXNzID09PSB1bmRlZmluZWQgPyB7fSA6IHsgb25Qcm9ncmVzcyB9KSwKICB9KTsKICBpZiAoY2Fub25pY2FsUGFyZW50ICE9PSBwYXJlbnQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIHBhcmVudCBtdXN0IHVzZSBpdHMgY2Fub25pY2FsIHBhdGg6ICR7cGFyZW50fWApOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgY29uc3QgYmVmb3JlID0gYXdhaXQgbHN0YXQoYWJzb2x1dGUsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICghYmVmb3JlLmlzRmlsZSgpIHx8IGJlZm9yZS5pc1N5bWJvbGljTGluaygpIHx8IGJlZm9yZS5ubGluayAhPT0gMW4pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIG11c3QgYmUgYSByZWd1bGFyIHNpbmdsZS1saW5rIGZpbGU6ICR7YWJzb2x1dGV9YCk7CiAgfQogIGlkZW50aXR5RnJvbVN0YXRzKGJlZm9yZSwgYWJzb2x1dGUpOwogIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAid2luMzIiKSB7CiAgICBjb25zdCBjdXJyZW50VWlkID0gcHJvY2Vzcy5nZXR1aWQ/LigpOwogICAgaWYgKGN1cnJlbnRVaWQgIT09IHVuZGVmaW5lZCAmJiBiZWZvcmUudWlkICE9PSBCaWdJbnQoY3VycmVudFVpZCkpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgaXMgbm90IG93bmVkIGJ5IHRoZSBjdXJyZW50IHVzZXI6ICR7YWJzb2x1dGV9YCk7CiAgICB9CiAgICBpZiAoKGJlZm9yZS5tb2RlICYgMG8wMjJuKSAhPT0gMG4pIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgaXMgZ3JvdXAvd29ybGQtd3JpdGFibGU6ICR7YWJzb2x1dGV9YCk7CiAgICB9CiAgfQogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKGFic29sdXRlKTsKICBpZiAoY2Fub25pY2FsICE9PSBhYnNvbHV0ZSkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgbXVzdCB1c2UgaXRzIGNhbm9uaWNhbCBwYXRoOiAke2Fic29sdXRlfWApOwogIH0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gIndpbjMyIikgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIldpbmRvd3MgZmlsZSBBQ0wgdmFsaWRhdGlvbiBzdGFydGVkIik7CiAgICBhd2FpdCBhc3NlcnRXaW5kb3dzUGF0aFNlY3VyaXR5KFt7IHBhdGg6IGNhbm9uaWNhbCwgcm9sZTogImZpbGUiIH1dLCBjb250ZXh0KTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJXaW5kb3dzIGZpbGUgQUNMIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJkYXJ3aW4iKSB7CiAgICBhd2FpdCBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkoY2Fub25pY2FsLCAiZmlsZSIsIGNvbnRleHQpOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGNvbnN0IGFmdGVyID0gYXdhaXQgbHN0YXQoY2Fub25pY2FsLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoCiAgICAhYWZ0ZXIuaXNGaWxlKCkgfHwgYWZ0ZXIuaXNTeW1ib2xpY0xpbmsoKSB8fCBhZnRlci5ubGluayAhPT0gMW4gfHwKICAgIGFmdGVyLmRldiAhPT0gYmVmb3JlLmRldiB8fCBhZnRlci5pbm8gIT09IGJlZm9yZS5pbm8KICApIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlkZW50aXR5IGNoYW5nZWQgZHVyaW5nIHZhbGlkYXRpb246ICR7Y2Fub25pY2FsfWApOwogIH0KICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAicHJpdmF0ZSBmaWxlIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICByZXR1cm4gY2Fub25pY2FsOwp9Cgphc3luYyBmdW5jdGlvbiBwcmVwYXJlTG9ja1BhdGgocmVxdWVzdGVkUGF0aCwgY29udGV4dCkgewogIGNvbnN0IGFic29sdXRlID0gcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoKTsKICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBwYXRoIHByZXBhcmF0aW9uIHN0YXJ0ZWQiKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgYXdhaXQgbWtkaXIoZGlybmFtZShhYnNvbHV0ZSksIHsgcmVjdXJzaXZlOiB0cnVlLCBtb2RlOiAwbzcwMCB9KTsKICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBwYXJlbnQgY3JlYXRpb24gY29tcGxldGUiKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgY29uc3QgcGFyZW50ID0gYXdhaXQgcmVhbHBhdGgoZGlybmFtZShhYnNvbHV0ZSkpOwogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJsb2NrIHBhcmVudCBjYW5vbmljYWxpemF0aW9uIGNvbXBsZXRlIik7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJsb2NrIHBhcmVudCBzZWN1cml0eSB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICBjb25zdCB2YWxpZGF0ZWRQYXJlbnQgPSBhd2FpdCBhc3NlcnRMb2NhbFByaXZhdGVEaXJlY3RvcnkocGFyZW50LCB7CiAgICB0aW1lb3V0TXM6IGNvbnRleHQudGltZW91dE1zLAogICAgbGFiZWw6IGNvbnRleHQubGFiZWwsCiAgICBkZWFkbGluZTogY29udGV4dC5kZWFkbGluZSwKICAgIC4uLihjb250ZXh0Lm9uUHJvZ3Jlc3MgPT09IHVuZGVmaW5lZAogICAgICA/IHt9CiAgICAgIDogeyBvblByb2dyZXNzOiBjb250ZXh0Lm9uUHJvZ3Jlc3MgfSksCiAgfSk7CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgcGFyZW50IHNlY3VyaXR5IHZhbGlkYXRpb24gY29tcGxldGUiKTsKICBpZiAodmFsaWRhdGVkUGFyZW50ICE9PSBwYXJlbnQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgcGFyZW50IG11c3QgdXNlIGl0cyBjYW5vbmljYWwgcGF0aDogJHtwYXJlbnR9YCk7CiAgfQogIGNvbnN0IHBhcmVudFN0YXRzID0gYXdhaXQgbHN0YXQocGFyZW50LCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoIXBhcmVudFN0YXRzLmlzRGlyZWN0b3J5KCkgfHwgcGFyZW50U3RhdHMuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBwYXJlbnQgaXMgbm90IGEgcmVhbCBkaXJlY3Rvcnk6ICR7cGFyZW50fWApOwogIH0KICBhc3NlcnRQb3NpeE93bmVyc2hpcChwYXJlbnRTdGF0cywgcGFyZW50LCAicGFyZW50Iik7CgogIGNvbnN0IHBhdGggPSBqb2luKHBhcmVudCwgYmFzZW5hbWUoYWJzb2x1dGUpKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoKTsKICB0cnkgewogICAgY29uc3QgaGFuZGxlID0gYXdhaXQgb3BlbihwYXRoLCAid3giLCAwbzYwMCk7CiAgICB0cnkgewogICAgICBhd2FpdCBoYW5kbGUuY2xvc2UoKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGF3YWl0IGhhbmRsZS5jbG9zZSgpLmNhdGNoKCgpID0+IHt9KTsKICAgICAgdGhyb3cgZXJyb3I7CiAgICB9CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGlmIChlcnJvcj8uY29kZSAhPT0gIkVFWElTVCIpIHRocm93IGVycm9yOwogIH0KICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBkYXRhYmFzZSBmaWxlIGNyZWF0aW9uIGNvbXBsZXRlIik7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7CiAgY29uc3QgcGF0aFN0YXRzID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsocGF0aFN0YXRzLCBwYXRoKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChwYXRoU3RhdHMsIHBhdGgsICJmaWxlIik7CiAgY29uc3QgY2Fub25pY2FsID0gYXdhaXQgcmVhbHBhdGgocGF0aCk7CiAgY29uc3Qgc3RhdHMgPSBhd2FpdCBsc3RhdChjYW5vbmljYWwsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHN0YXRzLCBjYW5vbmljYWwpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHN0YXRzLCBjYW5vbmljYWwsICJmaWxlIik7CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGNobW9kKGNhbm9uaWNhbCwgMG82MDApOwogICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJkYXJ3aW4iKSB7CiAgICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eShjYW5vbmljYWwsICJsb2NrIGRhdGFiYXNlIGZpbGUiLCBjb250ZXh0KTsKICAgIH0KICB9IGVsc2UgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgZGF0YWJhc2UgQUNMIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eShbCiAgICAgIHsgcGF0aDogcGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfSwKICAgICAgeyBwYXRoOiBjYW5vbmljYWwsIHJvbGU6ICJmaWxlIiB9LAogICAgXSwgY29udGV4dCk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBkYXRhYmFzZSBBQ0wgdmFsaWRhdGlvbiBjb21wbGV0ZSIpOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGNvbnN0IHNlY3VyZWRTdGF0cyA9IGF3YWl0IGxzdGF0KGNhbm9uaWNhbCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHNlY3VyZWRTdGF0cywgY2Fub25pY2FsLCAiZmlsZSIpOwogIHJldHVybiB7CiAgICBwYXRoOiBjYW5vbmljYWwsCiAgICBwYXJlbnQsCiAgICBkZXY6IHNlY3VyZWRTdGF0cy5kZXYsCiAgICBpbm86IHNlY3VyZWRTdGF0cy5pbm8sCiAgICBpZGVudGl0eUtleTogaWRlbnRpdHlGcm9tU3RhdHMoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpLAogIH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJldmFsaWRhdGVQcmVwYXJlZExvY2soCiAgcHJlcGFyZWQsCiAgY29udGV4dCwKICB7IHZhbGlkYXRlV2luZG93c0FjbCA9IGZhbHNlIH0gPSB7fSwKKSB7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCk7CiAgY29uc3QgcGFyZW50U3RhdHMgPSBhd2FpdCBsc3RhdChwcmVwYXJlZC5wYXJlbnQsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICghcGFyZW50U3RhdHMuaXNEaXJlY3RvcnkoKSB8fCBwYXJlbnRTdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIHBhcmVudCBpcyBubyBsb25nZXIgYSByZWFsIGRpcmVjdG9yeTogJHtwcmVwYXJlZC5wYXJlbnR9YCk7CiAgfQogIGFzc2VydFBvc2l4T3duZXJzaGlwKHBhcmVudFN0YXRzLCBwcmVwYXJlZC5wYXJlbnQsICJwYXJlbnQiKTsKICBjb25zdCBzdGF0cyA9IGF3YWl0IGxzdGF0KHByZXBhcmVkLnBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHN0YXRzLCBwcmVwYXJlZC5wYXRoKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgcHJlcGFyZWQucGF0aCwgImZpbGUiKTsKICBpZiAoc3RhdHMuZGV2ICE9PSBwcmVwYXJlZC5kZXYgfHwgc3RhdHMuaW5vICE9PSBwcmVwYXJlZC5pbm8pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaWRlbnRpdHkgY2hhbmdlZCBkdXJpbmcgYWNxdWlzaXRpb246ICR7cHJlcGFyZWQucGF0aH1gKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIgJiYgdmFsaWRhdGVXaW5kb3dzQWNsKSB7CiAgICBhd2FpdCBhc3NlcnRXaW5kb3dzUGF0aFNlY3VyaXR5KFsKICAgICAgeyBwYXRoOiBwcmVwYXJlZC5wYXJlbnQsIHJvbGU6ICJsZWFmRGlyZWN0b3J5IiB9LAogICAgICB7IHBhdGg6IHByZXBhcmVkLnBhdGgsIHJvbGU6ICJmaWxlIiB9LAogICAgXSwgY29udGV4dCk7CiAgfSBlbHNlIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgYXdhaXQgYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5KHByZXBhcmVkLnBhdGgsICJsb2NrIGRhdGFiYXNlIGZpbGUiLCBjb250ZXh0KTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCk7Cn0KCmZ1bmN0aW9uIHByYWdtYVZhbHVlKGRhdGFiYXNlLCBwcmFnbWEpIHsKICBjb25zdCByb3cgPSBkYXRhYmFzZS5wcmVwYXJlKGBQUkFHTUEgJHtwcmFnbWF9YCkuZ2V0KCk7CiAgcmV0dXJuIHJvdyA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogT2JqZWN0LnZhbHVlcyhyb3cpWzBdOwp9CgpmdW5jdGlvbiBwcmFnbWFOdW1iZXIoZGF0YWJhc2UsIHByYWdtYSkgewogIGNvbnN0IHZhbHVlID0gcHJhZ21hVmFsdWUoZGF0YWJhc2UsIHByYWdtYSk7CiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gIm51bWJlciIgPyB2YWx1ZSA6IHVuZGVmaW5lZDsKfQoKZnVuY3Rpb24gcHJhZ21hVGV4dChkYXRhYmFzZSwgcHJhZ21hKSB7CiAgY29uc3QgdmFsdWUgPSBwcmFnbWFWYWx1ZShkYXRhYmFzZSwgcHJhZ21hKTsKICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAic3RyaW5nIiA/IHZhbHVlLnRvTG93ZXJDYXNlKCkgOiB1bmRlZmluZWQ7Cn0KCmV4cG9ydCBmdW5jdGlvbiBjb25maWd1cmVMb2NhbFNxbGl0ZUxvY2tDb25uZWN0aW9uKGRhdGFiYXNlKSB7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIGJ1c3lfdGltZW91dCA9IDAiKTsKICBkYXRhYmFzZS5leGVjKCJQUkFHTUEgdHJ1c3RlZF9zY2hlbWEgPSBPRkYiKTsKICBkYXRhYmFzZS5leGVjKCJQUkFHTUEgc3luY2hyb25vdXMgPSBFWFRSQSIpOwogIGRhdGFiYXNlLmVuYWJsZURlZmVuc2l2ZSh0cnVlKTsKICBkYXRhYmFzZS5lbmFibGVMb2FkRXh0ZW5zaW9uKGZhbHNlKTsKICBpZiAoCiAgICBwcmFnbWFOdW1iZXIoZGF0YWJhc2UsICJidXN5X3RpbWVvdXQiKSAhPT0gMCB8fAogICAgcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAidHJ1c3RlZF9zY2hlbWEiKSAhPT0gMCB8fAogICAgcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAic3luY2hyb25vdXMiKSAhPT0gMwogICkgewogICAgdGhyb3cgbmV3IEVycm9yKCJhZ2VuYzogU1FMaXRlIGxvY2sgY29ubmVjdGlvbiBoYXJkZW5pbmcgZGlkIG5vdCB0YWtlIGVmZmVjdCIpOwogIH0KfQoKZnVuY3Rpb24gaW5zcGVjdExvY2tEYXRhYmFzZShkYXRhYmFzZSwgcGF0aCkgewogIGNvbnN0IGFwcGxpY2F0aW9uSWQgPSBwcmFnbWFOdW1iZXIoZGF0YWJhc2UsICJhcHBsaWNhdGlvbl9pZCIpOwogIGlmIChhcHBsaWNhdGlvbklkID09PSAwKSB7CiAgICBjb25zdCByb3cgPSBkYXRhYmFzZS5wcmVwYXJlKAogICAgICAiU0VMRUNUIGNvdW50KCopIEFTIGNvdW50IEZST00gc3FsaXRlX3NjaGVtYSBXSEVSRSBuYW1lIE5PVCBMSUtFICdzcWxpdGVfJSciLAogICAgKS5nZXQoKTsKICAgIGlmIChyb3c/LmNvdW50ICE9PSAwKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigKICAgICAgICBgYWdlbmM6IHJlZnVzaW5nIHRvIHJldXNlIGFuIHVucmVsYXRlZCBTUUxpdGUgZGF0YWJhc2UgYXMgYSBsb2NrOiAke3BhdGh9YCwKICAgICAgKTsKICAgIH0KICAgIHJldHVybiAiZW1wdHkiOwogIH0KICBpZiAoYXBwbGljYXRpb25JZCAhPT0gTE9DS19BUFBMSUNBVElPTl9JRCkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBoYXMgYW4gaW5jb21wYXRpYmxlIGFwcGxpY2F0aW9uIGlkOiAke3BhdGh9YCk7CiAgfQogIHRyeSB7CiAgICBjb25zdCBzY2hlbWEgPSBkYXRhYmFzZS5wcmVwYXJlKAogICAgICAiU0VMRUNUIHR5cGUsIHNxbCBGUk9NIHNxbGl0ZV9zY2hlbWEgV0hFUkUgbmFtZSA9ICdhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2snIiwKICAgICkuZ2V0KCk7CiAgICBjb25zdCBvYmplY3RzID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCBjb3VudCgqKSBBUyBjb3VudCBGUk9NIHNxbGl0ZV9zY2hlbWEgV0hFUkUgbmFtZSBOT1QgTElLRSAnc3FsaXRlXyUnIiwKICAgICkuZ2V0KCk7CiAgICBjb25zdCByb3dzID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCBzaW5nbGV0b24sIGZvcm1hdF92ZXJzaW9uIEZST00gYWdlbmNfbG9jYWxfcHJvY2Vzc19sb2NrIiwKICAgICkuYWxsKCk7CiAgICBjb25zdCBub3JtYWxpemVkU2NoZW1hID0gdHlwZW9mIHNjaGVtYT8uc3FsID09PSAic3RyaW5nIgogICAgICA/IHNjaGVtYS5zcWwucmVwbGFjZSgvXHMrL2csICIgIikudHJpbSgpCiAgICAgIDogdW5kZWZpbmVkOwogICAgaWYgKAogICAgICBzY2hlbWE/LnR5cGUgIT09ICJ0YWJsZSIgfHwKICAgICAgbm9ybWFsaXplZFNjaGVtYSAhPT0KICAgICAgICAiQ1JFQVRFIFRBQkxFIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayAoIHNpbmdsZXRvbiBJTlRFR0VSIFBSSU1BUlkgS0VZIENIRUNLIChzaW5nbGV0b24gPSAxKSwgZm9ybWF0X3ZlcnNpb24gSU5URUdFUiBOT1QgTlVMTCApIFNUUklDVCIgfHwKICAgICAgb2JqZWN0cz8uY291bnQgIT09IDEgfHwKICAgICAgcm93cy5sZW5ndGggIT09IDEgfHwKICAgICAgcm93c1swXT8uc2luZ2xldG9uICE9PSAxIHx8CiAgICAgIHJvd3NbMF0/LmZvcm1hdF92ZXJzaW9uICE9PSBMT0NLX0ZPUk1BVF9WRVJTSU9OCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHNlbnRpbmVsIHNjaGVtYSIpOwogICAgfQogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGhhcyBhbiBpbmNvbXBhdGlibGUgZm9ybWF0OiAke3BhdGh9YCwgewogICAgICBjYXVzZTogZXJyb3IsCiAgICB9KTsKICB9CiAgcmV0dXJuICJ2YWxpZCI7Cn0KCmZ1bmN0aW9uIGJ1c3lUcmFuc2l0aW9uRXJyb3IocGF0aCwgbW9kZSkgewogIHJldHVybiBPYmplY3QuYXNzaWduKAogICAgbmV3IEVycm9yKGBhZ2VuYzogU1FMaXRlIGxvY2sgam91cm5hbCBtb2RlIHJlbWFpbmVkICR7bW9kZSA/PyAidW5rbm93biJ9OiAke3BhdGh9YCksCiAgICB7IGVycmNvZGU6IFNRTElURV9CVVNZIH0sCiAgKTsKfQoKZnVuY3Rpb24gYmVnaW5BbmRWYWxpZGF0ZUxvY2soZGF0YWJhc2UsIHBhdGgsIGNvbnRleHQpIHsKICBmb3IgKGxldCBwaGFzZSA9IDA7IHBoYXNlIDwgODsgcGhhc2UgKz0gMSkgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSB0cmFuc2FjdGlvbiBiZWdpbiBzdGFydGVkIik7CiAgICBkYXRhYmFzZS5leGVjKCJCRUdJTiBJTU1FRElBVEUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgdHJhbnNhY3Rpb24gYmVnaW4gY29tcGxldGUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgbG9jayBkYXRhYmFzZSBpbnNwZWN0aW9uIHN0YXJ0ZWQiKTsKICAgIGNvbnN0IHN0YXRlID0gaW5zcGVjdExvY2tEYXRhYmFzZShkYXRhYmFzZSwgcGF0aCk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGxvY2sgZGF0YWJhc2UgaW5zcGVjdGlvbiBjb21wbGV0ZSIpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBqb3VybmFsIG1vZGUgaW5zcGVjdGlvbiBzdGFydGVkIik7CiAgICBjb25zdCBqb3VybmFsTW9kZSA9IHByYWdtYVRleHQoZGF0YWJhc2UsICJqb3VybmFsX21vZGUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgam91cm5hbCBtb2RlIGluc3BlY3Rpb24gY29tcGxldGUiKTsKICAgIGlmIChqb3VybmFsTW9kZSAhPT0gImRlbGV0ZSIpIHsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBqb3VybmFsIG1vZGUgcmVzZXQgc3RhcnRlZCIpOwogICAgICBkYXRhYmFzZS5leGVjKCJST0xMQkFDSyIpOwogICAgICBjb25zdCBzZWxlY3RlZCA9IHByYWdtYVRleHQoZGF0YWJhc2UsICJqb3VybmFsX21vZGU9REVMRVRFIik7CiAgICAgIGlmIChzZWxlY3RlZCAhPT0gImRlbGV0ZSIpIHRocm93IGJ1c3lUcmFuc2l0aW9uRXJyb3IocGF0aCwgc2VsZWN0ZWQpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGpvdXJuYWwgbW9kZSByZXNldCBjb21wbGV0ZSIpOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIGlmIChzdGF0ZSA9PT0gImVtcHR5IikgewogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGxvY2sgZGF0YWJhc2UgaW5pdGlhbGl6YXRpb24gc3RhcnRlZCIpOwogICAgICBkYXRhYmFzZS5leGVjKGAKICAgICAgICBQUkFHTUEgYXBwbGljYXRpb25faWQgPSAke0xPQ0tfQVBQTElDQVRJT05fSUR9OwogICAgICAgIENSRUFURSBUQUJMRSBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKAogICAgICAgICAgc2luZ2xldG9uIElOVEVHRVIgUFJJTUFSWSBLRVkgQ0hFQ0sgKHNpbmdsZXRvbiA9IDEpLAogICAgICAgICAgZm9ybWF0X3ZlcnNpb24gSU5URUdFUiBOT1QgTlVMTAogICAgICAgICkgU1RSSUNUOwogICAgICAgIElOU0VSVCBJTlRPIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayAoc2luZ2xldG9uLCBmb3JtYXRfdmVyc2lvbikKICAgICAgICBWQUxVRVMgKDEsICR7TE9DS19GT1JNQVRfVkVSU0lPTn0pOwogICAgICAgIENPTU1JVDsKICAgICAgYCk7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgbG9jayBkYXRhYmFzZSBpbml0aWFsaXphdGlvbiBjb21wbGV0ZSIpOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIHJldHVybjsKICB9CiAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBpbml0aWFsaXphdGlvbiBkaWQgbm90IGNvbnZlcmdlOiAke3BhdGh9YCk7Cn0KCmZ1bmN0aW9uIGNsb3NlRGF0YWJhc2UoZGF0YWJhc2UpIHsKICBpZiAoIWRhdGFiYXNlPy5pc09wZW4pIHJldHVybjsKICBjb25zdCBlcnJvcnMgPSBbXTsKICB0cnkgewogICAgaWYgKGRhdGFiYXNlLmlzVHJhbnNhY3Rpb24pIGRhdGFiYXNlLmV4ZWMoIlJPTExCQUNLIik7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICB9CiAgdHJ5IHsKICAgIGRhdGFiYXNlLmNsb3NlKCk7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICB9CiAgaWYgKGVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGVycm9yc1swXTsKICBpZiAoZXJyb3JzLmxlbmd0aCA+IDEpIHsKICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihlcnJvcnMsICJhZ2VuYzogZmFpbGVkIHRvIGNsb3NlIGEgbG9jYWwgcHJvY2VzcyBsb2NrIGRhdGFiYXNlIik7CiAgfQp9CgpleHBvcnQgZnVuY3Rpb24gaXNTcWxpdGVCdXN5RXJyb3IoZXJyb3IpIHsKICByZXR1cm4gdHlwZW9mIGVycm9yPy5lcnJjb2RlID09PSAibnVtYmVyIiAmJgogICAgKGVycm9yLmVycmNvZGUgJiAweGZmKSA9PT0gU1FMSVRFX0JVU1k7Cn0KCmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JCdXN5UmV0cnkoY29udGV4dCwgcGF0aCwgYXR0ZW1wdCwgY2F1c2UpIHsKICBjb25zdCByZW1haW5pbmcgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgaWYgKHJlbWFpbmluZyA8PSAwKSB0aHJvdyB0aW1lb3V0RXJyb3IoY29udGV4dCwgcGF0aCwgY2F1c2UpOwogIGNvbnN0IGV4cG9uZW50aWFsQ2FwID0gTWF0aC5taW4oTUFYX0JVU1lfUkVUUllfTVMsIDIgKiogTWF0aC5taW4oYXR0ZW1wdCwgNikpOwogIGNvbnN0IGppdHRlciA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChleHBvbmVudGlhbENhcCArIDEpKSk7CiAgY29uc3Qgd2FpdE1zID0gTWF0aC5taW4ocmVtYWluaW5nLCBqaXR0ZXIpOwogIGNvbnN0IHNpZ25hbCA9IGNvbnRleHQucmV0cnlXYWtlU2lnbmFsOwogIGlmIChzaWduYWwgPT09IHVuZGVmaW5lZCB8fCBjb250ZXh0LnJldHJ5V2FrZUNvbnN1bWVkKSB7CiAgICBhd2FpdCBkZWxheSh3YWl0TXMpOwogIH0gZWxzZSB7CiAgICAvLyBBIGhpbnQgb25seSBzaG9ydGVucyBvbmUgc2xlZXAuIFRoZSBuZXh0IGF0dGVtcHQgbXVzdCBzdGlsbCB2YWxpZGF0ZQogICAgLy8gdGhlIHBhdGggYW5kIGFjcXVpcmUgdGhlIFNRTGl0ZSB0cmFuc2FjdGlvbiBhZ2FpbnN0IHRoZSBzYW1lIGRlYWRsaW5lLgogICAgbGV0IHRpbWVyOwogICAgbGV0IHdha2U7CiAgICB0cnkgewogICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gewogICAgICAgIHdha2UgPSAoKSA9PiB7CiAgICAgICAgICBjb250ZXh0LnJldHJ5V2FrZUNvbnN1bWVkID0gdHJ1ZTsKICAgICAgICAgIHJlc29sdmUoKTsKICAgICAgICB9OwogICAgICAgIHRpbWVyID0gc2V0VGltZW91dChyZXNvbHZlLCB3YWl0TXMpOwogICAgICAgIHNpZ25hbC5hZGRFdmVudExpc3RlbmVyKCJhYm9ydCIsIHdha2UsIHsgb25jZTogdHJ1ZSB9KTsKICAgICAgICAvLyBDb3ZlcnMgcmVhZGluZXNzIGJlZm9yZSBzdWJzY3JpcHRpb24gYXMgd2VsbCBhcyBiZWZvcmUgYWNxdWlzaXRpb24uCiAgICAgICAgaWYgKHNpZ25hbC5hYm9ydGVkKSB3YWtlKCk7CiAgICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBidXN5IHJldHJ5IHdhaXQgc3RhcnRlZCIpOwogICAgICB9KTsKICAgIH0gZmluYWxseSB7CiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7CiAgICAgIGlmICh3YWtlICE9PSB1bmRlZmluZWQpIHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKCJhYm9ydCIsIHdha2UpOwogICAgfQogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoLCBjYXVzZSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVTcWxpdGVEYXRhYmFzZShEYXRhYmFzZVN5bmMsIHByZXBhcmVkLCBjb250ZXh0KSB7CiAgbGV0IGF0dGVtcHQgPSAwOwogIGxldCBsYXN0QnVzeTsKICB3aGlsZSAodHJ1ZSkgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgbGFzdEJ1c3kpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBwcmUtb3BlbiBsb2NrIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgYXdhaXQgcmV2YWxpZGF0ZVByZXBhcmVkTG9jayhwcmVwYXJlZCwgY29udGV4dCwgewogICAgICAvLyBUaGUgY3JlYXRpb24gcGF0aCBhbHJlYWR5IHZhbGlkYXRlZCB0aGUgY29tcGxldGUgYW5jZXN0b3IgY2hhaW4gYW5kCiAgICAgIC8vIHRoZSBleGFjdCBwYXJlbnQvZmlsZSBBQ0xzLiBSZXZhbGlkYXRlIEFDTHMgYWZ0ZXIgY29udGVudGlvbiBiZWNhdXNlCiAgICAgIC8vIGFub3RoZXIgaG9sZGVyIGFuZCBhbiB1bmJvdW5kZWQgaW50ZXJ2YWwgaGF2ZSBjcm9zc2VkIHRoaXMgYXR0ZW1wdC4KICAgICAgdmFsaWRhdGVXaW5kb3dzQWNsOiBhdHRlbXB0ID4gMCwKICAgIH0pOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBwcmUtb3BlbiBsb2NrIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICAgIGxldCBkYXRhYmFzZTsKICAgIHRyeSB7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgZGF0YWJhc2Ugb3BlbiBzdGFydGVkIik7CiAgICAgIGRhdGFiYXNlID0gbmV3IERhdGFiYXNlU3luYyhwcmVwYXJlZC5wYXRoLCB7CiAgICAgICAgYWxsb3dFeHRlbnNpb246IGZhbHNlLAogICAgICAgIHRpbWVvdXQ6IDAsCiAgICAgIH0pOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGRhdGFiYXNlIG9wZW4gY29tcGxldGUiKTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBjb25uZWN0aW9uIGhhcmRlbmluZyBzdGFydGVkIik7CiAgICAgIGNvbmZpZ3VyZUxvY2FsU3FsaXRlTG9ja0Nvbm5lY3Rpb24oZGF0YWJhc2UpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGNvbm5lY3Rpb24gaGFyZGVuaW5nIGNvbXBsZXRlIik7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgcG9zdC1vcGVuIGxvY2sgdmFsaWRhdGlvbiBzdGFydGVkIik7CiAgICAgIGF3YWl0IHJldmFsaWRhdGVQcmVwYXJlZExvY2socHJlcGFyZWQsIGNvbnRleHQpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIHBvc3Qtb3BlbiBsb2NrIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICAgICAgYmVnaW5BbmRWYWxpZGF0ZUxvY2soZGF0YWJhc2UsIHByZXBhcmVkLnBhdGgsIGNvbnRleHQpOwogICAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwcmVwYXJlZC5wYXRoLCBsYXN0QnVzeSk7CiAgICAgIHJldHVybiBkYXRhYmFzZTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGNvbnN0IGNsZWFudXBFcnJvcnMgPSBbXTsKICAgICAgaWYgKGRhdGFiYXNlICE9PSB1bmRlZmluZWQpIHsKICAgICAgICB0cnkgewogICAgICAgICAgY2xvc2VEYXRhYmFzZShkYXRhYmFzZSk7CiAgICAgICAgfSBjYXRjaCAoY2xlYW51cEVycm9yKSB7CiAgICAgICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKGNsZWFudXBFcnJvcnMubGVuZ3RoID4gMCkgewogICAgICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcigKICAgICAgICAgIFtlcnJvciwgLi4uY2xlYW51cEVycm9yc10sCiAgICAgICAgICBgYWdlbmM6IGxvY2sgYXR0ZW1wdCBhbmQgY2xlYW51cCBib3RoIGZhaWxlZCBmb3IgJHtwcmVwYXJlZC5wYXRofWAsCiAgICAgICAgKTsKICAgICAgfQogICAgICBpZiAoIWlzU3FsaXRlQnVzeUVycm9yKGVycm9yKSkgdGhyb3cgZXJyb3I7CiAgICAgIGxhc3RCdXN5ID0gZXJyb3I7CiAgICAgIGF0dGVtcHQgKz0gMTsKICAgICAgYXdhaXQgd2FpdEZvckJ1c3lSZXRyeShjb250ZXh0LCBwcmVwYXJlZC5wYXRoLCBhdHRlbXB0LCBsYXN0QnVzeSk7CiAgICB9CiAgfQp9CgpmdW5jdGlvbiByZWxlYXNlQWNxdWlyZWQoYWNxdWlyZWQsIGxhYmVsKSB7CiAgY29uc3QgZXJyb3JzID0gW107CiAgZm9yIChjb25zdCBpdGVtIG9mIGFjcXVpcmVkLnRvUmV2ZXJzZWQoKSkgewogICAgdHJ5IHsKICAgICAgY2xvc2VEYXRhYmFzZShpdGVtLmRhdGFiYXNlKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICAgIH0KICAgIGlmICgoIWl0ZW0uZGF0YWJhc2UgfHwgIWl0ZW0uZGF0YWJhc2UuaXNPcGVuKSAmJiAhaXRlbS5pblByb2Nlc3NSZWxlYXNlZCkgewogICAgICB0cnkgewogICAgICAgIGl0ZW0ucmVsZWFzZUluUHJvY2VzcygpOwogICAgICAgIGl0ZW0uaW5Qcm9jZXNzUmVsZWFzZWQgPSB0cnVlOwogICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICAgICAgfQogICAgfQogIH0KICBpZiAoZXJyb3JzLmxlbmd0aCA9PT0gMSkgdGhyb3cgZXJyb3JzWzBdOwogIGlmIChlcnJvcnMubGVuZ3RoID4gMSkgewogICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGVycm9ycywgYGFnZW5jOiAke2xhYmVsfSBsb2NrIHJlbGVhc2UgZmFpbGVkYCk7CiAgfQp9CgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYWNxdWlyZUxvY2FsU3FsaXRlTG9ja3MoCiAgcmVxdWVzdGVkUGF0aHMsCiAgewogICAgdGltZW91dE1zID0gNjBfMDAwLAogICAgbGFiZWwgPSAiQWdlbkMgb3BlcmF0aW9uIiwKICAgIGRlYWRsaW5lOiBzdXBwbGllZERlYWRsaW5lLAogICAgb25Qcm9ncmVzcywKICAgIHJldHJ5V2FrZVNpZ25hbCwKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgaWYgKCFBcnJheS5pc0FycmF5KHJlcXVlc3RlZFBhdGhzKSkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBwYXRocyBtdXN0IGJlIGFuIGFycmF5Iik7CiAgfQogIGlmIChvblByb2dyZXNzICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIG9uUHJvZ3Jlc3MgIT09ICJmdW5jdGlvbiIpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgb25Qcm9ncmVzcyBtdXN0IGJlIGEgZnVuY3Rpb24iKTsKICB9CiAgaWYgKHJldHJ5V2FrZVNpZ25hbCAhPT0gdW5kZWZpbmVkICYmICEocmV0cnlXYWtlU2lnbmFsIGluc3RhbmNlb2YgQWJvcnRTaWduYWwpKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIHJldHJ5V2FrZVNpZ25hbCBtdXN0IGJlIGFuIEFib3J0U2lnbmFsIik7CiAgfQogIGlmIChyZXF1ZXN0ZWRQYXRocy5sZW5ndGggPT09IDApIHJldHVybiAoKSA9PiB7fTsKCiAgY29uc3Qgc3RhcnRlZEF0ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgY29uc3QgY29udGV4dCA9IHsKICAgIGRlYWRsaW5lOiBNYXRoLm1pbigKICAgICAgc3VwcGxpZWREZWFkbGluZSA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksCiAgICAgIHN0YXJ0ZWRBdCArIHRpbWVvdXRNcywKICAgICksCiAgICBsYWJlbCwKICAgIHRpbWVvdXRNcywKICAgIG9uUHJvZ3Jlc3MsCiAgICByZXRyeVdha2VTaWduYWwsCiAgICByZXRyeVdha2VDb25zdW1lZDogZmFsc2UsCiAgfTsKICBjb25zdCBmaXJzdERpc3BsYXlQYXRoID0gcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoc1swXSk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgZmlyc3REaXNwbGF5UGF0aCk7CgogIGNvbnN0IHByZXBhcmVkQnlJZGVudGl0eSA9IG5ldyBNYXAoKTsKICBmb3IgKGNvbnN0IHJlcXVlc3RlZFBhdGggb2YgcmVxdWVzdGVkUGF0aHMpIHsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHJlc29sdmUocmVxdWVzdGVkUGF0aCkpOwogICAgY29uc3QgcHJlcGFyZWQgPSBhd2FpdCBwcmVwYXJlTG9ja1BhdGgocmVxdWVzdGVkUGF0aCwgY29udGV4dCk7CiAgICBwcmVwYXJlZEJ5SWRlbnRpdHkuc2V0KHByZXBhcmVkLmlkZW50aXR5S2V5LCBwcmVwYXJlZCk7CiAgfQogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJsb2NrIHBhdGggcHJlcGFyYXRpb24gY29tcGxldGUiKTsKICBjb25zdCBwcmVwYXJlZExvY2tzID0gWy4uLnByZXBhcmVkQnlJZGVudGl0eS52YWx1ZXMoKV0uc29ydCgobGVmdCwgcmlnaHQpID0+CiAgICBsZWZ0LmlkZW50aXR5S2V5IDwgcmlnaHQuaWRlbnRpdHlLZXkgPyAtMSA6IGxlZnQuaWRlbnRpdHlLZXkgPiByaWdodC5pZGVudGl0eUtleSA/IDEgOiAwKTsKICBjb25zdCBwZW5kaW5nTG9jYWwgPSBbXTsKICBjb25zdCBhY3F1aXJlZCA9IFtdOwogIGxldCBjdXJyZW50UGF0aCA9IHByZXBhcmVkTG9ja3NbMF0/LnBhdGggPz8gZmlyc3REaXNwbGF5UGF0aDsKICB0cnkgewogICAgZm9yIChjb25zdCBwcmVwYXJlZCBvZiBwcmVwYXJlZExvY2tzKSB7CiAgICAgIGN1cnJlbnRQYXRoID0gcHJlcGFyZWQucGF0aDsKICAgICAgY29uc3QgcmVsZWFzZSA9IGF3YWl0IGFjcXVpcmVJblByb2Nlc3NMb2NrKHByZXBhcmVkLCBjb250ZXh0KTsKICAgICAgcGVuZGluZ0xvY2FsLnB1c2goeyBwcmVwYXJlZCwgcmVsZWFzZSB9KTsKICAgIH0KICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJpbi1wcm9jZXNzIGxvY2sgYWNxdWlzaXRpb24gY29tcGxldGUiKTsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGN1cnJlbnRQYXRoKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgbW9kdWxlIGltcG9ydCBzdGFydGVkIik7CiAgICBjb25zdCB7IERhdGFiYXNlU3luYyB9ID0gYXdhaXQgaW1wb3J0KCJub2RlOnNxbGl0ZSIpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBtb2R1bGUgaW1wb3J0IGNvbXBsZXRlIik7CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjdXJyZW50UGF0aCk7CiAgICBmb3IgKGNvbnN0IHsgcHJlcGFyZWQsIHJlbGVhc2UgfSBvZiBwZW5kaW5nTG9jYWwpIHsKICAgICAgY3VycmVudFBhdGggPSBwcmVwYXJlZC5wYXRoOwogICAgICBjb25zdCBpdGVtID0gewogICAgICAgIGRhdGFiYXNlOiB1bmRlZmluZWQsCiAgICAgICAgcmVsZWFzZUluUHJvY2VzczogcmVsZWFzZSwKICAgICAgICBpblByb2Nlc3NSZWxlYXNlZDogZmFsc2UsCiAgICAgIH07CiAgICAgIGFjcXVpcmVkLnB1c2goaXRlbSk7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgdHJhbnNhY3Rpb24gYWNxdWlzaXRpb24gc3RhcnRlZCIpOwogICAgICBpdGVtLmRhdGFiYXNlID0gYXdhaXQgYWNxdWlyZVNxbGl0ZURhdGFiYXNlKERhdGFiYXNlU3luYywgcHJlcGFyZWQsIGNvbnRleHQpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIHRyYW5zYWN0aW9uIGFjcXVpc2l0aW9uIGNvbXBsZXRlIik7CiAgICB9CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGNvbnN0IGNsZWFudXBFcnJvcnMgPSBbXTsKICAgIHRyeSB7CiAgICAgIHJlbGVhc2VBY3F1aXJlZChhY3F1aXJlZCwgbGFiZWwpOwogICAgfSBjYXRjaCAoY2xlYW51cEVycm9yKSB7CiAgICAgIGNsZWFudXBFcnJvcnMucHVzaChjbGVhbnVwRXJyb3IpOwogICAgfQogICAgZm9yIChjb25zdCB7IHJlbGVhc2UgfSBvZiBwZW5kaW5nTG9jYWwuc2xpY2UoYWNxdWlyZWQubGVuZ3RoKS50b1JldmVyc2VkKCkpIHsKICAgICAgdHJ5IHsKICAgICAgICByZWxlYXNlKCk7CiAgICAgIH0gY2F0Y2ggKGNsZWFudXBFcnJvcikgewogICAgICAgIGNsZWFudXBFcnJvcnMucHVzaChjbGVhbnVwRXJyb3IpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBmb3JtYXR0ZWQgPSBpc1NxbGl0ZUJ1c3lFcnJvcihlcnJvcikKICAgICAgPyB0aW1lb3V0RXJyb3IoY29udGV4dCwgY3VycmVudFBhdGgsIGVycm9yKQogICAgICA6IGVycm9yOwogICAgaWYgKGNsZWFudXBFcnJvcnMubGVuZ3RoID4gMCkgewogICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgICAgW2Zvcm1hdHRlZCwgLi4uY2xlYW51cEVycm9yc10sCiAgICAgICAgYGFnZW5jOiAke2xhYmVsfSBsb2NrIGFjcXVpc2l0aW9uIGFuZCByb2xsYmFjayBib3RoIGZhaWxlZGAsCiAgICAgICk7CiAgICB9CiAgICB0aHJvdyBmb3JtYXR0ZWQ7CiAgfQoKICBsZXQgcmVsZWFzZWQgPSBmYWxzZTsKICByZXR1cm4gKCkgPT4gewogICAgaWYgKHJlbGVhc2VkKSByZXR1cm47CiAgICByZWxlYXNlQWNxdWlyZWQoYWNxdWlyZWQsIGxhYmVsKTsKICAgIHJlbGVhc2VkID0gYWNxdWlyZWQuZXZlcnkoKGl0ZW0pID0+IGl0ZW0uaW5Qcm9jZXNzUmVsZWFzZWQpOwogIH07Cn0KCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhY3F1aXJlTG9jYWxTcWxpdGVMb2NrKHBhdGgsIG9wdGlvbnMpIHsKICByZXR1cm4gYWNxdWlyZUxvY2FsU3FsaXRlTG9ja3MoW3BhdGhdLCBvcHRpb25zKTsKfQo=";
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
  return import("data:text/javascript;base64,Ly8gQ2xlYW51cCBpcyBkZWxpYmVyYXRlbHkgbWFjT1Mtb25seS4gS2VlcCBMaW51eC9XaW5kb3dzIGluc3RhbGwgc2VtYW50aWNzLgppbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tICJub2RlOmNoaWxkX3Byb2Nlc3MiOwppbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAibm9kZTpjcnlwdG8iOwppbXBvcnQgeyBjbG9zZVN5bmMsIGNvbnN0YW50cywgZmNobW9kU3luYywgZnN0YXRTeW5jLCBmc3luY1N5bmMsIGxzdGF0U3luYywgbWtkaXJTeW5jLCBvcGVuU3luYywgcmVhZEZpbGVTeW5jLAogIHJlYWRkaXJTeW5jLCByZWFscGF0aFN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYyB9IGZyb20gIm5vZGU6ZnMiOwppbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSAibm9kZTpwYXRoIjsKaW1wb3J0IHsgYWNxdWlyZUxvY2FsU3FsaXRlTG9jayB9IGZyb20gImRhdGE6dGV4dC9qYXZhc2NyaXB0O2Jhc2U2NCxMeThnUTNKdmMzTXRjSEp2WTJWemN5QnNiMk5oYkNCbWFXeGxjM2x6ZEdWdElHeHZZMnR6SUdKaFkydGxaQ0JpZVNCVFVVeHBkR1VuY3lCUFV5QnNiMk5yYVc1bklHeGhlV1Z5TGdvdkx3b3ZMeUJDUlVkSlRpQkpUVTFGUkVsQlZFVWdiM2R1Y3lCMGFHVWdkM0pwZEdWeUlISmxjMlZ5ZG1GMGFXOXVJR1p2Y2lCMGFHVWdZMkZzYkdWeUozTWdZM0pwZEdsallXd0tMeThnYzJWamRHbHZiaTRnVTFGTWFYUmxJSEpsYkdWaGMyVnpJR2wwSUc5dUlHTnNiM05sSUc5eUlIQnliMk5sYzNNZ1pHVmhkR2dzSUdsdVkyeDFaR2x1WnlCVFNVZExTVXhNTGdvdkx5QkJJSEJ5YjJObGMzTXRkMmxrWlNCR1NVWlBJSEpsWjJsemRISjVJSEJ5WlhabGJuUnpJR1IxY0d4cFkyRjBaU0J0YjJSMWJHVWdhVzV6ZEdGdVkyVnpJR1p5YjIwS0x5OGdZbXh2WTJ0cGJtY2diMjVsSUdGdWIzUm9aWElnYVc1emFXUmxJSE41Ym1Ob2NtOXViM1Z6SUZOUlRHbDBaU0JqWVd4c2N6c2dZM0p2YzNNdGNISnZZMlZ6Y3lCaWRYTjVDaTh2SUdOdmJuUmxiblJwYjI0Z2FYTWdjbVYwY21sbFpDQmhjM2x1WTJoeWIyNXZkWE5zZVNCaFoyRnBibk4wSUc5dVpTQnRiMjV2ZEc5dWFXTWdaR1ZoWkd4cGJtVXVDZ3BwYlhCdmNuUWdleUJsZUdWalJtbHNaU0I5SUdaeWIyMGdJbTV2WkdVNlkyaHBiR1JmY0hKdlkyVnpjeUk3Q21sdGNHOXlkQ0I3Q2lBZ1kyeHZjMlZUZVc1akxBb2dJR052Ym5OMFlXNTBjeUJoY3lCbWMwTnZibk4wWVc1MGN5d0tJQ0JtYzNSaGRGTjVibU1zQ2lBZ2JITjBZWFJUZVc1akxBb2dJRzl3Wlc1VGVXNWpMQW9nSUhKbFlXeHdZWFJvVTNsdVl5d0tmU0JtY205dElDSnViMlJsT21aeklqc0thVzF3YjNKMElIc0tJQ0JqYUcxdlpDd0tJQ0JzYzNSaGRDd0tJQ0J0YTJScGNpd0tJQ0J2Y0dWdUxBb2dJSEpsWVdSR2FXeGxMQW9nSUhKbFlXeHdZWFJvTEFwOUlHWnliMjBnSW01dlpHVTZabk12Y0hKdmJXbHpaWE1pT3dwcGJYQnZjblFnZXdvZ0lHSmhjMlZ1WVcxbExBb2dJR1JwY201aGJXVXNDaUFnYW05cGJpd0tJQ0J5WlhOdmJIWmxMQW9nSUhObGNDd0tJQ0IzYVc0ek1pd0tmU0JtY205dElDSnViMlJsT25CaGRHZ2lPd3BwYlhCdmNuUWdleUJ6WlhSVWFXMWxiM1YwSUdGeklHUmxiR0Y1SUgwZ1puSnZiU0FpYm05a1pUcDBhVzFsY25NdmNISnZiV2x6WlhNaU93b0tZMjl1YzNRZ1RFOURTMTlCVUZCTVNVTkJWRWxQVGw5SlJDQTlJREI0TkRFME56UmxORE03SUM4dklDSkJSMDVESWdwamIyNXpkQ0JNVDBOTFgwWlBVazFCVkY5V1JWSlRTVTlPSUQwZ01Uc0tZMjl1YzNRZ1UxRk1TVlJGWDBKVlUxa2dQU0ExT3dwamIyNXpkQ0JTUlVkSlUxUlNXVjlXUlZKVFNVOU9JRDBnTVRzS1kyOXVjM1FnVWtWSFNWTlVVbGxmVTFsTlFrOU1JRDBnVTNsdFltOXNMbVp2Y2lnaVFIUmxkSE4xYnkxaGFTOWhaMlZ1WXk1emNXeHBkR1V0Ykc5amF5MXlaV2RwYzNSeWVTSXBPd3BqYjI1emRDQk5RVmhmUWxWVFdWOVNSVlJTV1Y5TlV5QTlJRFV3T3dwamIyNXpkQ0JOUVZoZlZFbE5SVkpmUkVWTVFWbGZUVk1nUFNBeVh6RTBOMTgwT0ROZk5qUTNPd3BqYjI1emRDQlZUbE5WVUZCUFVsUkZSRjlHU1V4RlgwbEVYelkwSUQwZ01IaG1abVptWDJabVptWmZabVptWmw5bVptWm1ianNLWTI5dWMzUWdWMGxPUkU5WFUxOVFRVlJJWDFSU1FVNVRVRTlTVkY5TlFWaGZRMGhCVWxNZ1BTQXhObDh6T0RRN0NtTnZibk4wSUZkSlRrUlBWMU5mVUVGVVNGOVVVa0ZPVTFCUFVsUmZUVUZZWDBWT1ZGSkpSVk1nUFNBeE1qZzdDbU52Ym5OMElGZEpUa1JQVjFOZlUxbFRWRVZOWDFKUFQxUWdQU0JUZEhKcGJtY3VjbUYzWUZ4Y1AxeEhURTlDUVV4U1QwOVVYRk41YzNSbGJWSnZiM1JnT3dwamIyNXpkQ0JYU1U1RVQxZFRYMFZZUlVOVlZFRkNURVZmUmtsTVJWTlpVMVJGVFNBOUlIc0tJQ0JzYzNSaGREb2dLSEJoZEdncElEMCtJR3h6ZEdGMFUzbHVZeWh3WVhSb0xDQjdJR0pwWjJsdWREb2dkSEoxWlNCOUtTd0tJQ0J2Y0dWdU9pQW9jR0YwYUNrZ1BUNGdiM0JsYmxONWJtTW9DaUFnSUNCd1lYUm9MQW9nSUNBZ1puTkRiMjV6ZEdGdWRITXVUMTlTUkU5T1RGa2dmQ0FvWm5ORGIyNXpkR0Z1ZEhNdVQxOU9UMFpQVEV4UFZ5QS9QeUF3S1N3S0lDQXBMQW9nSUdaemRHRjBPaUFvWkdWelkzSnBjSFJ2Y2lrZ1BUNGdabk4wWVhSVGVXNWpLR1JsYzJOeWFYQjBiM0lzSUhzZ1ltbG5hVzUwT2lCMGNuVmxJSDBwTEFvZ0lHTnNiM05sT2lCamJHOXpaVk41Ym1Nc0NuMDdDbU52Ym5OMElFeFBRMEZNWDBaSlRFVlRXVk5VUlUxZlZGbFFSVk1nUFNCdVpYY2dVMlYwS0ZzS0lDQWlZWEJtY3lJc0lDSmlZMkZqYUdWbWN5SXNJQ0ppZEhKbWN5SXNJQ0psZUdaaGRDSXNJQ0psZUhReUlpd2dJbVY0ZERNaUxDQWlaWGgwTkNJc0lDSm1NbVp6SWl3S0lDQWlhR1p6SWl3Z0ltaG1jM0JzZFhNaUxDQWlhbVp6SWl3Z0ltMXpaRzl6SWl3Z0ltNXBiR1p6TWlJc0lDSnVkR1p6SWl3Z0ltNTBabk16SWl3Z0ltOTJaWEpzWVhraUxBb2dJQ0p5WVcxbWN5SXNJQ0p5WldselpYSm1jeUlzSUNKMGJYQm1jeUlzSUNKMVltbG1jeUlzSUNKMVpuTWlMQ0FpZG1aaGRDSXNJQ0o0Wm5NaUxDQWllbVp6SWl3S1hTazdDbU52Ym5OMElFUkJVbGRKVGw5QlEweGZVa1ZCUkY5U1NVZElWRk1nUFNCdVpYY2dVMlYwS0ZzS0lDQWljbVZoWkNJc0lDSnNhWE4wSWl3Z0luTmxZWEpqYUNJc0lDSmxlR1ZqZFhSbElpd2dJbkpsWVdSaGRIUnlJaXdnSW5KbFlXUmxlSFJoZEhSeUlpd2dJbkpsWVdSelpXTjFjbWwwZVNJc0NsMHBPd3BqYjI1emRDQkVRVkpYU1U1ZlFVTk1YMGxPU0VWU1NWUkJUa05GWDBaTVFVZFRJRDBnYm1WM0lGTmxkQ2hiQ2lBZ0ltWnBiR1ZmYVc1b1pYSnBkQ0lzSUNKa2FYSmxZM1J2Y25sZmFXNW9aWEpwZENJc0lDSnNhVzFwZEY5cGJtaGxjbWwwSWl3Z0ltOXViSGxmYVc1b1pYSnBkQ0lzQ2wwcE93cGpiMjV6ZENCRVFWSlhTVTVmUVVOTVgwMVZWRUZVU1U5T1gxSkpSMGhVVXlBOUlHNWxkeUJUWlhRb1d3b2dJQ0ozY21sMFpTSXNJQ0poY0hCbGJtUWlMQ0FpWVdSa1gyWnBiR1VpTENBaVlXUmtYM04xWW1ScGNtVmpkRzl5ZVNJc0lDSmtaV3hsZEdVaUxDQWlaR1ZzWlhSbFgyTm9hV3hrSWl3S0lDQWlkM0pwZEdWaGRIUnlJaXdnSW5keWFYUmxaWGgwWVhSMGNpSXNJQ0ozY21sMFpYTmxZM1Z5YVhSNUlpd2dJbU5vYjNkdUlpd0tYU2s3Q21OdmJuTjBJRVJCVWxkSlRsOUJRMHhmUzA1UFYwNWZWRTlMUlU1VElEMGdibVYzSUZObGRDaGJDaUFnTGk0dVJFRlNWMGxPWDBGRFRGOVNSVUZFWDFKSlIwaFVVeXdLSUNBdUxpNUVRVkpYU1U1ZlFVTk1YMGxPU0VWU1NWUkJUa05GWDBaTVFVZFRMQW9nSUM0dUxrUkJVbGRKVGw5QlEweGZUVlZVUVZSSlQwNWZVa2xIU0ZSVExBcGRLVHNLWTI5dWMzUWdSRUZTVjBsT1gwRkRURjlXUlZKRVNVTlVYME5CUTBoRlgweEpUVWxVSUQwZ05URXlPd3BqYjI1emRDQmtZWEozYVc1QlkyeFdaWEprYVdOMGN5QTlJRzVsZHlCTllYQW9LVHNLQ21OdmJuTjBJRmRKVGtSUFYxTmZVMFZEVlZKSlZGbGZVME5TU1ZCVUlEMGdVM1J5YVc1bkxuSmhkMkFLSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3b2pJRXRsWlhBZ2RHaHBjeUJrYVhKbFkzUXRMazVGVkNCdmJteDVPaUJ0YjJSMWJHVWdZWFYwYjJ4dllXUWdZMkZ1SUdWNGFHRjFjM1FnZEdobElITm9ZWEpsWkNCc2IyTnJJR1JsWVdSc2FXNWxMZ29rZEhKaGJuTndiM0owSUQwZ1czTjBjbWx1WjEwa1pXNTJPa0ZIUlU1RFgweFBRMHRmVUVGVVNGTUthV1lnS0Z0emRISnBibWRkT2pwSmMwNTFiR3hQY2tWdGNIUjVLQ1IwY21GdWMzQnZjblFwSUMxdmNpQWtkSEpoYm5Od2IzSjBMa3hsYm1kMGFDQXRaM1FnSkh0WFNVNUVUMWRUWDFCQlZFaGZWRkpCVGxOUVQxSlVYMDFCV0Y5RFNFRlNVMzBwSUhzS0lDQjBhSEp2ZHlBbmFXNTJZV3hwWkNCd2NtOTBaV04wWldRdGNHRjBhQ0IwY21GdWMzQnZjblFuQ24wS0pHVnVkSEpwWlhNZ1BTQmJjM1J5YVc1blcxMWRKSFJ5WVc1emNHOXlkQzVUY0d4cGRDaGJZMmhoY2wweE1Da0thV1lnS0NSbGJuUnlhV1Z6TGtOdmRXNTBJQzFzZENBeElDMXZjaUFrWlc1MGNtbGxjeTVEYjNWdWRDQXRaM1FnSkh0WFNVNUVUMWRUWDFCQlZFaGZWRkpCVGxOUVQxSlVYMDFCV0Y5RlRsUlNTVVZUZlNrZ2V3b2dJSFJvY205M0lDZHBiblpoYkdsa0lIQnliM1JsWTNSbFpDMXdZWFJvSUhSeVlXNXpjRzl5ZENjS2ZRb2tZM1Z5Y21WdWRGTnBaQ0E5SUZ0VGVYTjBaVzB1VTJWamRYSnBkSGt1VUhKcGJtTnBjR0ZzTGxkcGJtUnZkM05KWkdWdWRHbDBlVjA2T2tkbGRFTjFjbkpsYm5Rb0tTNVZjMlZ5TGxaaGJIVmxDaVIwY25WemRHVmtJRDBnUUNnS0lDQWtZM1Z5Y21WdWRGTnBaQ3dLSUNBblV5MHhMVFV0TVRnbkxBb2dJQ2RUTFRFdE5TMHpNaTAxTkRRbkxBb2dJQ2RUTFRFdE5TMDRNQzA1TlRZd01EZzRPRFV0TXpReE9EVXlNalkwT1MweE9ETXhNRE00TURRMExURTROVE15T1RJMk16RXRNakkzTVRRM09EUTJOQ2NLS1FvaklGTndaV05wWm1saklHMTFkR0YwYVc5dUlISnBaMmgwY3lCd2JIVnpJRWRGVGtWU1NVTmZWMUpKVkVVZ1lXNWtJRWRGVGtWU1NVTmZRVXhNTGdva2JHVmhaazExZEdGMGFXOXVUV0Z6YXlBOUlGdHBiblEyTkYweE16UXpNREk1TlRrd0NpUmhibU5sYzNSdmNrMTFkR0YwYVc5dVRXRnpheUE5SUZ0cGJuUTJORjB4TXpRek1ESTVOVGcyQ21admNtVmhZMmdnS0NSbGJuUnllU0JwYmlBa1pXNTBjbWxsY3lrZ2V3b2dJQ1J6WlhCaGNtRjBiM0lnUFNBa1pXNTBjbmt1U1c1a1pYaFBaaWhiWTJoaGNsMDFPQ2tLSUNCcFppQW9KSE5sY0dGeVlYUnZjaUF0YkhRZ01TQXRiM0lnSkhObGNHRnlZWFJ2Y2lBdFpYRWdLQ1JsYm5SeWVTNU1aVzVuZEdnZ0xTQXhLU2tnZXdvZ0lDQWdkR2h5YjNjZ0oybHVkbUZzYVdRZ2NISnZkR1ZqZEdWa0xYQmhkR2dnZEhKaGJuTndiM0owSndvZ0lIMEtJQ0FrY205c1pTQTlJQ1JsYm5SeWVTNVRkV0p6ZEhKcGJtY29NQ3dnSkhObGNHRnlZWFJ2Y2lrS0lDQnBaaUFvUUNnbmJHVmhaa1JwY21WamRHOXllU2NzSUNkaGJtTmxjM1J2Y2tScGNtVmpkRzl5ZVNjc0lDZG1hV3hsSnlrZ0xXNXZkR052Ym5SaGFXNXpJQ1J5YjJ4bEtTQjdDaUFnSUNCMGFISnZkeUFpYVc1MllXeHBaQ0J3Y205MFpXTjBaV1F0Y0dGMGFDQnliMnhsT2lBa2NtOXNaU0lLSUNCOUNpQWdKR1Z1WTI5a1pXUlFZWFJvSUQwZ0pHVnVkSEo1TGxOMVluTjBjbWx1Wnlna2MyVndZWEpoZEc5eUlDc2dNU2tLSUNCcFppQW9LQ1JsYm1OdlpHVmtVR0YwYUM1TVpXNW5kR2dnSlNBMEtTQXRibVVnTUNrZ2V5QjBhSEp2ZHlBbmFXNTJZV3hwWkNCd2NtOTBaV04wWldRdGNHRjBhQ0IwY21GdWMzQnZjblFuSUgwS0lDQWtjR0YwYUVKNWRHVnpJRDBnVzFONWMzUmxiUzVEYjI1MlpYSjBYVG82Um5KdmJVSmhjMlUyTkZOMGNtbHVaeWdrWlc1amIyUmxaRkJoZEdncENpQWdhV1lnS0Nna2NHRjBhRUo1ZEdWekxreGxibWQwYUNBbElESXBJQzF1WlNBd0tTQjdJSFJvY205M0lDZHBiblpoYkdsa0lIQnliM1JsWTNSbFpDMXdZWFJvSUhSeVlXNXpjRzl5ZENjZ2ZRb2dJR2xtSUNoYlUzbHpkR1Z0TGtOdmJuWmxjblJkT2pwVWIwSmhjMlUyTkZOMGNtbHVaeWdrY0dGMGFFSjVkR1Z6S1NBdFkyNWxJQ1JsYm1OdlpHVmtVR0YwYUNrZ2V3b2dJQ0FnZEdoeWIzY2dKMjV2YmkxallXNXZibWxqWVd3Z2NISnZkR1ZqZEdWa0xYQmhkR2dnZEhKaGJuTndiM0owSndvZ0lIMEtJQ0FrY0dGMGFFTm9ZWEpoWTNSbGNuTWdQU0JiWTJoaGNsdGRYVG82Ym1WM0tGdHBiblJkS0NSd1lYUm9RbmwwWlhNdVRHVnVaM1JvSUM4Z01pa3BDaUFnWm05eUlDZ2thVzVrWlhnZ1BTQXdPeUFrYVc1a1pYZ2dMV3gwSUNSd1lYUm9RMmhoY21GamRHVnljeTVNWlc1bmRHZzdJQ1JwYm1SbGVDQXJQU0F4S1NCN0NpQWdJQ0FrWW5sMFpVOW1abk5sZENBOUlDUnBibVJsZUNBcUlESUtJQ0FnSUNSc2IzZENlWFJsSUQwZ1cybHVkRjBrY0dGMGFFSjVkR1Z6V3lSaWVYUmxUMlptYzJWMFhRb2dJQ0FnSkdocFoyaENlWFJsSUQwZ1cybHVkRjBrY0dGMGFFSjVkR1Z6V3lSaWVYUmxUMlptYzJWMElDc2dNVjBLSUNBZ0lDUndZWFJvUTJoaGNtRmpkR1Z5YzFza2FXNWtaWGhkSUQwZ1cyTm9ZWEpkS0NSc2IzZENlWFJsSUMxaWIzSWdLQ1JvYVdkb1FubDBaU0F0YzJoc0lEZ3BLUW9nSUgwS0lDQWtjbVZ4ZFdWemRHVmtJRDBnVzNOMGNtbHVaMTA2T201bGR5Z2tjR0YwYUVOb1lYSmhZM1JsY25NcENpQWdKRzExZEdGMGFXOXVUV0Z6YXlBOUlHbG1JQ2drY205c1pTQXRaWEVnSjJGdVkyVnpkRzl5UkdseVpXTjBiM0o1SnlrZ2V3b2dJQ0FnSkdGdVkyVnpkRzl5VFhWMFlYUnBiMjVOWVhOckNpQWdmU0JsYkhObElIc0tJQ0FnSUNSc1pXRm1UWFYwWVhScGIyNU5ZWE5yQ2lBZ2ZRb2dJQ1JtZFd4c0lEMGdXMU41YzNSbGJTNUpUeTVRWVhSb1hUbzZSMlYwUm5Wc2JGQmhkR2dvSkhKbGNYVmxjM1JsWkNrS0lDQnBaaUFvSkdaMWJHd3VVM1JoY25SelYybDBhQ2duWEZ3bktTQXRiM0lnSkdaMWJHd3VVM1JoY25SelYybDBhQ2duWEZ3L1hDY3BJQzF2Y2lBa1puVnNiQzVUZEdGeWRITlhhWFJvS0NkY1hDNWNKeWtwSUhzS0lDQWdJSFJvY205M0lDSnVaWFIzYjNKcklHRnVaQ0JrWlhacFkyVWdjR0YwYUhNZ1lYSmxJSFZ1YzNWd2NHOXlkR1ZrT2lBa1puVnNiQ0lLSUNCOUNpQWdKR0YwZEhKcFluVjBaWE1nUFNCYlUzbHpkR1Z0TGtsUExrWnBiR1ZkT2pwSFpYUkJkSFJ5YVdKMWRHVnpLQ1JtZFd4c0tRb2dJR2xtSUNnb0pHRjBkSEpwWW5WMFpYTWdMV0poYm1RZ1cxTjVjM1JsYlM1SlR5NUdhV3hsUVhSMGNtbGlkWFJsYzEwNk9sSmxjR0Z5YzJWUWIybHVkQ2tnTFc1bElEQXBJSHNLSUNBZ0lIUm9jbTkzSUNKeVpYQmhjbk5sSUhCdmFXNTBjeUJoY21VZ2RXNXpkWEJ3YjNKMFpXUTZJQ1JtZFd4c0lnb2dJSDBLSUNBa2FYTkVhWEpsWTNSdmNua2dQU0FvSkdGMGRISnBZblYwWlhNZ0xXSmhibVFnVzFONWMzUmxiUzVKVHk1R2FXeGxRWFIwY21saWRYUmxjMTA2T2tScGNtVmpkRzl5ZVNrZ0xXNWxJREFLSUNCcFppQW9KR2x6UkdseVpXTjBiM0o1SUMxdVpTQW9KSEp2YkdVZ0xXNWxJQ2RtYVd4bEp5a3BJSHNLSUNBZ0lIUm9jbTkzSUNKd2NtOTBaV04wWldRdGNHRjBhQ0J5YjJ4bElHUnZaWE1nYm05MElHMWhkR05vSUdsMGN5QjBlWEJsT2lBa1puVnNiQ0lLSUNCOUNpQWdKR1J5YVhabElEMGdXMU41YzNSbGJTNUpUeTVFY21sMlpVbHVabTlkT2pwdVpYY29XMU41YzNSbGJTNUpUeTVRWVhSb1hUbzZSMlYwVUdGMGFGSnZiM1FvSkdaMWJHd3BLUW9nSUdsbUlDaEFLRElzSURNc0lEWXBJQzF1YjNSamIyNTBZV2x1Y3lCYmFXNTBYU1JrY21sMlpTNUVjbWwyWlZSNWNHVXBJSHNLSUNBZ0lIUm9jbTkzSUNKdWIyNHRiRzlqWVd3Z1pISnBkbVVnYVhNZ2RXNXpkWEJ3YjNKMFpXUTZJQ1JtZFd4c0lnb2dJSDBLSUNCcFppQW9KR1J5YVhabExrUnlhWFpsUm05eWJXRjBJQzF1WlNBblRsUkdVeWNwSUhzS0lDQWdJSFJvY205M0lDSm1hV3hsYzNsemRHVnRJR05oYm01dmRDQmxibVp2Y21ObElIUm9aU0J5WlhGMWFYSmxaQ0JCUTB3Z1kyOXVkSEpoWTNRNklDUm1kV3hzSWdvZ0lIMEtJQ0FrWVdOc1UyVmpkR2x2Ym5NZ1BTQmJVM2x6ZEdWdExsTmxZM1Z5YVhSNUxrRmpZMlZ6YzBOdmJuUnliMnd1UVdOalpYTnpRMjl1ZEhKdmJGTmxZM1JwYjI1elhUbzZUM2R1WlhJZ0xXSnZjaUJiVTNsemRHVnRMbE5sWTNWeWFYUjVMa0ZqWTJWemMwTnZiblJ5YjJ3dVFXTmpaWE56UTI5dWRISnZiRk5sWTNScGIyNXpYVG82UVdOalpYTnpDaUFnYVdZZ0tDUnBjMFJwY21WamRHOXllU2tnZXdvZ0lDQWdKR0ZqYkNBOUlGdFRlWE4wWlcwdVNVOHVSR2x5WldOMGIzSjVYVG82UjJWMFFXTmpaWE56UTI5dWRISnZiQ2drWm5Wc2JDd2dKR0ZqYkZObFkzUnBiMjV6S1FvZ0lIMGdaV3h6WlNCN0NpQWdJQ0FrWVdOc0lEMGdXMU41YzNSbGJTNUpUeTVHYVd4bFhUbzZSMlYwUVdOalpYTnpRMjl1ZEhKdmJDZ2tablZzYkN3Z0pHRmpiRk5sWTNScGIyNXpLUW9nSUgwS0lDQnBaaUFvTFc1dmRDQWtZV05zTGtGeVpVRmpZMlZ6YzFKMWJHVnpRMkZ1YjI1cFkyRnNLU0I3Q2lBZ0lDQjBhSEp2ZHlBaWJtOXVMV05oYm05dWFXTmhiQ0JCUTB3Z2FYTWdkVzV6ZFhCd2IzSjBaV1E2SUNSbWRXeHNJZ29nSUgwS0lDQWtZbmwwWlhNZ1BTQWtZV05zTGtkbGRGTmxZM1Z5YVhSNVJHVnpZM0pwY0hSdmNrSnBibUZ5ZVVadmNtMG9LUW9nSUNSeVlYY2dQU0JiVTNsemRHVnRMbE5sWTNWeWFYUjVMa0ZqWTJWemMwTnZiblJ5YjJ3dVVtRjNVMlZqZFhKcGRIbEVaWE5qY21sd2RHOXlYVG82Ym1WM0tDUmllWFJsY3l3Z01Da0tJQ0JwWmlBb0pHNTFiR3dnTFdWeElDUnlZWGN1UkdselkzSmxkR2x2Ym1GeWVVRmpiQ2tnZXdvZ0lDQWdkR2h5YjNjZ0ltNTFiR3dnUkVGRFRDQnBjeUIxYm5OMWNIQnZjblJsWkRvZ0pHWjFiR3dpQ2lBZ2ZRb2dJQ1J2ZDI1bGNpQTlJQ1JoWTJ3dVIyVjBUM2R1WlhJb1cxTjVjM1JsYlM1VFpXTjFjbWwwZVM1UWNtbHVZMmx3WVd3dVUyVmpkWEpwZEhsSlpHVnVkR2xtYVdWeVhTa3VWbUZzZFdVS0lDQnBaaUFvSkhSeWRYTjBaV1FnTFc1dmRHTnZiblJoYVc1eklDUnZkMjVsY2lrZ2V3b2dJQ0FnZEdoeWIzY2dJblZ1ZEhKMWMzUmxaQ0J2ZDI1bGNpQlRTVVFnYjI0Z2JHOWpheUJ3WVhSb09pQWtablZzYkNJS0lDQjlDaUFnSkhKMWJHVnpJRDBnSkdGamJDNUhaWFJCWTJObGMzTlNkV3hsY3lnS0lDQWdJQ1IwY25WbExBb2dJQ0FnSkhSeWRXVXNDaUFnSUNCYlUzbHpkR1Z0TGxObFkzVnlhWFI1TGxCeWFXNWphWEJoYkM1VFpXTjFjbWwwZVVsa1pXNTBhV1pwWlhKZENpQWdLUW9nSUdadmNtVmhZMmdnS0NSeWRXeGxJR2x1SUNSeWRXeGxjeWtnZXdvZ0lDQWdhV1lnS0NSeWRXeGxMa0ZqWTJWemMwTnZiblJ5YjJ4VWVYQmxJQzF1WlNCYlUzbHpkR1Z0TGxObFkzVnlhWFI1TGtGalkyVnpjME52Ym5SeWIyd3VRV05qWlhOelEyOXVkSEp2YkZSNWNHVmRPanBCYkd4dmR5a2dld29nSUNBZ0lDQmpiMjUwYVc1MVpRb2dJQ0FnZlFvZ0lDQWdKR2x1YUdWeWFYUlBibXg1SUQwZ0tDUnlkV3hsTGxCeWIzQmhaMkYwYVc5dVJteGhaM01nTFdKaGJtUWdXMU41YzNSbGJTNVRaV04xY21sMGVTNUJZMk5sYzNORGIyNTBjbTlzTGxCeWIzQmhaMkYwYVc5dVJteGhaM05kT2pwSmJtaGxjbWwwVDI1c2VTa2dMVzVsSURBS0lDQWdJR2xtSUNna2FXNW9aWEpwZEU5dWJIa3BJSHNLSUNBZ0lDQWdKR05vYVd4a1NXNW9aWEpwZEdGdVkyVWdQU0JiVTNsemRHVnRMbE5sWTNWeWFYUjVMa0ZqWTJWemMwTnZiblJ5YjJ3dVNXNW9aWEpwZEdGdVkyVkdiR0ZuYzEwNk9rOWlhbVZqZEVsdWFHVnlhWFFnTFdKdmNpQmJVM2x6ZEdWdExsTmxZM1Z5YVhSNUxrRmpZMlZ6YzBOdmJuUnliMnd1U1c1b1pYSnBkR0Z1WTJWR2JHRm5jMTA2T2tOdmJuUmhhVzVsY2tsdWFHVnlhWFFLSUNBZ0lDQWdKSEpsWVdOb1pYTk9aWGREYUdsc1pDQTlJQ2drY25Wc1pTNUpibWhsY21sMFlXNWpaVVpzWVdkeklDMWlZVzVrSUNSamFHbHNaRWx1YUdWeWFYUmhibU5sS1NBdGJtVWdNQW9nSUNBZ0lDQnBaaUFvSkhKdmJHVWdMVzVsSUNkc1pXRm1SR2x5WldOMGIzSjVKeUF0YjNJZ0xXNXZkQ0FrY21WaFkyaGxjMDVsZDBOb2FXeGtLU0I3Q2lBZ0lDQWdJQ0FnWTI5dWRHbHVkV1VLSUNBZ0lDQWdmUW9nSUNBZ2ZRb2dJQ0FnSkhOcFpDQTlJQ1J5ZFd4bExrbGtaVzUwYVhSNVVtVm1aWEpsYm1ObExsWmhiSFZsQ2lBZ0lDQWtjbWxuYUhSeklEMGdLRnRwYm5RMk5GMGtjblZzWlM1R2FXeGxVM2x6ZEdWdFVtbG5hSFJ6S1NBdFltRnVaQ0JiYVc1ME5qUmROREk1TkRrMk56STVOUW9nSUNBZ2FXWWdLQ1IwY25WemRHVmtJQzF1YjNSamIyNTBZV2x1Y3lBa2MybGtJQzFoYm1RZ0tDZ2tjbWxuYUhSeklDMWlZVzVrSUNSdGRYUmhkR2x2YmsxaGMyc3BJQzF1WlNBd0tTa2dld29nSUNBZ0lDQjBhSEp2ZHlBaWRXNTBjblZ6ZEdWa0lHMTFkR0YwYVc5dUlFRkRSU0J2YmlCc2IyTnJJSEJoZEdnNklDUm1kV3hzSWdvZ0lDQWdmUW9nSUgwS2ZRcGJRMjl1YzI5c1pWMDZPazkxZEM1WGNtbDBaU2duVDBzbktRcGdPd3BqYjI1emRDQlhTVTVFVDFkVFgxTkZRMVZTU1ZSWlgxTkRVa2xRVkY5Q1FWTkZOalFnUFNCQ2RXWm1aWEl1Wm5KdmJTZ0tJQ0JYU1U1RVQxZFRYMU5GUTFWU1NWUlpYMU5EVWtsUVZDd0tJQ0FpZFhSbU1UWnNaU0lzQ2lrdWRHOVRkSEpwYm1jb0ltSmhjMlUyTkNJcE93b0taWGh3YjNKMElHTnNZWE56SUV4dlkyRnNVM0ZzYVhSbFRHOWphMVJwYldWdmRYUkZjbkp2Y2lCbGVIUmxibVJ6SUVWeWNtOXlJSHNLSUNCamIyNXpkSEoxWTNSdmNpaDdJSEJoZEdnc0lHeGhZbVZzTENCMGFXMWxiM1YwVFhNc0lHTmhkWE5sSUgwcElIc0tJQ0FnSUhOMWNHVnlLQW9nSUNBZ0lDQmdZV2RsYm1NNklDUjdiR0ZpWld4OUlIUnBiV1ZrSUc5MWRDQmhablJsY2lBa2UzUnBiV1Z2ZFhSTmMzMXRjeUIzWVdsMGFXNW5JR1p2Y2lCc2IyTmhiQ0J3Y205alpYTnpJR3h2WTJzZ0pIdHdZWFJvZldBc0NpQWdJQ0FnSUdOaGRYTmxJRDA5UFNCMWJtUmxabWx1WldRZ1B5QjFibVJsWm1sdVpXUWdPaUI3SUdOaGRYTmxJSDBzQ2lBZ0lDQXBPd29nSUNBZ2RHaHBjeTV1WVcxbElEMGdJa3h2WTJGc1UzRnNhWFJsVEc5amExUnBiV1Z2ZFhSRmNuSnZjaUk3Q2lBZ0lDQjBhR2x6TG1OdlpHVWdQU0FpUVVkRlRrTmZURTlEUzE5VVNVMUZUMVZVSWpzS0lDQWdJSFJvYVhNdWNHRjBhQ0E5SUhCaGRHZzdDaUFnSUNCMGFHbHpMbXhoWW1Wc0lEMGdiR0ZpWld3N0NpQWdJQ0IwYUdsekxuUnBiV1Z2ZFhSTmN5QTlJSFJwYldWdmRYUk5jenNLSUNCOUNuMEtDbVoxYm1OMGFXOXVJSFJwYldWdmRYUkZjbkp2Y2loamIyNTBaWGgwTENCd1lYUm9MQ0JqWVhWelpTa2dld29nSUhKbGRIVnliaUJ1WlhjZ1RHOWpZV3hUY1d4cGRHVk1iMk5yVkdsdFpXOTFkRVZ5Y205eUtIc0tJQ0FnSUhCaGRHZ3NDaUFnSUNCc1lXSmxiRG9nWTI5dWRHVjRkQzVzWVdKbGJDd0tJQ0FnSUhScGJXVnZkWFJOY3pvZ1kyOXVkR1Y0ZEM1MGFXMWxiM1YwVFhNc0NpQWdJQ0JqWVhWelpTd0tJQ0I5S1RzS2ZRb0tablZ1WTNScGIyNGdjbVZ0WVdsdWFXNW5UV2xzYkdselpXTnZibVJ6S0dOdmJuUmxlSFFwSUhzS0lDQnlaWFIxY200Z1RXRjBhQzVtYkc5dmNpaGpiMjUwWlhoMExtUmxZV1JzYVc1bElDMGdjR1Z5Wm05eWJXRnVZMlV1Ym05M0tDa3BPd3A5Q2dwbWRXNWpkR2x2YmlCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0J3WVhSb0xDQmpZWFZ6WlNrZ2V3b2dJR2xtSUNoeVpXMWhhVzVwYm1kTmFXeHNhWE5sWTI5dVpITW9ZMjl1ZEdWNGRDa2dQRDBnTUNrZ2V3b2dJQ0FnZEdoeWIzY2dkR2x0Wlc5MWRFVnljbTl5S0dOdmJuUmxlSFFzSUhCaGRHZ3NJR05oZFhObEtUc0tJQ0I5Q24wS0NtWjFibU4wYVc5dUlISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUhCb1lYTmxLU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUhKbGMzVnNkQ0E5SUdOdmJuUmxlSFF1YjI1UWNtOW5jbVZ6Y3o4dUtIQm9ZWE5sS1RzS0lDQWdJR2xtSUNoeVpYTjFiSFFnSVQwOUlIVnVaR1ZtYVc1bFpDa2dld29nSUNBZ0lDQjJiMmxrSUZCeWIyMXBjMlV1Y21WemIyeDJaU2h5WlhOMWJIUXBMbU5oZEdOb0tDZ3BJRDArSUh0OUtUc0tJQ0FnSUgwS0lDQjlJR05oZEdOb0lIc0tJQ0FnSUM4dklFUnBZV2R1YjNOMGFXTnpJRzExYzNRZ2JtVjJaWElnWTJoaGJtZGxJR3h2WTJzZ1lXTnhkV2x6YVhScGIyNGdiM0lnY21Wc1pXRnpaU0J6WlcxaGJuUnBZM011Q2lBZ2ZRcDlDZ3BtZFc1amRHbHZiaUJ3Y205alpYTnpURzlqYTFKbFoybHpkSEo1S0NrZ2V3b2dJR052Ym5OMElHTjFjbkpsYm5RZ1BTQndjbTlqWlhOelcxSkZSMGxUVkZKWlgxTlpUVUpQVEYwN0NpQWdhV1lnS0dOMWNuSmxiblFnSVQwOUlIVnVaR1ZtYVc1bFpDa2dld29nSUNBZ2FXWWdLQW9nSUNBZ0lDQmpkWEp5Wlc1MElEMDlQU0J1ZFd4c0lIeDhDaUFnSUNBZ0lIUjVjR1Z2WmlCamRYSnlaVzUwSUNFOVBTQWliMkpxWldOMElpQjhmQW9nSUNBZ0lDQmpkWEp5Wlc1MExuWmxjbk5wYjI0Z0lUMDlJRkpGUjBsVFZGSlpYMVpGVWxOSlQwNGdmSHdLSUNBZ0lDQWdJU2hqZFhKeVpXNTBMbXh2WTJ0eklHbHVjM1JoYm1ObGIyWWdUV0Z3S1FvZ0lDQWdLU0I3Q2lBZ0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpZ0tJQ0FnSUNBZ0lDQWlZV2RsYm1NNklHbHVZMjl0Y0dGMGFXSnNaU0J3Y205alpYTnpMWGRwWkdVZ1UxRk1hWFJsSUd4dlkyc2djbVZuYVhOMGNua2dhWE1nWVd4eVpXRmtlU0JwYm5OMFlXeHNaV1FpTEFvZ0lDQWdJQ0FwT3dvZ0lDQWdmUW9nSUNBZ2NtVjBkWEp1SUdOMWNuSmxiblE3Q2lBZ2ZRb2dJR052Ym5OMElHTnlaV0YwWldRZ1BTQjdJSFpsY25OcGIyNDZJRkpGUjBsVFZGSlpYMVpGVWxOSlQwNHNJR3h2WTJ0ek9pQnVaWGNnVFdGd0tDa2dmVHNLSUNCUFltcGxZM1F1WkdWbWFXNWxVSEp2Y0dWeWRIa29jSEp2WTJWemN5d2dVa1ZIU1ZOVVVsbGZVMWxOUWs5TUxDQjdDaUFnSUNCMllXeDFaVG9nWTNKbFlYUmxaQ3dLSUNBZ0lHTnZibVpwWjNWeVlXSnNaVG9nWm1Gc2MyVXNDaUFnSUNCbGJuVnRaWEpoWW14bE9pQm1ZV3h6WlN3S0lDQWdJSGR5YVhSaFlteGxPaUJtWVd4elpTd0tJQ0I5S1RzS0lDQnlaWFIxY200Z1kzSmxZWFJsWkRzS2ZRb0tablZ1WTNScGIyNGdZV054ZFdseVpVbHVVSEp2WTJWemMweHZZMnNvY0hKbGNHRnlaV1FzSUdOdmJuUmxlSFFwSUhzS0lDQmpiMjV6ZENCeVpXZHBjM1J5ZVNBOUlIQnliMk5sYzNOTWIyTnJVbVZuYVhOMGNua29LVHNLSUNCamIyNXpkQ0JyWlhrZ1BTQndjbVZ3WVhKbFpDNXBaR1Z1ZEdsMGVVdGxlVHNLSUNCc1pYUWdjM1JoZEdVZ1BTQnlaV2RwYzNSeWVTNXNiMk5yY3k1blpYUW9hMlY1S1RzS0lDQnBaaUFvYzNSaGRHVWdQVDA5SUhWdVpHVm1hVzVsWkNrZ2V3b2dJQ0FnYzNSaGRHVWdQU0I3SUd4dlkydGxaRG9nWm1Gc2MyVXNJSGRoYVhSbGNuTTZJRnRkSUgwN0NpQWdJQ0J5WldkcGMzUnllUzVzYjJOcmN5NXpaWFFvYTJWNUxDQnpkR0YwWlNrN0NpQWdmUW9LSUNCamIyNXpkQ0J0WVd0bFVtVnNaV0Z6WlNBOUlDZ3BJRDArSUhzS0lDQWdJR3hsZENCeVpXeGxZWE5sWkNBOUlHWmhiSE5sT3dvZ0lDQWdjbVYwZFhKdUlDZ3BJRDArSUhzS0lDQWdJQ0FnYVdZZ0tISmxiR1ZoYzJWa0tTQnlaWFIxY200N0NpQWdJQ0FnSUhKbGJHVmhjMlZrSUQwZ2RISjFaVHNLSUNBZ0lDQWdZMjl1YzNRZ2JtVjRkQ0E5SUhOMFlYUmxMbmRoYVhSbGNuTXVjMmhwWm5Rb0tUc0tJQ0FnSUNBZ2FXWWdLRzVsZUhRZ1BUMDlJSFZ1WkdWbWFXNWxaQ2tnZXdvZ0lDQWdJQ0FnSUhOMFlYUmxMbXh2WTJ0bFpDQTlJR1poYkhObE93b2dJQ0FnSUNBZ0lISmxaMmx6ZEhKNUxteHZZMnR6TG1SbGJHVjBaU2hyWlhrcE93b2dJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUdOc1pXRnlWR2x0Wlc5MWRDaHVaWGgwTG5ScGJXVnlLVHNLSUNBZ0lDQWdJQ0J1WlhoMExuSmxjMjlzZG1Vb2JXRnJaVkpsYkdWaGMyVW9LU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lIMDdDaUFnZlRzS0NpQWdhV1lnS0NGemRHRjBaUzVzYjJOclpXUXBJSHNLSUNBZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCeVpYQmhjbVZrTG5CaGRHZ3BPd29nSUNBZ2MzUmhkR1V1Ykc5amEyVmtJRDBnZEhKMVpUc0tJQ0FnSUhKbGRIVnliaUJRY205dGFYTmxMbkpsYzI5c2RtVW9iV0ZyWlZKbGJHVmhjMlVvS1NrN0NpQWdmUW9LSUNCamIyNXpkQ0J5WlcxaGFXNXBibWNnUFNCeVpXMWhhVzVwYm1kTmFXeHNhWE5sWTI5dVpITW9ZMjl1ZEdWNGRDazdDaUFnYVdZZ0tISmxiV0ZwYm1sdVp5QThQU0F3S1NCN0NpQWdJQ0J5WlhSMWNtNGdVSEp2YldselpTNXlaV3BsWTNRb2RHbHRaVzkxZEVWeWNtOXlLR052Ym5SbGVIUXNJSEJ5WlhCaGNtVmtMbkJoZEdncEtUc0tJQ0I5Q2lBZ2NtVjBkWEp1SUc1bGR5QlFjbTl0YVhObEtDaHlaWE52YkhabFYyRnBkQ3dnY21WcVpXTjBWMkZwZENrZ1BUNGdld29nSUNBZ1kyOXVjM1FnZDJGcGRHVnlJRDBnZXdvZ0lDQWdJQ0J5WlhOdmJIWmxPaUJ5WlhOdmJIWmxWMkZwZEN3S0lDQWdJQ0FnZEdsdFpYSTZJSFZ1WkdWbWFXNWxaQ3dLSUNBZ0lIMDdDaUFnSUNCamIyNXpkQ0JoY20xVWFXMWxiM1YwSUQwZ0tDa2dQVDRnZXdvZ0lDQWdJQ0JqYjI1emRDQmtaV3hoZVUxeklEMGdjbVZ0WVdsdWFXNW5UV2xzYkdselpXTnZibVJ6S0dOdmJuUmxlSFFwT3dvZ0lDQWdJQ0JwWmlBb1pHVnNZWGxOY3lBOFBTQXdLU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdhVzVrWlhnZ1BTQnpkR0YwWlM1M1lXbDBaWEp6TG1sdVpHVjRUMllvZDJGcGRHVnlLVHNLSUNBZ0lDQWdJQ0JwWmlBb2FXNWtaWGdnSVQwOUlDMHhLU0J6ZEdGMFpTNTNZV2wwWlhKekxuTndiR2xqWlNocGJtUmxlQ3dnTVNrN0NpQWdJQ0FnSUNBZ2NtVnFaV04wVjJGcGRDaDBhVzFsYjNWMFJYSnliM0lvWTI5dWRHVjRkQ3dnY0hKbGNHRnlaV1F1Y0dGMGFDa3BPd29nSUNBZ0lDQWdJSEpsZEhWeWJqc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCM1lXbDBaWEl1ZEdsdFpYSWdQU0J6WlhSVWFXMWxiM1YwS0dGeWJWUnBiV1Z2ZFhRc0lFMWhkR2d1YldsdUtHUmxiR0Y1VFhNc0lFMUJXRjlVU1UxRlVsOUVSVXhCV1Y5TlV5a3BPd29nSUNBZ2ZUc0tJQ0FnSUhOMFlYUmxMbmRoYVhSbGNuTXVjSFZ6YUNoM1lXbDBaWElwT3dvZ0lDQWdZWEp0VkdsdFpXOTFkQ2dwT3dvZ0lIMHBPd3A5Q2dwbWRXNWpkR2x2YmlCa1pXTnZaR1ZOYjNWdWRGQmhkR2dvZG1Gc2RXVXBJSHNLSUNCeVpYUjFjbTRnZG1Gc2RXVXVjbVZ3YkdGalpTZ3ZYRndvV3pBdE4xMTdNMzBwTDJjc0lDaGZiV0YwWTJnc0lHOWpkR0ZzS1NBOVBnb2dJQ0FnVTNSeWFXNW5MbVp5YjIxRGFHRnlRMjlrWlNoT2RXMWlaWEl1Y0dGeWMyVkpiblFvYjJOMFlXd3NJRGdwS1NrN0NuMEtDbVoxYm1OMGFXOXVJSEJoZEdoSmMxZHBkR2hwYmlod1lYUm9MQ0J0YjNWdWRGQnZhVzUwS1NCN0NpQWdjbVYwZFhKdUlIQmhkR2dnUFQwOUlHMXZkVzUwVUc5cGJuUWdmSHdLSUNBZ0lIQmhkR2d1YzNSaGNuUnpWMmwwYUNodGIzVnVkRkJ2YVc1MElEMDlQU0J6WlhBZ1B5QnRiM1Z1ZEZCdmFXNTBJRG9nWUNSN2JXOTFiblJRYjJsdWRIMGtlM05sY0gxZ0tUc0tmUW9LWm5WdVkzUnBiMjRnWlhobFkwWnBiR1ZWZEdZNEtHWnBiR1VzSUdGeVozTXNJRzl3ZEdsdmJuTXNJR052Ym5SbGVIUXNJSEJoZEdncElIc0tJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVZTZFc0c0lISmxhbVZqZEZKMWJpa2dQVDRnZXdvZ0lDQWdiR1YwSUdSbFlXUnNhVzVsVkdsdFpYSTdDaUFnSUNCc1pYUWdaWGh3YVhKbFpDQTlJR1poYkhObE93b2dJQ0FnWTI5dWMzUWdZMmhwYkdRZ1BTQmxlR1ZqUm1sc1pTZ0tJQ0FnSUNBZ1ptbHNaU3dLSUNBZ0lDQWdZWEpuY3l3S0lDQWdJQ0FnZXlBdUxpNXZjSFJwYjI1ekxDQmxibU52WkdsdVp6b2dJblYwWmpnaUlIMHNDaUFnSUNBZ0lDaGxjbkp2Y2l3Z2MzUmtiM1YwTENCemRHUmxjbklwSUQwK0lIc0tJQ0FnSUNBZ0lDQnBaaUFvWkdWaFpHeHBibVZVYVcxbGNpQWhQVDBnZFc1a1pXWnBibVZrS1NCamJHVmhjbFJwYldWdmRYUW9aR1ZoWkd4cGJtVlVhVzFsY2lrN0NpQWdJQ0FnSUNBZ2FXWWdLR1Y0Y0dseVpXUXBJSHNLSUNBZ0lDQWdJQ0FnSUhKbGFtVmpkRkoxYmloMGFXMWxiM1YwUlhKeWIzSW9ZMjl1ZEdWNGRDd2djR0YwYUN3Z1pYSnliM0lnUHo4Z2RXNWtaV1pwYm1Wa0tTazdDaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNDdDaUFnSUNBZ0lDQWdmUW9nSUNBZ0lDQWdJR2xtSUNobGNuSnZjaUFoUFQwZ2JuVnNiQ2tnZXdvZ0lDQWdJQ0FnSUNBZ1QySnFaV04wTG1GemMybG5iaWhsY25KdmNpd2dleUJ6ZEdSdmRYUXNJSE4wWkdWeWNpQjlLVHNLSUNBZ0lDQWdJQ0FnSUhKbGFtVmpkRkoxYmlobGNuSnZjaWs3Q2lBZ0lDQWdJQ0FnSUNCeVpYUjFjbTQ3Q2lBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUhKbGMyOXNkbVZTZFc0b2V5QnpkR1J2ZFhRc0lITjBaR1Z5Y2lCOUtUc0tJQ0FnSUNBZ2ZTd0tJQ0FnSUNrN0NpQWdJQ0JqYjI1emRDQmhjbTFFWldGa2JHbHVaU0E5SUNncElEMCtJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NtVnRZV2x1YVc1bklEMGdjbVZ0WVdsdWFXNW5UV2xzYkdselpXTnZibVJ6S0dOdmJuUmxlSFFwT3dvZ0lDQWdJQ0JwWmlBb2NtVnRZV2x1YVc1bklEdzlJREFwSUhzS0lDQWdJQ0FnSUNCbGVIQnBjbVZrSUQwZ2RISjFaVHNLSUNBZ0lDQWdJQ0JqYUdsc1pDNXJhV3hzS0NrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1T3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR1JsWVdSc2FXNWxWR2x0WlhJZ1BTQnpaWFJVYVcxbGIzVjBLQW9nSUNBZ0lDQWdJR0Z5YlVSbFlXUnNhVzVsTEFvZ0lDQWdJQ0FnSUUxaGRHZ3ViV2x1S0hKbGJXRnBibWx1Wnl3Z1RVRllYMVJKVFVWU1gwUkZURUZaWDAxVEtTd0tJQ0FnSUNBZ0tUc0tJQ0FnSUgwN0NpQWdJQ0JoY20xRVpXRmtiR2x1WlNncE93b2dJSDBwT3dwOUNncG1kVzVqZEdsdmJpQnViM0p0WVd4cGVtVlVhVzFsWkVOdmJXMWhibVJGY25KdmNpaGxjbkp2Y2l3Z1kyOXVkR1Y0ZEN3Z2NHRjBhQ2tnZXdvZ0lHbG1JQ2dLSUNBZ0lISmxiV0ZwYm1sdVowMXBiR3hwYzJWamIyNWtjeWhqYjI1MFpYaDBLU0E4UFNBd0lIeDhDaUFnSUNCbGNuSnZjajh1WTI5a1pTQTlQVDBnSWtWVVNVMUZSRTlWVkNJZ2ZId0tJQ0FnSUdWeWNtOXlQeTVyYVd4c1pXUWdQVDA5SUhSeWRXVUtJQ0FwSUhzS0lDQWdJSEpsZEhWeWJpQjBhVzFsYjNWMFJYSnliM0lvWTI5dWRHVjRkQ3dnY0dGMGFDd2daWEp5YjNJcE93b2dJSDBLSUNCeVpYUjFjbTRnWlhKeWIzSTdDbjBLQ21aMWJtTjBhVzl1SUhaaGJHbGtZWFJsUkdGeWQybHVRV05zVEdsemRHbHVaeWh6ZEdSdmRYUXNJSEJoZEdnc0lISnZiR1VwSUhzS0lDQnBaaUFvYzNSa2IzVjBMbWx1WTJ4MVpHVnpLQ0pjY2lJcEtTQjdDaUFnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWUdGblpXNWpPaUJFWVhKM2FXNGdRVU5NSUdobGJIQmxjaUJ5WlhSMWNtNWxaQ0J1YjI0dFkyRnViMjVwWTJGc0lHOTFkSEIxZENCbWIzSWdKSHR3WVhSb2ZXQXBPd29nSUgwS0lDQmpiMjV6ZENCc2FXNWxjeUE5SUhOMFpHOTFkQzV6Y0d4cGRDZ2lYRzRpS1RzS0lDQnBaaUFvYkdsdVpYTXVZWFFvTFRFcElEMDlQU0FpSWlrZ2JHbHVaWE11Y0c5d0tDazdDaUFnYVdZZ0tHeHBibVZ6TG14bGJtZDBhQ0E5UFQwZ01DQjhmQ0JzYVc1bGMxc3dYUzVzWlc1bmRHZ2dQVDA5SURBcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJRVJoY25kcGJpQkJRMHdnYUdWc2NHVnlJSEpsZEhWeWJtVmtJRzV2SUcxbGRHRmtZWFJoSUdadmNpQWtlM0JoZEdoOVlDazdDaUFnZlFvZ0lHeGxkQ0J3Y21WMmFXOTFjMDl5WkdsdVlXd2dQU0F0TVRzS0lDQnNaWFFnYzJGM1RHVm5ZV041VDNkdVpYSWdQU0JtWVd4elpUc0tJQ0JtYjNJZ0tHTnZibk4wSUd4cGJtVWdiMllnYkdsdVpYTXVjMnhwWTJVb01Ta3BJSHNLSUNBZ0lHbG1JQ2d2WGx4ekttOTNibVZ5T2x4eksxeFRMaW9rTDNVdWRHVnpkQ2hzYVc1bEtTQW1KaUFoYzJGM1RHVm5ZV041VDNkdVpYSWdKaVlnY0hKbGRtbHZkWE5QY21ScGJtRnNJRDA5UFNBdE1Ta2dld29nSUNBZ0lDQnpZWGRNWldkaFkzbFBkMjVsY2lBOUlIUnlkV1U3Q2lBZ0lDQWdJR052Ym5ScGJuVmxPd29nSUNBZ2ZRb2dJQ0FnWTI5dWMzUWdiV0YwWTJnZ1BTQnNhVzVsTG0xaGRHTm9LQW9nSUNBZ0lDQXZYbHh6S2loY1pDc3BPbHh6S3lndUt6OHBYSE1yS0Q4NktHbHVhR1Z5YVhSbFpDbGNjeXNwUHloaGJHeHZkM3hrWlc1NUtWeHpLeWhiWVMxNlgxMHJLRDg2TEZ0aExYcGZYU3NwS2lsY2N5b2tMM1VzQ2lBZ0lDQXBPd29nSUNBZ2FXWWdLRzFoZEdOb0lEMDlQU0J1ZFd4c0tTQjdDaUFnSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUVSaGNuZHBiaUJCUTB3Z2FHVnNjR1Z5SUhKbGRIVnlibVZrSUhWdWNtVmpiMmR1YVhwbFpDQnZkWFJ3ZFhRZ1ptOXlJQ1I3Y0dGMGFIMWdLVHNLSUNBZ0lIMEtJQ0FnSUdOdmJuTjBJRzl5WkdsdVlXd2dQU0JPZFcxaVpYSW9iV0YwWTJoYk1WMHBPd29nSUNBZ2FXWWdLQ0ZPZFcxaVpYSXVhWE5UWVdabFNXNTBaV2RsY2lodmNtUnBibUZzS1NCOGZDQnZjbVJwYm1Gc0lEdzlJSEJ5WlhacGIzVnpUM0prYVc1aGJDa2dld29nSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCRVlYSjNhVzRnUVVOTUlHaGxiSEJsY2lCeVpYUjFjbTVsWkNCcGJuWmhiR2xrSUVGRFJTQnZjbVJsY21sdVp5Qm1iM0lnSkh0d1lYUm9mV0FwT3dvZ0lDQWdmUW9nSUNBZ2NISmxkbWx2ZFhOUGNtUnBibUZzSUQwZ2IzSmthVzVoYkRzS0lDQWdJR052Ym5OMElHRnpjMjlqYVdGMGFXOXVJRDBnYldGMFkyaGJORjA3Q2lBZ0lDQmpiMjV6ZENCMGIydGxibk1nUFNCdFlYUmphRnMxWFM1emNHeHBkQ2dpTENJcE93b2dJQ0FnWm05eUlDaGpiMjV6ZENCMGIydGxiaUJ2WmlCMGIydGxibk1wSUhzS0lDQWdJQ0FnYVdZZ0tDRkVRVkpYU1U1ZlFVTk1YMHRPVDFkT1gxUlBTMFZPVXk1b1lYTW9kRzlyWlc0cEtTQjdDaUFnSUNBZ0lDQWdkR2h5YjNjZ2JtVjNJRVZ5Y205eUtHQmhaMlZ1WXpvZ1JHRnlkMmx1SUVGRFRDQm9aV3h3WlhJZ2NtVjBkWEp1WldRZ2RXNXJibTkzYmlCeWFXZG9kQ0FrZTNSdmEyVnVmVG9nSkh0d1lYUm9mV0FwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQjlDaUFnSUNCcFppQW9DaUFnSUNBZ0lHRnpjMjlqYVdGMGFXOXVJRDA5UFNBaVlXeHNiM2NpSUNZbUNpQWdJQ0FnSUhSdmEyVnVjeTV6YjIxbEtDaDBiMnRsYmlrZ1BUNGdSRUZTVjBsT1gwRkRURjlOVlZSQlZFbFBUbDlTU1VkSVZGTXVhR0Z6S0hSdmEyVnVLU2tLSUNBZ0lDa2dld29nSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb0NpQWdJQ0FnSUNBZ1lHRm5aVzVqT2lCd2NtOTBaV04wWldRZ0pIdHliMnhsZlNCb1lYTWdZU0J0ZFhSaGRHbHZiaTFqWVhCaFlteGxJRVJoY25kcGJpQkJRMHc2SUNSN2NHRjBhSDFnTEFvZ0lDQWdJQ0FwT3dvZ0lDQWdmUW9nSUgwS2ZRb0tZWE41Ym1NZ1puVnVZM1JwYjI0Z1lYTnpaWEowUkdGeWQybHVVR0YwYUZObFkzVnlhWFI1S0hCaGRHZ3NJSEp2YkdVc0lHTnZiblJsZUhRcElIc0tJQ0J5WlhSMWNtNGdZWE56WlhKMFJHRnlkMmx1VUdGMGFGTmxZM1Z5YVhSNVYybDBhRWxQS0FvZ0lDQWdjR0YwYUN3S0lDQWdJSEp2YkdVc0NpQWdJQ0JqYjI1MFpYaDBMQW9nSUNBZ1pYaGxZMFpwYkdWVmRHWTRMQW9nSUNBZ0tHTmhibVJwWkdGMFpTa2dQVDRnYkhOMFlYUW9ZMkZ1Wkdsa1lYUmxMQ0I3SUdKcFoybHVkRG9nZEhKMVpTQjlLU3dLSUNBcE93cDlDZ292THlCSVJsTXJJSEpsY0c5eWRITWdZMmhoYm1kbElIUnBiV1VnYVc0Z2QyaHZiR1VnYzJWamIyNWtjeXdnYzI4Z1lXNGdRVU5NSUdWa2FYUWdkMmwwYUdsdUlIUm9aU0J6WVcxbENpOHZJSE5sWTI5dVpDQmpZVzRnYkdWaGRtVWdkR2hsSUdsa1pXNTBhWFI1SUhWdVkyaGhibWRsWkM0Z1QyNXNlU0J6ZFdJdGMyVmpiMjVrSUdOb1lXNW5aU0IwYVcxbGN5QmhjbVVLTHk4Z2NISmxZMmx6WlNCbGJtOTFaMmdnZEc4Z1kyRmphR1VnWVNCMlpYSmthV04wTGdwbWRXNWpkR2x2YmlCb1lYTlRkV0p6WldOdmJtUkRhR0Z1WjJWVWFXMWxLSE4wWVhSektTQjdDaUFnYVdZZ0tIUjVjR1Z2WmlCemRHRjBjeTVqZEdsdFpVNXpJRDA5UFNBaVltbG5hVzUwSWlrZ2NtVjBkWEp1SUhOMFlYUnpMbU4wYVcxbFRuTWdKU0F4WHpBd01GOHdNREJmTURBd2JpQWhQVDBnTUc0N0NpQWdjbVYwZFhKdUlFNTFiV0psY2k1cGMwWnBibWwwWlNoemRHRjBjeTVqZEdsdFpVMXpLU0FtSmlCemRHRjBjeTVqZEdsdFpVMXpJQ1VnTVRBd01DQWhQVDBnTURzS2ZRb0tablZ1WTNScGIyNGdaR0Z5ZDJsdVFXTnNTV1JsYm5ScGRIa29jM1JoZEhNcElIc0tJQ0J5WlhSMWNtNGdXd29nSUNBZ2MzUmhkSE11WkdWMkxDQnpkR0YwY3k1cGJtOHNJSE4wWVhSekxtTjBhVzFsVG5NZ1B6OGdjM1JoZEhNdVkzUnBiV1ZOY3l3S0lDQWdJSE4wWVhSekxtMXZaR1VzSUhOMFlYUnpMblZwWkN3Z2MzUmhkSE11WjJsa0xBb2dJQ0FnY0hKdlkyVnpjeTVuWlhSMWFXUS9MaWdwTENCd2NtOWpaWE56TG1kbGRHVjFhV1EvTGlncExBb2dJRjB1YW05cGJpZ2lPaUlwT3dwOUNncGhjM2x1WXlCbWRXNWpkR2x2YmlCaGMzTmxjblJFWVhKM2FXNVFZWFJvVTJWamRYSnBkSGxYYVhSb1NVOG9jR0YwYUN3Z2NtOXNaU3dnWTI5dWRHVjRkQ3dnYkdsemRHVnlMQ0J6ZEdGMFVHRjBhQ2tnZXdvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCaGRHZ3BPd29nSUM4dklFRWdSR0Z5ZDJsdUlFRkRUQ0JsWkdsMElHRmtkbUZ1WTJWeklHTjBhVzFsTGlCU1pTMXpkR0YwSUc5dUlHVjJaWEo1SUd4dmIydDFjQ0J6YnlCaGJpQnZiR1FLSUNBdkx5QnpkV05qWlhOelpuVnNJSFpsY21ScFkzUWdZMkZ1Ym05MElHRjFkR2h2Y21sNlpTQmhJR05vWVc1blpXUWdhVzV2WkdVc0lHOTNibVZ5TENCdmNpQkJRMHd1Q2lBZ1kyOXVjM1FnWW1WbWIzSmxJRDBnWkdGeWQybHVRV05zU1dSbGJuUnBkSGtvWVhkaGFYUWdjM1JoZEZCaGRHZ29jR0YwYUNrcE93b2dJR052Ym5OMElHTmhZMmhsUzJWNUlEMGdZQ1I3Y205c1pYMWNNQ1I3Y0dGMGFIMWdPd29nSUdsbUlDaGtZWEozYVc1QlkyeFdaWEprYVdOMGN5NW5aWFFvWTJGamFHVkxaWGtwSUQwOVBTQmlaV1p2Y21VcElIc0tJQ0FnSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJSEJoZEdncE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQmtZWEozYVc1QlkyeFdaWEprYVdOMGN5NWtaV3hsZEdVb1kyRmphR1ZMWlhrcE93b2dJR3hsZENCeVpYTjFiSFE3Q2lBZ2RISjVJSHNLSUNBZ0lISmxjM1ZzZENBOUlHRjNZV2wwSUd4cGMzUmxjaWdLSUNBZ0lDQWdJaTlpYVc0dmJITWlMQW9nSUNBZ0lDQmJJaTFzWkdWeElpd2djR0YwYUYwc0NpQWdJQ0FnSUhzS0lDQWdJQ0FnSUNCbGJuWTZJSHNnVEVOZlFVeE1PaUFpUXlJZ2ZTd0tJQ0FnSUNBZ0lDQnRZWGhDZFdabVpYSTZJREkxTmlBcUlERXdNalFzQ2lBZ0lDQWdJSDBzQ2lBZ0lDQWdJR052Ym5SbGVIUXNDaUFnSUNBZ0lIQmhkR2dzQ2lBZ0lDQXBPd29nSUgwZ1kyRjBZMmdnS0dWeWNtOXlLU0I3Q2lBZ0lDQjBhSEp2ZHlCdWIzSnRZV3hwZW1WVWFXMWxaRU52YlcxaGJtUkZjbkp2Y2lobGNuSnZjaXdnWTI5dWRHVjRkQ3dnY0dGMGFDazdDaUFnZlFvZ0lHbG1JQ2h5WlhOMWJIUXVjM1JrWlhKeUlDRTlQU0FpSWlrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2dSR0Z5ZDJsdUlFRkRUQ0JvWld4d1pYSWdjbVYwZFhKdVpXUWdkVzVsZUhCbFkzUmxaQ0JrYVdGbmJtOXpkR2xqY3lCbWIzSWdKSHR3WVhSb2ZXQXBPd29nSUgwS0lDQjJZV3hwWkdGMFpVUmhjbmRwYmtGamJFeHBjM1JwYm1jb2NtVnpkV3gwTG5OMFpHOTFkQ3dnY0dGMGFDd2djbTlzWlNrN0NpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NHRjBhQ2s3Q2lBZ0x5OGdRU0J3WVhSb0lHTm9ZVzVuWldRZ2QyaHBiR1VnYkhNZ2NtRnVJRzExYzNRZ2JtVjJaWElnYzJWbFpDQmhJSFpsY21ScFkzUWdabTl5SUdsMGN5QnVaWGNnYzNSaGRHVXVDaUFnWTI5dWMzUWdZV1owWlhKVGRHRjBjeUE5SUdGM1lXbDBJSE4wWVhSUVlYUm9LSEJoZEdncE93b2dJR052Ym5OMElHRm1kR1Z5SUQwZ1pHRnlkMmx1UVdOc1NXUmxiblJwZEhrb1lXWjBaWEpUZEdGMGN5azdDaUFnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2djR0YwYUNrN0NpQWdhV1lnS0dGbWRHVnlJRDA5UFNCaVpXWnZjbVVnSmlZZ2FHRnpVM1ZpYzJWamIyNWtRMmhoYm1kbFZHbHRaU2hoWm5SbGNsTjBZWFJ6S1NrZ2V3b2dJQ0FnYVdZZ0tHUmhjbmRwYmtGamJGWmxjbVJwWTNSekxuTnBlbVVnUGowZ1JFRlNWMGxPWDBGRFRGOVdSVkpFU1VOVVgwTkJRMGhGWDB4SlRVbFVLU0I3Q2lBZ0lDQWdJR1JoY25kcGJrRmpiRlpsY21ScFkzUnpMbVJsYkdWMFpTaGtZWEozYVc1QlkyeFdaWEprYVdOMGN5NXJaWGx6S0NrdWJtVjRkQ2dwTG5aaGJIVmxLVHNLSUNBZ0lIMEtJQ0FnSUdSaGNuZHBia0ZqYkZabGNtUnBZM1J6TG5ObGRDaGpZV05vWlV0bGVTd2dZbVZtYjNKbEtUc0tJQ0I5Q24wS0NtWjFibU4wYVc5dUlIUnlkWE4wWldSWGFXNWtiM2R6VUc5M1pYSlRhR1ZzYkZCaGRHZ29DaUFnWTJGdWIyNXBZMkZzYVhwbElEMGdjbVZoYkhCaGRHaFRlVzVqTG01aGRHbDJaU3dLSUNCbWFXeGxjM2x6ZEdWdElEMGdWMGxPUkU5WFUxOUZXRVZEVlZSQlFreEZYMFpKVEVWVFdWTlVSVTBzQ2lrZ2V3b2dJQzh2SUVSbGNtbDJaU0JoSUVOeVpXRjBaVkJ5YjJObGMzTXRZMjl0Y0dGMGFXSnNaU0JFVDFNZ2MzQmxiR3hwYm1jZ1puSnZiU0JIVEU5Q1FVeFNUMDlVTENCMGFHVnVJSEJ5YjNabENpQWdMeThnWW05MGFDQnpjR1ZzYkdsdVozTWdjM1JwYkd3Z2JtRnRaU0IwYUdVZ2MyRnRaU0J5WldkMWJHRnlJSE41YzNSbGJTQm1hV3hsSUdKbFptOXlaU0JzWVhWdVkyZ3VDaUFnWTI5dWMzUWdjM2x6ZEdWdFVtOXZkQ0E5SUdOaGJtOXVhV05oYkdsNlpTaFhTVTVFVDFkVFgxTlpVMVJGVFY5U1QwOVVLVHNLSUNCcFppQW9JUzllVzJFdGVsMDZYRnd2YVhVdWRHVnpkQ2h6ZVhOMFpXMVNiMjkwS1NCOGZDQjNhVzR6TWk1dWIzSnRZV3hwZW1Vb2MzbHpkR1Z0VW05dmRDa2dJVDA5SUhONWMzUmxiVkp2YjNRcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWdpZEhKMWMzUmxaQ0JYYVc1a2IzZHpJRk41YzNSbGJWSnZiM1FnWkdsa0lHNXZkQ0J5WlhOdmJIWmxJSFJ2SUdFZ1kyRnViMjVwWTJGc0lHeHZZMkZzSUVSUFV5QndZWFJvSWlrN0NpQWdmUW9nSUdOdmJuTjBJSGR2Y210cGJtZEVhWEpsWTNSdmNua2dQU0IzYVc0ek1pNXFiMmx1S0hONWMzUmxiVkp2YjNRc0lDSlRlWE4wWlcwek1pSXBPd29nSUdOdmJuTjBJR1Y0WldOMWRHRmliR1VnUFNCM2FXNHpNaTVxYjJsdUtBb2dJQ0FnZDI5eWEybHVaMFJwY21WamRHOXllU3dLSUNBZ0lDSlhhVzVrYjNkelVHOTNaWEpUYUdWc2JDSXNDaUFnSUNBaWRqRXVNQ0lzQ2lBZ0lDQWljRzkzWlhKemFHVnNiQzVsZUdVaUxBb2dJQ2s3Q2lBZ1kyOXVjM1FnYm1GdFpYTndZV05sUlhobFkzVjBZV0pzWlNBOUlIZHBiak15TG1wdmFXNG9DaUFnSUNCWFNVNUVUMWRUWDFOWlUxUkZUVjlTVDA5VUxBb2dJQ0FnSWxONWMzUmxiVE15SWl3S0lDQWdJQ0pYYVc1a2IzZHpVRzkzWlhKVGFHVnNiQ0lzQ2lBZ0lDQWlkakV1TUNJc0NpQWdJQ0FpY0c5M1pYSnphR1ZzYkM1bGVHVWlMQW9nSUNrN0NpQWdkbVZ5YVdaNVYybHVaRzkzYzBWNFpXTjFkR0ZpYkdWQmJHbGhjMlZ6S0c1aGJXVnpjR0ZqWlVWNFpXTjFkR0ZpYkdVc0lHVjRaV04xZEdGaWJHVXNJR1pwYkdWemVYTjBaVzBwT3dvZ0lISmxkSFZ5YmlCN0NpQWdJQ0J6ZVhOMFpXMVNiMjkwTEFvZ0lDQWdkMjl5YTJsdVowUnBjbVZqZEc5eWVTd0tJQ0FnSUdWNFpXTjFkR0ZpYkdVc0NpQWdmVHNLZlFvS1puVnVZM1JwYjI0Z2RtVnlhV1o1VjJsdVpHOTNjMFY0WldOMWRHRmliR1ZCYkdsaGMyVnpLRzVoYldWemNHRmpaVVY0WldOMWRHRmliR1VzSUdWNFpXTjFkR0ZpYkdVc0lHWnBiR1Z6ZVhOMFpXMHBJSHNLSUNCc1pYUWdibUZ0WlhOd1lXTmxSR1Z6WTNKcGNIUnZjanNLSUNCc1pYUWdZMkZ1Wkdsa1lYUmxSR1Z6WTNKcGNIUnZjanNLSUNCc1pYUWdiM0JsY21GMGFXOXVSWEp5YjNJN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHNWhiV1Z6Y0dGalpVSmxabTl5WlNBOUlHWnBiR1Z6ZVhOMFpXMHViSE4wWVhRb2JtRnRaWE53WVdObFJYaGxZM1YwWVdKc1pTazdDaUFnSUNCamIyNXpkQ0JqWVc1a2FXUmhkR1ZDWldadmNtVWdQU0JtYVd4bGMzbHpkR1Z0TG14emRHRjBLR1Y0WldOMWRHRmliR1VwT3dvZ0lDQWdZWE56WlhKMFVtVm5kV3hoY2xkcGJtUnZkM05GZUdWamRYUmhZbXhsS0c1aGJXVnpjR0ZqWlVKbFptOXlaU3dnSWtkTVQwSkJURkpQVDFRZ2NHRjBhQ0lwT3dvZ0lDQWdZWE56WlhKMFVtVm5kV3hoY2xkcGJtUnZkM05GZUdWamRYUmhZbXhsS0dOaGJtUnBaR0YwWlVKbFptOXlaU3dnSWtSUFV5QndZWFJvSWlrN0NpQWdJQ0J1WVcxbGMzQmhZMlZFWlhOamNtbHdkRzl5SUQwZ1ptbHNaWE41YzNSbGJTNXZjR1Z1S0c1aGJXVnpjR0ZqWlVWNFpXTjFkR0ZpYkdVcE93b2dJQ0FnWTJGdVpHbGtZWFJsUkdWelkzSnBjSFJ2Y2lBOUlHWnBiR1Z6ZVhOMFpXMHViM0JsYmlobGVHVmpkWFJoWW14bEtUc0tJQ0FnSUdOdmJuTjBJRzVoYldWemNHRmpaVTl3Wlc1bFpDQTlJR1pwYkdWemVYTjBaVzB1Wm5OMFlYUW9ibUZ0WlhOd1lXTmxSR1Z6WTNKcGNIUnZjaWs3Q2lBZ0lDQmpiMjV6ZENCallXNWthV1JoZEdWUGNHVnVaV1FnUFNCbWFXeGxjM2x6ZEdWdExtWnpkR0YwS0dOaGJtUnBaR0YwWlVSbGMyTnlhWEIwYjNJcE93b2dJQ0FnWTI5dWMzUWdibUZ0WlhOd1lXTmxRV1owWlhJZ1BTQm1hV3hsYzNsemRHVnRMbXh6ZEdGMEtHNWhiV1Z6Y0dGalpVVjRaV04xZEdGaWJHVXBPd29nSUNBZ1kyOXVjM1FnWTJGdVpHbGtZWFJsUVdaMFpYSWdQU0JtYVd4bGMzbHpkR1Z0TG14emRHRjBLR1Y0WldOMWRHRmliR1VwT3dvZ0lDQWdZWE56WlhKMFVtVm5kV3hoY2xkcGJtUnZkM05GZUdWamRYUmhZbXhsS0c1aGJXVnpjR0ZqWlU5d1pXNWxaQ3dnSWtkTVQwSkJURkpQVDFRZ1pHVnpZM0pwY0hSdmNpSXBPd29nSUNBZ1lYTnpaWEowVW1WbmRXeGhjbGRwYm1SdmQzTkZlR1ZqZFhSaFlteGxLR05oYm1ScFpHRjBaVTl3Wlc1bFpDd2dJa1JQVXlCa1pYTmpjbWx3ZEc5eUlpazdDaUFnSUNCaGMzTmxjblJTWldkMWJHRnlWMmx1Wkc5M2MwVjRaV04xZEdGaWJHVW9ibUZ0WlhOd1lXTmxRV1owWlhJc0lDSkhURTlDUVV4U1QwOVVJSEJoZEdnaUtUc0tJQ0FnSUdGemMyVnlkRkpsWjNWc1lYSlhhVzVrYjNkelJYaGxZM1YwWVdKc1pTaGpZVzVrYVdSaGRHVkJablJsY2l3Z0lrUlBVeUJ3WVhSb0lpazdDaUFnSUNCbWIzSWdLR052Ym5OMElHbGtaVzUwYVhSNUlHOW1JRnNLSUNBZ0lDQWdibUZ0WlhOd1lXTmxRbVZtYjNKbExBb2dJQ0FnSUNCallXNWthV1JoZEdWQ1pXWnZjbVVzQ2lBZ0lDQWdJRzVoYldWemNHRmpaVTl3Wlc1bFpDd0tJQ0FnSUNBZ1kyRnVaR2xrWVhSbFQzQmxibVZrTEFvZ0lDQWdJQ0J1WVcxbGMzQmhZMlZCWm5SbGNpd0tJQ0FnSUNBZ1kyRnVaR2xrWVhSbFFXWjBaWElzQ2lBZ0lDQmRLU0I3Q2lBZ0lDQWdJR2xtSUNnS0lDQWdJQ0FnSUNCcFpHVnVkR2wwZVM1a1pYWWdQRDBnTUc0Z2ZId2dhV1JsYm5ScGRIa3VhVzV2SUR3OUlEQnVJSHg4Q2lBZ0lDQWdJQ0FnYVdSbGJuUnBkSGt1WkdWMklEMDlQU0JWVGxOVlVGQlBVbFJGUkY5R1NVeEZYMGxFWHpZMElIeDhJR2xrWlc1MGFYUjVMbWx1YnlBOVBUMGdWVTVUVlZCUVQxSlVSVVJmUmtsTVJWOUpSRjgyTkFvZ0lDQWdJQ0FwSUhzS0lDQWdJQ0FnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvSW5SeWRYTjBaV1FnVjJsdVpHOTNjeUJ6ZVhOMFpXMGdaWGhsWTNWMFlXSnNaU0JwWkdWdWRHbDBlU0JwY3lCMWJtRjJZV2xzWVdKc1pTSXBPd29nSUNBZ0lDQjlDaUFnSUNCOUNpQWdJQ0JwWmlBb0NpQWdJQ0FnSUNGellXMWxSbWxzWlVsa1pXNTBhWFI1S0c1aGJXVnpjR0ZqWlVKbFptOXlaU3dnYm1GdFpYTndZV05sVDNCbGJtVmtLU0I4ZkFvZ0lDQWdJQ0FoYzJGdFpVWnBiR1ZKWkdWdWRHbDBlU2h1WVcxbGMzQmhZMlZQY0dWdVpXUXNJRzVoYldWemNHRmpaVUZtZEdWeUtTQjhmQW9nSUNBZ0lDQWhjMkZ0WlVacGJHVkpaR1Z1ZEdsMGVTaGpZVzVrYVdSaGRHVkNaV1p2Y21Vc0lHTmhibVJwWkdGMFpVOXdaVzVsWkNrZ2ZId0tJQ0FnSUNBZ0lYTmhiV1ZHYVd4bFNXUmxiblJwZEhrb1kyRnVaR2xrWVhSbFQzQmxibVZrTENCallXNWthV1JoZEdWQlpuUmxjaWtnZkh3S0lDQWdJQ0FnSVhOaGJXVkdhV3hsU1dSbGJuUnBkSGtvYm1GdFpYTndZV05sVDNCbGJtVmtMQ0JqWVc1a2FXUmhkR1ZQY0dWdVpXUXBDaUFnSUNBcElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0NKMGNuVnpkR1ZrSUZkcGJtUnZkM01nYzNsemRHVnRJR1Y0WldOMWRHRmliR1VnYVdSbGJuUnBkSGtnYldsemJXRjBZMmdpS1RzS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNobGNuSnZjaWtnZXdvZ0lDQWdiM0JsY21GMGFXOXVSWEp5YjNJZ1BTQmxjbkp2Y2pzS0lDQjlDaUFnWTI5dWMzUWdZMnh2YzJWRmNuSnZjbk1nUFNCYlhUc0tJQ0JtYjNJZ0tHTnZibk4wSUdSbGMyTnlhWEIwYjNJZ2IyWWdXMk5oYm1ScFpHRjBaVVJsYzJOeWFYQjBiM0lzSUc1aGJXVnpjR0ZqWlVSbGMyTnlhWEIwYjNKZEtTQjdDaUFnSUNCcFppQW9aR1Z6WTNKcGNIUnZjaUE5UFQwZ2RXNWtaV1pwYm1Wa0tTQmpiMjUwYVc1MVpUc0tJQ0FnSUhSeWVTQjdJR1pwYkdWemVYTjBaVzB1WTJ4dmMyVW9aR1Z6WTNKcGNIUnZjaWs3SUgwZ1kyRjBZMmdnS0dWeWNtOXlLU0I3SUdOc2IzTmxSWEp5YjNKekxuQjFjMmdvWlhKeWIzSXBPeUI5Q2lBZ2ZRb2dJR2xtSUNodmNHVnlZWFJwYjI1RmNuSnZjaUFoUFQwZ2RXNWtaV1pwYm1Wa0tTQjdDaUFnSUNCcFppQW9ZMnh2YzJWRmNuSnZjbk11YkdWdVozUm9JRDRnTUNrZ2V3b2dJQ0FnSUNCMGFISnZkeUJ1WlhjZ1FXZG5jbVZuWVhSbFJYSnliM0lvQ2lBZ0lDQWdJQ0FnVzI5d1pYSmhkR2x2YmtWeWNtOXlMQ0F1TGk1amJHOXpaVVZ5Y205eWMxMHNDaUFnSUNBZ0lDQWdJblJ5ZFhOMFpXUWdWMmx1Wkc5M2N5QmxlR1ZqZFhSaFlteGxJSFpoYkdsa1lYUnBiMjRnWVc1a0lHTnNaV0Z1ZFhBZ1ltOTBhQ0JtWVdsc1pXUWlMQW9nSUNBZ0lDQXBPd29nSUNBZ2ZRb2dJQ0FnZEdoeWIzY2diM0JsY21GMGFXOXVSWEp5YjNJN0NpQWdmUW9nSUdsbUlDaGpiRzl6WlVWeWNtOXljeTVzWlc1bmRHZ2dQVDA5SURFcElIUm9jbTkzSUdOc2IzTmxSWEp5YjNKeld6QmRPd29nSUdsbUlDaGpiRzl6WlVWeWNtOXljeTVzWlc1bmRHZ2dQaUF4S1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUVdkbmNtVm5ZWFJsUlhKeWIzSW9DaUFnSUNBZ0lHTnNiM05sUlhKeWIzSnpMQW9nSUNBZ0lDQWlkSEoxYzNSbFpDQlhhVzVrYjNkeklHVjRaV04xZEdGaWJHVWdaR1Z6WTNKcGNIUnZjaUJqYkdWaGJuVndJR1poYVd4bFpDSXNDaUFnSUNBcE93b2dJSDBLZlFvS1puVnVZM1JwYjI0Z1lYTnpaWEowVW1WbmRXeGhjbGRwYm1SdmQzTkZlR1ZqZFhSaFlteGxLR2xrWlc1MGFYUjVMQ0J6Y0dWc2JHbHVaeWtnZXdvZ0lHbG1JQ2doYVdSbGJuUnBkSGt1YVhOR2FXeGxLQ2tnZkh3Z2FXUmxiblJwZEhrdWFYTlRlVzFpYjJ4cFkweHBibXNvS1NrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0IwY25WemRHVmtJRmRwYm1SdmQzTWdKSHR6Y0dWc2JHbHVaMzBnWlhobFkzVjBZV0pzWlNCcGN5QnViM1FnWVNCeVpXZDFiR0Z5SUc1dmJpMXNhVzVySUdacGJHVmdLVHNLSUNCOUNuMEtDbVoxYm1OMGFXOXVJSE5oYldWR2FXeGxTV1JsYm5ScGRIa29iR1ZtZEN3Z2NtbG5hSFFwSUhzS0lDQnlaWFIxY200Z2JHVm1kQzVrWlhZZ1BUMDlJSEpwWjJoMExtUmxkaUFtSmlCc1pXWjBMbWx1YnlBOVBUMGdjbWxuYUhRdWFXNXZPd3A5Q2dwbWRXNWpkR2x2YmlCM2FXNWtiM2R6VUc5M1pYSlRhR1ZzYkVWdWRtbHliMjV0Wlc1MEtIQmhkR2h6TENCMGNuVnpkR1ZrVUdGMGFITWdQU0IwY25WemRHVmtWMmx1Wkc5M2MxQnZkMlZ5VTJobGJHeFFZWFJvS0NrcElIc0tJQ0JqYjI1emRDQjdJSE41YzNSbGJWSnZiM1FzSUhkdmNtdHBibWRFYVhKbFkzUnZjbmtnZlNBOUlIUnlkWE4wWldSUVlYUm9jenNLSUNBdkx5QnNhV0oxZGlCbWFXeHNjeUJoSUdacGVHVmtJSE5sZENCdlppQWljbVZ4ZFdseVpXUWlJRmRwYm1SdmQzTWdkbUZ5YVdGaWJHVnpJR1p5YjIwZ2RHaGxJSEJoY21WdWRBb2dJQzh2SUhkb1pXNGdkR2hsZVNCaGNtVWdZV0p6Wlc1MExpQkVaV1pwYm1VZ1pYWmxjbmtnYjI1bElITnZJSEJ2YVhOdmJtVmtJR05oYkd4bGNpQnpkR0YwWlNCallXNXViM1FnWW1VS0lDQXZMeUJ6YVd4bGJuUnNlU0JwYm1obGNtbDBaV1FnYVc1MGJ5QjBhR1VnZG1Gc2FXUmhkR2x2YmlCb1pXeHdaWEl1Q2lBZ2NtVjBkWEp1SUhzS0lDQWdJRUZIUlU1RFgweFBRMHRmVUVGVVNGTTZJSGRwYm1SdmQzTlFZWFJvVkhKaGJuTndiM0owS0hCaGRHaHpLU3dLSUNBZ0lFRlFVRVJCVkVFNklDSWlMQW9nSUNBZ1EwOU5VMUJGUXpvZ0lpSXNDaUFnSUNCSVQwMUZSRkpKVmtVNklDSWlMQW9nSUNBZ1NFOU5SVkJCVkVnNklDSWlMQW9nSUNBZ1RFOURRVXhCVUZCRVFWUkJPaUFpSWl3S0lDQWdJRXhQUjA5T1UwVlNWa1ZTT2lBaUlpd0tJQ0FnSUZCQlZFZzZJSGR2Y210cGJtZEVhWEpsWTNSdmNua3NDaUFnSUNCUVFWUklSVmhVT2lBaUxrVllSU0lzQ2lBZ0lDQlFVMDFQUkZWTVJWQkJWRWc2SUNJaUxBb2dJQ0FnVTFsVFZFVk5SRkpKVmtVNklDSWlMQW9nSUNBZ1UxbFRWRVZOVWs5UFZEb2djM2x6ZEdWdFVtOXZkQ3dLSUNBZ0lGUkZUVkE2SUhkdmNtdHBibWRFYVhKbFkzUnZjbmtzQ2lBZ0lDQlVUVkE2SUhkdmNtdHBibWRFYVhKbFkzUnZjbmtzQ2lBZ0lDQlZVMFZTUkU5TlFVbE9PaUFpSWl3S0lDQWdJRlZUUlZKT1FVMUZPaUFpSWl3S0lDQWdJRlZUUlZKUVVrOUdTVXhGT2lCM2IzSnJhVzVuUkdseVpXTjBiM0o1TEFvZ0lDQWdWMGxPUkVsU09pQnplWE4wWlcxU2IyOTBMQW9nSUgwN0NuMEtDbVoxYm1OMGFXOXVJSGRwYm1SdmQzTlFZWFJvVkhKaGJuTndiM0owS0dWdWRISnBaWE1wSUhzS0lDQnBaaUFvQ2lBZ0lDQWhRWEp5WVhrdWFYTkJjbkpoZVNobGJuUnlhV1Z6S1NCOGZBb2dJQ0FnWlc1MGNtbGxjeTVzWlc1bmRHZ2dQQ0F4SUh4OENpQWdJQ0JsYm5SeWFXVnpMbXhsYm1kMGFDQStJRmRKVGtSUFYxTmZVRUZVU0Y5VVVrRk9VMUJQVWxSZlRVRllYMFZPVkZKSlJWTUtJQ0FwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpZ2lZV2RsYm1NNklGZHBibVJ2ZDNNZ2NISnZkR1ZqZEdWa0xYQmhkR2dnZEhKaGJuTndiM0owSUdoaGN5QmhiaUJwYm5aaGJHbGtJR1Z1ZEhKNUlHTnZkVzUwSWlrN0NpQWdmUW9nSUdOdmJuTjBJSEpsWTI5eVpITWdQU0JiWFRzS0lDQnNaWFFnZEhKaGJuTndiM0owUTJoaGNuTWdQU0F3T3dvZ0lHWnZjaUFvWTI5dWMzUWdaVzUwY25rZ2IyWWdaVzUwY21sbGN5a2dld29nSUNBZ1kyOXVjM1FnY0dGMGFDQTlJR1Z1ZEhKNVB5NXdZWFJvT3dvZ0lDQWdZMjl1YzNRZ2NtOXNaU0E5SUdWdWRISjVQeTV5YjJ4bE93b2dJQ0FnYVdZZ0tBb2dJQ0FnSUNCMGVYQmxiMllnY0dGMGFDQWhQVDBnSW5OMGNtbHVaeUlnZkh3S0lDQWdJQ0FnY0dGMGFDNXNaVzVuZEdnZ1BUMDlJREFnZkh3S0lDQWdJQ0FnY0dGMGFDNXNaVzVuZEdnZ1BpQlhTVTVFVDFkVFgxQkJWRWhmVkZKQlRsTlFUMUpVWDAxQldGOURTRUZTVXlCOGZBb2dJQ0FnSUNBb2NtOXNaU0FoUFQwZ0lteGxZV1pFYVhKbFkzUnZjbmtpSUNZbUlISnZiR1VnSVQwOUlDSmhibU5sYzNSdmNrUnBjbVZqZEc5eWVTSWdKaVlnY205c1pTQWhQVDBnSW1acGJHVWlLUW9nSUNBZ0tTQjdDaUFnSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2lnaVlXZGxibU02SUZkcGJtUnZkM01nY0hKdmRHVmpkR1ZrTFhCaGRHZ2dkSEpoYm5Od2IzSjBJR1Z1ZEhKNUlHbHpJR2x1ZG1Gc2FXUWlLVHNLSUNBZ0lIMEtJQ0FnSUdOdmJuTjBJSEpsWTI5eVpDQTlJR0FrZTNKdmJHVjlPaVI3UW5WbVptVnlMbVp5YjIwb2NHRjBhQ3dnSW5WMFpqRTJiR1VpS1M1MGIxTjBjbWx1WnlnaVltRnpaVFkwSWlsOVlEc0tJQ0FnSUhSeVlXNXpjRzl5ZEVOb1lYSnpJQ3M5SUhKbFkyOXlaQzVzWlc1bmRHZ2dLeUFvY21WamIzSmtjeTVzWlc1bmRHZ2dQVDA5SURBZ1B5QXdJRG9nTVNrN0NpQWdJQ0JwWmlBb2RISmhibk53YjNKMFEyaGhjbk1nUGlCWFNVNUVUMWRUWDFCQlZFaGZWRkpCVGxOUVQxSlVYMDFCV0Y5RFNFRlNVeWtnZXdvZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9JbUZuWlc1ak9pQlhhVzVrYjNkeklIQnliM1JsWTNSbFpDMXdZWFJvSUhSeVlXNXpjRzl5ZENCbGVHTmxaV1J6SUdsMGN5QnNhVzFwZENJcE93b2dJQ0FnZlFvZ0lDQWdjbVZqYjNKa2N5NXdkWE5vS0hKbFkyOXlaQ2s3Q2lBZ2ZRb2dJSEpsZEhWeWJpQnlaV052Y21SekxtcHZhVzRvSWx4dUlpazdDbjBLQ21GemVXNWpJR1oxYm1OMGFXOXVJR0Z6YzJWeWRGZHBibVJ2ZDNOUVlYUm9VMlZqZFhKcGRIa29aVzUwY21sbGN5d2dZMjl1ZEdWNGRDa2dld29nSUdOdmJuTjBJR1JwYzNCc1lYbFFZWFJvSUQwZ1pXNTBjbWxsY3k1aGRDZ3RNU2svTG5CaGRHZ2dQejhnSW5WdWEyNXZkMjRpT3dvZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUdScGMzQnNZWGxRWVhSb0tUc0tJQ0JqYjI1emRDQjBjblZ6ZEdWa1VHRjBhSE1nUFNCMGNuVnpkR1ZrVjJsdVpHOTNjMUJ2ZDJWeVUyaGxiR3hRWVhSb0tDazdDaUFnWTI5dWMzUWdleUIzYjNKcmFXNW5SR2x5WldOMGIzSjVMQ0JsZUdWamRYUmhZbXhsSUgwZ1BTQjBjblZ6ZEdWa1VHRjBhSE03Q2lBZ2JHVjBJSEpsYzNWc2REc0tJQ0IwY25rZ2V3b2dJQ0FnY21WemRXeDBJRDBnWVhkaGFYUWdaWGhsWTBacGJHVlZkR1k0S0FvZ0lDQWdJQ0JsZUdWamRYUmhZbXhsTEFvZ0lDQWdJQ0JiQ2lBZ0lDQWdJQ0FnSWkxT2IweHZaMjhpTEFvZ0lDQWdJQ0FnSUNJdFRtOVFjbTltYVd4bElpd0tJQ0FnSUNBZ0lDQWlMVTV2YmtsdWRHVnlZV04wYVhabElpd0tJQ0FnSUNBZ0lDQWlMVVZ1WTI5a1pXUkRiMjF0WVc1a0lpd0tJQ0FnSUNBZ0lDQlhTVTVFVDFkVFgxTkZRMVZTU1ZSWlgxTkRVa2xRVkY5Q1FWTkZOalFzQ2lBZ0lDQWdJRjBzQ2lBZ0lDQWdJSHNLSUNBZ0lDQWdJQ0JqZDJRNklIZHZjbXRwYm1kRWFYSmxZM1J2Y25rc0NpQWdJQ0FnSUNBZ1pXNTJPaUIzYVc1a2IzZHpVRzkzWlhKVGFHVnNiRVZ1ZG1seWIyNXRaVzUwS0dWdWRISnBaWE1zSUhSeWRYTjBaV1JRWVhSb2N5a3NDaUFnSUNBZ0lDQWdiV0Y0UW5WbVptVnlPaUF4TURJMElDb2dNVEF5TkN3S0lDQWdJQ0FnSUNCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlN3S0lDQWdJQ0FnZlN3S0lDQWdJQ0FnWTI5dWRHVjRkQ3dLSUNBZ0lDQWdaR2x6Y0d4aGVWQmhkR2dzQ2lBZ0lDQXBPd29nSUgwZ1kyRjBZMmdnS0dWeWNtOXlLU0I3Q2lBZ0lDQjBhSEp2ZHlCdWIzSnRZV3hwZW1WVWFXMWxaRU52YlcxaGJtUkZjbkp2Y2lobGNuSnZjaXdnWTI5dWRHVjRkQ3dnWkdsemNHeGhlVkJoZEdncE93b2dJSDBLSUNCcFppQW9jbVZ6ZFd4MExuTjBaRzkxZENBaFBUMGdJazlMSWlrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2dWMmx1Wkc5M2N5QnNiMk5yTFhCaGRHZ2dkbUZzYVdSaGRHbHZiaUJ5WlhSMWNtNWxaQ0JoYmlCcGJuWmhiR2xrSUhKbGMzQnZibk5sSUdadmNpQWtlMlJwYzNCc1lYbFFZWFJvZldBcE93b2dJSDBLSUNCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0JrYVhOd2JHRjVVR0YwYUNrN0NuMEtDbUZ6ZVc1aklHWjFibU4wYVc5dUlHRnpjMlZ5ZEV4dlkyRnNSbWxzWlhONWMzUmxiU2h3WVhKbGJuUXNJR052Ym5SbGVIUXBJSHNLSUNCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0J3WVhKbGJuUXBPd29nSUd4bGRDQm1hV3hsYzNsemRHVnRWSGx3WlRzS0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0lteHBiblY0SWlrZ2V3b2dJQ0FnWTI5dWMzUWdiVzkxYm5SeklEMGdZWGRoYVhRZ2NtVmhaRVpwYkdVb0lpOXdjbTlqTDNObGJHWXZiVzkxYm5ScGJtWnZJaXdnSW5WMFpqZ2lLVHNLSUNBZ0lIUm9jbTkzU1daRmVIQnBjbVZrS0dOdmJuUmxlSFFzSUhCaGNtVnVkQ2s3Q2lBZ0lDQnNaWFFnYkc5dVoyVnpkQ0E5SUMweE93b2dJQ0FnWm05eUlDaGpiMjV6ZENCc2FXNWxJRzltSUcxdmRXNTBjeTV6Y0d4cGRDZ2lYRzRpS1NrZ2V3b2dJQ0FnSUNCamIyNXpkQ0JtYVdWc1pITWdQU0JzYVc1bExuTndiR2wwS0NJZ0lpazdDaUFnSUNBZ0lHTnZibk4wSUhObGNHRnlZWFJ2Y2tsdVpHVjRJRDBnWm1sbGJHUnpMbWx1WkdWNFQyWW9JaTBpS1RzS0lDQWdJQ0FnYVdZZ0tBb2dJQ0FnSUNBZ0lITmxjR0Z5WVhSdmNrbHVaR1Y0SUR3Z05pQjhmQW9nSUNBZ0lDQWdJR1pwWld4a2MxczBYU0E5UFQwZ2RXNWtaV1pwYm1Wa0lIeDhDaUFnSUNBZ0lDQWdabWxsYkdSelczTmxjR0Z5WVhSdmNrbHVaR1Y0SUNzZ01WMGdQVDA5SUhWdVpHVm1hVzVsWkFvZ0lDQWdJQ0FwSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0JqYjI1emRDQnRiM1Z1ZEZCdmFXNTBJRDBnWkdWamIyUmxUVzkxYm5SUVlYUm9LR1pwWld4a2MxczBYU2s3Q2lBZ0lDQWdJR2xtSUNod1lYUm9TWE5YYVhSb2FXNG9jR0Z5Wlc1MExDQnRiM1Z1ZEZCdmFXNTBLU0FtSmlCdGIzVnVkRkJ2YVc1MExteGxibWQwYUNBK0lHeHZibWRsYzNRcElIc0tJQ0FnSUNBZ0lDQnNiMjVuWlhOMElEMGdiVzkxYm5SUWIybHVkQzVzWlc1bmRHZzdDaUFnSUNBZ0lDQWdabWxzWlhONWMzUmxiVlI1Y0dVZ1BTQm1hV1ZzWkhOYmMyVndZWEpoZEc5eVNXNWtaWGdnS3lBeFhUc0tJQ0FnSUNBZ2ZRb2dJQ0FnZlFvZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSW1SaGNuZHBiaUlwSUhzS0lDQWdJR3hsZENCemRHUnZkWFE3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0FvZXlCemRHUnZkWFFnZlNBOUlHRjNZV2wwSUdWNFpXTkdhV3hsVlhSbU9DZ2lMM05pYVc0dmJXOTFiblFpTENCYlhTd2dld29nSUNBZ0lDQWdJR1Z1ZGpvZ2V5Qk1RMTlCVEV3NklDSkRJaUI5TEFvZ0lDQWdJQ0FnSUcxaGVFSjFabVpsY2pvZ05DQXFJREV3TWpRZ0tpQXhNREkwTEFvZ0lDQWdJQ0I5TENCamIyNTBaWGgwTENCd1lYSmxiblFwS1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1Z5Y205eUtTQjdDaUFnSUNBZ0lIUm9jbTkzSUc1dmNtMWhiR2w2WlZScGJXVmtRMjl0YldGdVpFVnljbTl5S0dWeWNtOXlMQ0JqYjI1MFpYaDBMQ0J3WVhKbGJuUXBPd29nSUNBZ2ZRb2dJQ0FnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2djR0Z5Wlc1MEtUc0tJQ0FnSUd4bGRDQnNiMjVuWlhOMElEMGdMVEU3Q2lBZ0lDQm1iM0lnS0dOdmJuTjBJR3hwYm1VZ2IyWWdjM1JrYjNWMExuTndiR2wwS0NKY2JpSXBLU0I3Q2lBZ0lDQWdJR052Ym5OMElHMWhkR05vSUQwZ2JHbHVaUzV0WVhSamFDZ3ZJRzl1SUNndUt5a2dYQ2dvVzE0c1hTc3BMeWs3Q2lBZ0lDQWdJR2xtSUNodFlYUmphQ0E5UFQwZ2JuVnNiQ2tnWTI5dWRHbHVkV1U3Q2lBZ0lDQWdJR052Ym5OMElHMXZkVzUwVUc5cGJuUWdQU0JrWldOdlpHVk5iM1Z1ZEZCaGRHZ29iV0YwWTJoYk1WMHBPd29nSUNBZ0lDQnBaaUFvY0dGMGFFbHpWMmwwYUdsdUtIQmhjbVZ1ZEN3Z2JXOTFiblJRYjJsdWRDa2dKaVlnYlc5MWJuUlFiMmx1ZEM1c1pXNW5kR2dnUGlCc2IyNW5aWE4wS1NCN0NpQWdJQ0FnSUNBZ2JHOXVaMlZ6ZENBOUlHMXZkVzUwVUc5cGJuUXViR1Z1WjNSb093b2dJQ0FnSUNBZ0lHWnBiR1Z6ZVhOMFpXMVVlWEJsSUQwZ2JXRjBZMmhiTWwwN0NpQWdJQ0FnSUgwS0lDQWdJSDBLSUNCOUlHVnNjMlVnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ0ozYVc0ek1pSXBJSHNLSUNBZ0lHRjNZV2wwSUdGemMyVnlkRmRwYm1SdmQzTlFZWFJvVTJWamRYSnBkSGtvVzNzZ2NHRjBhRG9nY0dGeVpXNTBMQ0J5YjJ4bE9pQWliR1ZoWmtScGNtVmpkRzl5ZVNJZ2ZWMHNJR052Ym5SbGVIUXBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMGdaV3h6WlNCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9DaUFnSUNBZ0lHQmhaMlZ1WXpvZ1kyRnVibTkwSUdWemRHRmliR2x6YUNCc2IyTnJJR1pwYkdWemVYTjBaVzBnYkc5allXeHBkSGtnYjI0Z0pIdHdjbTlqWlhOekxuQnNZWFJtYjNKdGZXQXNDaUFnSUNBcE93b2dJSDBLSUNCcFppQW9abWxzWlhONWMzUmxiVlI1Y0dVZ1BUMDlJSFZ1WkdWbWFXNWxaQ0I4ZkNBaFRFOURRVXhmUmtsTVJWTlpVMVJGVFY5VVdWQkZVeTVvWVhNb1ptbHNaWE41YzNSbGJWUjVjR1VwS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9DaUFnSUNBZ0lHQmhaMlZ1WXpvZ2JtOXVMV3h2WTJGc0lHOXlJSFZ1YTI1dmQyNGdiRzlqYXlCbWFXeGxjM2x6ZEdWdElHbHpJSFZ1YzNWd2NHOXlkR1ZrSUNna2UyWnBiR1Z6ZVhOMFpXMVVlWEJsSUQ4L0lDSjFibXR1YjNkdUluMHBPaUFrZTNCaGNtVnVkSDFnTEFvZ0lDQWdLVHNLSUNCOUNuMEtDaThxS2dvZ0tpQkZjM1JoWW14cGMyZ2dkR2hoZENCaGJpQmxlR2x6ZEdsdVp5QmthWEpsWTNSdmNua2dhWE1nWVNCc2IyTmhiQ3dnY0hKcGRtRjBaV3g1SUcxMWRHRmliR1VLSUNvZ1kyOXZjbVJwYm1GMGFXOXVJR0p2ZFc1a1lYSjVMaUJYY21Gd2NHVnlJSEpsY0d4aFkyVnRaVzUwSUhWelpYTWdZU0J5WldkcGMzUnllUzFvYjNOMFpXUWdVMUZNYVhSbENpQXFJR3h2WTJzc0lITnZJR0VnYzJoaGNtVmtJRzl5SUdGMGRHRmphMlZ5TFhkeWFYUmhZbXhsSUhkeVlYQndaWElnWkdseVpXTjBiM0o1SUhkdmRXeGtJRzkwYUdWeWQybHpaUW9nS2lCd1pYSnRhWFFnWTNKdmMzTXRhRzl6ZENCeVlXTmxjeUJ2Y2lCd1lYUm9JSE4xWW5OMGFYUjFkR2x2YmlCdmRYUnphV1JsSUhSb1lYUWdiRzlqYXk0S0lDb3ZDbVY0Y0c5eWRDQmhjM2x1WXlCbWRXNWpkR2x2YmlCaGMzTmxjblJNYjJOaGJGQnlhWFpoZEdWRWFYSmxZM1J2Y25rb0NpQWdjbVZ4ZFdWemRHVmtVR0YwYUN3S0lDQjdDaUFnSUNCMGFXMWxiM1YwVFhNZ1BTQTJNRjh3TURBc0NpQWdJQ0JzWVdKbGJDQTlJQ0pCWjJWdVF5QnZjR1Z5WVhScGIyNGlMQW9nSUNBZ1pHVmhaR3hwYm1VNklITjFjSEJzYVdWa1JHVmhaR3hwYm1Vc0NpQWdJQ0JoYkd4dmQxUnlkWE4wWldSVGRHbGphM2xNWldGbUlEMGdabUZzYzJVc0NpQWdJQ0J2YmxCeWIyZHlaWE56TEFvZ0lIMGdQU0I3ZlN3S0tTQjdDaUFnYVdZZ0tDRk9kVzFpWlhJdWFYTlRZV1psU1c1MFpXZGxjaWgwYVcxbGIzVjBUWE1wSUh4OElIUnBiV1Z2ZFhSTmN5QThQU0F3S1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnVkhsd1pVVnljbTl5S0NKc2IyTnJJSFJwYldWdmRYUk5jeUJ0ZFhOMElHSmxJR0VnY0c5emFYUnBkbVVnYzJGbVpTQnBiblJsWjJWeUlpazdDaUFnZlFvZ0lHbG1JQ2h6ZFhCd2JHbGxaRVJsWVdSc2FXNWxJQ0U5UFNCMWJtUmxabWx1WldRZ0ppWWdJVTUxYldKbGNpNXBjMFpwYm1sMFpTaHpkWEJ3YkdsbFpFUmxZV1JzYVc1bEtTa2dld29nSUNBZ2RHaHliM2NnYm1WM0lGUjVjR1ZGY25KdmNpZ2liRzlqYXlCa1pXRmtiR2x1WlNCdGRYTjBJR0psSUdacGJtbDBaU0lwT3dvZ0lIMEtJQ0JwWmlBb2RIbHdaVzltSUdGc2JHOTNWSEoxYzNSbFpGTjBhV05yZVV4bFlXWWdJVDA5SUNKaWIyOXNaV0Z1SWlrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUZSNWNHVkZjbkp2Y2lnaVlXeHNiM2RVY25WemRHVmtVM1JwWTJ0NVRHVmhaaUJ0ZFhOMElHSmxJR0p2YjJ4bFlXNGlLVHNLSUNCOUNpQWdhV1lnS0c5dVVISnZaM0psYzNNZ0lUMDlJSFZ1WkdWbWFXNWxaQ0FtSmlCMGVYQmxiMllnYjI1UWNtOW5jbVZ6Y3lBaFBUMGdJbVoxYm1OMGFXOXVJaWtnZXdvZ0lDQWdkR2h5YjNjZ2JtVjNJRlI1Y0dWRmNuSnZjaWdpYkc5amF5QnZibEJ5YjJkeVpYTnpJRzExYzNRZ1ltVWdZU0JtZFc1amRHbHZiaUlwT3dvZ0lIMEtJQ0JqYjI1emRDQmpiMjUwWlhoMElEMGdld29nSUNBZ1pHVmhaR3hwYm1VNklFMWhkR2d1YldsdUtBb2dJQ0FnSUNCemRYQndiR2xsWkVSbFlXUnNhVzVsSUQ4L0lFNTFiV0psY2k1UVQxTkpWRWxXUlY5SlRrWkpUa2xVV1N3S0lDQWdJQ0FnY0dWeVptOXliV0Z1WTJVdWJtOTNLQ2tnS3lCMGFXMWxiM1YwVFhNc0NpQWdJQ0FwTEFvZ0lDQWdiR0ZpWld3c0NpQWdJQ0IwYVcxbGIzVjBUWE1zQ2lBZ0lDQnZibEJ5YjJkeVpYTnpMQW9nSUgwN0NpQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0luQnlhWFpoZEdVZ1pHbHlaV04wYjNKNUlIWmhiR2xrWVhScGIyNGdjM1JoY25SbFpDSXBPd29nSUdOdmJuTjBJR0ZpYzI5c2RYUmxJRDBnY21WemIyeDJaU2h5WlhGMVpYTjBaV1JRWVhSb0tUc0tJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQmhZbk52YkhWMFpTazdDaUFnWTI5dWMzUWdZMkZ1YjI1cFkyRnNJRDBnWVhkaGFYUWdjbVZoYkhCaGRHZ29ZV0p6YjJ4MWRHVXBPd29nSUdOdmJuTjBJR0Z1WTJWemRHOXljeUE5SUZ0ZE93b2dJR1p2Y2lBb2JHVjBJR04xY25KbGJuUWdQU0JqWVc1dmJtbGpZV3c3SURzZ1kzVnljbVZ1ZENBOUlHUnBjbTVoYldVb1kzVnljbVZ1ZENrcElIc0tJQ0FnSUdGdVkyVnpkRzl5Y3k1d2RYTm9LR04xY25KbGJuUXBPd29nSUNBZ2FXWWdLR1JwY201aGJXVW9ZM1Z5Y21WdWRDa2dQVDA5SUdOMWNuSmxiblFwSUdKeVpXRnJPd29nSUgwS0lDQmpiMjV6ZENCamRYSnlaVzUwVldsa0lEMGdjSEp2WTJWemN5NW5aWFIxYVdRL0xpZ3BPd29nSUdOdmJuTjBJR0psWm05eVpVbGtaVzUwYVhScFpYTWdQU0J1WlhjZ1RXRndLQ2s3Q2lBZ1ptOXlJQ2hzWlhRZ2FXNWtaWGdnUFNBd095QnBibVJsZUNBOElHRnVZMlZ6ZEc5eWN5NXNaVzVuZEdnN0lHbHVaR1Y0SUNzOUlERXBJSHNLSUNBZ0lHTnZibk4wSUhCaGRHZ2dQU0JoYm1ObGMzUnZjbk5iYVc1a1pYaGRPd29nSUNBZ1kyOXVjM1FnYzNSaGRITWdQU0JoZDJGcGRDQnNjM1JoZENod1lYUm9MQ0I3SUdKcFoybHVkRG9nZEhKMVpTQjlLVHNLSUNBZ0lHbG1JQ2doYzNSaGRITXVhWE5FYVhKbFkzUnZjbmtvS1NCOGZDQnpkR0YwY3k1cGMxTjViV0p2YkdsalRHbHVheWdwS1NCN0NpQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJSEJ5YjNSbFkzUmxaQ0J3WVhSb0lHRnVZMlZ6ZEc5eUlHbHpJRzV2ZENCaElISmxZV3dnWkdseVpXTjBiM0o1T2lBa2UzQmhkR2g5WUNrN0NpQWdJQ0I5Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0luZHBiak15SWlrZ2V3b2dJQ0FnSUNCamIyNXpkQ0JzWldGbUlEMGdhVzVrWlhnZ1BUMDlJREE3Q2lBZ0lDQWdJR052Ym5OMElIUnlkWE4wWldSUGQyNWxjaUE5SUhOMFlYUnpMblZwWkNBOVBUMGdNRzRnZkh3S0lDQWdJQ0FnSUNBb1kzVnljbVZ1ZEZWcFpDQWhQVDBnZFc1a1pXWnBibVZrSUNZbUlITjBZWFJ6TG5WcFpDQTlQVDBnUW1sblNXNTBLR04xY25KbGJuUlZhV1FwS1RzS0lDQWdJQ0FnWTI5dWMzUWdjM1JwWTJ0NVFtOTFibVJoY25rZ1BTQW9JV3hsWVdZZ2ZId2dZV3hzYjNkVWNuVnpkR1ZrVTNScFkydDVUR1ZoWmlrZ0ppWUtJQ0FnSUNBZ0lDQW9jM1JoZEhNdWJXOWtaU0FtSURCdk1UQXdNRzRwSUNFOVBTQXdiaUFtSmlCMGNuVnpkR1ZrVDNkdVpYSTdDaUFnSUNBZ0lHbG1JQ2doZEhKMWMzUmxaRTkzYm1WeUlIeDhJQ2dvYzNSaGRITXViVzlrWlNBbUlEQnZNREl5YmlrZ0lUMDlJREJ1SUNZbUlDRnpkR2xqYTNsQ2IzVnVaR0Z5ZVNrcElIc0tJQ0FnSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb0NpQWdJQ0FnSUNBZ0lDQmdZV2RsYm1NNklIQnliM1JsWTNSbFpDQmthWEpsWTNSdmNua2dZMmhoYVc0Z2NHVnliV2wwY3lCMWJuUnlkWE4wWldRZ2JYVjBZWFJwYjI0NklDUjdjR0YwYUgwN0lHQWdLd29nSUNBZ0lDQWdJQ0FnSW5KbGJXOTJaU0JuY205MWNDOTNiM0pzWkNCM2NtbDBaU0JoWTJObGMzTWdZbVZtYjNKbElISmxkSEo1YVc1bklpd0tJQ0FnSUNBZ0lDQXBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHbG1JQ2dLSUNBZ0lDQWdJQ0JzWldGbUlDWW1JQ0Z6ZEdsamEzbENiM1Z1WkdGeWVTQW1KaUJqZFhKeVpXNTBWV2xrSUNFOVBTQjFibVJsWm1sdVpXUWdKaVlLSUNBZ0lDQWdJQ0J6ZEdGMGN5NTFhV1FnSVQwOUlFSnBaMGx1ZENoamRYSnlaVzUwVldsa0tRb2dJQ0FnSUNBcElIc0tJQ0FnSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCd2NtOTBaV04wWldRZ1pHbHlaV04wYjNKNUlHbHpJRzV2ZENCdmQyNWxaQ0JpZVNCMGFHVWdZM1Z5Y21WdWRDQjFjMlZ5T2lBa2UzQmhkR2g5WUNrN0NpQWdJQ0FnSUgwS0lDQWdJSDBLSUNBZ0lHSmxabTl5WlVsa1pXNTBhWFJwWlhNdWMyVjBLSEJoZEdnc0lIc2daR1YyT2lCemRHRjBjeTVrWlhZc0lHbHViem9nYzNSaGRITXVhVzV2SUgwcE93b2dJQ0FnYVdSbGJuUnBkSGxHY205dFUzUmhkSE1vYzNSaGRITXNJSEJoZEdncE93b2dJSDBLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSW5kcGJqTXlJaWtnZXdvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsZHBibVJ2ZDNNZ1lXNWpaWE4wYjNJZ1FVTk1JSFpoYkdsa1lYUnBiMjRnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdZWGRoYVhRZ1lYTnpaWEowVjJsdVpHOTNjMUJoZEdoVFpXTjFjbWwwZVNnS0lDQWdJQ0FnWVc1alpYTjBiM0p6TG0xaGNDZ29jR0YwYUN3Z2FXNWtaWGdwSUQwK0lDaDdDaUFnSUNBZ0lDQWdjR0YwYUN3S0lDQWdJQ0FnSUNCeWIyeGxPaUJwYm1SbGVDQTlQVDBnTUNBL0lDSnNaV0ZtUkdseVpXTjBiM0o1SWlBNklDSmhibU5sYzNSdmNrUnBjbVZqZEc5eWVTSXNDaUFnSUNBZ0lIMHBLU3dLSUNBZ0lDQWdZMjl1ZEdWNGRDd0tJQ0FnSUNrN0NpQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlWMmx1Wkc5M2N5QmhibU5sYzNSdmNpQkJRMHdnZG1Gc2FXUmhkR2x2YmlCamIyMXdiR1YwWlNJcE93b2dJSDBnWld4elpTQjdDaUFnSUNCaGQyRnBkQ0JoYzNObGNuUk1iMk5oYkVacGJHVnplWE4wWlcwb1kyRnViMjVwWTJGc0xDQmpiMjUwWlhoMEtUc0tJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FpWkdGeWQybHVJaWtnZXdvZ0lDQWdJQ0JtYjNJZ0tHeGxkQ0JwYm1SbGVDQTlJREE3SUdsdVpHVjRJRHdnWVc1alpYTjBiM0p6TG14bGJtZDBhRHNnYVc1a1pYZ2dLejBnTVNrZ2V3b2dJQ0FnSUNBZ0lHRjNZV2wwSUdGemMyVnlkRVJoY25kcGJsQmhkR2hUWldOMWNtbDBlU2dLSUNBZ0lDQWdJQ0FnSUdGdVkyVnpkRzl5YzF0cGJtUmxlRjBzQ2lBZ0lDQWdJQ0FnSUNCcGJtUmxlQ0E5UFQwZ01DQS9JQ0pzWldGbUlHUnBjbVZqZEc5eWVTSWdPaUFpWVc1alpYTjBiM0lnWkdseVpXTjBiM0o1SWl3S0lDQWdJQ0FnSUNBZ0lHTnZiblJsZUhRc0NpQWdJQ0FnSUNBZ0tUc0tJQ0FnSUNBZ2ZRb2dJQ0FnZlFvZ0lIMEtJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQmpZVzV2Ym1sallXd3BPd29nSUdadmNpQW9ZMjl1YzNRZ2NHRjBhQ0J2WmlCaGJtTmxjM1J2Y25NcElIc0tJQ0FnSUdOdmJuTjBJR0ZtZEdWeUlEMGdZWGRoYVhRZ2JITjBZWFFvY0dGMGFDd2dleUJpYVdkcGJuUTZJSFJ5ZFdVZ2ZTazdDaUFnSUNCamIyNXpkQ0JpWldadmNtVWdQU0JpWldadmNtVkpaR1Z1ZEdsMGFXVnpMbWRsZENod1lYUm9LVHNLSUNBZ0lHbG1JQ2dLSUNBZ0lDQWdJV0ZtZEdWeUxtbHpSR2x5WldOMGIzSjVLQ2tnZkh3Z1lXWjBaWEl1YVhOVGVXMWliMnhwWTB4cGJtc29LU0I4ZkNCaVpXWnZjbVVnUFQwOUlIVnVaR1ZtYVc1bFpDQjhmQW9nSUNBZ0lDQmhablJsY2k1a1pYWWdJVDA5SUdKbFptOXlaUzVrWlhZZ2ZId2dZV1owWlhJdWFXNXZJQ0U5UFNCaVpXWnZjbVV1YVc1dkNpQWdJQ0FwSUhzS0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2djSEp2ZEdWamRHVmtJR1JwY21WamRHOXllU0JwWkdWdWRHbDBlU0JqYUdGdVoyVmtJR1IxY21sdVp5QjJZV3hwWkdGMGFXOXVPaUFrZTNCaGRHaDlZQ2s3Q2lBZ0lDQjlDaUFnZlFvZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKd2NtbDJZWFJsSUdScGNtVmpkRzl5ZVNCMllXeHBaR0YwYVc5dUlHTnZiWEJzWlhSbElpazdDaUFnY21WMGRYSnVJR05oYm05dWFXTmhiRHNLZlFvS1puVnVZM1JwYjI0Z1lYTnpaWEowVW1WbmRXeGhjbE5wYm1kc1pVeHBibXNvYzNSaGRITXNJSEJoZEdncElIc0tJQ0JwWmlBb0lYTjBZWFJ6TG1selJtbHNaU2dwSUh4OElITjBZWFJ6TG1selUzbHRZbTlzYVdOTWFXNXJLQ2twSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklHeHZZMnNnWkdGMFlXSmhjMlVnYVhNZ2JtOTBJR0VnY21WbmRXeGhjaUJtYVd4bE9pQWtlM0JoZEdoOVlDazdDaUFnZlFvZ0lHbG1JQ2h6ZEdGMGN5NXViR2x1YXlBaFBUMGdNVzRwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklHeHZZMnNnWkdGMFlXSmhjMlVnYlhWemRDQnViM1FnYUdGMlpTQm9ZWEprTFd4cGJtc2dZV3hwWVhObGN6b2dKSHR3WVhSb2ZXQXBPd29nSUgwS2ZRb0tablZ1WTNScGIyNGdhV1JsYm5ScGRIbEdjbTl0VTNSaGRITW9jM1JoZEhNc0lIQmhkR2dwSUhzS0lDQnBaaUFvQ2lBZ0lDQnpkR0YwY3k1a1pYWWdQVDA5SURCdUlIeDhDaUFnSUNCemRHRjBjeTVwYm04Z1BUMDlJREJ1SUh4OENpQWdJQ0J6ZEdGMGN5NXBibThnUFQwOUlDMHhiaUI4ZkFvZ0lDQWdRbWxuU1c1MExtRnpWV2x1ZEU0b05qUXNJSE4wWVhSekxtbHVieWtnUFQwOUlGVk9VMVZRVUU5U1ZFVkVYMFpKVEVWZlNVUmZOalFLSUNBcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJR3h2WTJzZ1pHRjBZV0poYzJVZ2FHRnpJRzV2SUhOMFlXSnNaU0JtYVd4bGMzbHpkR1Z0SUdsa1pXNTBhWFI1T2lBa2UzQmhkR2g5WUNrN0NpQWdmUW9nSUhKbGRIVnliaUJnSkh0emRHRjBjeTVrWlhaOU9pUjdjM1JoZEhNdWFXNXZmV0E3Q24wS0NtWjFibU4wYVc5dUlHRnpjMlZ5ZEZCdmMybDRUM2R1WlhKemFHbHdLSE4wWVhSekxDQndZWFJvTENCcmFXNWtLU0I3Q2lBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNKM2FXNHpNaUlwSUhKbGRIVnlianNLSUNCamIyNXpkQ0JqZFhKeVpXNTBWV2xrSUQwZ2NISnZZMlZ6Y3k1blpYUjFhV1EvTGlncE93b2dJR2xtSUNoamRYSnlaVzUwVldsa0lDRTlQU0IxYm1SbFptbHVaV1FnSmlZZ2MzUmhkSE11ZFdsa0lDRTlQU0JDYVdkSmJuUW9ZM1Z5Y21WdWRGVnBaQ2twSUhzS0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGdZV2RsYm1NNklHeHZZMnNnWkdGMFlXSmhjMlVnSkh0cmFXNWtmU0JwY3lCdWIzUWdiM2R1WldRZ1lua2dkR2hsSUdOMWNuSmxiblFnZFhObGNqb2dKSHR3WVhSb2ZXQXBPd29nSUgwS0lDQnBaaUFvS0hOMFlYUnpMbTF2WkdVZ0ppQXdiekF5TW00cElDRTlQU0F3YmlrZ2V3b2dJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2diRzlqYXlCa1lYUmhZbUZ6WlNBa2UydHBibVI5SUdseklHZHliM1Z3TDNkdmNteGtMWGR5YVhSaFlteGxPaUFrZTNCaGRHaDlZQ2s3Q2lBZ2ZRcDlDZ292S2lvS0lDb2dWbUZzYVdSaGRHVWdZU0J5WldkMWJHRnlJR1pwYkdVZ1lXNWtJR2wwY3lCamIyMXdiR1YwWlNCa2FYSmxZM1J2Y25rZ1kyaGhhVzRnWW1WbWIzSmxJR0VnWTJGc2JHVnlDaUFxSUhSeWRYTjBjeUJwZEhNZ1kyOXVkR1Z1ZEhNdUlGUm9hWE1nYVhNZ2FXNTBaVzUwYVc5dVlXeHNlU0J1YjI0dGJYVjBZWFJwYm1jNklIVnVjMkZtWlNCdmQyNWxjbk5vYVhBc0NpQXFJRzF2WkdVZ1ltbDBjeXdnUVVOTWN5d2dZV3hwWVhObGN5d2diM0lnYVdSbGJuUnBkSGtnWTJoaGJtZGxjeUJtWVdsc0lHTnNiM05sWkM0S0lDb3ZDbVY0Y0c5eWRDQmhjM2x1WXlCbWRXNWpkR2x2YmlCaGMzTmxjblJNYjJOaGJGQnlhWFpoZEdWR2FXeGxLQW9nSUhKbGNYVmxjM1JsWkZCaGRHZ3NDaUFnZXdvZ0lDQWdkR2x0Wlc5MWRFMXpJRDBnTmpCZk1EQXdMQW9nSUNBZ2JHRmlaV3dnUFNBaVFXZGxia01nYjNCbGNtRjBhVzl1SWl3S0lDQWdJR1JsWVdSc2FXNWxPaUJ6ZFhCd2JHbGxaRVJsWVdSc2FXNWxMQW9nSUNBZ2IyNVFjbTluY21WemN5d0tJQ0I5SUQwZ2UzMHNDaWtnZXdvZ0lHbG1JQ2doVG5WdFltVnlMbWx6VTJGbVpVbHVkR1ZuWlhJb2RHbHRaVzkxZEUxektTQjhmQ0IwYVcxbGIzVjBUWE1nUEQwZ01Da2dld29nSUNBZ2RHaHliM2NnYm1WM0lGUjVjR1ZGY25KdmNpZ2liRzlqYXlCMGFXMWxiM1YwVFhNZ2JYVnpkQ0JpWlNCaElIQnZjMmwwYVhabElITmhabVVnYVc1MFpXZGxjaUlwT3dvZ0lIMEtJQ0JwWmlBb2MzVndjR3hwWldSRVpXRmtiR2x1WlNBaFBUMGdkVzVrWldacGJtVmtJQ1ltSUNGT2RXMWlaWEl1YVhOR2FXNXBkR1VvYzNWd2NHeHBaV1JFWldGa2JHbHVaU2twSUhzS0lDQWdJSFJvY205M0lHNWxkeUJVZVhCbFJYSnliM0lvSW14dlkyc2daR1ZoWkd4cGJtVWdiWFZ6ZENCaVpTQm1hVzVwZEdVaUtUc0tJQ0I5Q2lBZ2FXWWdLRzl1VUhKdlozSmxjM01nSVQwOUlIVnVaR1ZtYVc1bFpDQW1KaUIwZVhCbGIyWWdiMjVRY205bmNtVnpjeUFoUFQwZ0ltWjFibU4wYVc5dUlpa2dld29nSUNBZ2RHaHliM2NnYm1WM0lGUjVjR1ZGY25KdmNpZ2liRzlqYXlCdmJsQnliMmR5WlhOeklHMTFjM1FnWW1VZ1lTQm1kVzVqZEdsdmJpSXBPd29nSUgwS0lDQmpiMjV6ZENCamIyNTBaWGgwSUQwZ2V3b2dJQ0FnWkdWaFpHeHBibVU2SUUxaGRHZ3ViV2x1S0FvZ0lDQWdJQ0J6ZFhCd2JHbGxaRVJsWVdSc2FXNWxJRDgvSUU1MWJXSmxjaTVRVDFOSlZFbFdSVjlKVGtaSlRrbFVXU3dLSUNBZ0lDQWdjR1Z5Wm05eWJXRnVZMlV1Ym05M0tDa2dLeUIwYVcxbGIzVjBUWE1zQ2lBZ0lDQXBMQW9nSUNBZ2JHRmlaV3dzQ2lBZ0lDQjBhVzFsYjNWMFRYTXNDaUFnSUNCdmJsQnliMmR5WlhOekxBb2dJSDA3Q2lBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSW5CeWFYWmhkR1VnWm1sc1pTQjJZV3hwWkdGMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNCamIyNXpkQ0JoWW5OdmJIVjBaU0E5SUhKbGMyOXNkbVVvY21WeGRXVnpkR1ZrVUdGMGFDazdDaUFnWTI5dWMzUWdjR0Z5Wlc1MElEMGdaR2x5Ym1GdFpTaGhZbk52YkhWMFpTazdDaUFnWTI5dWMzUWdZMkZ1YjI1cFkyRnNVR0Z5Wlc1MElEMGdZWGRoYVhRZ1lYTnpaWEowVEc5allXeFFjbWwyWVhSbFJHbHlaV04wYjNKNUtIQmhjbVZ1ZEN3Z2V3b2dJQ0FnZEdsdFpXOTFkRTF6TEFvZ0lDQWdiR0ZpWld3c0NpQWdJQ0JrWldGa2JHbHVaVG9nWTI5dWRHVjRkQzVrWldGa2JHbHVaU3dLSUNBZ0lDNHVMaWh2YmxCeWIyZHlaWE56SUQwOVBTQjFibVJsWm1sdVpXUWdQeUI3ZlNBNklIc2diMjVRY205bmNtVnpjeUI5S1N3S0lDQjlLVHNLSUNCcFppQW9ZMkZ1YjI1cFkyRnNVR0Z5Wlc1MElDRTlQU0J3WVhKbGJuUXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUhCeWIzUmxZM1JsWkNCbWFXeGxJSEJoY21WdWRDQnRkWE4wSUhWelpTQnBkSE1nWTJGdWIyNXBZMkZzSUhCaGRHZzZJQ1I3Y0dGeVpXNTBmV0FwT3dvZ0lIMEtJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQmhZbk52YkhWMFpTazdDaUFnWTI5dWMzUWdZbVZtYjNKbElEMGdZWGRoYVhRZ2JITjBZWFFvWVdKemIyeDFkR1VzSUhzZ1ltbG5hVzUwT2lCMGNuVmxJSDBwT3dvZ0lHbG1JQ2doWW1WbWIzSmxMbWx6Um1sc1pTZ3BJSHg4SUdKbFptOXlaUzVwYzFONWJXSnZiR2xqVEdsdWF5Z3BJSHg4SUdKbFptOXlaUzV1YkdsdWF5QWhQVDBnTVc0cElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJSEJ5YjNSbFkzUmxaQ0JtYVd4bElHMTFjM1FnWW1VZ1lTQnlaV2QxYkdGeUlITnBibWRzWlMxc2FXNXJJR1pwYkdVNklDUjdZV0p6YjJ4MWRHVjlZQ2s3Q2lBZ2ZRb2dJR2xrWlc1MGFYUjVSbkp2YlZOMFlYUnpLR0psWm05eVpTd2dZV0p6YjJ4MWRHVXBPd29nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElDRTlQU0FpZDJsdU16SWlLU0I3Q2lBZ0lDQmpiMjV6ZENCamRYSnlaVzUwVldsa0lEMGdjSEp2WTJWemN5NW5aWFIxYVdRL0xpZ3BPd29nSUNBZ2FXWWdLR04xY25KbGJuUlZhV1FnSVQwOUlIVnVaR1ZtYVc1bFpDQW1KaUJpWldadmNtVXVkV2xrSUNFOVBTQkNhV2RKYm5Rb1kzVnljbVZ1ZEZWcFpDa3BJSHNLSUNBZ0lDQWdkR2h5YjNjZ2JtVjNJRVZ5Y205eUtHQmhaMlZ1WXpvZ2NISnZkR1ZqZEdWa0lHWnBiR1VnYVhNZ2JtOTBJRzkzYm1Wa0lHSjVJSFJvWlNCamRYSnlaVzUwSUhWelpYSTZJQ1I3WVdKemIyeDFkR1Y5WUNrN0NpQWdJQ0I5Q2lBZ0lDQnBaaUFvS0dKbFptOXlaUzV0YjJSbElDWWdNRzh3TWpKdUtTQWhQVDBnTUc0cElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nY0hKdmRHVmpkR1ZrSUdacGJHVWdhWE1nWjNKdmRYQXZkMjl5YkdRdGQzSnBkR0ZpYkdVNklDUjdZV0p6YjJ4MWRHVjlZQ2s3Q2lBZ0lDQjlDaUFnZlFvZ0lHTnZibk4wSUdOaGJtOXVhV05oYkNBOUlHRjNZV2wwSUhKbFlXeHdZWFJvS0dGaWMyOXNkWFJsS1RzS0lDQnBaaUFvWTJGdWIyNXBZMkZzSUNFOVBTQmhZbk52YkhWMFpTa2dld29nSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nY0hKdmRHVmpkR1ZrSUdacGJHVWdiWFZ6ZENCMWMyVWdhWFJ6SUdOaGJtOXVhV05oYkNCd1lYUm9PaUFrZTJGaWMyOXNkWFJsZldBcE93b2dJSDBLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSW5kcGJqTXlJaWtnZXdvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsZHBibVJ2ZDNNZ1ptbHNaU0JCUTB3Z2RtRnNhV1JoZEdsdmJpQnpkR0Z5ZEdWa0lpazdDaUFnSUNCaGQyRnBkQ0JoYzNObGNuUlhhVzVrYjNkelVHRjBhRk5sWTNWeWFYUjVLRnQ3SUhCaGRHZzZJR05oYm05dWFXTmhiQ3dnY205c1pUb2dJbVpwYkdVaUlIMWRMQ0JqYjI1MFpYaDBLVHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKWGFXNWtiM2R6SUdacGJHVWdRVU5NSUhaaGJHbGtZWFJwYjI0Z1kyOXRjR3hsZEdVaUtUc0tJQ0I5SUdWc2MyVWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDSmtZWEozYVc0aUtTQjdDaUFnSUNCaGQyRnBkQ0JoYzNObGNuUkVZWEozYVc1UVlYUm9VMlZqZFhKcGRIa29ZMkZ1YjI1cFkyRnNMQ0FpWm1sc1pTSXNJR052Ym5SbGVIUXBPd29nSUgwS0lDQjBhSEp2ZDBsbVJYaHdhWEpsWkNoamIyNTBaWGgwTENCallXNXZibWxqWVd3cE93b2dJR052Ym5OMElHRm1kR1Z5SUQwZ1lYZGhhWFFnYkhOMFlYUW9ZMkZ1YjI1cFkyRnNMQ0I3SUdKcFoybHVkRG9nZEhKMVpTQjlLVHNLSUNCcFppQW9DaUFnSUNBaFlXWjBaWEl1YVhOR2FXeGxLQ2tnZkh3Z1lXWjBaWEl1YVhOVGVXMWliMnhwWTB4cGJtc29LU0I4ZkNCaFpuUmxjaTV1YkdsdWF5QWhQVDBnTVc0Z2ZId0tJQ0FnSUdGbWRHVnlMbVJsZGlBaFBUMGdZbVZtYjNKbExtUmxkaUI4ZkNCaFpuUmxjaTVwYm04Z0lUMDlJR0psWm05eVpTNXBibThLSUNBcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhnWVdkbGJtTTZJSEJ5YjNSbFkzUmxaQ0JtYVd4bElHbGtaVzUwYVhSNUlHTm9ZVzVuWldRZ1pIVnlhVzVuSUhaaGJHbGtZWFJwYjI0NklDUjdZMkZ1YjI1cFkyRnNmV0FwT3dvZ0lIMEtJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWljSEpwZG1GMFpTQm1hV3hsSUhaaGJHbGtZWFJwYjI0Z1kyOXRjR3hsZEdVaUtUc0tJQ0J5WlhSMWNtNGdZMkZ1YjI1cFkyRnNPd3A5Q2dwaGMzbHVZeUJtZFc1amRHbHZiaUJ3Y21Wd1lYSmxURzlqYTFCaGRHZ29jbVZ4ZFdWemRHVmtVR0YwYUN3Z1kyOXVkR1Y0ZENrZ2V3b2dJR052Ym5OMElHRmljMjlzZFhSbElEMGdjbVZ6YjJ4MlpTaHlaWEYxWlhOMFpXUlFZWFJvS1RzS0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaWJHOWpheUJ3WVhSb0lIQnlaWEJoY21GMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNCMGFISnZkMGxtUlhod2FYSmxaQ2hqYjI1MFpYaDBMQ0JoWW5OdmJIVjBaU2s3Q2lBZ1lYZGhhWFFnYld0a2FYSW9aR2x5Ym1GdFpTaGhZbk52YkhWMFpTa3NJSHNnY21WamRYSnphWFpsT2lCMGNuVmxMQ0J0YjJSbE9pQXdiemN3TUNCOUtUc0tJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWliRzlqYXlCd1lYSmxiblFnWTNKbFlYUnBiMjRnWTI5dGNHeGxkR1VpS1RzS0lDQjBhSEp2ZDBsbVJYaHdhWEpsWkNoamIyNTBaWGgwTENCaFluTnZiSFYwWlNrN0NpQWdZMjl1YzNRZ2NHRnlaVzUwSUQwZ1lYZGhhWFFnY21WaGJIQmhkR2dvWkdseWJtRnRaU2hoWW5OdmJIVjBaU2twT3dvZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKc2IyTnJJSEJoY21WdWRDQmpZVzV2Ym1sallXeHBlbUYwYVc5dUlHTnZiWEJzWlhSbElpazdDaUFnZEdoeWIzZEpaa1Y0Y0dseVpXUW9ZMjl1ZEdWNGRDd2dZV0p6YjJ4MWRHVXBPd29nSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pzYjJOcklIQmhjbVZ1ZENCelpXTjFjbWwwZVNCMllXeHBaR0YwYVc5dUlITjBZWEowWldRaUtUc0tJQ0JqYjI1emRDQjJZV3hwWkdGMFpXUlFZWEpsYm5RZ1BTQmhkMkZwZENCaGMzTmxjblJNYjJOaGJGQnlhWFpoZEdWRWFYSmxZM1J2Y25rb2NHRnlaVzUwTENCN0NpQWdJQ0IwYVcxbGIzVjBUWE02SUdOdmJuUmxlSFF1ZEdsdFpXOTFkRTF6TEFvZ0lDQWdiR0ZpWld3NklHTnZiblJsZUhRdWJHRmlaV3dzQ2lBZ0lDQmtaV0ZrYkdsdVpUb2dZMjl1ZEdWNGRDNWtaV0ZrYkdsdVpTd0tJQ0FnSUM0dUxpaGpiMjUwWlhoMExtOXVVSEp2WjNKbGMzTWdQVDA5SUhWdVpHVm1hVzVsWkFvZ0lDQWdJQ0EvSUh0OUNpQWdJQ0FnSURvZ2V5QnZibEJ5YjJkeVpYTnpPaUJqYjI1MFpYaDBMbTl1VUhKdlozSmxjM01nZlNrc0NpQWdmU2s3Q2lBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSW14dlkyc2djR0Z5Wlc1MElITmxZM1Z5YVhSNUlIWmhiR2xrWVhScGIyNGdZMjl0Y0d4bGRHVWlLVHNLSUNCcFppQW9kbUZzYVdSaGRHVmtVR0Z5Wlc1MElDRTlQU0J3WVhKbGJuUXBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUd4dlkyc2daR0YwWVdKaGMyVWdjR0Z5Wlc1MElHMTFjM1FnZFhObElHbDBjeUJqWVc1dmJtbGpZV3dnY0dGMGFEb2dKSHR3WVhKbGJuUjlZQ2s3Q2lBZ2ZRb2dJR052Ym5OMElIQmhjbVZ1ZEZOMFlYUnpJRDBnWVhkaGFYUWdiSE4wWVhRb2NHRnlaVzUwTENCN0lHSnBaMmx1ZERvZ2RISjFaU0I5S1RzS0lDQnBaaUFvSVhCaGNtVnVkRk4wWVhSekxtbHpSR2x5WldOMGIzSjVLQ2tnZkh3Z2NHRnlaVzUwVTNSaGRITXVhWE5UZVcxaWIyeHBZMHhwYm1zb0tTa2dld29nSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nYkc5amF5QmtZWFJoWW1GelpTQndZWEpsYm5RZ2FYTWdibTkwSUdFZ2NtVmhiQ0JrYVhKbFkzUnZjbms2SUNSN2NHRnlaVzUwZldBcE93b2dJSDBLSUNCaGMzTmxjblJRYjNOcGVFOTNibVZ5YzJocGNDaHdZWEpsYm5SVGRHRjBjeXdnY0dGeVpXNTBMQ0FpY0dGeVpXNTBJaWs3Q2dvZ0lHTnZibk4wSUhCaGRHZ2dQU0JxYjJsdUtIQmhjbVZ1ZEN3Z1ltRnpaVzVoYldVb1lXSnpiMngxZEdVcEtUc0tJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQndZWFJvS1RzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2FHRnVaR3hsSUQwZ1lYZGhhWFFnYjNCbGJpaHdZWFJvTENBaWQzZ2lMQ0F3YnpZd01DazdDaUFnSUNCMGNua2dld29nSUNBZ0lDQmhkMkZwZENCb1lXNWtiR1V1WTJ4dmMyVW9LVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVnljbTl5S1NCN0NpQWdJQ0FnSUdGM1lXbDBJR2hoYm1Sc1pTNWpiRzl6WlNncExtTmhkR05vS0NncElEMCtJSHQ5S1RzS0lDQWdJQ0FnZEdoeWIzY2daWEp5YjNJN0NpQWdJQ0I5Q2lBZ2ZTQmpZWFJqYUNBb1pYSnliM0lwSUhzS0lDQWdJR2xtSUNobGNuSnZjajh1WTI5a1pTQWhQVDBnSWtWRldFbFRWQ0lwSUhSb2NtOTNJR1Z5Y205eU93b2dJSDBLSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpYkc5amF5QmtZWFJoWW1GelpTQm1hV3hsSUdOeVpXRjBhVzl1SUdOdmJYQnNaWFJsSWlrN0NpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NHRjBhQ2s3Q2lBZ1kyOXVjM1FnY0dGMGFGTjBZWFJ6SUQwZ1lYZGhhWFFnYkhOMFlYUW9jR0YwYUN3Z2V5QmlhV2RwYm5RNklIUnlkV1VnZlNrN0NpQWdZWE56WlhKMFVtVm5kV3hoY2xOcGJtZHNaVXhwYm1zb2NHRjBhRk4wWVhSekxDQndZWFJvS1RzS0lDQmhjM05sY25SUWIzTnBlRTkzYm1WeWMyaHBjQ2h3WVhSb1UzUmhkSE1zSUhCaGRHZ3NJQ0ptYVd4bElpazdDaUFnWTI5dWMzUWdZMkZ1YjI1cFkyRnNJRDBnWVhkaGFYUWdjbVZoYkhCaGRHZ29jR0YwYUNrN0NpQWdZMjl1YzNRZ2MzUmhkSE1nUFNCaGQyRnBkQ0JzYzNSaGRDaGpZVzV2Ym1sallXd3NJSHNnWW1sbmFXNTBPaUIwY25WbElIMHBPd29nSUdGemMyVnlkRkpsWjNWc1lYSlRhVzVuYkdWTWFXNXJLSE4wWVhSekxDQmpZVzV2Ym1sallXd3BPd29nSUdGemMyVnlkRkJ2YzJsNFQzZHVaWEp6YUdsd0tITjBZWFJ6TENCallXNXZibWxqWVd3c0lDSm1hV3hsSWlrN0NpQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnSVQwOUlDSjNhVzR6TWlJcElIc0tJQ0FnSUdGM1lXbDBJR05vYlc5a0tHTmhibTl1YVdOaGJDd2dNRzgyTURBcE93b2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ0prWVhKM2FXNGlLU0I3Q2lBZ0lDQWdJR0YzWVdsMElHRnpjMlZ5ZEVSaGNuZHBibEJoZEdoVFpXTjFjbWwwZVNoallXNXZibWxqWVd3c0lDSnNiMk5ySUdSaGRHRmlZWE5sSUdacGJHVWlMQ0JqYjI1MFpYaDBLVHNLSUNBZ0lIMEtJQ0I5SUdWc2MyVWdld29nSUNBZ2NtVndiM0owVUhKdlozSmxjM01vWTI5dWRHVjRkQ3dnSW14dlkyc2daR0YwWVdKaGMyVWdRVU5NSUhaaGJHbGtZWFJwYjI0Z2MzUmhjblJsWkNJcE93b2dJQ0FnWVhkaGFYUWdZWE56WlhKMFYybHVaRzkzYzFCaGRHaFRaV04xY21sMGVTaGJDaUFnSUNBZ0lIc2djR0YwYURvZ2NHRnlaVzUwTENCeWIyeGxPaUFpYkdWaFprUnBjbVZqZEc5eWVTSWdmU3dLSUNBZ0lDQWdleUJ3WVhSb09pQmpZVzV2Ym1sallXd3NJSEp2YkdVNklDSm1hV3hsSWlCOUxBb2dJQ0FnWFN3Z1kyOXVkR1Y0ZENrN0NpQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWliRzlqYXlCa1lYUmhZbUZ6WlNCQlEwd2dkbUZzYVdSaGRHbHZiaUJqYjIxd2JHVjBaU0lwT3dvZ0lIMEtJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQmpZVzV2Ym1sallXd3BPd29nSUdOdmJuTjBJSE5sWTNWeVpXUlRkR0YwY3lBOUlHRjNZV2wwSUd4emRHRjBLR05oYm05dWFXTmhiQ3dnZXlCaWFXZHBiblE2SUhSeWRXVWdmU2s3Q2lBZ1lYTnpaWEowVW1WbmRXeGhjbE5wYm1kc1pVeHBibXNvYzJWamRYSmxaRk4wWVhSekxDQmpZVzV2Ym1sallXd3BPd29nSUdGemMyVnlkRkJ2YzJsNFQzZHVaWEp6YUdsd0tITmxZM1Z5WldSVGRHRjBjeXdnWTJGdWIyNXBZMkZzTENBaVptbHNaU0lwT3dvZ0lISmxkSFZ5YmlCN0NpQWdJQ0J3WVhSb09pQmpZVzV2Ym1sallXd3NDaUFnSUNCd1lYSmxiblFzQ2lBZ0lDQmtaWFk2SUhObFkzVnlaV1JUZEdGMGN5NWtaWFlzQ2lBZ0lDQnBibTg2SUhObFkzVnlaV1JUZEdGMGN5NXBibThzQ2lBZ0lDQnBaR1Z1ZEdsMGVVdGxlVG9nYVdSbGJuUnBkSGxHY205dFUzUmhkSE1vYzJWamRYSmxaRk4wWVhSekxDQmpZVzV2Ym1sallXd3BMQW9nSUgwN0NuMEtDbUZ6ZVc1aklHWjFibU4wYVc5dUlISmxkbUZzYVdSaGRHVlFjbVZ3WVhKbFpFeHZZMnNvQ2lBZ2NISmxjR0Z5WldRc0NpQWdZMjl1ZEdWNGRDd0tJQ0I3SUhaaGJHbGtZWFJsVjJsdVpHOTNjMEZqYkNBOUlHWmhiSE5sSUgwZ1BTQjdmU3dLS1NCN0NpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NISmxjR0Z5WldRdWNHRjBhQ2s3Q2lBZ1kyOXVjM1FnY0dGeVpXNTBVM1JoZEhNZ1BTQmhkMkZwZENCc2MzUmhkQ2h3Y21Wd1lYSmxaQzV3WVhKbGJuUXNJSHNnWW1sbmFXNTBPaUIwY25WbElIMHBPd29nSUdsbUlDZ2hjR0Z5Wlc1MFUzUmhkSE11YVhORWFYSmxZM1J2Y25rb0tTQjhmQ0J3WVhKbGJuUlRkR0YwY3k1cGMxTjViV0p2YkdsalRHbHVheWdwS1NCN0NpQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9ZR0ZuWlc1ak9pQnNiMk5ySUdSaGRHRmlZWE5sSUhCaGNtVnVkQ0JwY3lCdWJ5QnNiMjVuWlhJZ1lTQnlaV0ZzSUdScGNtVmpkRzl5ZVRvZ0pIdHdjbVZ3WVhKbFpDNXdZWEpsYm5SOVlDazdDaUFnZlFvZ0lHRnpjMlZ5ZEZCdmMybDRUM2R1WlhKemFHbHdLSEJoY21WdWRGTjBZWFJ6TENCd2NtVndZWEpsWkM1d1lYSmxiblFzSUNKd1lYSmxiblFpS1RzS0lDQmpiMjV6ZENCemRHRjBjeUE5SUdGM1lXbDBJR3h6ZEdGMEtIQnlaWEJoY21Wa0xuQmhkR2dzSUhzZ1ltbG5hVzUwT2lCMGNuVmxJSDBwT3dvZ0lHRnpjMlZ5ZEZKbFozVnNZWEpUYVc1bmJHVk1hVzVyS0hOMFlYUnpMQ0J3Y21Wd1lYSmxaQzV3WVhSb0tUc0tJQ0JoYzNObGNuUlFiM05wZUU5M2JtVnljMmhwY0NoemRHRjBjeXdnY0hKbGNHRnlaV1F1Y0dGMGFDd2dJbVpwYkdVaUtUc0tJQ0JwWmlBb2MzUmhkSE11WkdWMklDRTlQU0J3Y21Wd1lYSmxaQzVrWlhZZ2ZId2djM1JoZEhNdWFXNXZJQ0U5UFNCd2NtVndZWEpsWkM1cGJtOHBJSHNLSUNBZ0lIUm9jbTkzSUc1bGR5QkZjbkp2Y2loZ1lXZGxibU02SUd4dlkyc2daR0YwWVdKaGMyVWdhV1JsYm5ScGRIa2dZMmhoYm1kbFpDQmtkWEpwYm1jZ1lXTnhkV2x6YVhScGIyNDZJQ1I3Y0hKbGNHRnlaV1F1Y0dGMGFIMWdLVHNLSUNCOUNpQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDSjNhVzR6TWlJZ0ppWWdkbUZzYVdSaGRHVlhhVzVrYjNkelFXTnNLU0I3Q2lBZ0lDQmhkMkZwZENCaGMzTmxjblJYYVc1a2IzZHpVR0YwYUZObFkzVnlhWFI1S0ZzS0lDQWdJQ0FnZXlCd1lYUm9PaUJ3Y21Wd1lYSmxaQzV3WVhKbGJuUXNJSEp2YkdVNklDSnNaV0ZtUkdseVpXTjBiM0o1SWlCOUxBb2dJQ0FnSUNCN0lIQmhkR2c2SUhCeVpYQmhjbVZrTG5CaGRHZ3NJSEp2YkdVNklDSm1hV3hsSWlCOUxBb2dJQ0FnWFN3Z1kyOXVkR1Y0ZENrN0NpQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBaVpHRnlkMmx1SWlrZ2V3b2dJQ0FnWVhkaGFYUWdZWE56WlhKMFJHRnlkMmx1VUdGMGFGTmxZM1Z5YVhSNUtIQnlaWEJoY21Wa0xuQmhkR2dzSUNKc2IyTnJJR1JoZEdGaVlYTmxJR1pwYkdVaUxDQmpiMjUwWlhoMEtUc0tJQ0I5Q2lBZ2RHaHliM2RKWmtWNGNHbHlaV1FvWTI5dWRHVjRkQ3dnY0hKbGNHRnlaV1F1Y0dGMGFDazdDbjBLQ21aMWJtTjBhVzl1SUhCeVlXZHRZVlpoYkhWbEtHUmhkR0ZpWVhObExDQndjbUZuYldFcElIc0tJQ0JqYjI1emRDQnliM2NnUFNCa1lYUmhZbUZ6WlM1d2NtVndZWEpsS0dCUVVrRkhUVUVnSkh0d2NtRm5iV0Y5WUNrdVoyVjBLQ2s3Q2lBZ2NtVjBkWEp1SUhKdmR5QTlQVDBnZFc1a1pXWnBibVZrSUQ4Z2RXNWtaV1pwYm1Wa0lEb2dUMkpxWldOMExuWmhiSFZsY3loeWIzY3BXekJkT3dwOUNncG1kVzVqZEdsdmJpQndjbUZuYldGT2RXMWlaWElvWkdGMFlXSmhjMlVzSUhCeVlXZHRZU2tnZXdvZ0lHTnZibk4wSUhaaGJIVmxJRDBnY0hKaFoyMWhWbUZzZFdVb1pHRjBZV0poYzJVc0lIQnlZV2R0WVNrN0NpQWdjbVYwZFhKdUlIUjVjR1Z2WmlCMllXeDFaU0E5UFQwZ0ltNTFiV0psY2lJZ1B5QjJZV3gxWlNBNklIVnVaR1ZtYVc1bFpEc0tmUW9LWm5WdVkzUnBiMjRnY0hKaFoyMWhWR1Y0ZENoa1lYUmhZbUZ6WlN3Z2NISmhaMjFoS1NCN0NpQWdZMjl1YzNRZ2RtRnNkV1VnUFNCd2NtRm5iV0ZXWVd4MVpTaGtZWFJoWW1GelpTd2djSEpoWjIxaEtUc0tJQ0J5WlhSMWNtNGdkSGx3Wlc5bUlIWmhiSFZsSUQwOVBTQWljM1J5YVc1bklpQS9JSFpoYkhWbExuUnZURzkzWlhKRFlYTmxLQ2tnT2lCMWJtUmxabWx1WldRN0NuMEtDbVY0Y0c5eWRDQm1kVzVqZEdsdmJpQmpiMjVtYVdkMWNtVk1iMk5oYkZOeGJHbDBaVXh2WTJ0RGIyNXVaV04wYVc5dUtHUmhkR0ZpWVhObEtTQjdDaUFnWkdGMFlXSmhjMlV1WlhobFl5Z2lVRkpCUjAxQklHSjFjM2xmZEdsdFpXOTFkQ0E5SURBaUtUc0tJQ0JrWVhSaFltRnpaUzVsZUdWaktDSlFVa0ZIVFVFZ2RISjFjM1JsWkY5elkyaGxiV0VnUFNCUFJrWWlLVHNLSUNCa1lYUmhZbUZ6WlM1bGVHVmpLQ0pRVWtGSFRVRWdjM2x1WTJoeWIyNXZkWE1nUFNCRldGUlNRU0lwT3dvZ0lHUmhkR0ZpWVhObExtVnVZV0pzWlVSbFptVnVjMmwyWlNoMGNuVmxLVHNLSUNCa1lYUmhZbUZ6WlM1bGJtRmliR1ZNYjJGa1JYaDBaVzV6YVc5dUtHWmhiSE5sS1RzS0lDQnBaaUFvQ2lBZ0lDQndjbUZuYldGT2RXMWlaWElvWkdGMFlXSmhjMlVzSUNKaWRYTjVYM1JwYldWdmRYUWlLU0FoUFQwZ01DQjhmQW9nSUNBZ2NISmhaMjFoVG5WdFltVnlLR1JoZEdGaVlYTmxMQ0FpZEhKMWMzUmxaRjl6WTJobGJXRWlLU0FoUFQwZ01DQjhmQW9nSUNBZ2NISmhaMjFoVG5WdFltVnlLR1JoZEdGaVlYTmxMQ0FpYzNsdVkyaHliMjV2ZFhNaUtTQWhQVDBnTXdvZ0lDa2dld29nSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0NKaFoyVnVZem9nVTFGTWFYUmxJR3h2WTJzZ1kyOXVibVZqZEdsdmJpQm9ZWEprWlc1cGJtY2daR2xrSUc1dmRDQjBZV3RsSUdWbVptVmpkQ0lwT3dvZ0lIMEtmUW9LWm5WdVkzUnBiMjRnYVc1emNHVmpkRXh2WTJ0RVlYUmhZbUZ6WlNoa1lYUmhZbUZ6WlN3Z2NHRjBhQ2tnZXdvZ0lHTnZibk4wSUdGd2NHeHBZMkYwYVc5dVNXUWdQU0J3Y21GbmJXRk9kVzFpWlhJb1pHRjBZV0poYzJVc0lDSmhjSEJzYVdOaGRHbHZibDlwWkNJcE93b2dJR2xtSUNoaGNIQnNhV05oZEdsdmJrbGtJRDA5UFNBd0tTQjdDaUFnSUNCamIyNXpkQ0J5YjNjZ1BTQmtZWFJoWW1GelpTNXdjbVZ3WVhKbEtBb2dJQ0FnSUNBaVUwVk1SVU5VSUdOdmRXNTBLQ29wSUVGVElHTnZkVzUwSUVaU1QwMGdjM0ZzYVhSbFgzTmphR1Z0WVNCWFNFVlNSU0J1WVcxbElFNVBWQ0JNU1V0RklDZHpjV3hwZEdWZkpTY2lMQW9nSUNBZ0tTNW5aWFFvS1RzS0lDQWdJR2xtSUNoeWIzYy9MbU52ZFc1MElDRTlQU0F3S1NCN0NpQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWdLSUNBZ0lDQWdJQ0JnWVdkbGJtTTZJSEpsWm5WemFXNW5JSFJ2SUhKbGRYTmxJR0Z1SUhWdWNtVnNZWFJsWkNCVFVVeHBkR1VnWkdGMFlXSmhjMlVnWVhNZ1lTQnNiMk5yT2lBa2UzQmhkR2g5WUN3S0lDQWdJQ0FnS1RzS0lDQWdJSDBLSUNBZ0lISmxkSFZ5YmlBaVpXMXdkSGtpT3dvZ0lIMEtJQ0JwWmlBb1lYQndiR2xqWVhScGIyNUpaQ0FoUFQwZ1RFOURTMTlCVUZCTVNVTkJWRWxQVGw5SlJDa2dld29nSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nYkc5amF5QmtZWFJoWW1GelpTQm9ZWE1nWVc0Z2FXNWpiMjF3WVhScFlteGxJR0Z3Y0d4cFkyRjBhVzl1SUdsa09pQWtlM0JoZEdoOVlDazdDaUFnZlFvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCelkyaGxiV0VnUFNCa1lYUmhZbUZ6WlM1d2NtVndZWEpsS0FvZ0lDQWdJQ0FpVTBWTVJVTlVJSFI1Y0dVc0lITnhiQ0JHVWs5TklITnhiR2wwWlY5elkyaGxiV0VnVjBoRlVrVWdibUZ0WlNBOUlDZGhaMlZ1WTE5c2IyTmhiRjl3Y205alpYTnpYMnh2WTJzbklpd0tJQ0FnSUNrdVoyVjBLQ2s3Q2lBZ0lDQmpiMjV6ZENCdlltcGxZM1J6SUQwZ1pHRjBZV0poYzJVdWNISmxjR0Z5WlNnS0lDQWdJQ0FnSWxORlRFVkRWQ0JqYjNWdWRDZ3FLU0JCVXlCamIzVnVkQ0JHVWs5TklITnhiR2wwWlY5elkyaGxiV0VnVjBoRlVrVWdibUZ0WlNCT1QxUWdURWxMUlNBbmMzRnNhWFJsWHlVbklpd0tJQ0FnSUNrdVoyVjBLQ2s3Q2lBZ0lDQmpiMjV6ZENCeWIzZHpJRDBnWkdGMFlXSmhjMlV1Y0hKbGNHRnlaU2dLSUNBZ0lDQWdJbE5GVEVWRFZDQnphVzVuYkdWMGIyNHNJR1p2Y20xaGRGOTJaWEp6YVc5dUlFWlNUMDBnWVdkbGJtTmZiRzlqWVd4ZmNISnZZMlZ6YzE5c2IyTnJJaXdLSUNBZ0lDa3VZV3hzS0NrN0NpQWdJQ0JqYjI1emRDQnViM0p0WVd4cGVtVmtVMk5vWlcxaElEMGdkSGx3Wlc5bUlITmphR1Z0WVQ4dWMzRnNJRDA5UFNBaWMzUnlhVzVuSWdvZ0lDQWdJQ0EvSUhOamFHVnRZUzV6Y1d3dWNtVndiR0ZqWlNndlhITXJMMmNzSUNJZ0lpa3VkSEpwYlNncENpQWdJQ0FnSURvZ2RXNWtaV1pwYm1Wa093b2dJQ0FnYVdZZ0tBb2dJQ0FnSUNCelkyaGxiV0UvTG5SNWNHVWdJVDA5SUNKMFlXSnNaU0lnZkh3S0lDQWdJQ0FnYm05eWJXRnNhWHBsWkZOamFHVnRZU0FoUFQwS0lDQWdJQ0FnSUNBaVExSkZRVlJGSUZSQlFreEZJR0ZuWlc1algyeHZZMkZzWDNCeWIyTmxjM05mYkc5amF5QW9JSE5wYm1kc1pYUnZiaUJKVGxSRlIwVlNJRkJTU1UxQlVsa2dTMFZaSUVOSVJVTkxJQ2h6YVc1bmJHVjBiMjRnUFNBeEtTd2dabTl5YldGMFgzWmxjbk5wYjI0Z1NVNVVSVWRGVWlCT1QxUWdUbFZNVENBcElGTlVVa2xEVkNJZ2ZId0tJQ0FnSUNBZ2IySnFaV04wY3o4dVkyOTFiblFnSVQwOUlERWdmSHdLSUNBZ0lDQWdjbTkzY3k1c1pXNW5kR2dnSVQwOUlERWdmSHdLSUNBZ0lDQWdjbTkzYzFzd1hUOHVjMmx1WjJ4bGRHOXVJQ0U5UFNBeElIeDhDaUFnSUNBZ0lISnZkM05iTUYwL0xtWnZjbTFoZEY5MlpYSnphVzl1SUNFOVBTQk1UME5MWDBaUFVrMUJWRjlXUlZKVFNVOU9DaUFnSUNBcElIc0tJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0NKcGJuWmhiR2xrSUhObGJuUnBibVZzSUhOamFHVnRZU0lwT3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0dWeWNtOXlLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1lHRm5aVzVqT2lCc2IyTnJJR1JoZEdGaVlYTmxJR2hoY3lCaGJpQnBibU52YlhCaGRHbGliR1VnWm05eWJXRjBPaUFrZTNCaGRHaDlZQ3dnZXdvZ0lDQWdJQ0JqWVhWelpUb2daWEp5YjNJc0NpQWdJQ0I5S1RzS0lDQjlDaUFnY21WMGRYSnVJQ0oyWVd4cFpDSTdDbjBLQ21aMWJtTjBhVzl1SUdKMWMzbFVjbUZ1YzJsMGFXOXVSWEp5YjNJb2NHRjBhQ3dnYlc5a1pTa2dld29nSUhKbGRIVnliaUJQWW1wbFkzUXVZWE56YVdkdUtBb2dJQ0FnYm1WM0lFVnljbTl5S0dCaFoyVnVZem9nVTFGTWFYUmxJR3h2WTJzZ2FtOTFjbTVoYkNCdGIyUmxJSEpsYldGcGJtVmtJQ1I3Ylc5a1pTQS9QeUFpZFc1cmJtOTNiaUo5T2lBa2UzQmhkR2g5WUNrc0NpQWdJQ0I3SUdWeWNtTnZaR1U2SUZOUlRFbFVSVjlDVlZOWklIMHNDaUFnS1RzS2ZRb0tablZ1WTNScGIyNGdZbVZuYVc1QmJtUldZV3hwWkdGMFpVeHZZMnNvWkdGMFlXSmhjMlVzSUhCaGRHZ3NJR052Ym5SbGVIUXBJSHNLSUNCbWIzSWdLR3hsZENCd2FHRnpaU0E5SURBN0lIQm9ZWE5sSUR3Z09Ec2djR2hoYzJVZ0t6MGdNU2tnZXdvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCMGNtRnVjMkZqZEdsdmJpQmlaV2RwYmlCemRHRnlkR1ZrSWlrN0NpQWdJQ0JrWVhSaFltRnpaUzVsZUdWaktDSkNSVWRKVGlCSlRVMUZSRWxCVkVVaUtUc0tJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdkSEpoYm5OaFkzUnBiMjRnWW1WbmFXNGdZMjl0Y0d4bGRHVWlLVHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnYkc5amF5QmtZWFJoWW1GelpTQnBibk53WldOMGFXOXVJSE4wWVhKMFpXUWlLVHNLSUNBZ0lHTnZibk4wSUhOMFlYUmxJRDBnYVc1emNHVmpkRXh2WTJ0RVlYUmhZbUZ6WlNoa1lYUmhZbUZ6WlN3Z2NHRjBhQ2s3Q2lBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUd4dlkyc2daR0YwWVdKaGMyVWdhVzV6Y0dWamRHbHZiaUJqYjIxd2JHVjBaU0lwT3dvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCcWIzVnlibUZzSUcxdlpHVWdhVzV6Y0dWamRHbHZiaUJ6ZEdGeWRHVmtJaWs3Q2lBZ0lDQmpiMjV6ZENCcWIzVnlibUZzVFc5a1pTQTlJSEJ5WVdkdFlWUmxlSFFvWkdGMFlXSmhjMlVzSUNKcWIzVnlibUZzWDIxdlpHVWlLVHNLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnYW05MWNtNWhiQ0J0YjJSbElHbHVjM0JsWTNScGIyNGdZMjl0Y0d4bGRHVWlLVHNLSUNBZ0lHbG1JQ2hxYjNWeWJtRnNUVzlrWlNBaFBUMGdJbVJsYkdWMFpTSXBJSHNLSUNBZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCcWIzVnlibUZzSUcxdlpHVWdjbVZ6WlhRZ2MzUmhjblJsWkNJcE93b2dJQ0FnSUNCa1lYUmhZbUZ6WlM1bGVHVmpLQ0pTVDB4TVFrRkRTeUlwT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV3hsWTNSbFpDQTlJSEJ5WVdkdFlWUmxlSFFvWkdGMFlXSmhjMlVzSUNKcWIzVnlibUZzWDIxdlpHVTlSRVZNUlZSRklpazdDaUFnSUNBZ0lHbG1JQ2h6Wld4bFkzUmxaQ0FoUFQwZ0ltUmxiR1YwWlNJcElIUm9jbTkzSUdKMWMzbFVjbUZ1YzJsMGFXOXVSWEp5YjNJb2NHRjBhQ3dnYzJWc1pXTjBaV1FwT3dvZ0lDQWdJQ0J5WlhCdmNuUlFjbTluY21WemN5aGpiMjUwWlhoMExDQWlVMUZNYVhSbElHcHZkWEp1WVd3Z2JXOWtaU0J5WlhObGRDQmpiMjF3YkdWMFpTSXBPd29nSUNBZ0lDQmpiMjUwYVc1MVpUc0tJQ0FnSUgwS0lDQWdJR2xtSUNoemRHRjBaU0E5UFQwZ0ltVnRjSFI1SWlrZ2V3b2dJQ0FnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpVTFGTWFYUmxJR3h2WTJzZ1pHRjBZV0poYzJVZ2FXNXBkR2xoYkdsNllYUnBiMjRnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdJQ0JrWVhSaFltRnpaUzVsZUdWaktHQUtJQ0FnSUNBZ0lDQlFVa0ZIVFVFZ1lYQndiR2xqWVhScGIyNWZhV1FnUFNBa2UweFBRMHRmUVZCUVRFbERRVlJKVDA1ZlNVUjlPd29nSUNBZ0lDQWdJRU5TUlVGVVJTQlVRVUpNUlNCaFoyVnVZMTlzYjJOaGJGOXdjbTlqWlhOelgyeHZZMnNnS0FvZ0lDQWdJQ0FnSUNBZ2MybHVaMnhsZEc5dUlFbE9WRVZIUlZJZ1VGSkpUVUZTV1NCTFJWa2dRMGhGUTBzZ0tITnBibWRzWlhSdmJpQTlJREVwTEFvZ0lDQWdJQ0FnSUNBZ1ptOXliV0YwWDNabGNuTnBiMjRnU1U1VVJVZEZVaUJPVDFRZ1RsVk1UQW9nSUNBZ0lDQWdJQ2tnVTFSU1NVTlVPd29nSUNBZ0lDQWdJRWxPVTBWU1ZDQkpUbFJQSUdGblpXNWpYMnh2WTJGc1gzQnliMk5sYzNOZmJHOWpheUFvYzJsdVoyeGxkRzl1TENCbWIzSnRZWFJmZG1WeWMybHZiaWtLSUNBZ0lDQWdJQ0JXUVV4VlJWTWdLREVzSUNSN1RFOURTMTlHVDFKTlFWUmZWa1ZTVTBsUFRuMHBPd29nSUNBZ0lDQWdJRU5QVFUxSlZEc0tJQ0FnSUNBZ1lDazdDaUFnSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKVFVVeHBkR1VnYkc5amF5QmtZWFJoWW1GelpTQnBibWwwYVdGc2FYcGhkR2x2YmlCamIyMXdiR1YwWlNJcE93b2dJQ0FnSUNCamIyNTBhVzUxWlRzS0lDQWdJSDBLSUNBZ0lISmxkSFZ5YmpzS0lDQjlDaUFnZEdoeWIzY2dibVYzSUVWeWNtOXlLR0JoWjJWdVl6b2diRzlqYXlCa1lYUmhZbUZ6WlNCcGJtbDBhV0ZzYVhwaGRHbHZiaUJrYVdRZ2JtOTBJR052Ym5abGNtZGxPaUFrZTNCaGRHaDlZQ2s3Q24wS0NtWjFibU4wYVc5dUlHTnNiM05sUkdGMFlXSmhjMlVvWkdGMFlXSmhjMlVwSUhzS0lDQnBaaUFvSVdSaGRHRmlZWE5sUHk1cGMwOXdaVzRwSUhKbGRIVnlianNLSUNCamIyNXpkQ0JsY25KdmNuTWdQU0JiWFRzS0lDQjBjbmtnZXdvZ0lDQWdhV1lnS0dSaGRHRmlZWE5sTG1selZISmhibk5oWTNScGIyNHBJR1JoZEdGaVlYTmxMbVY0WldNb0lsSlBURXhDUVVOTElpazdDaUFnZlNCallYUmphQ0FvWlhKeWIzSXBJSHNLSUNBZ0lHVnljbTl5Y3k1d2RYTm9LR1Z5Y205eUtUc0tJQ0I5Q2lBZ2RISjVJSHNLSUNBZ0lHUmhkR0ZpWVhObExtTnNiM05sS0NrN0NpQWdmU0JqWVhSamFDQW9aWEp5YjNJcElIc0tJQ0FnSUdWeWNtOXljeTV3ZFhOb0tHVnljbTl5S1RzS0lDQjlDaUFnYVdZZ0tHVnljbTl5Y3k1c1pXNW5kR2dnUFQwOUlERXBJSFJvY205M0lHVnljbTl5YzFzd1hUc0tJQ0JwWmlBb1pYSnliM0p6TG14bGJtZDBhQ0ErSURFcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCQloyZHlaV2RoZEdWRmNuSnZjaWhsY25KdmNuTXNJQ0poWjJWdVl6b2dabUZwYkdWa0lIUnZJR05zYjNObElHRWdiRzlqWVd3Z2NISnZZMlZ6Y3lCc2IyTnJJR1JoZEdGaVlYTmxJaWs3Q2lBZ2ZRcDlDZ3BsZUhCdmNuUWdablZ1WTNScGIyNGdhWE5UY1d4cGRHVkNkWE41UlhKeWIzSW9aWEp5YjNJcElIc0tJQ0J5WlhSMWNtNGdkSGx3Wlc5bUlHVnljbTl5UHk1bGNuSmpiMlJsSUQwOVBTQWliblZ0WW1WeUlpQW1KZ29nSUNBZ0tHVnljbTl5TG1WeWNtTnZaR1VnSmlBd2VHWm1LU0E5UFQwZ1UxRk1TVlJGWDBKVlUxazdDbjBLQ21GemVXNWpJR1oxYm1OMGFXOXVJSGRoYVhSR2IzSkNkWE41VW1WMGNua29ZMjl1ZEdWNGRDd2djR0YwYUN3Z1lYUjBaVzF3ZEN3Z1kyRjFjMlVwSUhzS0lDQmpiMjV6ZENCeVpXMWhhVzVwYm1jZ1BTQnlaVzFoYVc1cGJtZE5hV3hzYVhObFkyOXVaSE1vWTI5dWRHVjRkQ2s3Q2lBZ2FXWWdLSEpsYldGcGJtbHVaeUE4UFNBd0tTQjBhSEp2ZHlCMGFXMWxiM1YwUlhKeWIzSW9ZMjl1ZEdWNGRDd2djR0YwYUN3Z1kyRjFjMlVwT3dvZ0lHTnZibk4wSUdWNGNHOXVaVzUwYVdGc1EyRndJRDBnVFdGMGFDNXRhVzRvVFVGWVgwSlZVMWxmVWtWVVVsbGZUVk1zSURJZ0tpb2dUV0YwYUM1dGFXNG9ZWFIwWlcxd2RDd2dOaWtwT3dvZ0lHTnZibk4wSUdwcGRIUmxjaUE5SUUxaGRHZ3ViV0Y0S0RFc0lFMWhkR2d1Wm14dmIzSW9UV0YwYUM1eVlXNWtiMjBvS1NBcUlDaGxlSEJ2Ym1WdWRHbGhiRU5oY0NBcklERXBLU2s3Q2lBZ1kyOXVjM1FnZDJGcGRFMXpJRDBnVFdGMGFDNXRhVzRvY21WdFlXbHVhVzVuTENCcWFYUjBaWElwT3dvZ0lHTnZibk4wSUhOcFoyNWhiQ0E5SUdOdmJuUmxlSFF1Y21WMGNubFhZV3RsVTJsbmJtRnNPd29nSUdsbUlDaHphV2R1WVd3Z1BUMDlJSFZ1WkdWbWFXNWxaQ0I4ZkNCamIyNTBaWGgwTG5KbGRISjVWMkZyWlVOdmJuTjFiV1ZrS1NCN0NpQWdJQ0JoZDJGcGRDQmtaV3hoZVNoM1lXbDBUWE1wT3dvZ0lIMGdaV3h6WlNCN0NpQWdJQ0F2THlCQklHaHBiblFnYjI1c2VTQnphRzl5ZEdWdWN5QnZibVVnYzJ4bFpYQXVJRlJvWlNCdVpYaDBJR0YwZEdWdGNIUWdiWFZ6ZENCemRHbHNiQ0IyWVd4cFpHRjBaUW9nSUNBZ0x5OGdkR2hsSUhCaGRHZ2dZVzVrSUdGamNYVnBjbVVnZEdobElGTlJUR2wwWlNCMGNtRnVjMkZqZEdsdmJpQmhaMkZwYm5OMElIUm9aU0J6WVcxbElHUmxZV1JzYVc1bExnb2dJQ0FnYkdWMElIUnBiV1Z5T3dvZ0lDQWdiR1YwSUhkaGEyVTdDaUFnSUNCMGNua2dld29nSUNBZ0lDQmhkMkZwZENCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTa2dQVDRnZXdvZ0lDQWdJQ0FnSUhkaGEyVWdQU0FvS1NBOVBpQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbkpsZEhKNVYyRnJaVU52Ym5OMWJXVmtJRDBnZEhKMVpUc0tJQ0FnSUNBZ0lDQWdJSEpsYzI5c2RtVW9LVHNLSUNBZ0lDQWdJQ0I5T3dvZ0lDQWdJQ0FnSUhScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENoeVpYTnZiSFpsTENCM1lXbDBUWE1wT3dvZ0lDQWdJQ0FnSUhOcFoyNWhiQzVoWkdSRmRtVnVkRXhwYzNSbGJtVnlLQ0poWW05eWRDSXNJSGRoYTJVc0lIc2diMjVqWlRvZ2RISjFaU0I5S1RzS0lDQWdJQ0FnSUNBdkx5QkRiM1psY25NZ2NtVmhaR2x1WlhOeklHSmxabTl5WlNCemRXSnpZM0pwY0hScGIyNGdZWE1nZDJWc2JDQmhjeUJpWldadmNtVWdZV054ZFdsemFYUnBiMjR1Q2lBZ0lDQWdJQ0FnYVdZZ0tITnBaMjVoYkM1aFltOXlkR1ZrS1NCM1lXdGxLQ2s3Q2lBZ0lDQWdJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQmlkWE41SUhKbGRISjVJSGRoYVhRZ2MzUmhjblJsWkNJcE93b2dJQ0FnSUNCOUtUc0tJQ0FnSUgwZ1ptbHVZV3hzZVNCN0NpQWdJQ0FnSUdOc1pXRnlWR2x0Wlc5MWRDaDBhVzFsY2lrN0NpQWdJQ0FnSUdsbUlDaDNZV3RsSUNFOVBTQjFibVJsWm1sdVpXUXBJSE5wWjI1aGJDNXlaVzF2ZG1WRmRtVnVkRXhwYzNSbGJtVnlLQ0poWW05eWRDSXNJSGRoYTJVcE93b2dJQ0FnZlFvZ0lIMEtJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQndZWFJvTENCallYVnpaU2s3Q24wS0NtRnplVzVqSUdaMWJtTjBhVzl1SUdGamNYVnBjbVZUY1d4cGRHVkVZWFJoWW1GelpTaEVZWFJoWW1GelpWTjVibU1zSUhCeVpYQmhjbVZrTENCamIyNTBaWGgwS1NCN0NpQWdiR1YwSUdGMGRHVnRjSFFnUFNBd093b2dJR3hsZENCc1lYTjBRblZ6ZVRzS0lDQjNhR2xzWlNBb2RISjFaU2tnZXdvZ0lDQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z2NISmxjR0Z5WldRdWNHRjBhQ3dnYkdGemRFSjFjM2twT3dvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCd2NtVXRiM0JsYmlCc2IyTnJJSFpoYkdsa1lYUnBiMjRnYzNSaGNuUmxaQ0lwT3dvZ0lDQWdZWGRoYVhRZ2NtVjJZV3hwWkdGMFpWQnlaWEJoY21Wa1RHOWpheWh3Y21Wd1lYSmxaQ3dnWTI5dWRHVjRkQ3dnZXdvZ0lDQWdJQ0F2THlCVWFHVWdZM0psWVhScGIyNGdjR0YwYUNCaGJISmxZV1I1SUhaaGJHbGtZWFJsWkNCMGFHVWdZMjl0Y0d4bGRHVWdZVzVqWlhOMGIzSWdZMmhoYVc0Z1lXNWtDaUFnSUNBZ0lDOHZJSFJvWlNCbGVHRmpkQ0J3WVhKbGJuUXZabWxzWlNCQlEweHpMaUJTWlhaaGJHbGtZWFJsSUVGRFRITWdZV1owWlhJZ1kyOXVkR1Z1ZEdsdmJpQmlaV05oZFhObENpQWdJQ0FnSUM4dklHRnViM1JvWlhJZ2FHOXNaR1Z5SUdGdVpDQmhiaUIxYm1KdmRXNWtaV1FnYVc1MFpYSjJZV3dnYUdGMlpTQmpjbTl6YzJWa0lIUm9hWE1nWVhSMFpXMXdkQzRLSUNBZ0lDQWdkbUZzYVdSaGRHVlhhVzVrYjNkelFXTnNPaUJoZEhSbGJYQjBJRDRnTUN3S0lDQWdJSDBwT3dvZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCd2NtVXRiM0JsYmlCc2IyTnJJSFpoYkdsa1lYUnBiMjRnWTI5dGNHeGxkR1VpS1RzS0lDQWdJR3hsZENCa1lYUmhZbUZ6WlRzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdaR0YwWVdKaGMyVWdiM0JsYmlCemRHRnlkR1ZrSWlrN0NpQWdJQ0FnSUdSaGRHRmlZWE5sSUQwZ2JtVjNJRVJoZEdGaVlYTmxVM2x1WXlod2NtVndZWEpsWkM1d1lYUm9MQ0I3Q2lBZ0lDQWdJQ0FnWVd4c2IzZEZlSFJsYm5OcGIyNDZJR1poYkhObExBb2dJQ0FnSUNBZ0lIUnBiV1Z2ZFhRNklEQXNDaUFnSUNBZ0lIMHBPd29nSUNBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUdSaGRHRmlZWE5sSUc5d1pXNGdZMjl0Y0d4bGRHVWlLVHNLSUNBZ0lDQWdjbVZ3YjNKMFVISnZaM0psYzNNb1kyOXVkR1Y0ZEN3Z0lsTlJUR2wwWlNCamIyNXVaV04wYVc5dUlHaGhjbVJsYm1sdVp5QnpkR0Z5ZEdWa0lpazdDaUFnSUNBZ0lHTnZibVpwWjNWeVpVeHZZMkZzVTNGc2FYUmxURzlqYTBOdmJtNWxZM1JwYjI0b1pHRjBZV0poYzJVcE93b2dJQ0FnSUNCeVpYQnZjblJRY205bmNtVnpjeWhqYjI1MFpYaDBMQ0FpVTFGTWFYUmxJR052Ym01bFkzUnBiMjRnYUdGeVpHVnVhVzVuSUdOdmJYQnNaWFJsSWlrN0NpQWdJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdjRzl6ZEMxdmNHVnVJR3h2WTJzZ2RtRnNhV1JoZEdsdmJpQnpkR0Z5ZEdWa0lpazdDaUFnSUNBZ0lHRjNZV2wwSUhKbGRtRnNhV1JoZEdWUWNtVndZWEpsWkV4dlkyc29jSEpsY0dGeVpXUXNJR052Ym5SbGVIUXBPd29nSUNBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUhCdmMzUXRiM0JsYmlCc2IyTnJJSFpoYkdsa1lYUnBiMjRnWTI5dGNHeGxkR1VpS1RzS0lDQWdJQ0FnWW1WbmFXNUJibVJXWVd4cFpHRjBaVXh2WTJzb1pHRjBZV0poYzJVc0lIQnlaWEJoY21Wa0xuQmhkR2dzSUdOdmJuUmxlSFFwT3dvZ0lDQWdJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQndjbVZ3WVhKbFpDNXdZWFJvTENCc1lYTjBRblZ6ZVNrN0NpQWdJQ0FnSUhKbGRIVnliaUJrWVhSaFltRnpaVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVnljbTl5S1NCN0NpQWdJQ0FnSUdOdmJuTjBJR05zWldGdWRYQkZjbkp2Y25NZ1BTQmJYVHNLSUNBZ0lDQWdhV1lnS0dSaGRHRmlZWE5sSUNFOVBTQjFibVJsWm1sdVpXUXBJSHNLSUNBZ0lDQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBZ0lDQWdZMnh2YzJWRVlYUmhZbUZ6WlNoa1lYUmhZbUZ6WlNrN0NpQWdJQ0FnSUNBZ2ZTQmpZWFJqYUNBb1kyeGxZVzUxY0VWeWNtOXlLU0I3Q2lBZ0lDQWdJQ0FnSUNCamJHVmhiblZ3UlhKeWIzSnpMbkIxYzJnb1kyeGxZVzUxY0VWeWNtOXlLVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdhV1lnS0dOc1pXRnVkWEJGY25KdmNuTXViR1Z1WjNSb0lENGdNQ2tnZXdvZ0lDQWdJQ0FnSUhSb2NtOTNJRzVsZHlCQloyZHlaV2RoZEdWRmNuSnZjaWdLSUNBZ0lDQWdJQ0FnSUZ0bGNuSnZjaXdnTGk0dVkyeGxZVzUxY0VWeWNtOXljMTBzQ2lBZ0lDQWdJQ0FnSUNCZ1lXZGxibU02SUd4dlkyc2dZWFIwWlcxd2RDQmhibVFnWTJ4bFlXNTFjQ0JpYjNSb0lHWmhhV3hsWkNCbWIzSWdKSHR3Y21Wd1lYSmxaQzV3WVhSb2ZXQXNDaUFnSUNBZ0lDQWdLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQnBaaUFvSVdselUzRnNhWFJsUW5WemVVVnljbTl5S0dWeWNtOXlLU2tnZEdoeWIzY2daWEp5YjNJN0NpQWdJQ0FnSUd4aGMzUkNkWE41SUQwZ1pYSnliM0k3Q2lBZ0lDQWdJR0YwZEdWdGNIUWdLejBnTVRzS0lDQWdJQ0FnWVhkaGFYUWdkMkZwZEVadmNrSjFjM2xTWlhSeWVTaGpiMjUwWlhoMExDQndjbVZ3WVhKbFpDNXdZWFJvTENCaGRIUmxiWEIwTENCc1lYTjBRblZ6ZVNrN0NpQWdJQ0I5Q2lBZ2ZRcDlDZ3BtZFc1amRHbHZiaUJ5Wld4bFlYTmxRV054ZFdseVpXUW9ZV054ZFdseVpXUXNJR3hoWW1Wc0tTQjdDaUFnWTI5dWMzUWdaWEp5YjNKeklEMGdXMTA3Q2lBZ1ptOXlJQ2hqYjI1emRDQnBkR1Z0SUc5bUlHRmpjWFZwY21Wa0xuUnZVbVYyWlhKelpXUW9LU2tnZXdvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTJ4dmMyVkVZWFJoWW1GelpTaHBkR1Z0TG1SaGRHRmlZWE5sS1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1Z5Y205eUtTQjdDaUFnSUNBZ0lHVnljbTl5Y3k1d2RYTm9LR1Z5Y205eUtUc0tJQ0FnSUgwS0lDQWdJR2xtSUNnb0lXbDBaVzB1WkdGMFlXSmhjMlVnZkh3Z0lXbDBaVzB1WkdGMFlXSmhjMlV1YVhOUGNHVnVLU0FtSmlBaGFYUmxiUzVwYmxCeWIyTmxjM05TWld4bFlYTmxaQ2tnZXdvZ0lDQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBZ0lHbDBaVzB1Y21Wc1pXRnpaVWx1VUhKdlkyVnpjeWdwT3dvZ0lDQWdJQ0FnSUdsMFpXMHVhVzVRY205alpYTnpVbVZzWldGelpXUWdQU0IwY25WbE93b2dJQ0FnSUNCOUlHTmhkR05vSUNobGNuSnZjaWtnZXdvZ0lDQWdJQ0FnSUdWeWNtOXljeTV3ZFhOb0tHVnljbTl5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdmUW9nSUgwS0lDQnBaaUFvWlhKeWIzSnpMbXhsYm1kMGFDQTlQVDBnTVNrZ2RHaHliM2NnWlhKeWIzSnpXekJkT3dvZ0lHbG1JQ2hsY25KdmNuTXViR1Z1WjNSb0lENGdNU2tnZXdvZ0lDQWdkR2h5YjNjZ2JtVjNJRUZuWjNKbFoyRjBaVVZ5Y205eUtHVnljbTl5Y3l3Z1lHRm5aVzVqT2lBa2UyeGhZbVZzZlNCc2IyTnJJSEpsYkdWaGMyVWdabUZwYkdWa1lDazdDaUFnZlFwOUNncGxlSEJ2Y25RZ1lYTjVibU1nWm5WdVkzUnBiMjRnWVdOeGRXbHlaVXh2WTJGc1UzRnNhWFJsVEc5amEzTW9DaUFnY21WeGRXVnpkR1ZrVUdGMGFITXNDaUFnZXdvZ0lDQWdkR2x0Wlc5MWRFMXpJRDBnTmpCZk1EQXdMQW9nSUNBZ2JHRmlaV3dnUFNBaVFXZGxia01nYjNCbGNtRjBhVzl1SWl3S0lDQWdJR1JsWVdSc2FXNWxPaUJ6ZFhCd2JHbGxaRVJsWVdSc2FXNWxMQW9nSUNBZ2IyNVFjbTluY21WemN5d0tJQ0FnSUhKbGRISjVWMkZyWlZOcFoyNWhiQ3dLSUNCOUlEMGdlMzBzQ2lrZ2V3b2dJR2xtSUNnaFRuVnRZbVZ5TG1selUyRm1aVWx1ZEdWblpYSW9kR2x0Wlc5MWRFMXpLU0I4ZkNCMGFXMWxiM1YwVFhNZ1BEMGdNQ2tnZXdvZ0lDQWdkR2h5YjNjZ2JtVjNJRlI1Y0dWRmNuSnZjaWdpYkc5amF5QjBhVzFsYjNWMFRYTWdiWFZ6ZENCaVpTQmhJSEJ2YzJsMGFYWmxJSE5oWm1VZ2FXNTBaV2RsY2lJcE93b2dJSDBLSUNCcFppQW9jM1Z3Y0d4cFpXUkVaV0ZrYkdsdVpTQWhQVDBnZFc1a1pXWnBibVZrSUNZbUlDRk9kVzFpWlhJdWFYTkdhVzVwZEdVb2MzVndjR3hwWldSRVpXRmtiR2x1WlNrcElIc0tJQ0FnSUhSb2NtOTNJRzVsZHlCVWVYQmxSWEp5YjNJb0lteHZZMnNnWkdWaFpHeHBibVVnYlhWemRDQmlaU0JtYVc1cGRHVWlLVHNLSUNCOUNpQWdhV1lnS0NGQmNuSmhlUzVwYzBGeWNtRjVLSEpsY1hWbGMzUmxaRkJoZEdoektTa2dld29nSUNBZ2RHaHliM2NnYm1WM0lGUjVjR1ZGY25KdmNpZ2liRzlqYXlCd1lYUm9jeUJ0ZFhOMElHSmxJR0Z1SUdGeWNtRjVJaWs3Q2lBZ2ZRb2dJR2xtSUNodmJsQnliMmR5WlhOeklDRTlQU0IxYm1SbFptbHVaV1FnSmlZZ2RIbHdaVzltSUc5dVVISnZaM0psYzNNZ0lUMDlJQ0ptZFc1amRHbHZiaUlwSUhzS0lDQWdJSFJvY205M0lHNWxkeUJVZVhCbFJYSnliM0lvSW14dlkyc2diMjVRY205bmNtVnpjeUJ0ZFhOMElHSmxJR0VnWm5WdVkzUnBiMjRpS1RzS0lDQjlDaUFnYVdZZ0tISmxkSEo1VjJGclpWTnBaMjVoYkNBaFBUMGdkVzVrWldacGJtVmtJQ1ltSUNFb2NtVjBjbmxYWVd0bFUybG5ibUZzSUdsdWMzUmhibU5sYjJZZ1FXSnZjblJUYVdkdVlXd3BLU0I3Q2lBZ0lDQjBhSEp2ZHlCdVpYY2dWSGx3WlVWeWNtOXlLQ0pzYjJOcklISmxkSEo1VjJGclpWTnBaMjVoYkNCdGRYTjBJR0psSUdGdUlFRmliM0owVTJsbmJtRnNJaWs3Q2lBZ2ZRb2dJR2xtSUNoeVpYRjFaWE4wWldSUVlYUm9jeTVzWlc1bmRHZ2dQVDA5SURBcElISmxkSFZ5YmlBb0tTQTlQaUI3ZlRzS0NpQWdZMjl1YzNRZ2MzUmhjblJsWkVGMElEMGdjR1Z5Wm05eWJXRnVZMlV1Ym05M0tDazdDaUFnWTI5dWMzUWdZMjl1ZEdWNGRDQTlJSHNLSUNBZ0lHUmxZV1JzYVc1bE9pQk5ZWFJvTG0xcGJpZ0tJQ0FnSUNBZ2MzVndjR3hwWldSRVpXRmtiR2x1WlNBL1B5Qk9kVzFpWlhJdVVFOVRTVlJKVmtWZlNVNUdTVTVKVkZrc0NpQWdJQ0FnSUhOMFlYSjBaV1JCZENBcklIUnBiV1Z2ZFhSTmN5d0tJQ0FnSUNrc0NpQWdJQ0JzWVdKbGJDd0tJQ0FnSUhScGJXVnZkWFJOY3l3S0lDQWdJRzl1VUhKdlozSmxjM01zQ2lBZ0lDQnlaWFJ5ZVZkaGEyVlRhV2R1WVd3c0NpQWdJQ0J5WlhSeWVWZGhhMlZEYjI1emRXMWxaRG9nWm1Gc2MyVXNDaUFnZlRzS0lDQmpiMjV6ZENCbWFYSnpkRVJwYzNCc1lYbFFZWFJvSUQwZ2NtVnpiMngyWlNoeVpYRjFaWE4wWldSUVlYUm9jMXN3WFNrN0NpQWdkR2h5YjNkSlprVjRjR2x5WldRb1kyOXVkR1Y0ZEN3Z1ptbHljM1JFYVhOd2JHRjVVR0YwYUNrN0Nnb2dJR052Ym5OMElIQnlaWEJoY21Wa1FubEpaR1Z1ZEdsMGVTQTlJRzVsZHlCTllYQW9LVHNLSUNCbWIzSWdLR052Ym5OMElISmxjWFZsYzNSbFpGQmhkR2dnYjJZZ2NtVnhkV1Z6ZEdWa1VHRjBhSE1wSUhzS0lDQWdJSFJvY205M1NXWkZlSEJwY21Wa0tHTnZiblJsZUhRc0lISmxjMjlzZG1Vb2NtVnhkV1Z6ZEdWa1VHRjBhQ2twT3dvZ0lDQWdZMjl1YzNRZ2NISmxjR0Z5WldRZ1BTQmhkMkZwZENCd2NtVndZWEpsVEc5amExQmhkR2dvY21WeGRXVnpkR1ZrVUdGMGFDd2dZMjl1ZEdWNGRDazdDaUFnSUNCd2NtVndZWEpsWkVKNVNXUmxiblJwZEhrdWMyVjBLSEJ5WlhCaGNtVmtMbWxrWlc1MGFYUjVTMlY1TENCd2NtVndZWEpsWkNrN0NpQWdmUW9nSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pzYjJOcklIQmhkR2dnY0hKbGNHRnlZWFJwYjI0Z1kyOXRjR3hsZEdVaUtUc0tJQ0JqYjI1emRDQndjbVZ3WVhKbFpFeHZZMnR6SUQwZ1d5NHVMbkJ5WlhCaGNtVmtRbmxKWkdWdWRHbDBlUzUyWVd4MVpYTW9LVjB1YzI5eWRDZ29iR1ZtZEN3Z2NtbG5hSFFwSUQwK0NpQWdJQ0JzWldaMExtbGtaVzUwYVhSNVMyVjVJRHdnY21sbmFIUXVhV1JsYm5ScGRIbExaWGtnUHlBdE1TQTZJR3hsWm5RdWFXUmxiblJwZEhsTFpYa2dQaUJ5YVdkb2RDNXBaR1Z1ZEdsMGVVdGxlU0EvSURFZ09pQXdLVHNLSUNCamIyNXpkQ0J3Wlc1a2FXNW5URzlqWVd3Z1BTQmJYVHNLSUNCamIyNXpkQ0JoWTNGMWFYSmxaQ0E5SUZ0ZE93b2dJR3hsZENCamRYSnlaVzUwVUdGMGFDQTlJSEJ5WlhCaGNtVmtURzlqYTNOYk1GMC9MbkJoZEdnZ1B6OGdabWx5YzNSRWFYTndiR0Y1VUdGMGFEc0tJQ0IwY25rZ2V3b2dJQ0FnWm05eUlDaGpiMjV6ZENCd2NtVndZWEpsWkNCdlppQndjbVZ3WVhKbFpFeHZZMnR6S1NCN0NpQWdJQ0FnSUdOMWNuSmxiblJRWVhSb0lEMGdjSEpsY0dGeVpXUXVjR0YwYURzS0lDQWdJQ0FnWTI5dWMzUWdjbVZzWldGelpTQTlJR0YzWVdsMElHRmpjWFZwY21WSmJsQnliMk5sYzNOTWIyTnJLSEJ5WlhCaGNtVmtMQ0JqYjI1MFpYaDBLVHNLSUNBZ0lDQWdjR1Z1WkdsdVoweHZZMkZzTG5CMWMyZ29leUJ3Y21Wd1lYSmxaQ3dnY21Wc1pXRnpaU0I5S1RzS0lDQWdJSDBLSUNBZ0lISmxjRzl5ZEZCeWIyZHlaWE56S0dOdmJuUmxlSFFzSUNKcGJpMXdjbTlqWlhOeklHeHZZMnNnWVdOeGRXbHphWFJwYjI0Z1kyOXRjR3hsZEdVaUtUc0tJQ0FnSUhSb2NtOTNTV1pGZUhCcGNtVmtLR052Ym5SbGVIUXNJR04xY25KbGJuUlFZWFJvS1RzS0lDQWdJSEpsY0c5eWRGQnliMmR5WlhOektHTnZiblJsZUhRc0lDSlRVVXhwZEdVZ2JXOWtkV3hsSUdsdGNHOXlkQ0J6ZEdGeWRHVmtJaWs3Q2lBZ0lDQmpiMjV6ZENCN0lFUmhkR0ZpWVhObFUzbHVZeUI5SUQwZ1lYZGhhWFFnYVcxd2IzSjBLQ0p1YjJSbE9uTnhiR2wwWlNJcE93b2dJQ0FnY21Wd2IzSjBVSEp2WjNKbGMzTW9ZMjl1ZEdWNGRDd2dJbE5SVEdsMFpTQnRiMlIxYkdVZ2FXMXdiM0owSUdOdmJYQnNaWFJsSWlrN0NpQWdJQ0IwYUhKdmQwbG1SWGh3YVhKbFpDaGpiMjUwWlhoMExDQmpkWEp5Wlc1MFVHRjBhQ2s3Q2lBZ0lDQm1iM0lnS0dOdmJuTjBJSHNnY0hKbGNHRnlaV1FzSUhKbGJHVmhjMlVnZlNCdlppQndaVzVrYVc1blRHOWpZV3dwSUhzS0lDQWdJQ0FnWTNWeWNtVnVkRkJoZEdnZ1BTQndjbVZ3WVhKbFpDNXdZWFJvT3dvZ0lDQWdJQ0JqYjI1emRDQnBkR1Z0SUQwZ2V3b2dJQ0FnSUNBZ0lHUmhkR0ZpWVhObE9pQjFibVJsWm1sdVpXUXNDaUFnSUNBZ0lDQWdjbVZzWldGelpVbHVVSEp2WTJWemN6b2djbVZzWldGelpTd0tJQ0FnSUNBZ0lDQnBibEJ5YjJObGMzTlNaV3hsWVhObFpEb2dabUZzYzJVc0NpQWdJQ0FnSUgwN0NpQWdJQ0FnSUdGamNYVnBjbVZrTG5CMWMyZ29hWFJsYlNrN0NpQWdJQ0FnSUhKbGNHOXlkRkJ5YjJkeVpYTnpLR052Ym5SbGVIUXNJQ0pUVVV4cGRHVWdkSEpoYm5OaFkzUnBiMjRnWVdOeGRXbHphWFJwYjI0Z2MzUmhjblJsWkNJcE93b2dJQ0FnSUNCcGRHVnRMbVJoZEdGaVlYTmxJRDBnWVhkaGFYUWdZV054ZFdseVpWTnhiR2wwWlVSaGRHRmlZWE5sS0VSaGRHRmlZWE5sVTNsdVl5d2djSEpsY0dGeVpXUXNJR052Ym5SbGVIUXBPd29nSUNBZ0lDQnlaWEJ2Y25SUWNtOW5jbVZ6Y3loamIyNTBaWGgwTENBaVUxRk1hWFJsSUhSeVlXNXpZV04wYVc5dUlHRmpjWFZwYzJsMGFXOXVJR052YlhCc1pYUmxJaWs3Q2lBZ0lDQjlDaUFnZlNCallYUmphQ0FvWlhKeWIzSXBJSHNLSUNBZ0lHTnZibk4wSUdOc1pXRnVkWEJGY25KdmNuTWdQU0JiWFRzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUhKbGJHVmhjMlZCWTNGMWFYSmxaQ2hoWTNGMWFYSmxaQ3dnYkdGaVpXd3BPd29nSUNBZ2ZTQmpZWFJqYUNBb1kyeGxZVzUxY0VWeWNtOXlLU0I3Q2lBZ0lDQWdJR05zWldGdWRYQkZjbkp2Y25NdWNIVnphQ2hqYkdWaGJuVndSWEp5YjNJcE93b2dJQ0FnZlFvZ0lDQWdabTl5SUNoamIyNXpkQ0I3SUhKbGJHVmhjMlVnZlNCdlppQndaVzVrYVc1blRHOWpZV3d1YzJ4cFkyVW9ZV054ZFdseVpXUXViR1Z1WjNSb0tTNTBiMUpsZG1WeWMyVmtLQ2twSUhzS0lDQWdJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0lDQnlaV3hsWVhObEtDazdDaUFnSUNBZ0lIMGdZMkYwWTJnZ0tHTnNaV0Z1ZFhCRmNuSnZjaWtnZXdvZ0lDQWdJQ0FnSUdOc1pXRnVkWEJGY25KdmNuTXVjSFZ6YUNoamJHVmhiblZ3UlhKeWIzSXBPd29nSUNBZ0lDQjlDaUFnSUNCOUNpQWdJQ0JqYjI1emRDQm1iM0p0WVhSMFpXUWdQU0JwYzFOeGJHbDBaVUoxYzNsRmNuSnZjaWhsY25KdmNpa0tJQ0FnSUNBZ1B5QjBhVzFsYjNWMFJYSnliM0lvWTI5dWRHVjRkQ3dnWTNWeWNtVnVkRkJoZEdnc0lHVnljbTl5S1FvZ0lDQWdJQ0E2SUdWeWNtOXlPd29nSUNBZ2FXWWdLR05zWldGdWRYQkZjbkp2Y25NdWJHVnVaM1JvSUQ0Z01Da2dld29nSUNBZ0lDQjBhSEp2ZHlCdVpYY2dRV2RuY21WbllYUmxSWEp5YjNJb0NpQWdJQ0FnSUNBZ1cyWnZjbTFoZEhSbFpDd2dMaTR1WTJ4bFlXNTFjRVZ5Y205eWMxMHNDaUFnSUNBZ0lDQWdZR0ZuWlc1ak9pQWtlMnhoWW1Wc2ZTQnNiMk5ySUdGamNYVnBjMmwwYVc5dUlHRnVaQ0J5YjJ4c1ltRmpheUJpYjNSb0lHWmhhV3hsWkdBc0NpQWdJQ0FnSUNrN0NpQWdJQ0I5Q2lBZ0lDQjBhSEp2ZHlCbWIzSnRZWFIwWldRN0NpQWdmUW9LSUNCc1pYUWdjbVZzWldGelpXUWdQU0JtWVd4elpUc0tJQ0J5WlhSMWNtNGdLQ2tnUFQ0Z2V3b2dJQ0FnYVdZZ0tISmxiR1ZoYzJWa0tTQnlaWFIxY200N0NpQWdJQ0J5Wld4bFlYTmxRV054ZFdseVpXUW9ZV054ZFdseVpXUXNJR3hoWW1Wc0tUc0tJQ0FnSUhKbGJHVmhjMlZrSUQwZ1lXTnhkV2x5WldRdVpYWmxjbmtvS0dsMFpXMHBJRDArSUdsMFpXMHVhVzVRY205alpYTnpVbVZzWldGelpXUXBPd29nSUgwN0NuMEtDbVY0Y0c5eWRDQmhjM2x1WXlCbWRXNWpkR2x2YmlCaFkzRjFhWEpsVEc5allXeFRjV3hwZEdWTWIyTnJLSEJoZEdnc0lHOXdkR2x2Ym5NcElIc0tJQ0J5WlhSMWNtNGdZV054ZFdseVpVeHZZMkZzVTNGc2FYUmxURzlqYTNNb1czQmhkR2hkTENCdmNIUnBiMjV6S1RzS2ZRbz0iOwoKY29uc3QgdmVyc2lvblBhdHRlcm4gPSAvXlxkK1wuXGQrXC5cZCsoPzotWzAtOUEtWmEtei4tXSspPyQvOwpmdW5jdGlvbiBwcml2YXRlRGlyZWN0b3J5KHBhdGgsIHJlcGFpcldyaXRhYmxlID0gZmFsc2UpIHsKICBta2RpclN5bmMocGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIG1vZGU6IDBvNzAwIH0pOwogIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMocGF0aCk7CiAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkgfHwgc3RhdC5pc1N5bWJvbGljTGluaygpIHx8IHJlYWxwYXRoU3luYyhwYXRoKSAhPT0gcGF0aCB8fAogICAgICBzdGF0LnVpZCAhPT0gcHJvY2Vzcy5nZXR1aWQoKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGBydW50aW1lIG1haW50ZW5hbmNlIGRpcmVjdG9yeSBpcyB1bnNhZmU6ICR7cGF0aH1gKTsKICB9CiAgaWYgKChzdGF0Lm1vZGUgJiAwbzAyMikgIT09IDApIHsKICAgIGlmICghcmVwYWlyV3JpdGFibGUpIHRocm93IG5ldyBFcnJvcihgcnVudGltZSBtYWludGVuYW5jZSBkaXJlY3RvcnkgaXMgd3JpdGFibGU6ICR7cGF0aH1gKTsKICAgIGNvbnN0IGZkID0gb3BlblN5bmMocGF0aCwgY29uc3RhbnRzLk9fUkRPTkxZIHwgY29uc3RhbnRzLk9fRElSRUNUT1JZIHwgY29uc3RhbnRzLk9fTk9GT0xMT1cpOwogICAgdHJ5IHsKICAgICAgY29uc3Qgb3BlbmVkID0gZnN0YXRTeW5jKGZkKTsKICAgICAgaWYgKG9wZW5lZC5kZXYgIT09IHN0YXQuZGV2IHx8IG9wZW5lZC5pbm8gIT09IHN0YXQuaW5vKSB0aHJvdyBuZXcgRXJyb3IoIm1haW50ZW5hbmNlIGRpcmVjdG9yeSBpZGVudGl0eSBjaGFuZ2VkIik7CiAgICAgIGZjaG1vZFN5bmMoZmQsIDBvNzAwKTsKICAgIH0gZmluYWxseSB7IGNsb3NlU3luYyhmZCk7IH0KICB9Cn0KZnVuY3Rpb24gYXRvbWljSnNvbihwYXRoLCB2YWx1ZSkgewogIGNvbnN0IHRlbXBvcmFyeSA9IGAke3BhdGh9LiR7cHJvY2Vzcy5waWR9LSR7cmFuZG9tVVVJRCgpfWA7CiAgdHJ5IHsKICAgIGNvbnN0IGZkID0gb3BlblN5bmModGVtcG9yYXJ5LCAid3giLCAwbzYwMCk7CiAgICB0cnkgeyB3cml0ZUZpbGVTeW5jKGZkLCBKU09OLnN0cmluZ2lmeSh2YWx1ZSkgKyAiXG4iKTsgZnN5bmNTeW5jKGZkKTsgfQogICAgZmluYWxseSB7IGNsb3NlU3luYyhmZCk7IH0KICAgIHJlbmFtZVN5bmModGVtcG9yYXJ5LCBwYXRoKTsKICAgIGNvbnN0IHBhcmVudCA9IG9wZW5TeW5jKGRpcm5hbWUocGF0aCksICJyIik7CiAgICB0cnkgeyBmc3luY1N5bmMocGFyZW50KTsgfSBmaW5hbGx5IHsgY2xvc2VTeW5jKHBhcmVudCk7IH0KICB9IGZpbmFsbHkgeyBybVN5bmModGVtcG9yYXJ5LCB7IGZvcmNlOiB0cnVlIH0pOyB9Cn0KZnVuY3Rpb24gbGl2ZShwaWQpIHsKICB0cnkgeyBwcm9jZXNzLmtpbGwocGlkLCAwKTsgcmV0dXJuIHRydWU7IH0KICBjYXRjaCAoZXJyb3IpIHsgcmV0dXJuIGVycm9yLmNvZGUgIT09ICJFU1JDSCI7IH0KfQoKLy8gVGhlIHNhbWUgbG9jayBzZXJpYWxpemVzIGxlYXNlIGNyZWF0aW9uIGFuZCBjbGVhbnVwLiBBIGxlYXNlIHNwYW5zIG5ldHdvcmsKLy8gZG93bmxvYWQsIHZlcmlmaWNhdGlvbiwgZXh0cmFjdGlvbiBhbmQgYWN0aXZhdGlvbiwgaW5jbHVkaW5nIHRoZWlyIGxvY2sgZ2Fwcy4KZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJlZ2luUnVudGltZVVwZGF0ZShob21lLCBwaWQgPSBwcm9jZXNzLnBpZCkgewogIGNvbnN0IHJvb3QgPSBqb2luKHJlYWxwYXRoU3luYyhob21lKSwgInJ1bnRpbWUiKTsKICBwcml2YXRlRGlyZWN0b3J5KHJvb3QsIHRydWUpOwogIGNvbnN0IHJlbGVhc2UgPSBhd2FpdCBhY3F1aXJlTG9jYWxTcWxpdGVMb2NrKGpvaW4ocm9vdCwgIi5tYWludGVuYW5jZS1sb2NrLnNxbGl0ZSIpLCB7CiAgICBsYWJlbDogInJ1bnRpbWUgbWFpbnRlbmFuY2UiLCB0aW1lb3V0TXM6IDYwXzAwMCwKICB9KTsKICB0cnkgewogICAgY29uc3QgZGlyZWN0b3J5ID0gam9pbihyb290LCAiLnVwZGF0ZS1sZWFzZXMiKTsKICAgIHByaXZhdGVEaXJlY3RvcnkoZGlyZWN0b3J5KTsKICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIocGlkKSB8fCBwaWQgPD0gMCkgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHVwZGF0ZSBwaWQiKTsKICAgIGNvbnN0IHBhdGggPSBqb2luKGRpcmVjdG9yeSwgYCR7cGlkfS0ke3JhbmRvbVVVSUQoKX0uanNvbmApOwogICAgYXRvbWljSnNvbihwYXRoLCB7IHBpZCB9KTsKICAgIHJldHVybiBwYXRoOwogIH0gZmluYWxseSB7IHJlbGVhc2UoKTsgfQp9CmV4cG9ydCBmdW5jdGlvbiBlbmRSdW50aW1lVXBkYXRlKGxlYXNlKSB7IHJtU3luYyhsZWFzZSwgeyBmb3JjZTogdHJ1ZSB9KTsgfQoKZXhwb3J0IGZ1bmN0aW9uIHJlY29yZFJ1bnRpbWVBY3RpdmF0aW9uKGhvbWUsIGN1cnJlbnQsIHByZXZpb3VzKSB7CiAgaWYgKCF2ZXJzaW9uUGF0dGVybi50ZXN0KGN1cnJlbnQpIHx8IChwcmV2aW91cyAhPT0gdW5kZWZpbmVkICYmICF2ZXJzaW9uUGF0dGVybi50ZXN0KHByZXZpb3VzKSkpIHsKICAgIHRocm93IG5ldyBFcnJvcigiaW52YWxpZCBydW50aW1lIGFjdGl2YXRpb24gaGlzdG9yeSIpOwogIH0KICBjb25zdCBwYXRoID0gam9pbihob21lLCAicnVudGltZSIsICIuYWN0aXZhdGlvbi1oaXN0b3J5Lmpzb24iKTsKICBsZXQgb2xkOwogIHRyeSB7IG9sZCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsICJ1dGY4IikpOyB9CiAgY2F0Y2ggKGVycm9yKSB7IGlmIChlcnJvci5jb2RlICE9PSAiRU5PRU5UIikgdGhyb3cgZXJyb3I7IH0KICAvLyBSZWluc3RhbGxpbmcgdGhlIGN1cnJlbnQgcmVsZWFzZSBtdXN0IG5vdCBmb3JnZXQgdGhlIHJvbGxiYWNrIHZlcnNpb24uCiAgaWYgKHByZXZpb3VzID09PSBjdXJyZW50IHx8IHByZXZpb3VzID09PSB1bmRlZmluZWQpIHsKICAgIHByZXZpb3VzID0gb2xkPy5jdXJyZW50ID09PSBjdXJyZW50ID8gb2xkLnByZXZpb3VzIDogb2xkPy5jdXJyZW50OwogIH0KICBpZiAob2xkPy5jdXJyZW50ID09PSBjdXJyZW50ICYmIG9sZD8ucHJldmlvdXMgPT09IHByZXZpb3VzKSByZXR1cm4gZmFsc2U7CiAgYXRvbWljSnNvbihwYXRoLCB7IGN1cnJlbnQsIC4uLihwcmV2aW91cyA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHByZXZpb3VzIH0pIH0pOwogIHJldHVybiB0cnVlOwp9CgovLyBJbmNsdWRlIGNvbW1hbmQgbGluZXMgKEpTIGVudHJ5cG9pbnRzKSBhbmQgb3BlbiBmaWxlcywgZXhlY3V0YWJsZSBtYXBwaW5ncywKLy8gbmF0aXZlIGFkZG9ucyBhbmQgY3dkLiBBIGZhaWxlZCBvciB0cnVuY2F0ZWQgaW52ZW50b3J5IGRpc2FibGVzIGFsbCBjbGVhbnVwLgpleHBvcnQgZnVuY3Rpb24gcnVudGltZVByb2Nlc3NJbnZlbnRvcnkocm9vdCkgewogIGNvbnN0IHBzID0gc3Bhd25TeW5jKCIvYmluL3BzIiwgWyItYXh3dyIsICItbyIsICJwaWQ9LGNvbW1hbmQ9Il0sIHsKICAgIGVuY29kaW5nOiAidXRmOCIsIHRpbWVvdXQ6IDE1XzAwMCwgbWF4QnVmZmVyOiAxNiAqIDEwMjQgKiAxMDI0LAogIH0pOwogIGNvbnN0IGZpbGVzID0gc3Bhd25TeW5jKCIvdXNyL3NiaW4vbHNvZiIsIFsiLW5QIiwgIi1GcG4iLCAiK0QiLCByb290XSwgewogICAgZW5jb2Rpbmc6ICJ1dGY4IiwgdGltZW91dDogMzBfMDAwLCBtYXhCdWZmZXI6IDMyICogMTAyNCAqIDEwMjQsCiAgfSk7CiAgaWYgKHBzLmVycm9yIHx8IHBzLnN0YXR1cyAhPT0gMCB8fCBmaWxlcy5lcnJvciB8fAogICAgICAoZmlsZXMuc3RhdHVzICE9PSAwICYmIGZpbGVzLnN0YXR1cyAhPT0gMSkgfHwKICAgICAgZmlsZXMuc3RkZXJyICE9PSAiIikgdGhyb3cgbmV3IEVycm9yKCJjYW5ub3QgZXN0YWJsaXNoIHJ1bm5pbmcgcnVudGltZSB1c2FnZSIpOwogIHJldHVybiBwcy5zdGRvdXQgKyAiXG4iICsgZmlsZXMuc3Rkb3V0Owp9CmZ1bmN0aW9uIHRyZWVCeXRlcyhwYXRoKSB7CiAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhwYXRoKTsKICBpZiAoc3RhdC5pc1N5bWJvbGljTGluaygpKSByZXR1cm4gc3RhdC5zaXplOwogIGlmICghc3RhdC5pc0RpcmVjdG9yeSgpKSByZXR1cm4gc3RhdC5zaXplOwogIHJldHVybiByZWFkZGlyU3luYyhwYXRoKS5yZWR1Y2UoKHN1bSwgbmFtZSkgPT4gc3VtICsgdHJlZUJ5dGVzKGpvaW4ocGF0aCwgbmFtZSkpLCAwKTsKfQoKZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBydW5lUnVudGltZXMoaG9tZSwgeyBpbnZlbnRvcnkgPSBydW50aW1lUHJvY2Vzc0ludmVudG9yeSwgY2hlY2twb2ludCA9ICgpID0+IHt9IH0gPSB7fSkgewogIGNvbnN0IHJvb3QgPSBqb2luKHJlYWxwYXRoU3luYyhob21lKSwgInJ1bnRpbWUiKTsKICBwcml2YXRlRGlyZWN0b3J5KHJvb3QpOwogIGNvbnN0IHJlbGVhc2UgPSBhd2FpdCBhY3F1aXJlTG9jYWxTcWxpdGVMb2NrKGpvaW4ocm9vdCwgIi5tYWludGVuYW5jZS1sb2NrLnNxbGl0ZSIpLCB7CiAgICBsYWJlbDogInJ1bnRpbWUgbWFpbnRlbmFuY2UiLCB0aW1lb3V0TXM6IDYwXzAwMCwKICB9KTsKICBsZXQgcmVsZWFzZUFjdGl2YXRpb247CiAgY29uc3QgcmVzdWx0ID0geyByZW1vdmVkOiBbXSwgZnJlZWRCeXRlczogMCwgc2tpcHBlZDogdW5kZWZpbmVkIH07CiAgdHJ5IHsKICAgIHJlbGVhc2VBY3RpdmF0aW9uID0gYXdhaXQgYWNxdWlyZUxvY2FsU3FsaXRlTG9jayhqb2luKHJvb3QsICIuYWN0aXZhdGlvbi1sb2NrLnNxbGl0ZSIpLCB7CiAgICAgIGxhYmVsOiAicnVudGltZSBwcnVuZSBhY3RpdmF0aW9uIiwgdGltZW91dE1zOiA2MF8wMDAsCiAgICB9KTsKICAgIGlmIChleGlzdHNTeW5jKGpvaW4ocm9vdCwgIi5hY3RpdmF0aW9uLXRyYW5zYWN0aW9uLmpzb24iKSkpIHsKICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiAiYWN0aXZhdGlvbiByZWNvdmVyeSBwZW5kaW5nIiB9OwogICAgfQogICAgY29uc3QgbGVhc2VzID0gam9pbihyb290LCAiLnVwZGF0ZS1sZWFzZXMiKTsKICAgIGlmIChleGlzdHNTeW5jKGxlYXNlcykpIHsKICAgICAgcHJpdmF0ZURpcmVjdG9yeShsZWFzZXMpOwogICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhZGRpclN5bmMobGVhc2VzKSkgewogICAgICAgIGNvbnN0IHBhdGggPSBqb2luKGxlYXNlcywgbmFtZSk7CiAgICAgICAgaWYgKCFsc3RhdFN5bmMocGF0aCkuaXNGaWxlKCkgfHwgbHN0YXRTeW5jKHBhdGgpLmlzU3ltYm9saWNMaW5rKCkpIHsKICAgICAgICAgIHJldHVybiB7IC4uLnJlc3VsdCwgc2tpcHBlZDogInVucmVjb2duaXplZCB1cGRhdGUgbGVhc2UiIH07CiAgICAgICAgfQogICAgICAgIGNvbnN0IGxlYXNlID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgInV0ZjgiKSk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihsZWFzZS5waWQpIHx8IGxlYXNlLnBpZCA8PSAwIHx8IGxpdmUobGVhc2UucGlkKSkgewogICAgICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiAidXBkYXRlIGluIHByb2dyZXNzIiB9OwogICAgICAgIH0KICAgICAgICBybVN5bmMocGF0aCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsICIuYWN0aXZhdGlvbi1oaXN0b3J5Lmpzb24iKSwgInV0ZjgiKSk7CiAgICBpZiAoIXZlcnNpb25QYXR0ZXJuLnRlc3QoaGlzdG9yeS5jdXJyZW50KSB8fCAhdmVyc2lvblBhdHRlcm4udGVzdChoaXN0b3J5LnByZXZpb3VzKSkgewogICAgICByZXR1cm4geyAuLi5yZXN1bHQsIHNraXBwZWQ6ICJ0d28gc3VjY2Vzc2Z1bCBhY3RpdmF0aW9ucyBub3QgcmVjb3JkZWQiIH07CiAgICB9CiAgICBjb25zdCB1c2FnZSA9IGludmVudG9yeShyb290KTsKICAgIC8vIE9sZGVyIHVwZGF0ZXIgYmluYXJpZXMgcHJlZGF0ZSBsZWFzZXMuIFRoZWlyIGZ1bGwgY29tbWFuZCBsaW5lIHN0aWxsCiAgICAvLyBpZGVudGlmaWVzIGFuIHVwZGF0ZSBvZiB0aGlzIGhvbWUuIEV4Y2x1ZGUgdGhpcyBjb21wbGV0ZWQgdXBkYXRlciBpdHNlbGYuCiAgICBpZiAodXNhZ2Uuc3BsaXQoIlxuIikuc29tZSgobGluZSkgPT4gewogICAgICBjb25zdCBjb21tYW5kID0gL15ccyooXGQrKVxzKyguKykkLy5leGVjKGxpbmUpOwogICAgICByZXR1cm4gY29tbWFuZCAhPT0gbnVsbCAmJiBOdW1iZXIoY29tbWFuZFsxXSkgIT09IHByb2Nlc3MucGlkICYmCiAgICAgICAgY29tbWFuZFsyXS5pbmNsdWRlcyhyb290ICsgIi8iKSAmJiAvXC9hZ2VuYyg/OlwuanMpP1xzK3VwZGF0ZSg/OlxzfCQpLy50ZXN0KGNvbW1hbmRbMl0pOwogICAgfSkpIHJldHVybiB7IC4uLnJlc3VsdCwgc2tpcHBlZDogIm9sZGVyIHVwZGF0ZXIgaW4gcHJvZ3Jlc3MiIH07CiAgICBmb3IgKGNvbnN0IHZlcnNpb24gb2YgcmVhZGRpclN5bmMocm9vdCkpIHsKICAgICAgaWYgKCF2ZXJzaW9uUGF0dGVybi50ZXN0KHZlcnNpb24pKSBjb250aW51ZTsKICAgICAgY29uc3QgcGF0aCA9IGpvaW4ocm9vdCwgdmVyc2lvbik7CiAgICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMocGF0aCk7CiAgICAgIGlmIChzdGF0LmlzRGlyZWN0b3J5KCkgJiYgIXN0YXQuaXNTeW1ib2xpY0xpbmsoKSAmJgogICAgICAgICAgcmVhZGRpclN5bmMocGF0aCkuc29tZSgobmFtZSkgPT4gbmFtZS5zdGFydHNXaXRoKCIuIikpKSB7CiAgICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiAicnVudGltZSBleHRyYWN0aW9uIG9yIHJlY292ZXJ5IHBlbmRpbmciIH07CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IHBydW5lSm91cm5hbCA9IGpvaW4ocm9vdCwgIi5wcnVuZS10cmFuc2FjdGlvbi5qc29uIik7CiAgICBjb25zdCByZW1vdmVUcmVlID0gKHZlcnNpb24sIHRyZWVOYW1lLCBxdWFyYW50aW5lTmFtZSwgcmVjb3ZlcmluZyA9IGZhbHNlKSA9PiB7CiAgICAgIGlmICghdmVyc2lvblBhdHRlcm4udGVzdCh2ZXJzaW9uKSB8fAogICAgICAgICAgIS9eKD86ZGFyd2lufGxpbnV4fHdpbiktKD86YXJtNjR8eDY0KS0oPzpuYXRpdmV8Z2xpYmMpLW5vZGUtYWJpLVxkKy1zaGEyNTYtW2EtZjAtOV17NjR9JC8udGVzdCh0cmVlTmFtZSkgfHwKICAgICAgICAgICEvXlwucHJ1bmUtW2EtZjAtOS1dezM2fSQvLnRlc3QocXVhcmFudGluZU5hbWUpKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHBydW5lIGpvdXJuYWwiKTsKICAgICAgfQogICAgICBjb25zdCB2ZXJzaW9uRGlyID0gam9pbihyb290LCB2ZXJzaW9uKSwgdHJlZSA9IGpvaW4odmVyc2lvbkRpciwgdHJlZU5hbWUpOwogICAgICBjb25zdCBxdWFyYW50aW5lID0gam9pbihyb290LCBxdWFyYW50aW5lTmFtZSk7CiAgICAgIGNvbnN0IHN5bmNQYXJlbnRzID0gKCkgPT4gewogICAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBbdmVyc2lvbkRpciwgcm9vdF0pIHsKICAgICAgICAgIGNvbnN0IGZkID0gb3BlblN5bmMocGF0aCwgInIiKTsKICAgICAgICAgIHRyeSB7IGZzeW5jU3luYyhmZCk7IH0gZmluYWxseSB7IGNsb3NlU3luYyhmZCk7IH0KICAgICAgICB9CiAgICAgIH07CiAgICAgIGNvbnN0IHJlc3RvcmUgPSAoKSA9PiB7CiAgICAgICAgaWYgKGV4aXN0c1N5bmMocXVhcmFudGluZSkpIHsKICAgICAgICAgIGlmIChleGlzdHNTeW5jKHRyZWUpKSB0aHJvdyBuZXcgRXJyb3IoInJldGFpbmVkIHJ1bnRpbWUgaGFzIGEgcGVuZGluZyBxdWFyYW50aW5lIGNvcHkiKTsKICAgICAgICAgIHJlbmFtZVN5bmMocXVhcmFudGluZSwgdHJlZSk7CiAgICAgICAgICBzeW5jUGFyZW50cygpOwogICAgICAgIH0KICAgICAgICBybVN5bmMocHJ1bmVKb3VybmFsLCB7IGZvcmNlOiB0cnVlIH0pOwogICAgICB9OwogICAgICBpZiAodmVyc2lvbiA9PT0gaGlzdG9yeS5jdXJyZW50IHx8IHZlcnNpb24gPT09IGhpc3RvcnkucHJldmlvdXMpIHsKICAgICAgICBpZiAocmVjb3ZlcmluZykgcmVzdG9yZSgpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBjb25zdCBidXN5ID0gKHNuYXBzaG90KSA9PiBbdmVyc2lvbkRpciwgcXVhcmFudGluZV0uc29tZSgocGF0aCkgPT4KICAgICAgICBzbmFwc2hvdC5pbmNsdWRlcyhwYXRoICsgIi8iKSB8fCBzbmFwc2hvdC5pbmNsdWRlcyhwYXRoICsgIlxuIikpOwogICAgICBpZiAoYnVzeShpbnZlbnRvcnkocm9vdCkpKSB7CiAgICAgICAgaWYgKHJlY292ZXJpbmcpIHJlc3RvcmUoKTsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInJ1bnRpbWUgYmVjYW1lIGJ1c3kgYmVmb3JlIHBydW5pbmciKTsKICAgICAgfQogICAgICBpZiAobHN0YXRTeW5jKHZlcnNpb25EaXIpLmlzU3ltYm9saWNMaW5rKCkpIHRocm93IG5ldyBFcnJvcigicHJ1bmUgcGFyZW50IGNoYW5nZWQgaWRlbnRpdHkiKTsKICAgICAgZm9yIChjb25zdCBwYXRoIG9mIFt0cmVlLCBxdWFyYW50aW5lXSkgewogICAgICAgIGlmIChleGlzdHNTeW5jKHBhdGgpICYmICghbHN0YXRTeW5jKHBhdGgpLmlzRGlyZWN0b3J5KCkgfHwgbHN0YXRTeW5jKHBhdGgpLmlzU3ltYm9saWNMaW5rKCkpKSB7CiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInBydW5lIHRyZWUgY2hhbmdlZCBpZGVudGl0eSIpOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoIXJlY292ZXJpbmcpIGF0b21pY0pzb24ocHJ1bmVKb3VybmFsLCB7IHZlcnNpb24sIHRyZWVOYW1lLCBxdWFyYW50aW5lTmFtZSB9KTsKICAgICAgY2hlY2twb2ludCgicHJ1bmUtcmVjb3JkZWQiKTsKICAgICAgaWYgKGV4aXN0c1N5bmModHJlZSkpIHsKICAgICAgICBpZiAoZXhpc3RzU3luYyhxdWFyYW50aW5lKSkgdGhyb3cgbmV3IEVycm9yKCJhbWJpZ3VvdXMgcHJ1bmUgcmVjb3Zlcnkgc3RhdGUiKTsKICAgICAgICByZW5hbWVTeW5jKHRyZWUsIHF1YXJhbnRpbmUpOwogICAgICAgIHN5bmNQYXJlbnRzKCk7CiAgICAgIH0KICAgICAgY2hlY2twb2ludCgicHJ1bmUtcXVhcmFudGluZWQiKTsKICAgICAgLy8gQ2xvc2UgdGhlIGxhdW5jaC12ZXJzdXMtc2NhbiByYWNlOiBvcmlnaW5hbCBsYXVuY2ggcGF0aHMgYXJlIG5vdyBhYnNlbnQuCiAgICAgIC8vIEEgcHJvY2VzcyB0aGF0IGVudGVyZWQgYmVmb3JlIHJlbmFtZSBpcyB2aXNpYmxlIGJ5IGl0cyBvbGQgYXJndiwgb3BlbgogICAgICAvLyBkZXNjcmlwdG9ycywgZXhlY3V0YWJsZSBtYXBwaW5nIG9yIGN3ZC4gUmVzdG9yZSBpdHMgdHJlZSBpbnN0ZWFkLgogICAgICBsZXQgYWZ0ZXJSZW5hbWU7CiAgICAgIHRyeSB7IGFmdGVyUmVuYW1lID0gaW52ZW50b3J5KHJvb3QpOyB9CiAgICAgIGNhdGNoIChlcnJvcikgeyByZXN0b3JlKCk7IHRocm93IGVycm9yOyB9CiAgICAgIGlmIChidXN5KGFmdGVyUmVuYW1lKSkgewogICAgICAgIHJlc3RvcmUoKTsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInJ1bnRpbWUgYmVjYW1lIGJ1c3kgZHVyaW5nIHBydW5pbmciKTsKICAgICAgfQogICAgICBjb25zdCBieXRlcyA9IGV4aXN0c1N5bmMocXVhcmFudGluZSkgPyB0cmVlQnl0ZXMocXVhcmFudGluZSkgOiAwOwogICAgICBybVN5bmMocXVhcmFudGluZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOwogICAgICBjaGVja3BvaW50KCJwcnVuZS1yZW1vdmVkIik7CiAgICAgIHJtU3luYyhwcnVuZUpvdXJuYWwpOwogICAgICBzeW5jUGFyZW50cygpOwogICAgICByZXN1bHQucmVtb3ZlZC5wdXNoKHRyZWUpOwogICAgICByZXN1bHQuZnJlZWRCeXRlcyArPSBieXRlczsKICAgIH07CiAgICBpZiAoZXhpc3RzU3luYyhwcnVuZUpvdXJuYWwpKSB7CiAgICAgIGlmICghbHN0YXRTeW5jKHBydW5lSm91cm5hbCkuaXNGaWxlKCkgfHwgbHN0YXRTeW5jKHBydW5lSm91cm5hbCkuaXNTeW1ib2xpY0xpbmsoKSkgdGhyb3cgbmV3IEVycm9yKCJ1bnNhZmUgcHJ1bmUgam91cm5hbCIpOwogICAgICBjb25zdCBwZW5kaW5nID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocHJ1bmVKb3VybmFsLCAidXRmOCIpKTsKICAgICAgcmVtb3ZlVHJlZShwZW5kaW5nLnZlcnNpb24sIHBlbmRpbmcudHJlZU5hbWUsIHBlbmRpbmcucXVhcmFudGluZU5hbWUsIHRydWUpOwogICAgfQogICAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKHJvb3QpKSB7CiAgICAgIGlmICghdmVyc2lvblBhdHRlcm4udGVzdChuYW1lKSB8fCBuYW1lID09PSBoaXN0b3J5LmN1cnJlbnQgfHwgbmFtZSA9PT0gaGlzdG9yeS5wcmV2aW91cykgY29udGludWU7CiAgICAgIGNvbnN0IHBhdGggPSBqb2luKHJvb3QsIG5hbWUpOwogICAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKHBhdGgpOwogICAgICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkoKSB8fCBzdGF0LmlzU3ltYm9saWNMaW5rKCkgfHwgc3RhdC51aWQgIT09IHByb2Nlc3MuZ2V0dWlkKCkpIGNvbnRpbnVlOwogICAgICAvLyBQcmVzZXJ2ZSBpbnRlcnJ1cHRlZCBleHRyYWN0aW9uL2JhY2t1cCB0cmVlcyBhbmQgdGhlaXIgcGVyc2lzdGVudCBsb2NrCiAgICAgIC8vIGlkZW50aXRpZXMuIE5ldmVyIHJlbW92ZSB0aGUgdmVyc2lvbiBkaXJlY3Rvcnkgb3IgU1FMaXRlIGxvY2sgZmlsZXMuCiAgICAgIGNvbnN0IGNoaWxkcmVuID0gcmVhZGRpclN5bmMocGF0aCk7CiAgICAgIGlmIChjaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQuc3RhcnRzV2l0aCgiLiIpKSkgY29udGludWU7CiAgICAgIGlmICh1c2FnZS5pbmNsdWRlcyhwYXRoICsgIi8iKSB8fCB1c2FnZS5pbmNsdWRlcyhwYXRoICsgIlxuIikpIGNvbnRpbnVlOwogICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7CiAgICAgICAgaWYgKCEvXig/OmRhcndpbnxsaW51eHx3aW4pLSg/OmFybTY0fHg2NCktKD86bmF0aXZlfGdsaWJjKS1ub2RlLWFiaS1cZCstc2hhMjU2LVthLWYwLTldezY0fSQvLnRlc3QoY2hpbGQpKSBjb250aW51ZTsKICAgICAgICBjb25zdCB0cmVlID0gam9pbihwYXRoLCBjaGlsZCk7CiAgICAgICAgY29uc3QgdHJlZVN0YXQgPSBsc3RhdFN5bmModHJlZSk7CiAgICAgICAgaWYgKCF0cmVlU3RhdC5pc0RpcmVjdG9yeSgpIHx8IHRyZWVTdGF0LmlzU3ltYm9saWNMaW5rKCkpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IG1hcmtlciA9IGpvaW4odHJlZSwgIi5hZ2VuYy1ydW50aW1lLW9rIik7CiAgICAgICAgaWYgKCFleGlzdHNTeW5jKG1hcmtlcikgfHwgbHN0YXRTeW5jKG1hcmtlcikuaXNTeW1ib2xpY0xpbmsoKSB8fAogICAgICAgICAgICByZWFkRmlsZVN5bmMobWFya2VyLCAidXRmOCIpLnRyaW0oKSAhPT0gY2hpbGQuc2xpY2UoLTY0KSkgY29udGludWU7CiAgICAgICAgLy8gQSBkdXJhYmxlIHBlci10cmVlIGpvdXJuYWwgbWFrZXMgaW50ZXJydXB0ZWQgcmVjdXJzaXZlIHJlbW92YWwKICAgICAgICAvLyByZXRyeWFibGUgZXZlbiBpZiB0aGUgbWFya2VyIHdhcyByZW1vdmVkIGJlZm9yZSB0aGUgY3Jhc2guCiAgICAgICAgcmVtb3ZlVHJlZShuYW1lLCBjaGlsZCwgYC5wcnVuZS0ke3JhbmRvbVVVSUQoKX1gKTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIHJlc3VsdDsKICB9IGNhdGNoIChlcnJvcikgewogICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBza2lwcGVkOiBlcnJvci5tZXNzYWdlIH07CiAgfSBmaW5hbGx5IHsgcmVsZWFzZUFjdGl2YXRpb24/LigpOyByZWxlYXNlKCk7IH0KfQo=");
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
