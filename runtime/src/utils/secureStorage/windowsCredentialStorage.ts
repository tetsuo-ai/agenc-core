import { join } from 'path'
import { jsonStringify } from '../slowOperations.js'
import {
  resolveTrustedWindowsSystemExecutable,
  resolveTrustedWindowsSystemPaths,
} from '../windows-system-path.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
} from './macOsKeychainHelpers.js'
import type { HomeContext } from '../../config/home.js'
import type { SecureStorage, SecureStorageData } from './index.js'
import { decodeSecureStorageData } from './decode.js'
import {
  runSecureStorageCommand,
  type SecureStorageCommandRunner,
} from './subprocess.js'

interface PowerShellResult {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
}

const INJECTED_WINDOWS_POWERSHELL_EXECUTABLE =
  String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

function resolveTrustedWindowsPowerShell(): string {
  return resolveTrustedWindowsSystemExecutable(
    resolveTrustedWindowsSystemPaths(),
    ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
  )
}

/** Windows-specific secure storage implementation using DPAPI. */
function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

function runPowerShell(
  runCommand: SecureStorageCommandRunner,
  getExecutable: () => string,
  script: string,
  options?: { input?: string },
): PowerShellResult | null {
  try {
    return runCommand(getExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      input: options?.input,
      reject: false,
    })
  } catch {
    return null
  }
}

function getFailureWarning(
  result: PowerShellResult | null,
  fallback: string,
): string {
  const stderr = result?.stderr?.trim()
  if (stderr) {
    return stderr
  }

  if (typeof result?.exitCode === 'number' && result.exitCode !== 0) {
    return `${fallback} (exit code ${result.exitCode}).`
  }

  return fallback
}

export function createWindowsCredentialStorage(
  home: HomeContext,
  runCommand: SecureStorageCommandRunner = runSecureStorageCommand,
  identityOverride?: {
    readonly serviceName: string
    readonly homePath: string
    readonly accountName: string
  },
  resolveExecutable?: () => string,
): SecureStorage {
  const username = identityOverride?.accountName ?? home.secureStorageAccount
  const resourceName = identityOverride?.serviceName ??
    getSecureStorageServiceName(home, CREDENTIALS_SERVICE_SUFFIX)
  const entropy = `${resourceName}:${username}`
  const safeResourceName = resourceName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storageFilePath = join(
    identityOverride?.homePath ?? home.path,
    `${safeResourceName}.secure.dpapi`,
  )
  const resolvePowerShell = resolveExecutable ??
    (runCommand === runSecureStorageCommand
      ? resolveTrustedWindowsPowerShell
      : () => INJECTED_WINDOWS_POWERSHELL_EXECUTABLE)
  let powerShellExecutable: string | undefined
  const getPowerShellExecutable = (): string => {
    powerShellExecutable ??= resolvePowerShell()
    if (!/^[a-z]:\\/iu.test(powerShellExecutable)) {
      throw new Error(
        'Windows secure storage PowerShell resolver returned a non-absolute path',
      )
    }
    return powerShellExecutable
  }

  return {
    name: 'windows-dpapi',
    read(): SecureStorageData | null {
      const filePath = escapePowerShellSingleQuoted(storageFilePath)
      const escapedEntropy = escapePowerShellSingleQuoted(entropy)
      const script = `
      $ErrorActionPreference = 'Stop'
      try {
        $path = '${filePath}'
        if (!(Test-Path -LiteralPath $path -PathType Leaf -ErrorAction Stop)) {
          exit 2
        }

        Add-Type -AssemblyName System.Security

        $protectedBase64 = [System.IO.File]::ReadAllText(
          $path,
          [System.Text.Encoding]::UTF8
        ).Trim()
        if (-not $protectedBase64) {
          throw 'Credential record is empty'
        }

        $protectedBytes = [Convert]::FromBase64String($protectedBase64)
        $entropyBytes = [System.Text.Encoding]::UTF8.GetBytes('${escapedEntropy}')
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
          $protectedBytes,
          $entropyBytes,
          [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
      } catch {
        exit 1
      }
    `

      const result = runPowerShell(runCommand, getPowerShellExecutable, script)
      if (result === null) {
        throw new Error('Windows secure storage could not start PowerShell')
      }
      if (result.exitCode === 2 && !result.stderr?.trim()) return null
      if (result.exitCode === 0 && result.stdout?.trim()) {
        return decodeSecureStorageData(
          result.stdout,
          'Windows secure storage',
        )
      }
      throw new Error(
        getFailureWarning(
          result,
          'Windows secure storage could not decrypt the credential record',
        ),
      )
    },
    async readAsync(): Promise<SecureStorageData | null> {
      return this.read()
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      const filePath = escapePowerShellSingleQuoted(storageFilePath)
      const escapedEntropy = escapePowerShellSingleQuoted(entropy)
      const payload = jsonStringify(data)
      const script = `
      $ErrorActionPreference = 'Stop'
      $tempPath = $null
      try {
        Add-Type -AssemblyName System.Security
        $path = '${filePath}'
        $directory = [System.IO.Path]::GetDirectoryName($path)
        if ($directory) {
          [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        }

        $payload = [Console]::In.ReadToEnd()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $entropyBytes = [System.Text.Encoding]::UTF8.GetBytes('${escapedEntropy}')
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
          $bytes,
          $entropyBytes,
          [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $protectedBase64 = [Convert]::ToBase64String($protectedBytes)
        $outputBytes = [System.Text.Encoding]::UTF8.GetBytes($protectedBase64)
        $tempPath = [System.IO.Path]::Combine(
          $directory,
          '.' + [System.IO.Path]::GetFileName($path) + '.' +
            [Guid]::NewGuid().ToString('N') + '.tmp'
        )
        $stream = [System.IO.FileStream]::new(
          $tempPath,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None,
          4096,
          [System.IO.FileOptions]::WriteThrough
        )
        try {
          $stream.Write($outputBytes, 0, $outputBytes.Length)
          $stream.Flush($true)
        } finally {
          $stream.Dispose()
        }
        if ([System.IO.File]::Exists($path)) {
          [System.IO.File]::Replace($tempPath, $path, $null)
        } else {
          [System.IO.File]::Move($tempPath, $path)
        }
        $tempPath = $null
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      } finally {
        if ($tempPath -and [System.IO.File]::Exists($tempPath)) {
          [System.IO.File]::Delete($tempPath)
        }
      }
    `
      const result = runPowerShell(
        runCommand,
        getPowerShellExecutable,
        script,
        { input: payload },
      )
      if (result?.exitCode === 0) {
        return { success: true }
      }

      return {
        success: false,
        warning: getFailureWarning(
          result,
          'Windows secure storage could not encrypt credentials with DPAPI',
        ),
      }
    },
    delete(): boolean {
      const filePath = escapePowerShellSingleQuoted(storageFilePath)
      const removeDpapiScript = `
      $ErrorActionPreference = 'Stop'
      try {
        $path = '${filePath}'
        if (Test-Path -LiteralPath $path -ErrorAction Stop) {
          Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        }
      } catch {
        exit 1
      }
    `
      const removeDpapiResult = runPowerShell(
        runCommand,
        getPowerShellExecutable,
        removeDpapiScript,
      )
      return (removeDpapiResult?.exitCode ?? 1) === 0
    },
  }
}
