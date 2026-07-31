[CmdletBinding()]
param(
  [Parameter()]
  [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$report = [ordered]@{
  schemaVersion = 1
  slug = $env:AGENC_RELEASE_SLUG
  runnerLabel = $env:AGENC_RUNNER_LABEL
  imageOS = $env:ImageOS
  imageVersion = $env:ImageVersion
  runnerArch = $env:RUNNER_ARCH
}

function Write-ObservedReport {
  if (-not $ReportPath) { return }
  $parent = Split-Path -Parent $ReportPath
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}

function Assert-Exact([string]$Label, [string]$Actual, [string]$Expected) {
  if (-not $Expected) { throw "reviewed $Label must be a non-empty string" }
  if ($Actual -cne $Expected) { throw "$Label drift: '$Actual' != '$Expected'" }
}

try {
  $toolchain = Get-Content -Raw release-toolchain.json | ConvertFrom-Json
  $contract = $toolchain.hostedRunners.PSObject.Properties[$env:AGENC_RELEASE_SLUG].Value
  if ($null -eq $contract) {
    throw "missing hosted runner contract for $env:AGENC_RELEASE_SLUG"
  }
  $profiles = @($contract.imageProfiles)
  if ($profiles.Count -eq 0) {
    throw "hosted runner contract for $env:AGENC_RELEASE_SLUG has no reviewed image profiles"
  }
  $versions = @($profiles | ForEach-Object { $_.imageVersion })
  if (@($versions | Where-Object { -not $_ }).Count -ne 0) {
    throw "hosted runner contract contains an empty image version"
  }
  if (@($versions | Sort-Object -Unique).Count -ne $versions.Count) {
    throw "hosted runner contract contains duplicate image versions"
  }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw "missing $vswhere" }
  $vswhereArgs = @(
    '-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
  )
  $installPath = (& $vswhere @vswhereArgs -property installationPath | Select-Object -First 1).Trim()
  $installationVersion = (& $vswhere @vswhereArgs -property installationVersion | Select-Object -First 1).Trim()
  $report.visualStudioInstallPath = $installPath
  $report.visualStudioVersion = $installationVersion

  $defaultToolsFile = Join-Path $installPath 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'
  if (-not (Test-Path -LiteralPath $defaultToolsFile -PathType Leaf)) {
    throw "missing $defaultToolsFile"
  }
  $report.defaultMsvcToolsVersion = (Get-Content -Raw $defaultToolsFile).Trim()

  $devCmd = Join-Path $installPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $devCmd -PathType Leaf)) { throw "missing $devCmd" }
  $environmentLines = & cmd.exe /d /s /c "`"$devCmd`" -no_logo -arch=x64 -host_arch=x64 && set"
  if ($LASTEXITCODE -ne 0) { throw 'VsDevCmd.bat failed' }
  $required = @(
    'PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VCToolsVersion',
    'WindowsSdkDir', 'WindowsSDKVersion', 'VCINSTALLDIR', 'VSINSTALLDIR'
  )
  $captured = @{}
  foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -le 0) { continue }
    $name = $line.Substring(0, $separator)
    if ($required -notcontains $name) { continue }
    if ($name -ieq 'PATH') { $name = 'PATH' }
    $value = $line.Substring($separator + 1)
    $captured[$name] = $value
    Set-Item -Path "Env:$name" -Value $value
  }
  foreach ($name in $required) {
    if (-not $captured.ContainsKey($name) -or -not $captured[$name]) {
      throw "VsDevCmd.bat did not define $name"
    }
  }

  $toolsVersion = $captured['VCToolsVersion'].TrimEnd([char[]]'\/')
  $sdkVersion = $captured['WindowsSDKVersion'].TrimEnd([char[]]'\/')
  $report.activeMsvcToolsVersion = $toolsVersion
  $report.windowsSdkVersion = $sdkVersion
  $cl = (Get-Command cl.exe -ErrorAction Stop).Source
  $link = (Get-Command link.exe -ErrorAction Stop).Source
  $report.clPath = $cl
  $report.linkPath = $link
  $compilerLines = @(& $cl /Bv 2>&1 | ForEach-Object { $_.ToString().Trim() })
  # /Bv without a source returns nonzero after printing the compiler identity.
  $global:LASTEXITCODE = 0
  $compilerIdentity = $compilerLines |
    Where-Object { $_ -like 'Microsoft (R) C/C++ Optimizing Compiler Version *' } |
    Select-Object -First 1
  $report.msvcCompilerIdentity = $compilerIdentity
  $report.msvcCompilerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $cl).Hash.ToLowerInvariant()
  $report.msvcLinkerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $link).Hash.ToLowerInvariant()
  Write-ObservedReport

  $matchingProfiles = @($profiles | Where-Object { $_.imageVersion -ceq $env:ImageVersion })
  if ($matchingProfiles.Count -ne 1) {
    throw "ImageVersion drift: '$env:ImageVersion' not in '$($versions -join "', '")'"
  }
  $profile = $matchingProfiles[0]

  Assert-Exact 'runner label' $env:AGENC_RUNNER_LABEL $contract.runnerLabel
  Assert-Exact 'ImageOS' $env:ImageOS $contract.imageOS
  Assert-Exact 'RUNNER_ARCH' $env:RUNNER_ARCH $contract.runnerArch
  Assert-Exact 'Visual Studio path' $installPath $profile.visualStudioInstallPath
  Assert-Exact 'Visual Studio version' $installationVersion $profile.visualStudioVersion
  Assert-Exact 'default MSVC tools version' $report.defaultMsvcToolsVersion $profile.msvcToolsVersion
  Assert-Exact 'active MSVC tools version' $toolsVersion $profile.msvcToolsVersion
  Assert-Exact 'active Windows SDK version' $sdkVersion $profile.windowsSdkVersion
  $expectedCompiler = "Microsoft (R) C/C++ Optimizing Compiler Version $($profile.msvcCompilerVersion) for x64"
  Assert-Exact 'MSVC compiler identity' $compilerIdentity $expectedCompiler
  Assert-Exact 'cl.exe SHA-256' $report.msvcCompilerSha256 $profile.msvcCompilerSha256
  Assert-Exact 'link.exe SHA-256' $report.msvcLinkerSha256 $profile.msvcLinkerSha256

  foreach ($name in $required) {
    "$name=$($captured[$name])" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  }
  $builder = "github-hosted:$($contract.runnerLabel):$($contract.imageOS):$($env:ImageVersion):$($contract.runnerArch)"
  @(
    'CC=cl.exe'
    'CXX=cl.exe'
    "AGENC_BUILDER_ID=$builder"
    "AGENC_VISUAL_STUDIO_VERSION=$installationVersion"
    "AGENC_VISUAL_STUDIO_INSTALL_PATH=$installPath"
    "AGENC_MSVC_COMPILER_SHA256=$($report.msvcCompilerSha256)"
    "AGENC_MSVC_LINKER_SHA256=$($report.msvcLinkerSha256)"
  ) | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  Write-Host "approved hosted runner, MSVC $toolsVersion, and Windows SDK $sdkVersion"
}
catch {
  $report.validationError = $_.Exception.Message
  Write-ObservedReport
  throw
}
