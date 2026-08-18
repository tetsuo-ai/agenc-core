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
$SupportedNodeVersion = "26.5.0"
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
  [void][System.Reflection.Assembly]::Load("System.Net.Http")
  [int]$bootstrapTimeoutMs = 120000
  if ($env:AGENC_INSTALL_TEST_BOOTSTRAP_TIMEOUT_MS) {
    [int]$parsedBootstrapTimeout = 0
    if (-not [int]::TryParse(
        $env:AGENC_INSTALL_TEST_BOOTSTRAP_TIMEOUT_MS,
        [ref]$parsedBootstrapTimeout
      ) -or $parsedBootstrapTimeout -lt 1 -or $parsedBootstrapTimeout -gt 120000) {
      Fail "invalid Node.js bootstrap deadline"
    }
    $bootstrapTimeoutMs = $parsedBootstrapTimeout
  }
  $deadline = [System.Threading.CancellationTokenSource]::new()
  $deadline.CancelAfter($bootstrapTimeoutMs)
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
    $response.EnsureSuccessStatusCode()
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
      $total += $read
      if ($total -gt $ExactBytes) { Fail "Node.js bootstrap exceeds pinned byte count" }
      $outputStream.Write($buffer, 0, $read)
    }
    $outputStream.Flush($true)
    if ($total -ne $ExactBytes) {
      Fail "Node.js bootstrap byte count mismatch (expected $ExactBytes, got $total)"
    }
  } catch [System.OperationCanceledException] {
    Fail "Node.js bootstrap deadline exceeded after ${bootstrapTimeoutMs}ms"
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
        validateContentLength(response);
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
  $BoundedFetch | & node - $Url $Destination ([string]$MaximumBytes) $ExactBytes $TrustMode
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
  $ghDirectory = "gh_${ghVersion}_windows_amd64"
  $ghBinary = Join-Path $ghRoot "$ghDirectory/bin/gh.exe"
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
  [void][System.Reflection.Assembly]::Load("System.IO.Compression.FileSystem")
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
  & $Path -e @'
const [expectedPlatform, expectedArch, mode, allowOverride] = process.argv.slice(1);
const [major, minor] = process.versions.node.split(".").map(Number);
const legacy = mode === "legacy";
const versionOk = legacy ? major === 25 && minor >= 9 : major === 26 && minor >= 5;
const abiOk = legacy ? process.versions.modules === "141" : process.versions.modules === "147";
const platformOk = allowOverride === "true" || (
  process.platform === expectedPlatform && process.arch === expectedArch
);
if (!versionOk || !abiOk || process.versions.napi !== "10" || !platformOk) process.exit(1);
'@ $nodePlatform $arch $mode ([string][bool]($env:AGENC_INSTALL_PLATFORM -or $env:AGENC_INSTALL_ARCH)).ToLowerInvariant() `
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
  $nodeDistributionFile = "node-v26.5.0-win-x64.zip"
  $nodeDistributionSha256 = "d3b2277dbcccfdf24ef6302928f64f484cff1d77a6d3caa3a28f4d20ce9158f6"
  $nodeDistributionBytes = 41113391
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
    Set-Acl -LiteralPath $bootstrapWork -AclObject $privateAcl
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
  [void][System.Reflection.Assembly]::Load("System.IO.Compression.FileSystem")
  [System.IO.Compression.ZipFile]::ExtractToDirectory($nodeDistributionArchive, $bootstrapWork)
  $nodeBin = Join-Path $bootstrapWork "node-v26.5.0-win-x64\node.exe"
  if (-not (Test-Path -LiteralPath $nodeBin -PathType Leaf)) {
    Fail "pinned Node.js bootstrap executable is missing"
  }
  if (-not $actualWindows) {
    & /bin/chmod 700 $nodeBin
    if ($LASTEXITCODE -ne 0) { Fail "could not secure test-seam Node.js bootstrap" }
  }
  & $nodeBin -e @'
const allowOverride = process.argv[1] === "true";
if (process.versions.node !== "26.5.0" || process.versions.modules !== "147" ||
    process.versions.napi !== "10" || (!allowOverride && (
      process.platform !== "win32" || process.arch !== "x64"
    ))) process.exit(1);
'@ ([string][bool]($env:AGENC_INSTALL_PLATFORM -or $env:AGENC_INSTALL_ARCH)).ToLowerInvariant()
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
$nodeMajor = [int](node -e "process.stdout.write(process.versions.node.split('.')[0])")
$nodeModuleAbi = node -e "process.stdout.write(process.versions.modules)"
if ($nodeModuleAbi -notmatch "^[0-9]+$") { Fail "Node.js reported an invalid native module ABI: $nodeModuleAbi" }
$tarPath = if ($actualWindows) {
  $resolvedTar = & ([string]$node.Source) -e @'
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
'@
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
  & ([string]$node.Source) -e '
    const { lstatSync } = require("node:fs");
    const path = process.argv[1];
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) process.exit(1);
  ' $tarPath
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
  & $nodeBin -e @'
const version = process.argv[1];
const actual = version.split("-", 1)[0].split(".").map(BigInt);
const minimum = [0n, 11n, 2n];
for (let index = 0; index < minimum.length; index += 1) {
  if (actual[index] > minimum[index]) process.exit(0);
  if (actual[index] < minimum[index]) process.exit(1);
}
process.exit(0);
'@ $env:AGENC_INSTALL_VERSION
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
$agencHome = (& node -e $CanonicalHome $agencHome | Out-String).Trim()
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
  $identityJson = (& node -e $DirectoryIdentity $Path | Out-String).Trim()
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
    Set-Acl -LiteralPath $Path -AclObject $privateAcl
  } else {
    & node -e 'require("node:fs").chmodSync(process.argv[1], 0o700)' $Path
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
        [string](node -e "process.stdout.write(process.versions.napi)") -cne "10") {
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
      $artifactNodeApiVersion -ne [string](node -e "process.stdout.write(process.versions.napi)") -or
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
if (!["recover", "install", "activate", "render-wrapper", "prepare-wrapper-directories"].includes(mode)) {
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
const AGENC_SQLITE_LOCK_SOURCE_BASE64 = "Ly8gQ3Jvc3MtcHJvY2VzcyBsb2NhbCBmaWxlc3lzdGVtIGxvY2tzIGJhY2tlZCBieSBTUUxpdGUncyBPUyBsb2NraW5nIGxheWVyLgovLwovLyBCRUdJTiBJTU1FRElBVEUgb3ducyB0aGUgd3JpdGVyIHJlc2VydmF0aW9uIGZvciB0aGUgY2FsbGVyJ3MgY3JpdGljYWwKLy8gc2VjdGlvbi4gU1FMaXRlIHJlbGVhc2VzIGl0IG9uIGNsb3NlIG9yIHByb2Nlc3MgZGVhdGgsIGluY2x1ZGluZyBTSUdLSUxMLgovLyBBIHByb2Nlc3Mtd2lkZSBGSUZPIHJlZ2lzdHJ5IHByZXZlbnRzIGR1cGxpY2F0ZSBtb2R1bGUgaW5zdGFuY2VzIGZyb20KLy8gYmxvY2tpbmcgb25lIGFub3RoZXIgaW5zaWRlIHN5bmNocm9ub3VzIFNRTGl0ZSBjYWxsczsgY3Jvc3MtcHJvY2VzcyBidXN5Ci8vIGNvbnRlbnRpb24gaXMgcmV0cmllZCBhc3luY2hyb25vdXNseSBhZ2FpbnN0IG9uZSBtb25vdG9uaWMgZGVhZGxpbmUuCgppbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gIm5vZGU6Y2hpbGRfcHJvY2VzcyI7CmltcG9ydCB7CiAgY2xvc2VTeW5jLAogIGNvbnN0YW50cyBhcyBmc0NvbnN0YW50cywKICBmc3RhdFN5bmMsCiAgbHN0YXRTeW5jLAogIG9wZW5TeW5jLAogIHJlYWxwYXRoU3luYywKfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsKICBjaG1vZCwKICBsc3RhdCwKICBta2RpciwKICBvcGVuLAogIHJlYWRGaWxlLAogIHJlYWxwYXRoLAp9IGZyb20gIm5vZGU6ZnMvcHJvbWlzZXMiOwppbXBvcnQgewogIGJhc2VuYW1lLAogIGRpcm5hbWUsCiAgam9pbiwKICByZXNvbHZlLAogIHNlcCwKICB3aW4zMiwKfSBmcm9tICJub2RlOnBhdGgiOwppbXBvcnQgeyBzZXRUaW1lb3V0IGFzIGRlbGF5IH0gZnJvbSAibm9kZTp0aW1lcnMvcHJvbWlzZXMiOwoKY29uc3QgTE9DS19BUFBMSUNBVElPTl9JRCA9IDB4NDE0NzRlNDM7IC8vICJBR05DIgpjb25zdCBMT0NLX0ZPUk1BVF9WRVJTSU9OID0gMTsKY29uc3QgU1FMSVRFX0JVU1kgPSA1Owpjb25zdCBSRUdJU1RSWV9WRVJTSU9OID0gMTsKY29uc3QgUkVHSVNUUllfU1lNQk9MID0gU3ltYm9sLmZvcigiQHRldHN1by1haS9hZ2VuYy5zcWxpdGUtbG9jay1yZWdpc3RyeSIpOwpjb25zdCBNQVhfQlVTWV9SRVRSWV9NUyA9IDUwOwpjb25zdCBNQVhfVElNRVJfREVMQVlfTVMgPSAyXzE0N180ODNfNjQ3Owpjb25zdCBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0ID0gMHhmZmZmX2ZmZmZfZmZmZl9mZmZmbjsKY29uc3QgV0lORE9XU19QQVRIX1RSQU5TUE9SVF9NQVhfQ0hBUlMgPSAxNl8zODQ7CmNvbnN0IFdJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0VOVFJJRVMgPSAxMjg7CmNvbnN0IFdJTkRPV1NfU1lTVEVNX1JPT1QgPSBTdHJpbmcucmF3YFxcP1xHTE9CQUxST09UXFN5c3RlbVJvb3RgOwpjb25zdCBXSU5ET1dTX0VYRUNVVEFCTEVfRklMRVNZU1RFTSA9IHsKICBsc3RhdDogKHBhdGgpID0+IGxzdGF0U3luYyhwYXRoLCB7IGJpZ2ludDogdHJ1ZSB9KSwKICBvcGVuOiAocGF0aCkgPT4gb3BlblN5bmMoCiAgICBwYXRoLAogICAgZnNDb25zdGFudHMuT19SRE9OTFkgfCAoZnNDb25zdGFudHMuT19OT0ZPTExPVyA/PyAwKSwKICApLAogIGZzdGF0OiAoZGVzY3JpcHRvcikgPT4gZnN0YXRTeW5jKGRlc2NyaXB0b3IsIHsgYmlnaW50OiB0cnVlIH0pLAogIGNsb3NlOiBjbG9zZVN5bmMsCn07CmNvbnN0IExPQ0FMX0ZJTEVTWVNURU1fVFlQRVMgPSBuZXcgU2V0KFsKICAiYXBmcyIsICJiY2FjaGVmcyIsICJidHJmcyIsICJleGZhdCIsICJleHQyIiwgImV4dDMiLCAiZXh0NCIsICJmMmZzIiwKICAiaGZzIiwgImhmc3BsdXMiLCAiamZzIiwgIm1zZG9zIiwgIm5pbGZzMiIsICJudGZzIiwgIm50ZnMzIiwgIm92ZXJsYXkiLAogICJyYW1mcyIsICJyZWlzZXJmcyIsICJ0bXBmcyIsICJ1YmlmcyIsICJ1ZnMiLCAidmZhdCIsICJ4ZnMiLCAiemZzIiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfUkVBRF9SSUdIVFMgPSBuZXcgU2V0KFsKICAicmVhZCIsICJsaXN0IiwgInNlYXJjaCIsICJleGVjdXRlIiwgInJlYWRhdHRyIiwgInJlYWRleHRhdHRyIiwgInJlYWRzZWN1cml0eSIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX0lOSEVSSVRBTkNFX0ZMQUdTID0gbmV3IFNldChbCiAgImZpbGVfaW5oZXJpdCIsICJkaXJlY3RvcnlfaW5oZXJpdCIsICJsaW1pdF9pbmhlcml0IiwgIm9ubHlfaW5oZXJpdCIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX01VVEFUSU9OX1JJR0hUUyA9IG5ldyBTZXQoWwogICJ3cml0ZSIsICJhcHBlbmQiLCAiYWRkX2ZpbGUiLCAiYWRkX3N1YmRpcmVjdG9yeSIsICJkZWxldGUiLCAiZGVsZXRlX2NoaWxkIiwKICAid3JpdGVhdHRyIiwgIndyaXRlZXh0YXR0ciIsICJ3cml0ZXNlY3VyaXR5IiwgImNob3duIiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfS05PV05fVE9LRU5TID0gbmV3IFNldChbCiAgLi4uREFSV0lOX0FDTF9SRUFEX1JJR0hUUywKICAuLi5EQVJXSU5fQUNMX0lOSEVSSVRBTkNFX0ZMQUdTLAogIC4uLkRBUldJTl9BQ0xfTVVUQVRJT05fUklHSFRTLApdKTsKCmNvbnN0IFdJTkRPV1NfU0VDVVJJVFlfU0NSSVBUID0gU3RyaW5nLnJhd2AKJEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJwojIEtlZXAgdGhpcyBkaXJlY3QtLk5FVCBvbmx5OiBtb2R1bGUgYXV0b2xvYWQgY2FuIGV4aGF1c3QgdGhlIHNoYXJlZCBsb2NrIGRlYWRsaW5lLgokdHJhbnNwb3J0ID0gW3N0cmluZ10kZW52OkFHRU5DX0xPQ0tfUEFUSFMKaWYgKFtzdHJpbmddOjpJc051bGxPckVtcHR5KCR0cmFuc3BvcnQpIC1vciAkdHJhbnNwb3J0Lkxlbmd0aCAtZ3QgJHtXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSU30pIHsKICB0aHJvdyAnaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnCn0KJGVudHJpZXMgPSBbc3RyaW5nW11dJHRyYW5zcG9ydC5TcGxpdChbY2hhcl0xMCkKaWYgKCRlbnRyaWVzLkNvdW50IC1sdCAxIC1vciAkZW50cmllcy5Db3VudCAtZ3QgJHtXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9FTlRSSUVTfSkgewogIHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcKfQokY3VycmVudFNpZCA9IFtTeXN0ZW0uU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NJZGVudGl0eV06OkdldEN1cnJlbnQoKS5Vc2VyLlZhbHVlCiR0cnVzdGVkID0gQCgKICAkY3VycmVudFNpZCwKICAnUy0xLTUtMTgnLAogICdTLTEtNS0zMi01NDQnLAogICdTLTEtNS04MC05NTYwMDg4ODUtMzQxODUyMjY0OS0xODMxMDM4MDQ0LTE4NTMyOTI2MzEtMjI3MTQ3ODQ2NCcKKQojIFNwZWNpZmljIG11dGF0aW9uIHJpZ2h0cyBwbHVzIEdFTkVSSUNfV1JJVEUgYW5kIEdFTkVSSUNfQUxMLgokbGVhZk11dGF0aW9uTWFzayA9IFtpbnQ2NF0xMzQzMDI5NTkwCiRhbmNlc3Rvck11dGF0aW9uTWFzayA9IFtpbnQ2NF0xMzQzMDI5NTg2CmZvcmVhY2ggKCRlbnRyeSBpbiAkZW50cmllcykgewogICRzZXBhcmF0b3IgPSAkZW50cnkuSW5kZXhPZihbY2hhcl01OCkKICBpZiAoJHNlcGFyYXRvciAtbHQgMSAtb3IgJHNlcGFyYXRvciAtZXEgKCRlbnRyeS5MZW5ndGggLSAxKSkgewogICAgdGhyb3cgJ2ludmFsaWQgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0JwogIH0KICAkcm9sZSA9ICRlbnRyeS5TdWJzdHJpbmcoMCwgJHNlcGFyYXRvcikKICBpZiAoQCgnbGVhZkRpcmVjdG9yeScsICdhbmNlc3RvckRpcmVjdG9yeScsICdmaWxlJykgLW5vdGNvbnRhaW5zICRyb2xlKSB7CiAgICB0aHJvdyAiaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCByb2xlOiAkcm9sZSIKICB9CiAgJGVuY29kZWRQYXRoID0gJGVudHJ5LlN1YnN0cmluZygkc2VwYXJhdG9yICsgMSkKICBpZiAoKCRlbmNvZGVkUGF0aC5MZW5ndGggJSA0KSAtbmUgMCkgeyB0aHJvdyAnaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnIH0KICAkcGF0aEJ5dGVzID0gW1N5c3RlbS5Db252ZXJ0XTo6RnJvbUJhc2U2NFN0cmluZygkZW5jb2RlZFBhdGgpCiAgaWYgKCgkcGF0aEJ5dGVzLkxlbmd0aCAlIDIpIC1uZSAwKSB7IHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcgfQogIGlmIChbU3lzdGVtLkNvbnZlcnRdOjpUb0Jhc2U2NFN0cmluZygkcGF0aEJ5dGVzKSAtY25lICRlbmNvZGVkUGF0aCkgewogICAgdGhyb3cgJ25vbi1jYW5vbmljYWwgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0JwogIH0KICAkcGF0aENoYXJhY3RlcnMgPSBbY2hhcltdXTo6bmV3KFtpbnRdKCRwYXRoQnl0ZXMuTGVuZ3RoIC8gMikpCiAgZm9yICgkaW5kZXggPSAwOyAkaW5kZXggLWx0ICRwYXRoQ2hhcmFjdGVycy5MZW5ndGg7ICRpbmRleCArPSAxKSB7CiAgICAkYnl0ZU9mZnNldCA9ICRpbmRleCAqIDIKICAgICRsb3dCeXRlID0gW2ludF0kcGF0aEJ5dGVzWyRieXRlT2Zmc2V0XQogICAgJGhpZ2hCeXRlID0gW2ludF0kcGF0aEJ5dGVzWyRieXRlT2Zmc2V0ICsgMV0KICAgICRwYXRoQ2hhcmFjdGVyc1skaW5kZXhdID0gW2NoYXJdKCRsb3dCeXRlIC1ib3IgKCRoaWdoQnl0ZSAtc2hsIDgpKQogIH0KICAkcmVxdWVzdGVkID0gW3N0cmluZ106Om5ldygkcGF0aENoYXJhY3RlcnMpCiAgJG11dGF0aW9uTWFzayA9IGlmICgkcm9sZSAtZXEgJ2FuY2VzdG9yRGlyZWN0b3J5JykgewogICAgJGFuY2VzdG9yTXV0YXRpb25NYXNrCiAgfSBlbHNlIHsKICAgICRsZWFmTXV0YXRpb25NYXNrCiAgfQogICRmdWxsID0gW1N5c3RlbS5JTy5QYXRoXTo6R2V0RnVsbFBhdGgoJHJlcXVlc3RlZCkKICBpZiAoJGZ1bGwuU3RhcnRzV2l0aCgnXFwnKSAtb3IgJGZ1bGwuU3RhcnRzV2l0aCgnXFw/XCcpIC1vciAkZnVsbC5TdGFydHNXaXRoKCdcXC5cJykpIHsKICAgIHRocm93ICJuZXR3b3JrIGFuZCBkZXZpY2UgcGF0aHMgYXJlIHVuc3VwcG9ydGVkOiAkZnVsbCIKICB9CiAgJGF0dHJpYnV0ZXMgPSBbU3lzdGVtLklPLkZpbGVdOjpHZXRBdHRyaWJ1dGVzKCRmdWxsKQogIGlmICgoJGF0dHJpYnV0ZXMgLWJhbmQgW1N5c3RlbS5JTy5GaWxlQXR0cmlidXRlc106OlJlcGFyc2VQb2ludCkgLW5lIDApIHsKICAgIHRocm93ICJyZXBhcnNlIHBvaW50cyBhcmUgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICAkaXNEaXJlY3RvcnkgPSAoJGF0dHJpYnV0ZXMgLWJhbmQgW1N5c3RlbS5JTy5GaWxlQXR0cmlidXRlc106OkRpcmVjdG9yeSkgLW5lIDAKICBpZiAoJGlzRGlyZWN0b3J5IC1uZSAoJHJvbGUgLW5lICdmaWxlJykpIHsKICAgIHRocm93ICJwcm90ZWN0ZWQtcGF0aCByb2xlIGRvZXMgbm90IG1hdGNoIGl0cyB0eXBlOiAkZnVsbCIKICB9CiAgJGRyaXZlID0gW1N5c3RlbS5JTy5Ecml2ZUluZm9dOjpuZXcoW1N5c3RlbS5JTy5QYXRoXTo6R2V0UGF0aFJvb3QoJGZ1bGwpKQogIGlmIChAKDIsIDMsIDYpIC1ub3Rjb250YWlucyBbaW50XSRkcml2ZS5Ecml2ZVR5cGUpIHsKICAgIHRocm93ICJub24tbG9jYWwgZHJpdmUgaXMgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICBpZiAoJGRyaXZlLkRyaXZlRm9ybWF0IC1uZSAnTlRGUycpIHsKICAgIHRocm93ICJmaWxlc3lzdGVtIGNhbm5vdCBlbmZvcmNlIHRoZSByZXF1aXJlZCBBQ0wgY29udHJhY3Q6ICRmdWxsIgogIH0KICAkYWNsU2VjdGlvbnMgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFNlY3Rpb25zXTo6T3duZXIgLWJvciBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFNlY3Rpb25zXTo6QWNjZXNzCiAgaWYgKCRpc0RpcmVjdG9yeSkgewogICAgJGFjbCA9IFtTeXN0ZW0uSU8uRGlyZWN0b3J5XTo6R2V0QWNjZXNzQ29udHJvbCgkZnVsbCwgJGFjbFNlY3Rpb25zKQogIH0gZWxzZSB7CiAgICAkYWNsID0gW1N5c3RlbS5JTy5GaWxlXTo6R2V0QWNjZXNzQ29udHJvbCgkZnVsbCwgJGFjbFNlY3Rpb25zKQogIH0KICBpZiAoLW5vdCAkYWNsLkFyZUFjY2Vzc1J1bGVzQ2Fub25pY2FsKSB7CiAgICB0aHJvdyAibm9uLWNhbm9uaWNhbCBBQ0wgaXMgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICAkYnl0ZXMgPSAkYWNsLkdldFNlY3VyaXR5RGVzY3JpcHRvckJpbmFyeUZvcm0oKQogICRyYXcgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuUmF3U2VjdXJpdHlEZXNjcmlwdG9yXTo6bmV3KCRieXRlcywgMCkKICBpZiAoJG51bGwgLWVxICRyYXcuRGlzY3JldGlvbmFyeUFjbCkgewogICAgdGhyb3cgIm51bGwgREFDTCBpcyB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRvd25lciA9ICRhY2wuR2V0T3duZXIoW1N5c3RlbS5TZWN1cml0eS5QcmluY2lwYWwuU2VjdXJpdHlJZGVudGlmaWVyXSkuVmFsdWUKICBpZiAoJHRydXN0ZWQgLW5vdGNvbnRhaW5zICRvd25lcikgewogICAgdGhyb3cgInVudHJ1c3RlZCBvd25lciBTSUQgb24gbG9jayBwYXRoOiAkZnVsbCIKICB9CiAgJHJ1bGVzID0gJGFjbC5HZXRBY2Nlc3NSdWxlcygKICAgICR0cnVlLAogICAgJHRydWUsCiAgICBbU3lzdGVtLlNlY3VyaXR5LlByaW5jaXBhbC5TZWN1cml0eUlkZW50aWZpZXJdCiAgKQogIGZvcmVhY2ggKCRydWxlIGluICRydWxlcykgewogICAgaWYgKCRydWxlLkFjY2Vzc0NvbnRyb2xUeXBlIC1uZSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFR5cGVdOjpBbGxvdykgewogICAgICBjb250aW51ZQogICAgfQogICAgJGluaGVyaXRPbmx5ID0gKCRydWxlLlByb3BhZ2F0aW9uRmxhZ3MgLWJhbmQgW1N5c3RlbS5TZWN1cml0eS5BY2Nlc3NDb250cm9sLlByb3BhZ2F0aW9uRmxhZ3NdOjpJbmhlcml0T25seSkgLW5lIDAKICAgIGlmICgkaW5oZXJpdE9ubHkpIHsKICAgICAgJGNoaWxkSW5oZXJpdGFuY2UgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106Ok9iamVjdEluaGVyaXQgLWJvciBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106OkNvbnRhaW5lckluaGVyaXQKICAgICAgJHJlYWNoZXNOZXdDaGlsZCA9ICgkcnVsZS5Jbmhlcml0YW5jZUZsYWdzIC1iYW5kICRjaGlsZEluaGVyaXRhbmNlKSAtbmUgMAogICAgICBpZiAoJHJvbGUgLW5lICdsZWFmRGlyZWN0b3J5JyAtb3IgLW5vdCAkcmVhY2hlc05ld0NoaWxkKSB7CiAgICAgICAgY29udGludWUKICAgICAgfQogICAgfQogICAgJHNpZCA9ICRydWxlLklkZW50aXR5UmVmZXJlbmNlLlZhbHVlCiAgICAkcmlnaHRzID0gKFtpbnQ2NF0kcnVsZS5GaWxlU3lzdGVtUmlnaHRzKSAtYmFuZCBbaW50NjRdNDI5NDk2NzI5NQogICAgaWYgKCR0cnVzdGVkIC1ub3Rjb250YWlucyAkc2lkIC1hbmQgKCgkcmlnaHRzIC1iYW5kICRtdXRhdGlvbk1hc2spIC1uZSAwKSkgewogICAgICB0aHJvdyAidW50cnVzdGVkIG11dGF0aW9uIEFDRSBvbiBsb2NrIHBhdGg6ICRmdWxsIgogICAgfQogIH0KfQpbQ29uc29sZV06Ok91dC5Xcml0ZSgnT0snKQpgOwpjb25zdCBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVF9CQVNFNjQgPSBCdWZmZXIuZnJvbSgKICBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVCwKICAidXRmMTZsZSIsCikudG9TdHJpbmcoImJhc2U2NCIpOwoKZXhwb3J0IGNsYXNzIExvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciBleHRlbmRzIEVycm9yIHsKICBjb25zdHJ1Y3Rvcih7IHBhdGgsIGxhYmVsLCB0aW1lb3V0TXMsIGNhdXNlIH0pIHsKICAgIHN1cGVyKAogICAgICBgYWdlbmM6ICR7bGFiZWx9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNc31tcyB3YWl0aW5nIGZvciBsb2NhbCBwcm9jZXNzIGxvY2sgJHtwYXRofWAsCiAgICAgIGNhdXNlID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB7IGNhdXNlIH0sCiAgICApOwogICAgdGhpcy5uYW1lID0gIkxvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciI7CiAgICB0aGlzLmNvZGUgPSAiQUdFTkNfTE9DS19USU1FT1VUIjsKICAgIHRoaXMucGF0aCA9IHBhdGg7CiAgICB0aGlzLmxhYmVsID0gbGFiZWw7CiAgICB0aGlzLnRpbWVvdXRNcyA9IHRpbWVvdXRNczsKICB9Cn0KCmZ1bmN0aW9uIHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIHJldHVybiBuZXcgTG9jYWxTcWxpdGVMb2NrVGltZW91dEVycm9yKHsKICAgIHBhdGgsCiAgICBsYWJlbDogY29udGV4dC5sYWJlbCwKICAgIHRpbWVvdXRNczogY29udGV4dC50aW1lb3V0TXMsCiAgICBjYXVzZSwKICB9KTsKfQoKZnVuY3Rpb24gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpIHsKICByZXR1cm4gTWF0aC5mbG9vcihjb250ZXh0LmRlYWRsaW5lIC0gcGVyZm9ybWFuY2Uubm93KCkpOwp9CgpmdW5jdGlvbiB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIGlmIChyZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCkgPD0gMCkgewogICAgdGhyb3cgdGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgsIGNhdXNlKTsKICB9Cn0KCmZ1bmN0aW9uIHByb2Nlc3NMb2NrUmVnaXN0cnkoKSB7CiAgY29uc3QgY3VycmVudCA9IHByb2Nlc3NbUkVHSVNUUllfU1lNQk9MXTsKICBpZiAoY3VycmVudCAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAoCiAgICAgIGN1cnJlbnQgPT09IG51bGwgfHwKICAgICAgdHlwZW9mIGN1cnJlbnQgIT09ICJvYmplY3QiIHx8CiAgICAgIGN1cnJlbnQudmVyc2lvbiAhPT0gUkVHSVNUUllfVkVSU0lPTiB8fAogICAgICAhKGN1cnJlbnQubG9ja3MgaW5zdGFuY2VvZiBNYXApCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKAogICAgICAgICJhZ2VuYzogaW5jb21wYXRpYmxlIHByb2Nlc3Mtd2lkZSBTUUxpdGUgbG9jayByZWdpc3RyeSBpcyBhbHJlYWR5IGluc3RhbGxlZCIsCiAgICAgICk7CiAgICB9CiAgICByZXR1cm4gY3VycmVudDsKICB9CiAgY29uc3QgY3JlYXRlZCA9IHsgdmVyc2lvbjogUkVHSVNUUllfVkVSU0lPTiwgbG9ja3M6IG5ldyBNYXAoKSB9OwogIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShwcm9jZXNzLCBSRUdJU1RSWV9TWU1CT0wsIHsKICAgIHZhbHVlOiBjcmVhdGVkLAogICAgY29uZmlndXJhYmxlOiBmYWxzZSwKICAgIGVudW1lcmFibGU6IGZhbHNlLAogICAgd3JpdGFibGU6IGZhbHNlLAogIH0pOwogIHJldHVybiBjcmVhdGVkOwp9CgpmdW5jdGlvbiBhY3F1aXJlSW5Qcm9jZXNzTG9jayhwcmVwYXJlZCwgY29udGV4dCkgewogIGNvbnN0IHJlZ2lzdHJ5ID0gcHJvY2Vzc0xvY2tSZWdpc3RyeSgpOwogIGNvbnN0IGtleSA9IHByZXBhcmVkLmlkZW50aXR5S2V5OwogIGxldCBzdGF0ZSA9IHJlZ2lzdHJ5LmxvY2tzLmdldChrZXkpOwogIGlmIChzdGF0ZSA9PT0gdW5kZWZpbmVkKSB7CiAgICBzdGF0ZSA9IHsgbG9ja2VkOiBmYWxzZSwgd2FpdGVyczogW10gfTsKICAgIHJlZ2lzdHJ5LmxvY2tzLnNldChrZXksIHN0YXRlKTsKICB9CgogIGNvbnN0IG1ha2VSZWxlYXNlID0gKCkgPT4gewogICAgbGV0IHJlbGVhc2VkID0gZmFsc2U7CiAgICByZXR1cm4gKCkgPT4gewogICAgICBpZiAocmVsZWFzZWQpIHJldHVybjsKICAgICAgcmVsZWFzZWQgPSB0cnVlOwogICAgICBjb25zdCBuZXh0ID0gc3RhdGUud2FpdGVycy5zaGlmdCgpOwogICAgICBpZiAobmV4dCA9PT0gdW5kZWZpbmVkKSB7CiAgICAgICAgc3RhdGUubG9ja2VkID0gZmFsc2U7CiAgICAgICAgcmVnaXN0cnkubG9ja3MuZGVsZXRlKGtleSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY2xlYXJUaW1lb3V0KG5leHQudGltZXIpOwogICAgICAgIG5leHQucmVzb2x2ZShtYWtlUmVsZWFzZSgpKTsKICAgICAgfQogICAgfTsKICB9OwoKICBpZiAoIXN0YXRlLmxvY2tlZCkgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCk7CiAgICBzdGF0ZS5sb2NrZWQgPSB0cnVlOwogICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShtYWtlUmVsZWFzZSgpKTsKICB9CgogIGNvbnN0IHJlbWFpbmluZyA9IHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KTsKICBpZiAocmVtYWluaW5nIDw9IDApIHsKICAgIHJldHVybiBQcm9taXNlLnJlamVjdCh0aW1lb3V0RXJyb3IoY29udGV4dCwgcHJlcGFyZWQucGF0aCkpOwogIH0KICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmVXYWl0LCByZWplY3RXYWl0KSA9PiB7CiAgICBjb25zdCB3YWl0ZXIgPSB7CiAgICAgIHJlc29sdmU6IHJlc29sdmVXYWl0LAogICAgICB0aW1lcjogdW5kZWZpbmVkLAogICAgfTsKICAgIGNvbnN0IGFybVRpbWVvdXQgPSAoKSA9PiB7CiAgICAgIGNvbnN0IGRlbGF5TXMgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgICAgIGlmIChkZWxheU1zIDw9IDApIHsKICAgICAgICBjb25zdCBpbmRleCA9IHN0YXRlLndhaXRlcnMuaW5kZXhPZih3YWl0ZXIpOwogICAgICAgIGlmIChpbmRleCAhPT0gLTEpIHN0YXRlLndhaXRlcnMuc3BsaWNlKGluZGV4LCAxKTsKICAgICAgICByZWplY3RXYWl0KHRpbWVvdXRFcnJvcihjb250ZXh0LCBwcmVwYXJlZC5wYXRoKSk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIHdhaXRlci50aW1lciA9IHNldFRpbWVvdXQoYXJtVGltZW91dCwgTWF0aC5taW4oZGVsYXlNcywgTUFYX1RJTUVSX0RFTEFZX01TKSk7CiAgICB9OwogICAgc3RhdGUud2FpdGVycy5wdXNoKHdhaXRlcik7CiAgICBhcm1UaW1lb3V0KCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGRlY29kZU1vdW50UGF0aCh2YWx1ZSkgewogIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXChbMC03XXszfSkvZywgKF9tYXRjaCwgb2N0YWwpID0+CiAgICBTdHJpbmcuZnJvbUNoYXJDb2RlKE51bWJlci5wYXJzZUludChvY3RhbCwgOCkpKTsKfQoKZnVuY3Rpb24gcGF0aElzV2l0aGluKHBhdGgsIG1vdW50UG9pbnQpIHsKICByZXR1cm4gcGF0aCA9PT0gbW91bnRQb2ludCB8fAogICAgcGF0aC5zdGFydHNXaXRoKG1vdW50UG9pbnQgPT09IHNlcCA/IG1vdW50UG9pbnQgOiBgJHttb3VudFBvaW50fSR7c2VwfWApOwp9CgpmdW5jdGlvbiBleGVjRmlsZVV0ZjgoZmlsZSwgYXJncywgb3B0aW9ucywgY29udGV4dCwgcGF0aCkgewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZVJ1biwgcmVqZWN0UnVuKSA9PiB7CiAgICBsZXQgZGVhZGxpbmVUaW1lcjsKICAgIGxldCBleHBpcmVkID0gZmFsc2U7CiAgICBjb25zdCBjaGlsZCA9IGV4ZWNGaWxlKAogICAgICBmaWxlLAogICAgICBhcmdzLAogICAgICB7IC4uLm9wdGlvbnMsIGVuY29kaW5nOiAidXRmOCIgfSwKICAgICAgKGVycm9yLCBzdGRvdXQsIHN0ZGVycikgPT4gewogICAgICAgIGlmIChkZWFkbGluZVRpbWVyICE9PSB1bmRlZmluZWQpIGNsZWFyVGltZW91dChkZWFkbGluZVRpbWVyKTsKICAgICAgICBpZiAoZXhwaXJlZCkgewogICAgICAgICAgcmVqZWN0UnVuKHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBlcnJvciA/PyB1bmRlZmluZWQpKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgaWYgKGVycm9yICE9PSBudWxsKSB7CiAgICAgICAgICBPYmplY3QuYXNzaWduKGVycm9yLCB7IHN0ZG91dCwgc3RkZXJyIH0pOwogICAgICAgICAgcmVqZWN0UnVuKGVycm9yKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgcmVzb2x2ZVJ1bih7IHN0ZG91dCwgc3RkZXJyIH0pOwogICAgICB9LAogICAgKTsKICAgIGNvbnN0IGFybURlYWRsaW5lID0gKCkgPT4gewogICAgICBjb25zdCByZW1haW5pbmcgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgICAgIGlmIChyZW1haW5pbmcgPD0gMCkgewogICAgICAgIGV4cGlyZWQgPSB0cnVlOwogICAgICAgIGNoaWxkLmtpbGwoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZGVhZGxpbmVUaW1lciA9IHNldFRpbWVvdXQoCiAgICAgICAgYXJtRGVhZGxpbmUsCiAgICAgICAgTWF0aC5taW4ocmVtYWluaW5nLCBNQVhfVElNRVJfREVMQVlfTVMpLAogICAgICApOwogICAgfTsKICAgIGFybURlYWRsaW5lKCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBjb250ZXh0LCBwYXRoKSB7CiAgaWYgKAogICAgcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpIDw9IDAgfHwKICAgIGVycm9yPy5jb2RlID09PSAiRVRJTUVET1VUIiB8fAogICAgZXJyb3I/LmtpbGxlZCA9PT0gdHJ1ZQogICkgewogICAgcmV0dXJuIHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBlcnJvcik7CiAgfQogIHJldHVybiBlcnJvcjsKfQoKZnVuY3Rpb24gdmFsaWRhdGVEYXJ3aW5BY2xMaXN0aW5nKHN0ZG91dCwgcGF0aCwgcm9sZSkgewogIGlmIChzdGRvdXQuaW5jbHVkZXMoIlxyIikpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIG5vbi1jYW5vbmljYWwgb3V0cHV0IGZvciAke3BhdGh9YCk7CiAgfQogIGNvbnN0IGxpbmVzID0gc3Rkb3V0LnNwbGl0KCJcbiIpOwogIGlmIChsaW5lcy5hdCgtMSkgPT09ICIiKSBsaW5lcy5wb3AoKTsKICBpZiAobGluZXMubGVuZ3RoID09PSAwIHx8IGxpbmVzWzBdLmxlbmd0aCA9PT0gMCkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgbm8gbWV0YWRhdGEgZm9yICR7cGF0aH1gKTsKICB9CiAgbGV0IHByZXZpb3VzT3JkaW5hbCA9IC0xOwogIGxldCBzYXdMZWdhY3lPd25lciA9IGZhbHNlOwogIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcy5zbGljZSgxKSkgewogICAgaWYgKC9eXHMqb3duZXI6XHMrXFMuKiQvdS50ZXN0KGxpbmUpICYmICFzYXdMZWdhY3lPd25lciAmJiBwcmV2aW91c09yZGluYWwgPT09IC0xKSB7CiAgICAgIHNhd0xlZ2FjeU93bmVyID0gdHJ1ZTsKICAgICAgY29udGludWU7CiAgICB9CiAgICBjb25zdCBtYXRjaCA9IGxpbmUubWF0Y2goCiAgICAgIC9eXHMqKFxkKyk6XHMrKC4rPylccysoPzooaW5oZXJpdGVkKVxzKyk/KGFsbG93fGRlbnkpXHMrKFthLXpfXSsoPzosW2Etel9dKykqKVxzKiQvdSwKICAgICk7CiAgICBpZiAobWF0Y2ggPT09IG51bGwpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgdW5yZWNvZ25pemVkIG91dHB1dCBmb3IgJHtwYXRofWApOwogICAgfQogICAgY29uc3Qgb3JkaW5hbCA9IE51bWJlcihtYXRjaFsxXSk7CiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKG9yZGluYWwpIHx8IG9yZGluYWwgPD0gcHJldmlvdXNPcmRpbmFsKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIGludmFsaWQgQUNFIG9yZGVyaW5nIGZvciAke3BhdGh9YCk7CiAgICB9CiAgICBwcmV2aW91c09yZGluYWwgPSBvcmRpbmFsOwogICAgY29uc3QgYXNzb2NpYXRpb24gPSBtYXRjaFs0XTsKICAgIGNvbnN0IHRva2VucyA9IG1hdGNoWzVdLnNwbGl0KCIsIik7CiAgICBmb3IgKGNvbnN0IHRva2VuIG9mIHRva2VucykgewogICAgICBpZiAoIURBUldJTl9BQ0xfS05PV05fVE9LRU5TLmhhcyh0b2tlbikpIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCB1bmtub3duIHJpZ2h0ICR7dG9rZW59OiAke3BhdGh9YCk7CiAgICAgIH0KICAgIH0KICAgIGlmICgKICAgICAgYXNzb2NpYXRpb24gPT09ICJhbGxvdyIgJiYKICAgICAgdG9rZW5zLnNvbWUoKHRva2VuKSA9PiBEQVJXSU5fQUNMX01VVEFUSU9OX1JJR0hUUy5oYXModG9rZW4pKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigKICAgICAgICBgYWdlbmM6IHByb3RlY3RlZCAke3JvbGV9IGhhcyBhIG11dGF0aW9uLWNhcGFibGUgRGFyd2luIEFDTDogJHtwYXRofWAsCiAgICAgICk7CiAgICB9CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkocGF0aCwgcm9sZSwgY29udGV4dCkgewogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIGxldCByZXN1bHQ7CiAgdHJ5IHsKICAgIHJlc3VsdCA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgKICAgICAgIi9iaW4vbHMiLAogICAgICBbIi1sZGVxIiwgcGF0aF0sCiAgICAgIHsKICAgICAgICBlbnY6IHsgTENfQUxMOiAiQyIgfSwKICAgICAgICBtYXhCdWZmZXI6IDI1NiAqIDEwMjQsCiAgICAgIH0sCiAgICAgIGNvbnRleHQsCiAgICAgIHBhdGgsCiAgICApOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgcGF0aCk7CiAgfQogIGlmIChyZXN1bHQuc3RkZXJyICE9PSAiIikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgdW5leHBlY3RlZCBkaWFnbm9zdGljcyBmb3IgJHtwYXRofWApOwogIH0KICB2YWxpZGF0ZURhcndpbkFjbExpc3RpbmcocmVzdWx0LnN0ZG91dCwgcGF0aCwgcm9sZSk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7Cn0KCmZ1bmN0aW9uIHRydXN0ZWRXaW5kb3dzUG93ZXJTaGVsbFBhdGgoCiAgY2Fub25pY2FsaXplID0gcmVhbHBhdGhTeW5jLm5hdGl2ZSwKICBmaWxlc3lzdGVtID0gV0lORE9XU19FWEVDVVRBQkxFX0ZJTEVTWVNURU0sCikgewogIC8vIERlcml2ZSBhIENyZWF0ZVByb2Nlc3MtY29tcGF0aWJsZSBET1Mgc3BlbGxpbmcgZnJvbSBHTE9CQUxST09ULCB0aGVuIHByb3ZlCiAgLy8gYm90aCBzcGVsbGluZ3Mgc3RpbGwgbmFtZSB0aGUgc2FtZSByZWd1bGFyIHN5c3RlbSBmaWxlIGJlZm9yZSBsYXVuY2guCiAgY29uc3Qgc3lzdGVtUm9vdCA9IGNhbm9uaWNhbGl6ZShXSU5ET1dTX1NZU1RFTV9ST09UKTsKICBpZiAoIS9eW2Etel06XFwvaXUudGVzdChzeXN0ZW1Sb290KSB8fCB3aW4zMi5ub3JtYWxpemUoc3lzdGVtUm9vdCkgIT09IHN5c3RlbVJvb3QpIHsKICAgIHRocm93IG5ldyBFcnJvcigidHJ1c3RlZCBXaW5kb3dzIFN5c3RlbVJvb3QgZGlkIG5vdCByZXNvbHZlIHRvIGEgY2Fub25pY2FsIGxvY2FsIERPUyBwYXRoIik7CiAgfQogIGNvbnN0IHdvcmtpbmdEaXJlY3RvcnkgPSB3aW4zMi5qb2luKHN5c3RlbVJvb3QsICJTeXN0ZW0zMiIpOwogIGNvbnN0IGV4ZWN1dGFibGUgPSB3aW4zMi5qb2luKAogICAgd29ya2luZ0RpcmVjdG9yeSwKICAgICJXaW5kb3dzUG93ZXJTaGVsbCIsCiAgICAidjEuMCIsCiAgICAicG93ZXJzaGVsbC5leGUiLAogICk7CiAgY29uc3QgbmFtZXNwYWNlRXhlY3V0YWJsZSA9IHdpbjMyLmpvaW4oCiAgICBXSU5ET1dTX1NZU1RFTV9ST09ULAogICAgIlN5c3RlbTMyIiwKICAgICJXaW5kb3dzUG93ZXJTaGVsbCIsCiAgICAidjEuMCIsCiAgICAicG93ZXJzaGVsbC5leGUiLAogICk7CiAgdmVyaWZ5V2luZG93c0V4ZWN1dGFibGVBbGlhc2VzKG5hbWVzcGFjZUV4ZWN1dGFibGUsIGV4ZWN1dGFibGUsIGZpbGVzeXN0ZW0pOwogIHJldHVybiB7CiAgICBzeXN0ZW1Sb290LAogICAgd29ya2luZ0RpcmVjdG9yeSwKICAgIGV4ZWN1dGFibGUsCiAgfTsKfQoKZnVuY3Rpb24gdmVyaWZ5V2luZG93c0V4ZWN1dGFibGVBbGlhc2VzKG5hbWVzcGFjZUV4ZWN1dGFibGUsIGV4ZWN1dGFibGUsIGZpbGVzeXN0ZW0pIHsKICBsZXQgbmFtZXNwYWNlRGVzY3JpcHRvcjsKICBsZXQgY2FuZGlkYXRlRGVzY3JpcHRvcjsKICBsZXQgb3BlcmF0aW9uRXJyb3I7CiAgdHJ5IHsKICAgIGNvbnN0IG5hbWVzcGFjZUJlZm9yZSA9IGZpbGVzeXN0ZW0ubHN0YXQobmFtZXNwYWNlRXhlY3V0YWJsZSk7CiAgICBjb25zdCBjYW5kaWRhdGVCZWZvcmUgPSBmaWxlc3lzdGVtLmxzdGF0KGV4ZWN1dGFibGUpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKG5hbWVzcGFjZUJlZm9yZSwgIkdMT0JBTFJPT1QgcGF0aCIpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGNhbmRpZGF0ZUJlZm9yZSwgIkRPUyBwYXRoIik7CiAgICBuYW1lc3BhY2VEZXNjcmlwdG9yID0gZmlsZXN5c3RlbS5vcGVuKG5hbWVzcGFjZUV4ZWN1dGFibGUpOwogICAgY2FuZGlkYXRlRGVzY3JpcHRvciA9IGZpbGVzeXN0ZW0ub3BlbihleGVjdXRhYmxlKTsKICAgIGNvbnN0IG5hbWVzcGFjZU9wZW5lZCA9IGZpbGVzeXN0ZW0uZnN0YXQobmFtZXNwYWNlRGVzY3JpcHRvcik7CiAgICBjb25zdCBjYW5kaWRhdGVPcGVuZWQgPSBmaWxlc3lzdGVtLmZzdGF0KGNhbmRpZGF0ZURlc2NyaXB0b3IpOwogICAgY29uc3QgbmFtZXNwYWNlQWZ0ZXIgPSBmaWxlc3lzdGVtLmxzdGF0KG5hbWVzcGFjZUV4ZWN1dGFibGUpOwogICAgY29uc3QgY2FuZGlkYXRlQWZ0ZXIgPSBmaWxlc3lzdGVtLmxzdGF0KGV4ZWN1dGFibGUpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKG5hbWVzcGFjZU9wZW5lZCwgIkdMT0JBTFJPT1QgZGVzY3JpcHRvciIpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGNhbmRpZGF0ZU9wZW5lZCwgIkRPUyBkZXNjcmlwdG9yIik7CiAgICBhc3NlcnRSZWd1bGFyV2luZG93c0V4ZWN1dGFibGUobmFtZXNwYWNlQWZ0ZXIsICJHTE9CQUxST09UIHBhdGgiKTsKICAgIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShjYW5kaWRhdGVBZnRlciwgIkRPUyBwYXRoIik7CiAgICBmb3IgKGNvbnN0IGlkZW50aXR5IG9mIFsKICAgICAgbmFtZXNwYWNlQmVmb3JlLAogICAgICBjYW5kaWRhdGVCZWZvcmUsCiAgICAgIG5hbWVzcGFjZU9wZW5lZCwKICAgICAgY2FuZGlkYXRlT3BlbmVkLAogICAgICBuYW1lc3BhY2VBZnRlciwKICAgICAgY2FuZGlkYXRlQWZ0ZXIsCiAgICBdKSB7CiAgICAgIGlmICgKICAgICAgICBpZGVudGl0eS5kZXYgPD0gMG4gfHwgaWRlbnRpdHkuaW5vIDw9IDBuIHx8CiAgICAgICAgaWRlbnRpdHkuZGV2ID09PSBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0IHx8IGlkZW50aXR5LmlubyA9PT0gVU5TVVBQT1JURURfRklMRV9JRF82NAogICAgICApIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInRydXN0ZWQgV2luZG93cyBzeXN0ZW0gZXhlY3V0YWJsZSBpZGVudGl0eSBpcyB1bmF2YWlsYWJsZSIpOwogICAgICB9CiAgICB9CiAgICBpZiAoCiAgICAgICFzYW1lRmlsZUlkZW50aXR5KG5hbWVzcGFjZUJlZm9yZSwgbmFtZXNwYWNlT3BlbmVkKSB8fAogICAgICAhc2FtZUZpbGVJZGVudGl0eShuYW1lc3BhY2VPcGVuZWQsIG5hbWVzcGFjZUFmdGVyKSB8fAogICAgICAhc2FtZUZpbGVJZGVudGl0eShjYW5kaWRhdGVCZWZvcmUsIGNhbmRpZGF0ZU9wZW5lZCkgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkoY2FuZGlkYXRlT3BlbmVkLCBjYW5kaWRhdGVBZnRlcikgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkobmFtZXNwYWNlT3BlbmVkLCBjYW5kaWRhdGVPcGVuZWQpCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJ0cnVzdGVkIFdpbmRvd3Mgc3lzdGVtIGV4ZWN1dGFibGUgaWRlbnRpdHkgbWlzbWF0Y2giKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgb3BlcmF0aW9uRXJyb3IgPSBlcnJvcjsKICB9CiAgY29uc3QgY2xvc2VFcnJvcnMgPSBbXTsKICBmb3IgKGNvbnN0IGRlc2NyaXB0b3Igb2YgW2NhbmRpZGF0ZURlc2NyaXB0b3IsIG5hbWVzcGFjZURlc2NyaXB0b3JdKSB7CiAgICBpZiAoZGVzY3JpcHRvciA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTsKICAgIHRyeSB7IGZpbGVzeXN0ZW0uY2xvc2UoZGVzY3JpcHRvcik7IH0gY2F0Y2ggKGVycm9yKSB7IGNsb3NlRXJyb3JzLnB1c2goZXJyb3IpOyB9CiAgfQogIGlmIChvcGVyYXRpb25FcnJvciAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAoY2xvc2VFcnJvcnMubGVuZ3RoID4gMCkgewogICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgICAgW29wZXJhdGlvbkVycm9yLCAuLi5jbG9zZUVycm9yc10sCiAgICAgICAgInRydXN0ZWQgV2luZG93cyBleGVjdXRhYmxlIHZhbGlkYXRpb24gYW5kIGNsZWFudXAgYm90aCBmYWlsZWQiLAogICAgICApOwogICAgfQogICAgdGhyb3cgb3BlcmF0aW9uRXJyb3I7CiAgfQogIGlmIChjbG9zZUVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGNsb3NlRXJyb3JzWzBdOwogIGlmIChjbG9zZUVycm9ycy5sZW5ndGggPiAxKSB7CiAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgIGNsb3NlRXJyb3JzLAogICAgICAidHJ1c3RlZCBXaW5kb3dzIGV4ZWN1dGFibGUgZGVzY3JpcHRvciBjbGVhbnVwIGZhaWxlZCIsCiAgICApOwogIH0KfQoKZnVuY3Rpb24gYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGlkZW50aXR5LCBzcGVsbGluZykgewogIGlmICghaWRlbnRpdHkuaXNGaWxlKCkgfHwgaWRlbnRpdHkuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGB0cnVzdGVkIFdpbmRvd3MgJHtzcGVsbGluZ30gZXhlY3V0YWJsZSBpcyBub3QgYSByZWd1bGFyIG5vbi1saW5rIGZpbGVgKTsKICB9Cn0KCmZ1bmN0aW9uIHNhbWVGaWxlSWRlbnRpdHkobGVmdCwgcmlnaHQpIHsKICByZXR1cm4gbGVmdC5kZXYgPT09IHJpZ2h0LmRldiAmJiBsZWZ0LmlubyA9PT0gcmlnaHQuaW5vOwp9CgpmdW5jdGlvbiB3aW5kb3dzUG93ZXJTaGVsbEVudmlyb25tZW50KHBhdGhzLCB0cnVzdGVkUGF0aHMgPSB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKCkpIHsKICBjb25zdCB7IHN5c3RlbVJvb3QsIHdvcmtpbmdEaXJlY3RvcnkgfSA9IHRydXN0ZWRQYXRoczsKICAvLyBsaWJ1diBmaWxscyBhIGZpeGVkIHNldCBvZiAicmVxdWlyZWQiIFdpbmRvd3MgdmFyaWFibGVzIGZyb20gdGhlIHBhcmVudAogIC8vIHdoZW4gdGhleSBhcmUgYWJzZW50LiBEZWZpbmUgZXZlcnkgb25lIHNvIHBvaXNvbmVkIGNhbGxlciBzdGF0ZSBjYW5ub3QgYmUKICAvLyBzaWxlbnRseSBpbmhlcml0ZWQgaW50byB0aGUgdmFsaWRhdGlvbiBoZWxwZXIuCiAgcmV0dXJuIHsKICAgIEFHRU5DX0xPQ0tfUEFUSFM6IHdpbmRvd3NQYXRoVHJhbnNwb3J0KHBhdGhzKSwKICAgIEFQUERBVEE6ICIiLAogICAgQ09NU1BFQzogIiIsCiAgICBIT01FRFJJVkU6ICIiLAogICAgSE9NRVBBVEg6ICIiLAogICAgTE9DQUxBUFBEQVRBOiAiIiwKICAgIExPR09OU0VSVkVSOiAiIiwKICAgIFBBVEg6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBQQVRIRVhUOiAiLkVYRSIsCiAgICBQU01PRFVMRVBBVEg6ICIiLAogICAgU1lTVEVNRFJJVkU6ICIiLAogICAgU1lTVEVNUk9PVDogc3lzdGVtUm9vdCwKICAgIFRFTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBUTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBVU0VSRE9NQUlOOiAiIiwKICAgIFVTRVJOQU1FOiAiIiwKICAgIFVTRVJQUk9GSUxFOiB3b3JraW5nRGlyZWN0b3J5LAogICAgV0lORElSOiBzeXN0ZW1Sb290LAogIH07Cn0KCmZ1bmN0aW9uIHdpbmRvd3NQYXRoVHJhbnNwb3J0KGVudHJpZXMpIHsKICBpZiAoCiAgICAhQXJyYXkuaXNBcnJheShlbnRyaWVzKSB8fAogICAgZW50cmllcy5sZW5ndGggPCAxIHx8CiAgICBlbnRyaWVzLmxlbmd0aCA+IFdJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0VOVFJJRVMKICApIHsKICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFdpbmRvd3MgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0IGhhcyBhbiBpbnZhbGlkIGVudHJ5IGNvdW50Iik7CiAgfQogIGNvbnN0IHJlY29yZHMgPSBbXTsKICBsZXQgdHJhbnNwb3J0Q2hhcnMgPSAwOwogIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykgewogICAgY29uc3QgcGF0aCA9IGVudHJ5Py5wYXRoOwogICAgY29uc3Qgcm9sZSA9IGVudHJ5Py5yb2xlOwogICAgaWYgKAogICAgICB0eXBlb2YgcGF0aCAhPT0gInN0cmluZyIgfHwKICAgICAgcGF0aC5sZW5ndGggPT09IDAgfHwKICAgICAgcGF0aC5sZW5ndGggPiBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSUyB8fAogICAgICAocm9sZSAhPT0gImxlYWZEaXJlY3RvcnkiICYmIHJvbGUgIT09ICJhbmNlc3RvckRpcmVjdG9yeSIgJiYgcm9sZSAhPT0gImZpbGUiKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFdpbmRvd3MgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0IGVudHJ5IGlzIGludmFsaWQiKTsKICAgIH0KICAgIGNvbnN0IHJlY29yZCA9IGAke3JvbGV9OiR7QnVmZmVyLmZyb20ocGF0aCwgInV0ZjE2bGUiKS50b1N0cmluZygiYmFzZTY0Iil9YDsKICAgIHRyYW5zcG9ydENoYXJzICs9IHJlY29yZC5sZW5ndGggKyAocmVjb3Jkcy5sZW5ndGggPT09IDAgPyAwIDogMSk7CiAgICBpZiAodHJhbnNwb3J0Q2hhcnMgPiBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSUykgewogICAgICB0aHJvdyBuZXcgRXJyb3IoImFnZW5jOiBXaW5kb3dzIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCBleGNlZWRzIGl0cyBsaW1pdCIpOwogICAgfQogICAgcmVjb3Jkcy5wdXNoKHJlY29yZCk7CiAgfQogIHJldHVybiByZWNvcmRzLmpvaW4oIlxuIik7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoZW50cmllcywgY29udGV4dCkgewogIGNvbnN0IGRpc3BsYXlQYXRoID0gZW50cmllcy5hdCgtMSk/LnBhdGggPz8gInVua25vd24iOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGRpc3BsYXlQYXRoKTsKICBjb25zdCB0cnVzdGVkUGF0aHMgPSB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKCk7CiAgY29uc3QgeyB3b3JraW5nRGlyZWN0b3J5LCBleGVjdXRhYmxlIH0gPSB0cnVzdGVkUGF0aHM7CiAgbGV0IHJlc3VsdDsKICB0cnkgewogICAgcmVzdWx0ID0gYXdhaXQgZXhlY0ZpbGVVdGY4KAogICAgICBleGVjdXRhYmxlLAogICAgICBbCiAgICAgICAgIi1Ob0xvZ28iLAogICAgICAgICItTm9Qcm9maWxlIiwKICAgICAgICAiLU5vbkludGVyYWN0aXZlIiwKICAgICAgICAiLUVuY29kZWRDb21tYW5kIiwKICAgICAgICBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVF9CQVNFNjQsCiAgICAgIF0sCiAgICAgIHsKICAgICAgICBjd2Q6IHdvcmtpbmdEaXJlY3RvcnksCiAgICAgICAgZW52OiB3aW5kb3dzUG93ZXJTaGVsbEVudmlyb25tZW50KGVudHJpZXMsIHRydXN0ZWRQYXRocyksCiAgICAgICAgbWF4QnVmZmVyOiAxMDI0ICogMTAyNCwKICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSwKICAgICAgfSwKICAgICAgY29udGV4dCwKICAgICAgZGlzcGxheVBhdGgsCiAgICApOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgZGlzcGxheVBhdGgpOwogIH0KICBpZiAocmVzdWx0LnN0ZG91dCAhPT0gIk9LIikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogV2luZG93cyBsb2NrLXBhdGggdmFsaWRhdGlvbiByZXR1cm5lZCBhbiBpbnZhbGlkIHJlc3BvbnNlIGZvciAke2Rpc3BsYXlQYXRofWApOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBkaXNwbGF5UGF0aCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydExvY2FsRmlsZXN5c3RlbShwYXJlbnQsIGNvbnRleHQpIHsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXJlbnQpOwogIGxldCBmaWxlc3lzdGVtVHlwZTsKICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImxpbnV4IikgewogICAgY29uc3QgbW91bnRzID0gYXdhaXQgcmVhZEZpbGUoIi9wcm9jL3NlbGYvbW91bnRpbmZvIiwgInV0ZjgiKTsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhcmVudCk7CiAgICBsZXQgbG9uZ2VzdCA9IC0xOwogICAgZm9yIChjb25zdCBsaW5lIG9mIG1vdW50cy5zcGxpdCgiXG4iKSkgewogICAgICBjb25zdCBmaWVsZHMgPSBsaW5lLnNwbGl0KCIgIik7CiAgICAgIGNvbnN0IHNlcGFyYXRvckluZGV4ID0gZmllbGRzLmluZGV4T2YoIi0iKTsKICAgICAgaWYgKAogICAgICAgIHNlcGFyYXRvckluZGV4IDwgNiB8fAogICAgICAgIGZpZWxkc1s0XSA9PT0gdW5kZWZpbmVkIHx8CiAgICAgICAgZmllbGRzW3NlcGFyYXRvckluZGV4ICsgMV0gPT09IHVuZGVmaW5lZAogICAgICApIGNvbnRpbnVlOwogICAgICBjb25zdCBtb3VudFBvaW50ID0gZGVjb2RlTW91bnRQYXRoKGZpZWxkc1s0XSk7CiAgICAgIGlmIChwYXRoSXNXaXRoaW4ocGFyZW50LCBtb3VudFBvaW50KSAmJiBtb3VudFBvaW50Lmxlbmd0aCA+IGxvbmdlc3QpIHsKICAgICAgICBsb25nZXN0ID0gbW91bnRQb2ludC5sZW5ndGg7CiAgICAgICAgZmlsZXN5c3RlbVR5cGUgPSBmaWVsZHNbc2VwYXJhdG9ySW5kZXggKyAxXTsKICAgICAgfQogICAgfQogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGxldCBzdGRvdXQ7CiAgICB0cnkgewogICAgICAoeyBzdGRvdXQgfSA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgiL3NiaW4vbW91bnQiLCBbXSwgewogICAgICAgIGVudjogeyBMQ19BTEw6ICJDIiB9LAogICAgICAgIG1heEJ1ZmZlcjogNCAqIDEwMjQgKiAxMDI0LAogICAgICB9LCBjb250ZXh0LCBwYXJlbnQpKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHRocm93IG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBjb250ZXh0LCBwYXJlbnQpOwogICAgfQogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGFyZW50KTsKICAgIGxldCBsb25nZXN0ID0gLTE7CiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3Rkb3V0LnNwbGl0KCJcbiIpKSB7CiAgICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgvIG9uICguKykgXCgoW14sXSspLyk7CiAgICAgIGlmIChtYXRjaCA9PT0gbnVsbCkgY29udGludWU7CiAgICAgIGNvbnN0IG1vdW50UG9pbnQgPSBkZWNvZGVNb3VudFBhdGgobWF0Y2hbMV0pOwogICAgICBpZiAocGF0aElzV2l0aGluKHBhcmVudCwgbW91bnRQb2ludCkgJiYgbW91bnRQb2ludC5sZW5ndGggPiBsb25nZXN0KSB7CiAgICAgICAgbG9uZ2VzdCA9IG1vdW50UG9pbnQubGVuZ3RoOwogICAgICAgIGZpbGVzeXN0ZW1UeXBlID0gbWF0Y2hbMl07CiAgICAgIH0KICAgIH0KICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoW3sgcGF0aDogcGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfV0sIGNvbnRleHQpOwogICAgcmV0dXJuOwogIH0gZWxzZSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogY2Fubm90IGVzdGFibGlzaCBsb2NrIGZpbGVzeXN0ZW0gbG9jYWxpdHkgb24gJHtwcm9jZXNzLnBsYXRmb3JtfWAsCiAgICApOwogIH0KICBpZiAoZmlsZXN5c3RlbVR5cGUgPT09IHVuZGVmaW5lZCB8fCAhTE9DQUxfRklMRVNZU1RFTV9UWVBFUy5oYXMoZmlsZXN5c3RlbVR5cGUpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogbm9uLWxvY2FsIG9yIHVua25vd24gbG9jayBmaWxlc3lzdGVtIGlzIHVuc3VwcG9ydGVkICgke2ZpbGVzeXN0ZW1UeXBlID8/ICJ1bmtub3duIn0pOiAke3BhcmVudH1gLAogICAgKTsKICB9Cn0KCi8qKgogKiBFc3RhYmxpc2ggdGhhdCBhbiBleGlzdGluZyBkaXJlY3RvcnkgaXMgYSBsb2NhbCwgcHJpdmF0ZWx5IG11dGFibGUKICogY29vcmRpbmF0aW9uIGJvdW5kYXJ5LiBXcmFwcGVyIHJlcGxhY2VtZW50IHVzZXMgYSByZWdpc3RyeS1ob3N0ZWQgU1FMaXRlCiAqIGxvY2ssIHNvIGEgc2hhcmVkIG9yIGF0dGFja2VyLXdyaXRhYmxlIHdyYXBwZXIgZGlyZWN0b3J5IHdvdWxkIG90aGVyd2lzZQogKiBwZXJtaXQgY3Jvc3MtaG9zdCByYWNlcyBvciBwYXRoIHN1YnN0aXR1dGlvbiBvdXRzaWRlIHRoYXQgbG9jay4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhc3NlcnRMb2NhbFByaXZhdGVEaXJlY3RvcnkoCiAgcmVxdWVzdGVkUGF0aCwKICB7CiAgICB0aW1lb3V0TXMgPSA2MF8wMDAsCiAgICBsYWJlbCA9ICJBZ2VuQyBvcGVyYXRpb24iLAogICAgZGVhZGxpbmU6IHN1cHBsaWVkRGVhZGxpbmUsCiAgICBhbGxvd1RydXN0ZWRTdGlja3lMZWFmID0gZmFsc2UsCiAgfSA9IHt9LAopIHsKICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRpbWVvdXRNcykgfHwgdGltZW91dE1zIDw9IDApIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgdGltZW91dE1zIG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXIiKTsKICB9CiAgaWYgKHN1cHBsaWVkRGVhZGxpbmUgIT09IHVuZGVmaW5lZCAmJiAhTnVtYmVyLmlzRmluaXRlKHN1cHBsaWVkRGVhZGxpbmUpKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIGRlYWRsaW5lIG11c3QgYmUgZmluaXRlIik7CiAgfQogIGlmICh0eXBlb2YgYWxsb3dUcnVzdGVkU3RpY2t5TGVhZiAhPT0gImJvb2xlYW4iKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJhbGxvd1RydXN0ZWRTdGlja3lMZWFmIG11c3QgYmUgYm9vbGVhbiIpOwogIH0KICBjb25zdCBjb250ZXh0ID0gewogICAgZGVhZGxpbmU6IE1hdGgubWluKAogICAgICBzdXBwbGllZERlYWRsaW5lID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwKICAgICAgcGVyZm9ybWFuY2Uubm93KCkgKyB0aW1lb3V0TXMsCiAgICApLAogICAgbGFiZWwsCiAgICB0aW1lb3V0TXMsCiAgfTsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUocmVxdWVzdGVkUGF0aCk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKGFic29sdXRlKTsKICBjb25zdCBhbmNlc3RvcnMgPSBbXTsKICBmb3IgKGxldCBjdXJyZW50ID0gY2Fub25pY2FsOyA7IGN1cnJlbnQgPSBkaXJuYW1lKGN1cnJlbnQpKSB7CiAgICBhbmNlc3RvcnMucHVzaChjdXJyZW50KTsKICAgIGlmIChkaXJuYW1lKGN1cnJlbnQpID09PSBjdXJyZW50KSBicmVhazsKICB9CiAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICBjb25zdCBiZWZvcmVJZGVudGl0aWVzID0gbmV3IE1hcCgpOwogIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBhbmNlc3RvcnMubGVuZ3RoOyBpbmRleCArPSAxKSB7CiAgICBjb25zdCBwYXRoID0gYW5jZXN0b3JzW2luZGV4XTsKICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBpZiAoIXN0YXRzLmlzRGlyZWN0b3J5KCkgfHwgc3RhdHMuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgcGF0aCBhbmNlc3RvciBpcyBub3QgYSByZWFsIGRpcmVjdG9yeTogJHtwYXRofWApOwogICAgfQogICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICJ3aW4zMiIpIHsKICAgICAgY29uc3QgbGVhZiA9IGluZGV4ID09PSAwOwogICAgICBjb25zdCB0cnVzdGVkT3duZXIgPSBzdGF0cy51aWQgPT09IDBuIHx8CiAgICAgICAgKGN1cnJlbnRVaWQgIT09IHVuZGVmaW5lZCAmJiBzdGF0cy51aWQgPT09IEJpZ0ludChjdXJyZW50VWlkKSk7CiAgICAgIGNvbnN0IHN0aWNreUJvdW5kYXJ5ID0gKCFsZWFmIHx8IGFsbG93VHJ1c3RlZFN0aWNreUxlYWYpICYmCiAgICAgICAgKHN0YXRzLm1vZGUgJiAwbzEwMDBuKSAhPT0gMG4gJiYgdHJ1c3RlZE93bmVyOwogICAgICBpZiAoIXRydXN0ZWRPd25lciB8fCAoKHN0YXRzLm1vZGUgJiAwbzAyMm4pICE9PSAwbiAmJiAhc3RpY2t5Qm91bmRhcnkpKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKAogICAgICAgICAgYGFnZW5jOiBwcm90ZWN0ZWQgZGlyZWN0b3J5IGNoYWluIHBlcm1pdHMgdW50cnVzdGVkIG11dGF0aW9uOiAke3BhdGh9OyBgICsKICAgICAgICAgICJyZW1vdmUgZ3JvdXAvd29ybGQgd3JpdGUgYWNjZXNzIGJlZm9yZSByZXRyeWluZyIsCiAgICAgICAgKTsKICAgICAgfQogICAgICBpZiAoCiAgICAgICAgbGVhZiAmJiAhc3RpY2t5Qm91bmRhcnkgJiYgY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmCiAgICAgICAgc3RhdHMudWlkICE9PSBCaWdJbnQoY3VycmVudFVpZCkKICAgICAgKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGRpcmVjdG9yeSBpcyBub3Qgb3duZWQgYnkgdGhlIGN1cnJlbnQgdXNlcjogJHtwYXRofWApOwogICAgICB9CiAgICB9CiAgICBiZWZvcmVJZGVudGl0aWVzLnNldChwYXRoLCB7IGRldjogc3RhdHMuZGV2LCBpbm86IHN0YXRzLmlubyB9KTsKICAgIGlkZW50aXR5RnJvbVN0YXRzKHN0YXRzLCBwYXRoKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoCiAgICAgIGFuY2VzdG9ycy5tYXAoKHBhdGgsIGluZGV4KSA9PiAoewogICAgICAgIHBhdGgsCiAgICAgICAgcm9sZTogaW5kZXggPT09IDAgPyAibGVhZkRpcmVjdG9yeSIgOiAiYW5jZXN0b3JEaXJlY3RvcnkiLAogICAgICB9KSksCiAgICAgIGNvbnRleHQsCiAgICApOwogIH0gZWxzZSB7CiAgICBhd2FpdCBhc3NlcnRMb2NhbEZpbGVzeXN0ZW0oY2Fub25pY2FsLCBjb250ZXh0KTsKICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgYW5jZXN0b3JzLmxlbmd0aDsgaW5kZXggKz0gMSkgewogICAgICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eSgKICAgICAgICAgIGFuY2VzdG9yc1tpbmRleF0sCiAgICAgICAgICBpbmRleCA9PT0gMCA/ICJsZWFmIGRpcmVjdG9yeSIgOiAiYW5jZXN0b3IgZGlyZWN0b3J5IiwKICAgICAgICAgIGNvbnRleHQsCiAgICAgICAgKTsKICAgICAgfQogICAgfQogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGZvciAoY29uc3QgcGF0aCBvZiBhbmNlc3RvcnMpIHsKICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBjb25zdCBiZWZvcmUgPSBiZWZvcmVJZGVudGl0aWVzLmdldChwYXRoKTsKICAgIGlmICgKICAgICAgIWFmdGVyLmlzRGlyZWN0b3J5KCkgfHwgYWZ0ZXIuaXNTeW1ib2xpY0xpbmsoKSB8fCBiZWZvcmUgPT09IHVuZGVmaW5lZCB8fAogICAgICBhZnRlci5kZXYgIT09IGJlZm9yZS5kZXYgfHwgYWZ0ZXIuaW5vICE9PSBiZWZvcmUuaW5vCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGRpcmVjdG9yeSBpZGVudGl0eSBjaGFuZ2VkIGR1cmluZyB2YWxpZGF0aW9uOiAke3BhdGh9YCk7CiAgICB9CiAgfQogIHJldHVybiBjYW5vbmljYWw7Cn0KCmZ1bmN0aW9uIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHN0YXRzLCBwYXRoKSB7CiAgaWYgKCFzdGF0cy5pc0ZpbGUoKSB8fCBzdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGlzIG5vdCBhIHJlZ3VsYXIgZmlsZTogJHtwYXRofWApOwogIH0KICBpZiAoc3RhdHMubmxpbmsgIT09IDFuKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIG11c3Qgbm90IGhhdmUgaGFyZC1saW5rIGFsaWFzZXM6ICR7cGF0aH1gKTsKICB9Cn0KCmZ1bmN0aW9uIGlkZW50aXR5RnJvbVN0YXRzKHN0YXRzLCBwYXRoKSB7CiAgaWYgKAogICAgc3RhdHMuZGV2ID09PSAwbiB8fAogICAgc3RhdHMuaW5vID09PSAwbiB8fAogICAgc3RhdHMuaW5vID09PSAtMW4gfHwKICAgIEJpZ0ludC5hc1VpbnROKDY0LCBzdGF0cy5pbm8pID09PSBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0CiAgKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGhhcyBubyBzdGFibGUgZmlsZXN5c3RlbSBpZGVudGl0eTogJHtwYXRofWApOwogIH0KICByZXR1cm4gYCR7c3RhdHMuZGV2fToke3N0YXRzLmlub31gOwp9CgpmdW5jdGlvbiBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgcGF0aCwga2luZCkgewogIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAid2luMzIiKSByZXR1cm47CiAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICBpZiAoY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmIHN0YXRzLnVpZCAhPT0gQmlnSW50KGN1cnJlbnRVaWQpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlICR7a2luZH0gaXMgbm90IG93bmVkIGJ5IHRoZSBjdXJyZW50IHVzZXI6ICR7cGF0aH1gKTsKICB9CiAgaWYgKChzdGF0cy5tb2RlICYgMG8wMjJuKSAhPT0gMG4pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgJHtraW5kfSBpcyBncm91cC93b3JsZC13cml0YWJsZTogJHtwYXRofWApOwogIH0KfQoKLyoqCiAqIFZhbGlkYXRlIGEgcmVndWxhciBmaWxlIGFuZCBpdHMgY29tcGxldGUgZGlyZWN0b3J5IGNoYWluIGJlZm9yZSBhIGNhbGxlcgogKiB0cnVzdHMgaXRzIGNvbnRlbnRzLiBUaGlzIGlzIGludGVudGlvbmFsbHkgbm9uLW11dGF0aW5nOiB1bnNhZmUgb3duZXJzaGlwLAogKiBtb2RlIGJpdHMsIEFDTHMsIGFsaWFzZXMsIG9yIGlkZW50aXR5IGNoYW5nZXMgZmFpbCBjbG9zZWQuCiAqLwpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYXNzZXJ0TG9jYWxQcml2YXRlRmlsZSgKICByZXF1ZXN0ZWRQYXRoLAogIHsKICAgIHRpbWVvdXRNcyA9IDYwXzAwMCwKICAgIGxhYmVsID0gIkFnZW5DIG9wZXJhdGlvbiIsCiAgICBkZWFkbGluZTogc3VwcGxpZWREZWFkbGluZSwKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgY29uc3QgY29udGV4dCA9IHsKICAgIGRlYWRsaW5lOiBNYXRoLm1pbigKICAgICAgc3VwcGxpZWREZWFkbGluZSA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksCiAgICAgIHBlcmZvcm1hbmNlLm5vdygpICsgdGltZW91dE1zLAogICAgKSwKICAgIGxhYmVsLAogICAgdGltZW91dE1zLAogIH07CiAgY29uc3QgYWJzb2x1dGUgPSByZXNvbHZlKHJlcXVlc3RlZFBhdGgpOwogIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoYWJzb2x1dGUpOwogIGNvbnN0IGNhbm9uaWNhbFBhcmVudCA9IGF3YWl0IGFzc2VydExvY2FsUHJpdmF0ZURpcmVjdG9yeShwYXJlbnQsIHsKICAgIHRpbWVvdXRNcywKICAgIGxhYmVsLAogICAgZGVhZGxpbmU6IGNvbnRleHQuZGVhZGxpbmUsCiAgfSk7CiAgaWYgKGNhbm9uaWNhbFBhcmVudCAhPT0gcGFyZW50KSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZmlsZSBwYXJlbnQgbXVzdCB1c2UgaXRzIGNhbm9uaWNhbCBwYXRoOiAke3BhcmVudH1gKTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IGJlZm9yZSA9IGF3YWl0IGxzdGF0KGFic29sdXRlLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoIWJlZm9yZS5pc0ZpbGUoKSB8fCBiZWZvcmUuaXNTeW1ib2xpY0xpbmsoKSB8fCBiZWZvcmUubmxpbmsgIT09IDFuKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZmlsZSBtdXN0IGJlIGEgcmVndWxhciBzaW5nbGUtbGluayBmaWxlOiAke2Fic29sdXRlfWApOwogIH0KICBpZGVudGl0eUZyb21TdGF0cyhiZWZvcmUsIGFic29sdXRlKTsKICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gIndpbjMyIikgewogICAgY29uc3QgY3VycmVudFVpZCA9IHByb2Nlc3MuZ2V0dWlkPy4oKTsKICAgIGlmIChjdXJyZW50VWlkICE9PSB1bmRlZmluZWQgJiYgYmVmb3JlLnVpZCAhPT0gQmlnSW50KGN1cnJlbnRVaWQpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlzIG5vdCBvd25lZCBieSB0aGUgY3VycmVudCB1c2VyOiAke2Fic29sdXRlfWApOwogICAgfQogICAgaWYgKChiZWZvcmUubW9kZSAmIDBvMDIybikgIT09IDBuKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlzIGdyb3VwL3dvcmxkLXdyaXRhYmxlOiAke2Fic29sdXRlfWApOwogICAgfQogIH0KICBjb25zdCBjYW5vbmljYWwgPSBhd2FpdCByZWFscGF0aChhYnNvbHV0ZSk7CiAgaWYgKGNhbm9uaWNhbCAhPT0gYWJzb2x1dGUpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIG11c3QgdXNlIGl0cyBjYW5vbmljYWwgcGF0aDogJHthYnNvbHV0ZX1gKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoW3sgcGF0aDogY2Fub25pY2FsLCByb2xlOiAiZmlsZSIgfV0sIGNvbnRleHQpOwogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eShjYW5vbmljYWwsICJmaWxlIiwgY29udGV4dCk7CiAgfQogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGNhbm9uaWNhbCk7CiAgY29uc3QgYWZ0ZXIgPSBhd2FpdCBsc3RhdChjYW5vbmljYWwsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICgKICAgICFhZnRlci5pc0ZpbGUoKSB8fCBhZnRlci5pc1N5bWJvbGljTGluaygpIHx8IGFmdGVyLm5saW5rICE9PSAxbiB8fAogICAgYWZ0ZXIuZGV2ICE9PSBiZWZvcmUuZGV2IHx8IGFmdGVyLmlubyAhPT0gYmVmb3JlLmlubwogICkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgaWRlbnRpdHkgY2hhbmdlZCBkdXJpbmcgdmFsaWRhdGlvbjogJHtjYW5vbmljYWx9YCk7CiAgfQogIHJldHVybiBjYW5vbmljYWw7Cn0KCmFzeW5jIGZ1bmN0aW9uIHByZXBhcmVMb2NrUGF0aChyZXF1ZXN0ZWRQYXRoLCBjb250ZXh0KSB7CiAgY29uc3QgYWJzb2x1dGUgPSByZXNvbHZlKHJlcXVlc3RlZFBhdGgpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGFic29sdXRlKTsKICBhd2FpdCBta2RpcihkaXJuYW1lKGFic29sdXRlKSwgeyByZWN1cnNpdmU6IHRydWUsIG1vZGU6IDBvNzAwIH0pOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGFic29sdXRlKTsKICBjb25zdCBwYXJlbnQgPSBhd2FpdCByZWFscGF0aChkaXJuYW1lKGFic29sdXRlKSk7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIGNvbnN0IHZhbGlkYXRlZFBhcmVudCA9IGF3YWl0IGFzc2VydExvY2FsUHJpdmF0ZURpcmVjdG9yeShwYXJlbnQsIHsKICAgIHRpbWVvdXRNczogY29udGV4dC50aW1lb3V0TXMsCiAgICBsYWJlbDogY29udGV4dC5sYWJlbCwKICAgIGRlYWRsaW5lOiBjb250ZXh0LmRlYWRsaW5lLAogIH0pOwogIGlmICh2YWxpZGF0ZWRQYXJlbnQgIT09IHBhcmVudCkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBwYXJlbnQgbXVzdCB1c2UgaXRzIGNhbm9uaWNhbCBwYXRoOiAke3BhcmVudH1gKTsKICB9CiAgY29uc3QgcGFyZW50U3RhdHMgPSBhd2FpdCBsc3RhdChwYXJlbnQsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICghcGFyZW50U3RhdHMuaXNEaXJlY3RvcnkoKSB8fCBwYXJlbnRTdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIHBhcmVudCBpcyBub3QgYSByZWFsIGRpcmVjdG9yeTogJHtwYXJlbnR9YCk7CiAgfQogIGFzc2VydFBvc2l4T3duZXJzaGlwKHBhcmVudFN0YXRzLCBwYXJlbnQsICJwYXJlbnQiKTsKCiAgY29uc3QgcGF0aCA9IGpvaW4ocGFyZW50LCBiYXNlbmFtZShhYnNvbHV0ZSkpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIHRyeSB7CiAgICBjb25zdCBoYW5kbGUgPSBhd2FpdCBvcGVuKHBhdGgsICJ3eCIsIDBvNjAwKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGhhbmRsZS5jbG9zZSgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgYXdhaXQgaGFuZGxlLmNsb3NlKCkuY2F0Y2goKCkgPT4ge30pOwogICAgICB0aHJvdyBlcnJvcjsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgaWYgKGVycm9yPy5jb2RlICE9PSAiRUVYSVNUIikgdGhyb3cgZXJyb3I7CiAgfQogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgpOwogIGNvbnN0IHBhdGhTdGF0cyA9IGF3YWl0IGxzdGF0KHBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHBhdGhTdGF0cywgcGF0aCk7CiAgYXNzZXJ0UG9zaXhPd25lcnNoaXAocGF0aFN0YXRzLCBwYXRoLCAiZmlsZSIpOwogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKHBhdGgpOwogIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQoY2Fub25pY2FsLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBhc3NlcnRSZWd1bGFyU2luZ2xlTGluayhzdGF0cywgY2Fub25pY2FsKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgY2Fub25pY2FsLCAiZmlsZSIpOwogIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAid2luMzIiKSB7CiAgICBhd2FpdCBjaG1vZChjYW5vbmljYWwsIDBvNjAwKTsKICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgICBhd2FpdCBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkoY2Fub25pY2FsLCAibG9jayBkYXRhYmFzZSBmaWxlIiwgY29udGV4dCk7CiAgICB9CiAgfSBlbHNlIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoWwogICAgICB7IHBhdGg6IHBhcmVudCwgcm9sZTogImxlYWZEaXJlY3RvcnkiIH0sCiAgICAgIHsgcGF0aDogY2Fub25pY2FsLCByb2xlOiAiZmlsZSIgfSwKICAgIF0sIGNvbnRleHQpOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGNvbnN0IHNlY3VyZWRTdGF0cyA9IGF3YWl0IGxzdGF0KGNhbm9uaWNhbCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHNlY3VyZWRTdGF0cywgY2Fub25pY2FsLCAiZmlsZSIpOwogIHJldHVybiB7CiAgICBwYXRoOiBjYW5vbmljYWwsCiAgICBwYXJlbnQsCiAgICBkZXY6IHNlY3VyZWRTdGF0cy5kZXYsCiAgICBpbm86IHNlY3VyZWRTdGF0cy5pbm8sCiAgICBpZGVudGl0eUtleTogaWRlbnRpdHlGcm9tU3RhdHMoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpLAogIH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJldmFsaWRhdGVQcmVwYXJlZExvY2socHJlcGFyZWQsIGNvbnRleHQpIHsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwcmVwYXJlZC5wYXRoKTsKICBjb25zdCBwYXJlbnRTdGF0cyA9IGF3YWl0IGxzdGF0KHByZXBhcmVkLnBhcmVudCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgaWYgKCFwYXJlbnRTdGF0cy5pc0RpcmVjdG9yeSgpIHx8IHBhcmVudFN0YXRzLmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgcGFyZW50IGlzIG5vIGxvbmdlciBhIHJlYWwgZGlyZWN0b3J5OiAke3ByZXBhcmVkLnBhcmVudH1gKTsKICB9CiAgYXNzZXJ0UG9zaXhPd25lcnNoaXAocGFyZW50U3RhdHMsIHByZXBhcmVkLnBhcmVudCwgInBhcmVudCIpOwogIGNvbnN0IHN0YXRzID0gYXdhaXQgbHN0YXQocHJlcGFyZWQucGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc3RhdHMsIHByZXBhcmVkLnBhdGgpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHN0YXRzLCBwcmVwYXJlZC5wYXRoLCAiZmlsZSIpOwogIGlmIChzdGF0cy5kZXYgIT09IHByZXBhcmVkLmRldiB8fCBzdGF0cy5pbm8gIT09IHByZXBhcmVkLmlubykgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBpZGVudGl0eSBjaGFuZ2VkIGR1cmluZyBhY3F1aXNpdGlvbjogJHtwcmVwYXJlZC5wYXRofWApOwogIH0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gIndpbjMyIikgewogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eShbCiAgICAgIHsgcGF0aDogcHJlcGFyZWQucGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfSwKICAgICAgeyBwYXRoOiBwcmVwYXJlZC5wYXRoLCByb2xlOiAiZmlsZSIgfSwKICAgIF0sIGNvbnRleHQpOwogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eShwcmVwYXJlZC5wYXRoLCAibG9jayBkYXRhYmFzZSBmaWxlIiwgY29udGV4dCk7CiAgfQogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpOwp9CgpmdW5jdGlvbiBwcmFnbWFWYWx1ZShkYXRhYmFzZSwgcHJhZ21hKSB7CiAgY29uc3Qgcm93ID0gZGF0YWJhc2UucHJlcGFyZShgUFJBR01BICR7cHJhZ21hfWApLmdldCgpOwogIHJldHVybiByb3cgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IE9iamVjdC52YWx1ZXMocm93KVswXTsKfQoKZnVuY3Rpb24gcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCBwcmFnbWEpIHsKICBjb25zdCB2YWx1ZSA9IHByYWdtYVZhbHVlKGRhdGFiYXNlLCBwcmFnbWEpOwogIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICJudW1iZXIiID8gdmFsdWUgOiB1bmRlZmluZWQ7Cn0KCmZ1bmN0aW9uIHByYWdtYVRleHQoZGF0YWJhc2UsIHByYWdtYSkgewogIGNvbnN0IHZhbHVlID0gcHJhZ21hVmFsdWUoZGF0YWJhc2UsIHByYWdtYSk7CiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gInN0cmluZyIgPyB2YWx1ZS50b0xvd2VyQ2FzZSgpIDogdW5kZWZpbmVkOwp9CgpleHBvcnQgZnVuY3Rpb24gY29uZmlndXJlTG9jYWxTcWxpdGVMb2NrQ29ubmVjdGlvbihkYXRhYmFzZSkgewogIGRhdGFiYXNlLmV4ZWMoIlBSQUdNQSBidXN5X3RpbWVvdXQgPSAwIik7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIHRydXN0ZWRfc2NoZW1hID0gT0ZGIik7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIHN5bmNocm9ub3VzID0gRVhUUkEiKTsKICBkYXRhYmFzZS5lbmFibGVEZWZlbnNpdmUodHJ1ZSk7CiAgZGF0YWJhc2UuZW5hYmxlTG9hZEV4dGVuc2lvbihmYWxzZSk7CiAgaWYgKAogICAgcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAiYnVzeV90aW1lb3V0IikgIT09IDAgfHwKICAgIHByYWdtYU51bWJlcihkYXRhYmFzZSwgInRydXN0ZWRfc2NoZW1hIikgIT09IDAgfHwKICAgIHByYWdtYU51bWJlcihkYXRhYmFzZSwgInN5bmNocm9ub3VzIikgIT09IDMKICApIHsKICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFNRTGl0ZSBsb2NrIGNvbm5lY3Rpb24gaGFyZGVuaW5nIGRpZCBub3QgdGFrZSBlZmZlY3QiKTsKICB9Cn0KCmZ1bmN0aW9uIGluc3BlY3RMb2NrRGF0YWJhc2UoZGF0YWJhc2UsIHBhdGgpIHsKICBjb25zdCBhcHBsaWNhdGlvbklkID0gcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAiYXBwbGljYXRpb25faWQiKTsKICBpZiAoYXBwbGljYXRpb25JZCA9PT0gMCkgewogICAgY29uc3Qgcm93ID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCBjb3VudCgqKSBBUyBjb3VudCBGUk9NIHNxbGl0ZV9zY2hlbWEgV0hFUkUgbmFtZSBOT1QgTElLRSAnc3FsaXRlXyUnIiwKICAgICkuZ2V0KCk7CiAgICBpZiAocm93Py5jb3VudCAhPT0gMCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgICAgYGFnZW5jOiByZWZ1c2luZyB0byByZXVzZSBhbiB1bnJlbGF0ZWQgU1FMaXRlIGRhdGFiYXNlIGFzIGEgbG9jazogJHtwYXRofWAsCiAgICAgICk7CiAgICB9CiAgICByZXR1cm4gImVtcHR5IjsKICB9CiAgaWYgKGFwcGxpY2F0aW9uSWQgIT09IExPQ0tfQVBQTElDQVRJT05fSUQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaGFzIGFuIGluY29tcGF0aWJsZSBhcHBsaWNhdGlvbiBpZDogJHtwYXRofWApOwogIH0KICB0cnkgewogICAgY29uc3Qgc2NoZW1hID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCB0eXBlLCBzcWwgRlJPTSBzcWxpdGVfc2NoZW1hIFdIRVJFIG5hbWUgPSAnYWdlbmNfbG9jYWxfcHJvY2Vzc19sb2NrJyIsCiAgICApLmdldCgpOwogICAgY29uc3Qgb2JqZWN0cyA9IGRhdGFiYXNlLnByZXBhcmUoCiAgICAgICJTRUxFQ1QgY291bnQoKikgQVMgY291bnQgRlJPTSBzcWxpdGVfc2NoZW1hIFdIRVJFIG5hbWUgTk9UIExJS0UgJ3NxbGl0ZV8lJyIsCiAgICApLmdldCgpOwogICAgY29uc3Qgcm93cyA9IGRhdGFiYXNlLnByZXBhcmUoCiAgICAgICJTRUxFQ1Qgc2luZ2xldG9uLCBmb3JtYXRfdmVyc2lvbiBGUk9NIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayIsCiAgICApLmFsbCgpOwogICAgY29uc3Qgbm9ybWFsaXplZFNjaGVtYSA9IHR5cGVvZiBzY2hlbWE/LnNxbCA9PT0gInN0cmluZyIKICAgICAgPyBzY2hlbWEuc3FsLnJlcGxhY2UoL1xzKy9nLCAiICIpLnRyaW0oKQogICAgICA6IHVuZGVmaW5lZDsKICAgIGlmICgKICAgICAgc2NoZW1hPy50eXBlICE9PSAidGFibGUiIHx8CiAgICAgIG5vcm1hbGl6ZWRTY2hlbWEgIT09CiAgICAgICAgIkNSRUFURSBUQUJMRSBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKCBzaW5nbGV0b24gSU5URUdFUiBQUklNQVJZIEtFWSBDSEVDSyAoc2luZ2xldG9uID0gMSksIGZvcm1hdF92ZXJzaW9uIElOVEVHRVIgTk9UIE5VTEwgKSBTVFJJQ1QiIHx8CiAgICAgIG9iamVjdHM/LmNvdW50ICE9PSAxIHx8CiAgICAgIHJvd3MubGVuZ3RoICE9PSAxIHx8CiAgICAgIHJvd3NbMF0/LnNpbmdsZXRvbiAhPT0gMSB8fAogICAgICByb3dzWzBdPy5mb3JtYXRfdmVyc2lvbiAhPT0gTE9DS19GT1JNQVRfVkVSU0lPTgogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigiaW52YWxpZCBzZW50aW5lbCBzY2hlbWEiKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBoYXMgYW4gaW5jb21wYXRpYmxlIGZvcm1hdDogJHtwYXRofWAsIHsKICAgICAgY2F1c2U6IGVycm9yLAogICAgfSk7CiAgfQogIHJldHVybiAidmFsaWQiOwp9CgpmdW5jdGlvbiBidXN5VHJhbnNpdGlvbkVycm9yKHBhdGgsIG1vZGUpIHsKICByZXR1cm4gT2JqZWN0LmFzc2lnbigKICAgIG5ldyBFcnJvcihgYWdlbmM6IFNRTGl0ZSBsb2NrIGpvdXJuYWwgbW9kZSByZW1haW5lZCAke21vZGUgPz8gInVua25vd24ifTogJHtwYXRofWApLAogICAgeyBlcnJjb2RlOiBTUUxJVEVfQlVTWSB9LAogICk7Cn0KCmZ1bmN0aW9uIGJlZ2luQW5kVmFsaWRhdGVMb2NrKGRhdGFiYXNlLCBwYXRoKSB7CiAgZm9yIChsZXQgcGhhc2UgPSAwOyBwaGFzZSA8IDg7IHBoYXNlICs9IDEpIHsKICAgIGRhdGFiYXNlLmV4ZWMoIkJFR0lOIElNTUVESUFURSIpOwogICAgY29uc3Qgc3RhdGUgPSBpbnNwZWN0TG9ja0RhdGFiYXNlKGRhdGFiYXNlLCBwYXRoKTsKICAgIGNvbnN0IGpvdXJuYWxNb2RlID0gcHJhZ21hVGV4dChkYXRhYmFzZSwgImpvdXJuYWxfbW9kZSIpOwogICAgaWYgKGpvdXJuYWxNb2RlICE9PSAiZGVsZXRlIikgewogICAgICBkYXRhYmFzZS5leGVjKCJST0xMQkFDSyIpOwogICAgICBjb25zdCBzZWxlY3RlZCA9IHByYWdtYVRleHQoZGF0YWJhc2UsICJqb3VybmFsX21vZGU9REVMRVRFIik7CiAgICAgIGlmIChzZWxlY3RlZCAhPT0gImRlbGV0ZSIpIHRocm93IGJ1c3lUcmFuc2l0aW9uRXJyb3IocGF0aCwgc2VsZWN0ZWQpOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIGlmIChzdGF0ZSA9PT0gImVtcHR5IikgewogICAgICBkYXRhYmFzZS5leGVjKGAKICAgICAgICBQUkFHTUEgYXBwbGljYXRpb25faWQgPSAke0xPQ0tfQVBQTElDQVRJT05fSUR9OwogICAgICAgIENSRUFURSBUQUJMRSBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKAogICAgICAgICAgc2luZ2xldG9uIElOVEVHRVIgUFJJTUFSWSBLRVkgQ0hFQ0sgKHNpbmdsZXRvbiA9IDEpLAogICAgICAgICAgZm9ybWF0X3ZlcnNpb24gSU5URUdFUiBOT1QgTlVMTAogICAgICAgICkgU1RSSUNUOwogICAgICAgIElOU0VSVCBJTlRPIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayAoc2luZ2xldG9uLCBmb3JtYXRfdmVyc2lvbikKICAgICAgICBWQUxVRVMgKDEsICR7TE9DS19GT1JNQVRfVkVSU0lPTn0pOwogICAgICAgIENPTU1JVDsKICAgICAgYCk7CiAgICAgIGNvbnRpbnVlOwogICAgfQogICAgcmV0dXJuOwogIH0KICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGluaXRpYWxpemF0aW9uIGRpZCBub3QgY29udmVyZ2U6ICR7cGF0aH1gKTsKfQoKZnVuY3Rpb24gY2xvc2VEYXRhYmFzZShkYXRhYmFzZSkgewogIGlmICghZGF0YWJhc2U/LmlzT3BlbikgcmV0dXJuOwogIGNvbnN0IGVycm9ycyA9IFtdOwogIHRyeSB7CiAgICBpZiAoZGF0YWJhc2UuaXNUcmFuc2FjdGlvbikgZGF0YWJhc2UuZXhlYygiUk9MTEJBQ0siKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgZXJyb3JzLnB1c2goZXJyb3IpOwogIH0KICB0cnkgewogICAgZGF0YWJhc2UuY2xvc2UoKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgZXJyb3JzLnB1c2goZXJyb3IpOwogIH0KICBpZiAoZXJyb3JzLmxlbmd0aCA9PT0gMSkgdGhyb3cgZXJyb3JzWzBdOwogIGlmIChlcnJvcnMubGVuZ3RoID4gMSkgewogICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGVycm9ycywgImFnZW5jOiBmYWlsZWQgdG8gY2xvc2UgYSBsb2NhbCBwcm9jZXNzIGxvY2sgZGF0YWJhc2UiKTsKICB9Cn0KCmV4cG9ydCBmdW5jdGlvbiBpc1NxbGl0ZUJ1c3lFcnJvcihlcnJvcikgewogIHJldHVybiB0eXBlb2YgZXJyb3I/LmVycmNvZGUgPT09ICJudW1iZXIiICYmCiAgICAoZXJyb3IuZXJyY29kZSAmIDB4ZmYpID09PSBTUUxJVEVfQlVTWTsKfQoKYXN5bmMgZnVuY3Rpb24gd2FpdEZvckJ1c3lSZXRyeShjb250ZXh0LCBwYXRoLCBhdHRlbXB0LCBjYXVzZSkgewogIGNvbnN0IHJlbWFpbmluZyA9IHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KTsKICBpZiAocmVtYWluaW5nIDw9IDApIHRocm93IHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBjYXVzZSk7CiAgY29uc3QgZXhwb25lbnRpYWxDYXAgPSBNYXRoLm1pbihNQVhfQlVTWV9SRVRSWV9NUywgMiAqKiBNYXRoLm1pbihhdHRlbXB0LCA2KSk7CiAgY29uc3Qgaml0dGVyID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKGV4cG9uZW50aWFsQ2FwICsgMSkpKTsKICBhd2FpdCBkZWxheShNYXRoLm1pbihyZW1haW5pbmcsIGppdHRlcikpOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhdGgsIGNhdXNlKTsKfQoKYXN5bmMgZnVuY3Rpb24gYWNxdWlyZVNxbGl0ZURhdGFiYXNlKERhdGFiYXNlU3luYywgcHJlcGFyZWQsIGNvbnRleHQpIHsKICBsZXQgYXR0ZW1wdCA9IDA7CiAgbGV0IGxhc3RCdXN5OwogIHdoaWxlICh0cnVlKSB7CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwcmVwYXJlZC5wYXRoLCBsYXN0QnVzeSk7CiAgICBhd2FpdCByZXZhbGlkYXRlUHJlcGFyZWRMb2NrKHByZXBhcmVkLCBjb250ZXh0KTsKICAgIGxldCBkYXRhYmFzZTsKICAgIHRyeSB7CiAgICAgIGRhdGFiYXNlID0gbmV3IERhdGFiYXNlU3luYyhwcmVwYXJlZC5wYXRoLCB7CiAgICAgICAgYWxsb3dFeHRlbnNpb246IGZhbHNlLAogICAgICAgIHRpbWVvdXQ6IDAsCiAgICAgIH0pOwogICAgICBjb25maWd1cmVMb2NhbFNxbGl0ZUxvY2tDb25uZWN0aW9uKGRhdGFiYXNlKTsKICAgICAgYXdhaXQgcmV2YWxpZGF0ZVByZXBhcmVkTG9jayhwcmVwYXJlZCwgY29udGV4dCk7CiAgICAgIGJlZ2luQW5kVmFsaWRhdGVMb2NrKGRhdGFiYXNlLCBwcmVwYXJlZC5wYXRoKTsKICAgICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgbGFzdEJ1c3kpOwogICAgICByZXR1cm4gZGF0YWJhc2U7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBjb25zdCBjbGVhbnVwRXJyb3JzID0gW107CiAgICAgIGlmIChkYXRhYmFzZSAhPT0gdW5kZWZpbmVkKSB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGNsb3NlRGF0YWJhc2UoZGF0YWJhc2UpOwogICAgICAgIH0gY2F0Y2ggKGNsZWFudXBFcnJvcikgewogICAgICAgICAgY2xlYW51cEVycm9ycy5wdXNoKGNsZWFudXBFcnJvcik7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChjbGVhbnVwRXJyb3JzLmxlbmd0aCA+IDApIHsKICAgICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgICAgICBbZXJyb3IsIC4uLmNsZWFudXBFcnJvcnNdLAogICAgICAgICAgYGFnZW5jOiBsb2NrIGF0dGVtcHQgYW5kIGNsZWFudXAgYm90aCBmYWlsZWQgZm9yICR7cHJlcGFyZWQucGF0aH1gLAogICAgICAgICk7CiAgICAgIH0KICAgICAgaWYgKCFpc1NxbGl0ZUJ1c3lFcnJvcihlcnJvcikpIHRocm93IGVycm9yOwogICAgICBsYXN0QnVzeSA9IGVycm9yOwogICAgICBhdHRlbXB0ICs9IDE7CiAgICAgIGF3YWl0IHdhaXRGb3JCdXN5UmV0cnkoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgYXR0ZW1wdCwgbGFzdEJ1c3kpOwogICAgfQogIH0KfQoKZnVuY3Rpb24gcmVsZWFzZUFjcXVpcmVkKGFjcXVpcmVkLCBsYWJlbCkgewogIGNvbnN0IGVycm9ycyA9IFtdOwogIGZvciAoY29uc3QgaXRlbSBvZiBhY3F1aXJlZC50b1JldmVyc2VkKCkpIHsKICAgIHRyeSB7CiAgICAgIGNsb3NlRGF0YWJhc2UoaXRlbS5kYXRhYmFzZSk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgICB9CiAgICBpZiAoKCFpdGVtLmRhdGFiYXNlIHx8ICFpdGVtLmRhdGFiYXNlLmlzT3BlbikgJiYgIWl0ZW0uaW5Qcm9jZXNzUmVsZWFzZWQpIHsKICAgICAgdHJ5IHsKICAgICAgICBpdGVtLnJlbGVhc2VJblByb2Nlc3MoKTsKICAgICAgICBpdGVtLmluUHJvY2Vzc1JlbGVhc2VkID0gdHJ1ZTsKICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICBlcnJvcnMucHVzaChlcnJvcik7CiAgICAgIH0KICAgIH0KICB9CiAgaWYgKGVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGVycm9yc1swXTsKICBpZiAoZXJyb3JzLmxlbmd0aCA+IDEpIHsKICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihlcnJvcnMsIGBhZ2VuYzogJHtsYWJlbH0gbG9jayByZWxlYXNlIGZhaWxlZGApOwogIH0KfQoKZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2tzKAogIHJlcXVlc3RlZFBhdGhzLAogIHsKICAgIHRpbWVvdXRNcyA9IDYwXzAwMCwKICAgIGxhYmVsID0gIkFnZW5DIG9wZXJhdGlvbiIsCiAgICBkZWFkbGluZTogc3VwcGxpZWREZWFkbGluZSwKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgaWYgKCFBcnJheS5pc0FycmF5KHJlcXVlc3RlZFBhdGhzKSkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBwYXRocyBtdXN0IGJlIGFuIGFycmF5Iik7CiAgfQogIGlmIChyZXF1ZXN0ZWRQYXRocy5sZW5ndGggPT09IDApIHJldHVybiAoKSA9PiB7fTsKCiAgY29uc3Qgc3RhcnRlZEF0ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgY29uc3QgY29udGV4dCA9IHsKICAgIGRlYWRsaW5lOiBNYXRoLm1pbigKICAgICAgc3VwcGxpZWREZWFkbGluZSA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksCiAgICAgIHN0YXJ0ZWRBdCArIHRpbWVvdXRNcywKICAgICksCiAgICBsYWJlbCwKICAgIHRpbWVvdXRNcywKICB9OwogIGNvbnN0IGZpcnN0RGlzcGxheVBhdGggPSByZXNvbHZlKHJlcXVlc3RlZFBhdGhzWzBdKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBmaXJzdERpc3BsYXlQYXRoKTsKCiAgY29uc3QgcHJlcGFyZWRCeUlkZW50aXR5ID0gbmV3IE1hcCgpOwogIGZvciAoY29uc3QgcmVxdWVzdGVkUGF0aCBvZiByZXF1ZXN0ZWRQYXRocykgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoKSk7CiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IHByZXBhcmVMb2NrUGF0aChyZXF1ZXN0ZWRQYXRoLCBjb250ZXh0KTsKICAgIHByZXBhcmVkQnlJZGVudGl0eS5zZXQocHJlcGFyZWQuaWRlbnRpdHlLZXksIHByZXBhcmVkKTsKICB9CiAgY29uc3QgcHJlcGFyZWRMb2NrcyA9IFsuLi5wcmVwYXJlZEJ5SWRlbnRpdHkudmFsdWVzKCldLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PgogICAgbGVmdC5pZGVudGl0eUtleSA8IHJpZ2h0LmlkZW50aXR5S2V5ID8gLTEgOiBsZWZ0LmlkZW50aXR5S2V5ID4gcmlnaHQuaWRlbnRpdHlLZXkgPyAxIDogMCk7CiAgY29uc3QgcGVuZGluZ0xvY2FsID0gW107CiAgY29uc3QgYWNxdWlyZWQgPSBbXTsKICBsZXQgY3VycmVudFBhdGggPSBwcmVwYXJlZExvY2tzWzBdPy5wYXRoID8/IGZpcnN0RGlzcGxheVBhdGg7CiAgdHJ5IHsKICAgIGZvciAoY29uc3QgcHJlcGFyZWQgb2YgcHJlcGFyZWRMb2NrcykgewogICAgICBjdXJyZW50UGF0aCA9IHByZXBhcmVkLnBhdGg7CiAgICAgIGNvbnN0IHJlbGVhc2UgPSBhd2FpdCBhY3F1aXJlSW5Qcm9jZXNzTG9jayhwcmVwYXJlZCwgY29udGV4dCk7CiAgICAgIHBlbmRpbmdMb2NhbC5wdXNoKHsgcHJlcGFyZWQsIHJlbGVhc2UgfSk7CiAgICB9CiAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjdXJyZW50UGF0aCk7CiAgICBjb25zdCB7IERhdGFiYXNlU3luYyB9ID0gYXdhaXQgaW1wb3J0KCJub2RlOnNxbGl0ZSIpOwogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgY3VycmVudFBhdGgpOwogICAgZm9yIChjb25zdCB7IHByZXBhcmVkLCByZWxlYXNlIH0gb2YgcGVuZGluZ0xvY2FsKSB7CiAgICAgIGN1cnJlbnRQYXRoID0gcHJlcGFyZWQucGF0aDsKICAgICAgY29uc3QgaXRlbSA9IHsKICAgICAgICBkYXRhYmFzZTogdW5kZWZpbmVkLAogICAgICAgIHJlbGVhc2VJblByb2Nlc3M6IHJlbGVhc2UsCiAgICAgICAgaW5Qcm9jZXNzUmVsZWFzZWQ6IGZhbHNlLAogICAgICB9OwogICAgICBhY3F1aXJlZC5wdXNoKGl0ZW0pOwogICAgICBpdGVtLmRhdGFiYXNlID0gYXdhaXQgYWNxdWlyZVNxbGl0ZURhdGFiYXNlKERhdGFiYXNlU3luYywgcHJlcGFyZWQsIGNvbnRleHQpOwogICAgfQogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBjb25zdCBjbGVhbnVwRXJyb3JzID0gW107CiAgICB0cnkgewogICAgICByZWxlYXNlQWNxdWlyZWQoYWNxdWlyZWQsIGxhYmVsKTsKICAgIH0gY2F0Y2ggKGNsZWFudXBFcnJvcikgewogICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgIH0KICAgIGZvciAoY29uc3QgeyByZWxlYXNlIH0gb2YgcGVuZGluZ0xvY2FsLnNsaWNlKGFjcXVpcmVkLmxlbmd0aCkudG9SZXZlcnNlZCgpKSB7CiAgICAgIHRyeSB7CiAgICAgICAgcmVsZWFzZSgpOwogICAgICB9IGNhdGNoIChjbGVhbnVwRXJyb3IpIHsKICAgICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgICAgfQogICAgfQogICAgY29uc3QgZm9ybWF0dGVkID0gaXNTcWxpdGVCdXN5RXJyb3IoZXJyb3IpCiAgICAgID8gdGltZW91dEVycm9yKGNvbnRleHQsIGN1cnJlbnRQYXRoLCBlcnJvcikKICAgICAgOiBlcnJvcjsKICAgIGlmIChjbGVhbnVwRXJyb3JzLmxlbmd0aCA+IDApIHsKICAgICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKAogICAgICAgIFtmb3JtYXR0ZWQsIC4uLmNsZWFudXBFcnJvcnNdLAogICAgICAgIGBhZ2VuYzogJHtsYWJlbH0gbG9jayBhY3F1aXNpdGlvbiBhbmQgcm9sbGJhY2sgYm90aCBmYWlsZWRgLAogICAgICApOwogICAgfQogICAgdGhyb3cgZm9ybWF0dGVkOwogIH0KCiAgbGV0IHJlbGVhc2VkID0gZmFsc2U7CiAgcmV0dXJuICgpID0+IHsKICAgIGlmIChyZWxlYXNlZCkgcmV0dXJuOwogICAgcmVsZWFzZUFjcXVpcmVkKGFjcXVpcmVkLCBsYWJlbCk7CiAgICByZWxlYXNlZCA9IGFjcXVpcmVkLmV2ZXJ5KChpdGVtKSA9PiBpdGVtLmluUHJvY2Vzc1JlbGVhc2VkKTsKICB9Owp9CgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYWNxdWlyZUxvY2FsU3FsaXRlTG9jayhwYXRoLCBvcHRpb25zKSB7CiAgcmV0dXJuIGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2tzKFtwYXRoXSwgb3B0aW9ucyk7Cn0K";
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
const AGENC_GENERATED_WRAPPER_SOURCE_BASE64 = "Ly8gQnl0ZS1jYW5vbmljYWwgc3RhbmRhbG9uZS1pbnN0YWxsZXIgd3JhcHBlciBjb250cmFjdCBzaGFyZWQgYnkgdGhlIHJ1bnRpbWUKLy8gdXBkYXRlciBhbmQgYm90aCBlbWJlZGRlZCBpbnN0YWxsZXJzLiBQYXJzaW5nIGlzIGRlbGliZXJhdGVseSBmdWxsLWZpbGU6Ci8vIG1hcmtlciBzdWJzdHJpbmdzIG11c3QgbmV2ZXIgZ3JhbnQgb3duZXJzaGlwIG9mIGEgdXNlci1hdXRob3JlZCBleGVjdXRhYmxlLgoKaW1wb3J0IHsgaXNBYnNvbHV0ZSwgcG9zaXgsIHdpbjMyIH0gZnJvbSAibm9kZTpwYXRoIjsKCmV4cG9ydCBjb25zdCBHRU5FUkFURURfV1JBUFBFUl9NQVhfQllURVMgPSA2NCAqIDEwMjQ7CmNvbnN0IFBPU0lYX1dSQVBQRVJfU0lHTkFUVVJFID0gIkdlbmVyYXRlZCBieSBBZ2VuQyBpbnN0YWxsLnNoIjsKY29uc3QgQ01EX1dSQVBQRVJfU0lHTkFUVVJFID0gIkdlbmVyYXRlZCBieSBBZ2VuQyBpbnN0YWxsLnBzMSI7CmNvbnN0IFdSQVBQRVJfTUVUQURBVEFfUFJFRklYID0gIkFnZW5DIHdyYXBwZXIgbWV0YWRhdGEgdjE6IjsKCmZ1bmN0aW9uIHZhbGlkYXRlVmFsdWVzKGtpbmQsIHZhbHVlcykgewogIGlmICghdmFsdWVzIHx8IHR5cGVvZiB2YWx1ZXMgIT09ICJvYmplY3QiKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJ3cmFwcGVyIHZhbHVlcyBtdXN0IGJlIGFuIG9iamVjdCIpOwogIH0KICBmb3IgKGNvbnN0IGxhYmVsIG9mIFsibm9kZUJpbiIsICJydW50aW1lQmluIiwgImFnZW5jSG9tZSJdKSB7CiAgICBjb25zdCB2YWx1ZSA9IHZhbHVlc1tsYWJlbF07CiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAic3RyaW5nIikgdGhyb3cgbmV3IFR5cGVFcnJvcihgd3JhcHBlciAke2xhYmVsfSBtdXN0IGJlIGEgc3RyaW5nYCk7CiAgICBpZiAodmFsdWUuaW5jbHVkZXMoIlwwIikpIHRocm93IG5ldyBFcnJvcihgd3JhcHBlciAke2xhYmVsfSBjb250YWlucyBOVUxgKTsKICAgIGlmIChraW5kID09PSAiY21kIiAmJiAvWyJcclxuXS91LnRlc3QodmFsdWUpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgV2luZG93cyB3cmFwcGVyICR7bGFiZWx9IGNvbnRhaW5zIGFuIHVuc3VwcG9ydGVkIGNoYXJhY3RlcmApOwogICAgfQogIH0KICBpZiAoIWlzQWJzb2x1dGUodmFsdWVzLmFnZW5jSG9tZSkpIHsKICAgIHRocm93IG5ldyBFcnJvcigid3JhcHBlciBBR0VOQ19IT01FIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCIpOwogIH0KICBpZiAodmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlcy5ub2RlTGlicmFyeVBhdGggIT09ICJzdHJpbmciKSB7CiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoIndyYXBwZXIgbm9kZUxpYnJhcnlQYXRoIG11c3QgYmUgYSBzdHJpbmciKTsKICAgIH0KICAgIGlmICh2YWx1ZXMubm9kZUxpYnJhcnlQYXRoLmluY2x1ZGVzKCJcMCIpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigid3JhcHBlciBub2RlTGlicmFyeVBhdGggY29udGFpbnMgTlVMIik7CiAgICB9CiAgICBpZiAoIWlzQWJzb2x1dGUodmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCkpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJ3cmFwcGVyIG5vZGVMaWJyYXJ5UGF0aCBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGgiKTsKICAgIH0KICAgIGlmIChraW5kID09PSAiY21kIikgewogICAgICB0aHJvdyBuZXcgRXJyb3IoIldpbmRvd3Mgd3JhcHBlcnMgZG8gbm90IHN1cHBvcnQgbm9kZUxpYnJhcnlQYXRoIik7CiAgICB9CiAgfQp9CgpmdW5jdGlvbiBtZXRhZGF0YUZvcih2YWx1ZXMpIHsKICBjb25zdCBtZXRhZGF0YSA9IHsKICAgIG5vZGVCaW46IHZhbHVlcy5ub2RlQmluLAogICAgcnVudGltZUJpbjogdmFsdWVzLnJ1bnRpbWVCaW4sCiAgICBhZ2VuY0hvbWU6IHZhbHVlcy5hZ2VuY0hvbWUsCiAgICAuLi4odmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCA9PT0gdW5kZWZpbmVkCiAgICAgID8ge30KICAgICAgOiB7IG5vZGVMaWJyYXJ5UGF0aDogdmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCB9KSwKICB9OwogIHJldHVybiBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeShtZXRhZGF0YSksICJ1dGY4IikudG9TdHJpbmcoImJhc2U2NHVybCIpOwp9CgpmdW5jdGlvbiByZW5kZXJMZWdhY3lPb21Qb3NpeFdyYXBwZXIoeyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUgfSkgewogIHJldHVybiBbCiAgICAiIyEvYmluL3NoIiwKICAgIGAjICR7UE9TSVhfV1JBUFBFUl9TSUdOQVRVUkV9IOKAlCByZXdyaXR0ZW4gb24gZXZlcnkgaW5zdGFsbC91cGdyYWRlLmAsCiAgICBgZXhwb3J0IEFHRU5DX0hPTUU9Ilwke0FHRU5DX0hPTUU6LSR7YWdlbmNIb21lfX0iYCwKICAgICIjIE9PTSBzZWxmLWRpYWdub3NpczogaGF2ZSBWOCB3cml0ZSBhIGhlYXAgc25hcHNob3QgZnJvbSBpbnNpZGUgdGhlIEdDIHdoZW4iLAogICAgIiMgdGhlIGhlYXAgbmVhcnMgaXRzIGxpbWl0IChyZWxpYWJsZSBldmVuIGluIHRoZSBlbmQtc3RhZ2UgR0Mgc3RhbGwgd2hlcmUgSlMiLAogICAgIiMgdGltZXJzIHN0YXJ2ZSksIGludG8gJEFHRU5DX0hPTUUvb29tLXNuYXBzaG90cy4gVGhlIHJ1bnRpbWUgcHJ1bmVzIG9sZCIsCiAgICAiIyBjYXB0dXJlcyBhbmQgcG9pbnRzIGF0IGZyZXNoIG9uZXMgb24gdGhlIG5leHQgc3RhcnR1cC4gVXNlci1wcm92aWRlZCIsCiAgICAiIyBOT0RFX09QVElPTlMgd2luOiBvdXJzIGFyZSBwcmVwZW5kZWQsIGFuZCB3ZSBza2lwIGVudGlyZWx5IHdoZW4gdGhlIHVzZXIiLAogICAgIiMgYWxyZWFkeSB0dW5lcyBoZWFwIHNuYXBzaG90cy4iLAogICAgJ2Nhc2UgIiAke05PREVfT1BUSU9OUzotfSAiIGluJywKICAgICIgICpoZWFwc25hcHNob3QtbmVhci1oZWFwLWxpbWl0KikgOiA7OyIsCiAgICAiICAqKSIsCiAgICAnICAgIG1rZGlyIC1wICIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiIDI+L2Rldi9udWxsIHx8IDonLAogICAgJyAgICBOT0RFX09QVElPTlM9Ii0taGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdD0xIC0tZGlhZ25vc3RpYy1kaXI9JHtBR0VOQ19IT01FfS9vb20tc25hcHNob3RzICR7Tk9ERV9PUFRJT05TOi19IicsCiAgICAiICAgIGV4cG9ydCBOT0RFX09QVElPTlMiLAogICAgIiAgICA7OyIsCiAgICAiZXNhYyIsCiAgICBgZXhlYyAiJHtub2RlQmlufSIgIiR7cnVudGltZUJpbn0iICIkQCJgLAogICAgIiIsCiAgXS5qb2luKCJcbiIpOwp9CgpleHBvcnQgZnVuY3Rpb24gcmVuZGVyR2VuZXJhdGVkV3JhcHBlckNvbnRlbnQoewogIGtpbmQsCiAgbm9kZUJpbiwKICBydW50aW1lQmluLAogIGFnZW5jSG9tZSwKICBub2RlTGlicmFyeVBhdGgsCn0pIHsKICBpZiAoa2luZCAhPT0gInBvc2l4IiAmJiBraW5kICE9PSAiY21kIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgdW5zdXBwb3J0ZWQgd3JhcHBlciBraW5kOiAke1N0cmluZyhraW5kKX1gKTsKICB9CiAgY29uc3QgdmFsdWVzID0geyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUsIG5vZGVMaWJyYXJ5UGF0aCB9OwogIHZhbGlkYXRlVmFsdWVzKGtpbmQsIHZhbHVlcyk7CiAgY29uc3QgbWV0YWRhdGEgPSBtZXRhZGF0YUZvcih2YWx1ZXMpOwogIGlmIChraW5kID09PSAiY21kIikgewogICAgY29uc3QgYmF0Y2ggPSAodmFsdWUpID0+IHZhbHVlLnJlcGxhY2VBbGwoIiUiLCAiJSUiKTsKICAgIGNvbnN0IG5vZGVEaXIgPSB3aW4zMi5kaXJuYW1lKG5vZGVCaW4pOwogICAgcmV0dXJuIFsKICAgICAgIkBlY2hvIG9mZiIsCiAgICAgICJzZXRsb2NhbCBEaXNhYmxlRGVsYXllZEV4cGFuc2lvbiIsCiAgICAgIGByZW0gJHtDTURfV1JBUFBFUl9TSUdOQVRVUkV9IC0gcmV3cml0dGVuIG9uIGV2ZXJ5IGluc3RhbGwvdXBncmFkZS5gLAogICAgICBgcmVtICR7V1JBUFBFUl9NRVRBREFUQV9QUkVGSVh9ICR7bWV0YWRhdGF9YCwKICAgICAgYGlmIG5vdCBkZWZpbmVkIEFHRU5DX0hPTUUgc2V0ICJBR0VOQ19IT01FPSR7YmF0Y2goYWdlbmNIb21lKX0iYCwKICAgICAgYHNldCAiUEFUSD0ke2JhdGNoKG5vZGVEaXIpfTslUEFUSCUiYCwKICAgICAgYCIke2JhdGNoKG5vZGVCaW4pfSIgIiR7YmF0Y2gocnVudGltZUJpbil9IiAlKmAsCiAgICAgICIiLAogICAgXS5qb2luKCJcclxuIik7CiAgfQogIGNvbnN0IHF1b3RlID0gKHZhbHVlKSA9PiBgJyR7dmFsdWUucmVwbGFjZUFsbCgiJyIsIGAnIiciJ2ApfSdgOwogIGNvbnN0IG5vZGVEaXIgPSBwb3NpeC5kaXJuYW1lKG5vZGVCaW4pOwogIGNvbnN0IGV4ZWNQcmVmaXggPSBub2RlTGlicmFyeVBhdGggPT09IHVuZGVmaW5lZAogICAgPyAiZXhlYyAiCiAgICA6IGBMRF9MSUJSQVJZX1BBVEg9JHtxdW90ZShub2RlTGlicmFyeVBhdGgpfSBleGVjIGA7CiAgcmV0dXJuIFsKICAgICIjIS9iaW4vc2giLAogICAgYCMgJHtQT1NJWF9XUkFQUEVSX1NJR05BVFVSRX0g4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsL3VwZ3JhZGUuYCwKICAgIGAjICR7V1JBUFBFUl9NRVRBREFUQV9QUkVGSVh9ICR7bWV0YWRhdGF9YCwKICAgICdpZiBbIC16ICIke0FHRU5DX0hPTUU6LX0iIF07IHRoZW4nLAogICAgYCAgZXhwb3J0IEFHRU5DX0hPTUU9JHtxdW90ZShhZ2VuY0hvbWUpfWAsCiAgICAiZmkiLAogICAgJ2lmIFsgLW4gIiR7UEFUSDotfSIgXTsgdGhlbicsCiAgICBgICBleHBvcnQgUEFUSD0ke3F1b3RlKG5vZGVEaXIpfToiJFBBVEgiYCwKICAgICJlbHNlIiwKICAgIGAgIGV4cG9ydCBQQVRIPSR7cXVvdGUobm9kZURpcil9YCwKICAgICJmaSIsCiAgICAiIyBDYXB0dXJlIG9uZSBWOCBuZWFyLWhlYXAtbGltaXQgc25hcHNob3QgdW5sZXNzIHRoZSBvcGVyYXRvciBhbHJlYWR5IGNvbmZpZ3VyZWQgaXQuIiwKICAgICdjYXNlICIgJHtOT0RFX09QVElPTlM6LX0gIiBpbicsCiAgICAiICAqaGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdCopIiwKICAgIGAgICAgJHtleGVjUHJlZml4fSR7cXVvdGUobm9kZUJpbil9ICR7cXVvdGUocnVudGltZUJpbil9ICIkQCJgLAogICAgIiAgICA7OyIsCiAgICAiICAqKSIsCiAgICAnICAgIG1rZGlyIC1wICIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiIDI+L2Rldi9udWxsIHx8IDonLAogICAgYCAgICAke2V4ZWNQcmVmaXh9JHtxdW90ZShub2RlQmluKX0gLS1oZWFwc25hcHNob3QtbmVhci1oZWFwLWxpbWl0PTEgYCArCiAgICAgICctLWRpYWdub3N0aWMtZGlyPSIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiICcgKwogICAgICBgJHtxdW90ZShydW50aW1lQmluKX0gIiRAImAsCiAgICAiICAgIDs7IiwKICAgICJlc2FjIiwKICAgICIiLAogIF0uam9pbigiXG4iKTsKfQoKLy8gUmVsZWFzZXMgMC42LjIgdGhyb3VnaCAwLjEwLjAgZW1pdHRlZCB0aGlzIGltbXV0YWJsZSBtZXRhZGF0YS12MSBzaGFwZQovLyBiZWZvcmUgc3RhbmRhbG9uZSBpbnN0YWxscyBjYXJyaWVkIGEgcHJpdmF0ZSBOb2RlIHJ1bnRpbWUuIEtlZXAgdGhlIHJlbmRlcmVyCi8vIHByaXZhdGU6IGl0IGV4aXN0cyBvbmx5IHNvIG93bmVyc2hpcCBjYW4gYmUgcHJvdmVuIGJ5IGV4YWN0IGZ1bGwtZmlsZQovLyByZWNvbnN0cnVjdGlvbiwgbmV2ZXIgYnkgdHJ1c3RpbmcgdGhlIGhpc3RvcmljYWwgbWFya2VyIG9yIG1ldGFkYXRhIGFsb25lLgpmdW5jdGlvbiByZW5kZXJQcmVQcml2YXRlTm9kZVdyYXBwZXJDb250ZW50KHsKICBraW5kLAogIG5vZGVCaW4sCiAgcnVudGltZUJpbiwKICBhZ2VuY0hvbWUsCn0pIHsKICBpZiAoa2luZCAhPT0gInBvc2l4IiAmJiBraW5kICE9PSAiY21kIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgdW5zdXBwb3J0ZWQgd3JhcHBlciBraW5kOiAke1N0cmluZyhraW5kKX1gKTsKICB9CiAgY29uc3QgdmFsdWVzID0geyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUgfTsKICB2YWxpZGF0ZVZhbHVlcyhraW5kLCB2YWx1ZXMpOwogIGNvbnN0IG1ldGFkYXRhID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkoewogICAgbm9kZUJpbiwKICAgIHJ1bnRpbWVCaW4sCiAgICBhZ2VuY0hvbWUsCiAgfSksICJ1dGY4IikudG9TdHJpbmcoImJhc2U2NHVybCIpOwogIGlmIChraW5kID09PSAiY21kIikgewogICAgY29uc3QgYmF0Y2ggPSAodmFsdWUpID0+IHZhbHVlLnJlcGxhY2VBbGwoIiUiLCAiJSUiKTsKICAgIHJldHVybiBbCiAgICAgICJAZWNobyBvZmYiLAogICAgICAic2V0bG9jYWwgRGlzYWJsZURlbGF5ZWRFeHBhbnNpb24iLAogICAgICBgcmVtICR7Q01EX1dSQVBQRVJfU0lHTkFUVVJFfSAtIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsL3VwZ3JhZGUuYCwKICAgICAgYHJlbSAke1dSQVBQRVJfTUVUQURBVEFfUFJFRklYfSAke21ldGFkYXRhfWAsCiAgICAgIGBpZiBub3QgZGVmaW5lZCBBR0VOQ19IT01FIHNldCAiQUdFTkNfSE9NRT0ke2JhdGNoKGFnZW5jSG9tZSl9ImAsCiAgICAgIGAiJHtiYXRjaChub2RlQmluKX0iICIke2JhdGNoKHJ1bnRpbWVCaW4pfSIgJSpgLAogICAgICAiIiwKICAgIF0uam9pbigiXHJcbiIpOwogIH0KICBjb25zdCBxdW90ZSA9ICh2YWx1ZSkgPT4gYCcke3ZhbHVlLnJlcGxhY2VBbGwoIiciLCBgJyInIidgKX0nYDsKICByZXR1cm4gWwogICAgIiMhL2Jpbi9zaCIsCiAgICBgIyAke1BPU0lYX1dSQVBQRVJfU0lHTkFUVVJFfSDigJQgcmV3cml0dGVuIG9uIGV2ZXJ5IGluc3RhbGwvdXBncmFkZS5gLAogICAgYCMgJHtXUkFQUEVSX01FVEFEQVRBX1BSRUZJWH0gJHttZXRhZGF0YX1gLAogICAgJ2lmIFsgLXogIiR7QUdFTkNfSE9NRTotfSIgXTsgdGhlbicsCiAgICBgICBleHBvcnQgQUdFTkNfSE9NRT0ke3F1b3RlKGFnZW5jSG9tZSl9YCwKICAgICJmaSIsCiAgICAiIyBDYXB0dXJlIG9uZSBWOCBuZWFyLWhlYXAtbGltaXQgc25hcHNob3QgdW5sZXNzIHRoZSBvcGVyYXRvciBhbHJlYWR5IGNvbmZpZ3VyZWQgaXQuIiwKICAgICdjYXNlICIgJHtOT0RFX09QVElPTlM6LX0gIiBpbicsCiAgICAiICAqaGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdCopIiwKICAgIGAgICAgZXhlYyAke3F1b3RlKG5vZGVCaW4pfSAke3F1b3RlKHJ1bnRpbWVCaW4pfSAiJEAiYCwKICAgICIgICAgOzsiLAogICAgIiAgKikiLAogICAgJyAgICBta2RpciAtcCAiJHtBR0VOQ19IT01FfS9vb20tc25hcHNob3RzIiAyPi9kZXYvbnVsbCB8fCA6JywKICAgIGAgICAgZXhlYyAke3F1b3RlKG5vZGVCaW4pfSAtLWhlYXBzbmFwc2hvdC1uZWFyLWhlYXAtbGltaXQ9MSBgICsKICAgICAgJy0tZGlhZ25vc3RpYy1kaXI9IiR7QUdFTkNfSE9NRX0vb29tLXNuYXBzaG90cyIgJyArCiAgICAgIGAke3F1b3RlKHJ1bnRpbWVCaW4pfSAiJEAiYCwKICAgICIgICAgOzsiLAogICAgImVzYWMiLAogICAgIiIsCiAgXS5qb2luKCJcbiIpOwp9CgpmdW5jdGlvbiBkZWNvZGVDYW5vbmljYWxNZXRhZGF0YShlbmNvZGVkKSB7CiAgdHJ5IHsKICAgIGNvbnN0IGJ5dGVzID0gQnVmZmVyLmZyb20oZW5jb2RlZCwgImJhc2U2NHVybCIpOwogICAgaWYgKGJ5dGVzLnRvU3RyaW5nKCJiYXNlNjR1cmwiKSAhPT0gZW5jb2RlZCkgcmV0dXJuIHVuZGVmaW5lZDsKICAgIGNvbnN0IGRlY29kZWQgPSBuZXcgVGV4dERlY29kZXIoInV0Zi04IiwgeyBmYXRhbDogdHJ1ZSB9KS5kZWNvZGUoYnl0ZXMpOwogICAgY29uc3QgdmFsdWUgPSBKU09OLnBhcnNlKGRlY29kZWQpOwogICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSAhPT0gIm9iamVjdCIgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB1bmRlZmluZWQ7CiAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXModmFsdWUpOwogICAgY29uc3QgZXhwZWN0ZWRLZXlzID0gdmFsdWUubm9kZUxpYnJhcnlQYXRoID09PSB1bmRlZmluZWQKICAgICAgPyBbIm5vZGVCaW4iLCAicnVudGltZUJpbiIsICJhZ2VuY0hvbWUiXQogICAgICA6IFsibm9kZUJpbiIsICJydW50aW1lQmluIiwgImFnZW5jSG9tZSIsICJub2RlTGlicmFyeVBhdGgiXTsKICAgIGlmICgKICAgICAga2V5cy5sZW5ndGggIT09IGV4cGVjdGVkS2V5cy5sZW5ndGggfHwKICAgICAgIWV4cGVjdGVkS2V5cy5ldmVyeSgoa2V5LCBpbmRleCkgPT4ga2V5c1tpbmRleF0gPT09IGtleSkgfHwKICAgICAgdHlwZW9mIHZhbHVlLm5vZGVCaW4gIT09ICJzdHJpbmciIHx8CiAgICAgIHR5cGVvZiB2YWx1ZS5ydW50aW1lQmluICE9PSAic3RyaW5nIiB8fAogICAgICB0eXBlb2YgdmFsdWUuYWdlbmNIb21lICE9PSAic3RyaW5nIiB8fAogICAgICAodmFsdWUubm9kZUxpYnJhcnlQYXRoICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCAhPT0gInN0cmluZyIpCiAgICApIHJldHVybiB1bmRlZmluZWQ7CiAgICByZXR1cm4gewogICAgICBub2RlQmluOiB2YWx1ZS5ub2RlQmluLAogICAgICBydW50aW1lQmluOiB2YWx1ZS5ydW50aW1lQmluLAogICAgICBhZ2VuY0hvbWU6IHZhbHVlLmFnZW5jSG9tZSwKICAgICAgLi4uKHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCA9PT0gdW5kZWZpbmVkCiAgICAgICAgPyB7fQogICAgICAgIDogeyBub2RlTGlicmFyeVBhdGg6IHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCB9KSwKICAgIH07CiAgfSBjYXRjaCB7CiAgICByZXR1cm4gdW5kZWZpbmVkOwogIH0KfQoKZnVuY3Rpb24gcGFyc2VNb2Rlcm4ocGF0aCwgY29udGVudCkgewogIGNvbnN0IG1hcmtlciA9IGNvbnRlbnQubWF0Y2goCiAgICAvXigjfHJlbSkgQWdlbkMgd3JhcHBlciBtZXRhZGF0YSB2MTogKFtBLVphLXowLTlfLV0rKVxyPyQvbXUsCiAgKTsKICBpZiAobWFya2VyID09PSBudWxsKSByZXR1cm4gdW5kZWZpbmVkOwogIGNvbnN0IGtpbmQgPSBtYXJrZXJbMV0gPT09ICJyZW0iID8gImNtZCIgOiAicG9zaXgiOwogIGNvbnN0IHZhbHVlcyA9IGRlY29kZUNhbm9uaWNhbE1ldGFkYXRhKG1hcmtlclsyXSk7CiAgaWYgKHZhbHVlcyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkOwogIHRyeSB7CiAgICBjb25zdCB3cmFwcGVyID0geyBraW5kLCBwYXRoLCAuLi52YWx1ZXMgfTsKICAgIGlmIChyZW5kZXJHZW5lcmF0ZWRXcmFwcGVyQ29udGVudCh3cmFwcGVyKSA9PT0gY29udGVudCkgcmV0dXJuIHdyYXBwZXI7CiAgICBpZiAoCiAgICAgIHZhbHVlcy5ub2RlTGlicmFyeVBhdGggPT09IHVuZGVmaW5lZCAmJgogICAgICByZW5kZXJQcmVQcml2YXRlTm9kZVdyYXBwZXJDb250ZW50KHdyYXBwZXIpID09PSBjb250ZW50CiAgICApIHJldHVybiB3cmFwcGVyOwogICAgcmV0dXJuIHVuZGVmaW5lZDsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpmdW5jdGlvbiBwYXJzZUxlZ2FjeShwYXRoLCBjb250ZW50KSB7CiAgY29uc3QgcG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKHBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogcG9zaXhbMV0sIG5vZGVCaW46IHBvc2l4WzJdLCBydW50aW1lQmluOiBwb3NpeFszXSB9OwogICAgdHJ5IHsKICAgICAgdmFsaWRhdGVWYWx1ZXMoInBvc2l4IiwgdmFsdWVzKTsKICAgICAgcmV0dXJuIHsga2luZDogInBvc2l4IiwgcGF0aCwgLi4udmFsdWVzIH07CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuIHVuZGVmaW5lZDsKICAgIH0KICB9CiAgLy8gMC42LjIgZGV2ZWxvcG1lbnQgbWFpbiBicmllZmx5IGVtaXR0ZWQgdGhpcyBleGFjdCBmdWxsLWZpbGUgd3JhcHBlciBiZWZvcmUKICAvLyBhY3RpdmF0aW9uIG93bmVyc2hpcCBiZWNhbWUgY2Fub25pY2FsLiBBY2NlcHRpbmcgb25seSBhIGJ5dGUtZm9yLWJ5dGUKICAvLyByZWNvbnN0cnVjdGlvbiBwcmVzZXJ2ZXMgdXBncmFkZXMgZnJvbSB0aGF0IHN1cmZhY2Ugd2l0aG91dCB0dXJuaW5nIHRoZQogIC8vIGhpc3RvcmljYWwgbWFya2VyIGludG8gYSBnZW5lcmFsIG93bmVyc2hpcCBvcmFjbGUuCiAgY29uc3Qgb29tUG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuW1xzXFNdKlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKG9vbVBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7CiAgICAgIGFnZW5jSG9tZTogb29tUG9zaXhbMV0sCiAgICAgIG5vZGVCaW46IG9vbVBvc2l4WzJdLAogICAgICBydW50aW1lQmluOiBvb21Qb3NpeFszXSwKICAgIH07CiAgICB0cnkgewogICAgICB2YWxpZGF0ZVZhbHVlcygicG9zaXgiLCB2YWx1ZXMpOwogICAgICBpZiAocmVuZGVyTGVnYWN5T29tUG9zaXhXcmFwcGVyKHZhbHVlcykgPT09IGNvbnRlbnQpIHsKICAgICAgICByZXR1cm4geyBraW5kOiAicG9zaXgiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICAgICAgfQogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiB1bmRlZmluZWQ7CiAgICB9CiAgfQogIGNvbnN0IGNtZCA9IGNvbnRlbnQubWF0Y2goCiAgICAvXkBlY2hvIG9mZihccj9cbilyZW0gR2VuZXJhdGVkIGJ5IEFnZW5DIGluc3RhbGxcLnBzMSAtIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cMWlmIG5vdCBkZWZpbmVkIEFHRU5DX0hPTUUgc2V0ICJBR0VOQ19IT01FPShbXiJcclxuXSspIlwxIihbXiJcclxuXSspIiAiKFteIlxyXG5dKykiICVcKlwxJC91LAogICk7CiAgaWYgKGNtZCA9PT0gbnVsbCkgcmV0dXJuIHVuZGVmaW5lZDsKICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogY21kWzJdLCBub2RlQmluOiBjbWRbM10sIHJ1bnRpbWVCaW46IGNtZFs0XSB9OwogIHRyeSB7CiAgICB2YWxpZGF0ZVZhbHVlcygiY21kIiwgdmFsdWVzKTsKICAgIHJldHVybiB7IGtpbmQ6ICJjbWQiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpleHBvcnQgZnVuY3Rpb24gcGFyc2VHZW5lcmF0ZWRXcmFwcGVyQ29udGVudChwYXRoLCBjb250ZW50KSB7CiAgaWYgKAogICAgdHlwZW9mIHBhdGggIT09ICJzdHJpbmciIHx8ICFpc0Fic29sdXRlKHBhdGgpIHx8CiAgICB0eXBlb2YgY29udGVudCAhPT0gInN0cmluZyIgfHwgQnVmZmVyLmJ5dGVMZW5ndGgoY29udGVudCwgInV0ZjgiKSA+IEdFTkVSQVRFRF9XUkFQUEVSX01BWF9CWVRFUwogICkgcmV0dXJuIG51bGw7CiAgcmV0dXJuIHBhcnNlTW9kZXJuKHBhdGgsIGNvbnRlbnQpID8/IHBhcnNlTGVnYWN5KHBhdGgsIGNvbnRlbnQpID8/IG51bGw7Cn0K";
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
  if (mode === "render-wrapper") await renderWrapperMain();
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

  $recoveryState = (& node $runtimeInstallerPath recover - $installDir $binRel `
    ([string]$artifact.sha256) "win" $provenanceExpectationBase64 "" "" `
    $nodeBinRel $nodeLibraryRel | Out-String).Trim()
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
    & node $runtimeInstallerPath install $tarball $installDir $binRel `
      ([string]$artifact.sha256) "win" $provenanceExpectationBase64 `
      $script:OfficialProvenanceReceiptBase64 $tarPath $nodeBinRel $nodeLibraryRel
    if ($LASTEXITCODE -ne 0) { Fail "runtime archive validation or installation failed" }
    Write-Log "runtime $version installed at $installDir"
  } else {
    Fail "runtime crash recovery returned an invalid state"
  }

  # --- shim ------------------------------------------------------------------

  if (-not $legacy) {
    & $privateNodeBin -e @'
const allowOverride = process.argv[1] === "true";
if (process.versions.node !== "26.5.0" || process.versions.modules !== "147" ||
    process.versions.napi !== "10" || (!allowOverride && (
      process.platform !== "win32" || process.arch !== "x64"
    ))) process.exit(1);
'@ ([string][bool]($env:AGENC_INSTALL_PLATFORM -or $env:AGENC_INSTALL_ARCH)).ToLowerInvariant()
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

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$binDir*") {
    Write-Log "NOTE: $binDir is not on your PATH. Add it via:  setx PATH `"$binDir;%PATH%`""
  }

  # Daemon-as-service on Windows uses WinSW with packaging/windows/agenc-daemon.xml;
  # see docs/install.md. Manual start works out of the box:
  Write-Log "install complete"
  Write-Host ""
  Write-Host "  AgenC $version installed."
  Write-Host ""
  Write-Host "  Next steps:"
  Write-Host "    $shim                # start the interactive TUI"
  Write-Host "    $shim doctor         # verify the installation"
  Write-Host "    $shim daemon start   # start the daemon"
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
