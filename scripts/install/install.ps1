# AgenC one-line installer (Windows).
#
#   iwr -useb https://get.agenc.ag/install.ps1 | iex
#
# Same install contract as install.sh and the npm launcher's runtime-manager:
# downloads the win-<arch> runtime tarball from the release manifest, verifies
# its sha256, extracts to $env:AGENC_HOME\runtime\<version>\ with the
# .agenc-runtime-ok marker, and installs an agenc.cmd shim.
#
# Environment overrides:
#   AGENC_INSTALL_MANIFEST_URL  manifest override (file paths supported)
#   AGENC_INSTALL_REPO          GitHub repo (default tetsuo-ai/agenc-releases)
#   AGENC_INSTALL_VERSION       pin a release version
#   AGENC_HOME                  runtime install root (default ~\.agenc)
#   AGENC_INSTALL_PREFIX        shim prefix (default $env:LOCALAPPDATA\agenc)

$ErrorActionPreference = "Stop"
$MinNodeMajor = 25

function Write-Log([string]$msg) { Write-Host "agenc-install: $msg" }
function Fail([string]$msg) { Write-Error "agenc-install: ERROR: $msg"; exit 1 }

# --- prerequisites -----------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js >= $MinNodeMajor is required. Install it (https://nodejs.org) and re-run." }
$nodeMajor = [int](node -e "process.stdout.write(process.versions.node.split('.')[0])")
if ($nodeMajor -lt $MinNodeMajor) { Fail "Node.js >= $MinNodeMajor required, found $(node -v)." }
$tar = Get-Command tar -ErrorAction SilentlyContinue
if (-not $tar) { Fail "tar is required (bundled with Windows 10 1803+)." }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Fail "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

# --- resolve manifest --------------------------------------------------------

$repo = if ($env:AGENC_INSTALL_REPO) { $env:AGENC_INSTALL_REPO } else { "tetsuo-ai/agenc-releases" }
$manifestUrl = $env:AGENC_INSTALL_MANIFEST_URL
if (-not $manifestUrl) {
  if ($env:AGENC_INSTALL_VERSION) {
    $manifestUrl = "https://github.com/$repo/releases/download/agenc-v$($env:AGENC_INSTALL_VERSION)/agenc-runtime-manifest.json"
  } else {
    $manifestUrl = "https://github.com/$repo/releases/latest/download/agenc-runtime-manifest.json"
  }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) "agenc-install-$PID"
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $manifestFile = Join-Path $work "manifest.json"
  Write-Log "fetching release manifest: $manifestUrl"
  if ($manifestUrl -match "^https?://") {
    Invoke-WebRequest -UseBasicParsing -Uri $manifestUrl -OutFile $manifestFile
  } else {
    Copy-Item ($manifestUrl -replace "^file://", "") $manifestFile
  }

  $manifest = Get-Content -Raw $manifestFile | ConvertFrom-Json
  $artifact = $manifest.artifacts | Where-Object { $_.platform -eq "win" -and $_.arch -eq $arch } | Select-Object -First 1
  if (-not $artifact) {
    $have = ($manifest.artifacts | ForEach-Object { "$($_.platform)-$($_.arch)" }) -join ", "
    Fail "no runtime build for win-$arch (available: $have)"
  }
  if (-not $manifest.runtimeVersion -or -not $artifact.url -or $artifact.sha256 -notmatch "^[0-9a-f]{64}$") {
    Fail "manifest artifact is missing runtimeVersion/url/sha256"
  }
  $version = $manifest.runtimeVersion
  $binRel = if ($artifact.bins -and $artifact.bins.agenc) { $artifact.bins.agenc } else { "node_modules/@tetsuo-ai/runtime/bin/agenc" }

  $agencHome = if ($env:AGENC_HOME) { $env:AGENC_HOME } else { Join-Path $env:USERPROFILE ".agenc" }
  $installDir = Join-Path (Join-Path $agencHome "runtime") $version
  $marker = Join-Path $installDir ".agenc-runtime-ok"
  $runtimeBin = Join-Path $installDir ($binRel -replace "/", "\")

  # --- download + verify + extract (idempotent via the marker contract) -----

  $installed = (Test-Path $marker) -and ((Get-Content -Raw $marker).Trim() -eq $artifact.sha256)
  if ($installed) {
    Write-Log "runtime $version already installed (verified marker) - skipping download"
  } else {
    Write-Log "downloading runtime $version (win-$arch)..."
    $tarball = Join-Path $work "runtime.tar.gz"
    if ($artifact.url -match "^https?://") {
      Invoke-WebRequest -UseBasicParsing -Uri $artifact.url -OutFile $tarball
    } else {
      Copy-Item ($artifact.url -replace "^file://", "") $tarball
    }
    $actual = (Get-FileHash -Algorithm SHA256 $tarball).Hash.ToLowerInvariant()
    if ($actual -ne $artifact.sha256) {
      Fail "checksum mismatch for runtime tarball (expected $($artifact.sha256), got $actual). Refusing to install."
    }
    Write-Log "checksum verified"
    if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    tar -xzf $tarball -C $installDir
    if ($LASTEXITCODE -ne 0) { Fail "extraction failed" }
    if (-not (Test-Path $runtimeBin)) { Fail "runtime extracted but entry missing: $runtimeBin" }
    Set-Content -NoNewline -Path $marker -Value $artifact.sha256
    Write-Log "runtime $version installed at $installDir"
  }

  # --- shim ------------------------------------------------------------------

  $prefix = if ($env:AGENC_INSTALL_PREFIX) { $env:AGENC_INSTALL_PREFIX } else { Join-Path $env:LOCALAPPDATA "agenc" }
  $binDir = Join-Path $prefix "bin"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $shim = Join-Path $binDir "agenc.cmd"
  @"
@echo off
rem Generated by AgenC install.ps1 - rewritten on every install/upgrade.
if not defined AGENC_HOME set "AGENC_HOME=$agencHome"
"$($node.Source)" "$runtimeBin" %*
"@ | Set-Content -Path $shim -Encoding ASCII
  Write-Log "installed shim: $shim"

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
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
