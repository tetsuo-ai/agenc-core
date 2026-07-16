import { execa } from 'execa'
import { readFile, realpath } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, join, posix, win32 } from 'path'
import { checkGlobalInstallPermissions } from './autoUpdater.js'
import { isInBundledMode } from './bundledMode.js'
import {
  formatAutoUpdaterDisabledReason,
  getAutoUpdaterDisabledReason,
  getGlobalConfig,
  type InstallMethod,
} from './config.js'
import { loadConfig } from '../config/loader.js'
import type { TransactionGuardConfig } from '../config/schema.js'
import {
  resolveTransactionGuardPolicy,
  type TransactionGuardValueSource,
} from '../transaction-guard/config.js'
import { getCwd } from './cwd.js'
import { isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  getDetectedLocalInstallDir,
  getShellType,
  isRunningFromLocalInstallation,
  localInstallationExists,
} from './localInstaller.js'
import {
  detectApk,
  detectAsdf,
  detectDeb,
  detectHomebrew,
  detectMise,
  detectPacman,
  detectRpm,
  detectWinget,
  getPackageManager,
} from './nativeInstaller/packageManagers.js'
import { getPlatform } from './platform.js'
import {
  getRipgrepInstallHint,
  getRipgrepStatus,
  probeRipgrepAvailable,
} from './ripgrep.js'
import { SandboxManager } from './sandbox/sandbox-runtime.js'
import {
  SandboxExecutionBroker,
  type SandboxExecutionStatus,
} from '../sandbox/execution-broker.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import {
  findAgenCAlias,
  findValidAgenCAlias,
  getShellConfigPaths,
} from './shellConfig.js'
import { jsonParse } from './slowOperations.js'
import { which } from './which.js'

function getCliBinaryName(): string {
  return MACRO.PACKAGE_URL === '@tetsuo-ai/runtime'
    ? 'agenc'
    : 'agenc'
}

function getNativeDataDirName(): string {
  return getCliBinaryName()
}

export type InstallationType =
  | 'npm-global'
  | 'npm-local'
  | 'native'
  | 'package-manager'
  | 'development'
  | 'unknown'

export type DiagnosticInfo = {
  installationType: InstallationType
  version: string
  installationPath: string
  invokedBinary: string
  configInstallMethod: InstallMethod | 'not set'
  autoUpdates: string
  hasUpdatePermissions: boolean | null
  multipleInstallations: Array<{ type: string; path: string }>
  warnings: Array<{ issue: string; fix: string }>
  recommendation?: string
  packageManager?: string
  ripgrepStatus: {
    working: boolean
    mode: 'system' | 'builtin' | 'embedded'
    systemPath: string | null
  }
  transactionGuard: TransactionGuardDoctorStatus
  sandbox: SandboxExecutionStatus
}

export type TransactionGuardDoctorStatus = {
  enabled: boolean
  /** Where the enabled/disabled decision came from. */
  source: TransactionGuardValueSource
  model: string
  endpoint: string
  failMode: 'open' | 'closed'
  /** `null` when the guard is disabled (endpoint not probed). */
  endpointReachable: boolean | null
}

function getNormalizedPaths(): [invokedPath: string, execPath: string] {
  let invokedPath = process.argv[1] || ''
  let execPath = process.execPath || process.argv[0] || ''

  // On Windows, convert backslashes to forward slashes for consistent path matching
  if (getPlatform() === 'windows') {
    invokedPath = invokedPath.split(win32.sep).join(posix.sep)
    execPath = execPath.split(win32.sep).join(posix.sep)
  }

  return [invokedPath, execPath]
}

export async function getCurrentInstallationType(): Promise<InstallationType> {
  if (process.env.NODE_ENV === 'development') {
    return 'development'
  }

  const [invokedPath] = getNormalizedPaths()

  // Check if running in bundled mode first
  if (isInBundledMode()) {
    // Check if this bundled instance was installed by a package manager
    if (
      detectHomebrew() ||
      detectWinget() ||
      detectMise() ||
      detectAsdf() ||
      (await detectPacman()) ||
      (await detectDeb()) ||
      (await detectRpm()) ||
      (await detectApk())
    ) {
      return 'package-manager'
    }
    return 'native'
  }

  // Check if running from local npm installation
  if (isRunningFromLocalInstallation()) {
    return 'npm-local'
  }

  // Check if we're in a typical npm global location
  const npmGlobalPaths = [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/.nvm/versions/node/', // nvm installations
  ]

  if (npmGlobalPaths.some(path => invokedPath.includes(path))) {
    return 'npm-global'
  }

  // Also check for npm/nvm in the path even if not in standard locations
  if (invokedPath.includes('/npm/') || invokedPath.includes('/nvm/')) {
    return 'npm-global'
  }

  const npmConfigResult = await execa('npm config get prefix', {
    shell: true,
    reject: false,
  })
  const globalPrefix =
    npmConfigResult.exitCode === 0 ? npmConfigResult.stdout.trim() : null

  if (globalPrefix && invokedPath.startsWith(globalPrefix)) {
    return 'npm-global'
  }

  // If we can't determine, return unknown
  return 'unknown'
}

async function getInstallationPath(): Promise<string> {
  if (process.env.NODE_ENV === 'development') {
    return getCwd()
  }

  // For bundled/native builds, show the binary location
  if (isInBundledMode()) {
    // Try to find the actual binary that was invoked
    try {
      return await realpath(process.execPath)
    } catch {
      // This function doesn't expect errors
    }

    try {
      const path = await which(getCliBinaryName())
      if (path) {
        return path
      }
    } catch {
      // This function doesn't expect errors
    }

    // If we can't find it, check common locations
    try {
      const nativeBinaryPath = join(
        homedir(),
        '.local',
        'bin',
        getCliBinaryName(),
      )
      await getFsImplementation().stat(nativeBinaryPath)
      return nativeBinaryPath
    } catch {
      // Not found
    }
    return 'native'
  }

  // For npm installations, use the path of the executable
  try {
    return process.argv[0] || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function getInvokedBinary(): string {
  try {
    // For bundled/compiled executables, show the actual binary path
    if (isInBundledMode()) {
      return process.execPath || 'unknown'
    }

    // For npm/development, show the script path
    return process.argv[1] || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function detectMultipleInstallations(): Promise<
  Array<{ type: string; path: string }>
> {
  const fs = getFsImplementation()
  const installations: Array<{ type: string; path: string }> = []

  // Check for local installation
  const localPath = await getDetectedLocalInstallDir()
  if (localPath) {
    installations.push({ type: 'npm-local', path: localPath })
  }

  // Check for global npm installation
  const packagesToCheck = ['@tetsuo-ai/runtime']
  if (MACRO.PACKAGE_URL && MACRO.PACKAGE_URL !== '@tetsuo-ai/runtime') {
    packagesToCheck.push(MACRO.PACKAGE_URL)
  }
  const npmResult = await execFileNoThrow('npm', [
    '-g',
    'config',
    'get',
    'prefix',
  ])
  if (npmResult.code === 0 && npmResult.stdout) {
    const npmPrefix = npmResult.stdout.trim()
    const isWindows = getPlatform() === 'windows'

    // First check for active installations via bin/agenc
    // Linux / macOS have prefix/bin/agenc and prefix/lib/node_modules
    // Windows has prefix/agenc and prefix/node_modules
    const globalBinPath = isWindows
      ? join(npmPrefix, getCliBinaryName())
      : join(npmPrefix, 'bin', getCliBinaryName())

    let globalBinExists = false
    try {
      await fs.stat(globalBinPath)
      globalBinExists = true
    } catch {
      // Not found
    }

    if (globalBinExists) {
      // Check if this is actually a Homebrew cask installation, not npm-global
      // When npm is installed via Homebrew, both can exist at /opt/homebrew/bin/agenc
      // We need to resolve the symlink to see where it actually points
      let isCurrentHomebrewInstallation = false

      try {
        // Resolve the symlink to get the actual target
        const realPath = await realpath(globalBinPath)

        // If the symlink points to a Caskroom directory, it's a Homebrew cask
        // Only skip it if it's the same Homebrew installation we're currently running from
        if (realPath.includes('/Caskroom/')) {
          isCurrentHomebrewInstallation = detectHomebrew()
        }
      } catch {
        // If we can't resolve the symlink, include it anyway
      }

      if (!isCurrentHomebrewInstallation) {
        installations.push({ type: 'npm-global', path: globalBinPath })
      }
    } else {
      // If no bin/agenc exists, check for orphaned packages (no bin/agenc symlink)
      for (const packageName of packagesToCheck) {
        const globalPackagePath = isWindows
          ? join(npmPrefix, 'node_modules', packageName)
          : join(npmPrefix, 'lib', 'node_modules', packageName)

        try {
          await fs.stat(globalPackagePath)
          installations.push({
            type: 'npm-global-orphan',
            path: globalPackagePath,
          })
        } catch {
          // Package not found
        }
      }
    }
  }

  // Check for native installation

  // Check common native installation paths
  const nativeBinPath = join(homedir(), '.local', 'bin', getCliBinaryName())
  try {
    await fs.stat(nativeBinPath)
    installations.push({ type: 'native', path: nativeBinPath })
  } catch {
    // Not found
  }

  // Also check if config indicates native installation
  const config = getGlobalConfig()
  if (config.installMethod === 'native') {
    const nativeDataPath = join(
      homedir(),
      '.local',
      'share',
      getNativeDataDirName(),
    )
    try {
      await fs.stat(nativeDataPath)
      if (!installations.some(i => i.type === 'native')) {
        installations.push({ type: 'native', path: nativeDataPath })
      }
    } catch {
      // Not found
    }
  }

  return installations
}

async function detectConfigurationIssues(
  type: InstallationType,
): Promise<Array<{ issue: string; fix: string }>> {
  const warnings: Array<{ issue: string; fix: string }> = []

  // Managed-settings forwards-compat: the schema preprocess silently drops
  // unknown strictPluginOnlyCustomization surface names so one future enum
  // value doesn't null out the entire policy file (settings.ts:101). But
  // admins should KNOW — read the raw file and diff. Runs before the
  // development-mode early return: this is config correctness, not an
  // install-path check, and it's useful to see during dev testing.
  try {
    const raw = await readFile(
      join(getManagedFilePath(), 'managed-settings.json'),
      'utf-8',
    )
    const parsed: unknown = jsonParse(raw)
    const field =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).strictPluginOnlyCustomization
        : undefined
    if (field !== undefined && typeof field !== 'boolean') {
      if (!Array.isArray(field)) {
        // .catch(undefined) in the schema silently drops this, so the rest
        // of managed settings survive — but the admin typed something
        // wrong (an object, a string, etc.).
        warnings.push({
          issue: `managed-settings.json: strictPluginOnlyCustomization has an invalid value (expected true or an array, got ${typeof field})`,
          fix: `The field is silently ignored (schema .catch rescues it). Set it to true, or an array of: ${CUSTOMIZATION_SURFACES.join(', ')}.`,
        })
      } else {
        const unknown = field.filter(
          x =>
            typeof x === 'string' &&
            !(CUSTOMIZATION_SURFACES as readonly string[]).includes(x),
        )
        if (unknown.length > 0) {
          warnings.push({
            issue: `managed-settings.json: strictPluginOnlyCustomization has ${unknown.length} value(s) this client doesn't recognize: ${unknown.map(String).join(', ')}`,
            fix: `These are silently ignored (forwards-compat). Known surfaces for this version: ${CUSTOMIZATION_SURFACES.join(', ')}. Either remove them, or this client is older than the managed-settings intended.`,
          })
        }
      }
    }
  } catch {
    // ENOENT (no managed settings) / parse error — not this check's concern.
    // Parse errors are surfaced by the settings loader itself.
  }

  const config = getGlobalConfig()

  // Skip most warnings for development mode
  if (type === 'development') {
    return warnings
  }

  // Check if ~/.local/bin is in PATH for native installations
  if (type === 'native') {
    const path = process.env.PATH || ''
    const pathDirectories = path.split(delimiter)
    const homeDir = homedir()
    const localBinPath = join(homeDir, '.local', 'bin')

    // On Windows, convert backslashes to forward slashes for consistent path matching
    let normalizedLocalBinPath = localBinPath
    if (getPlatform() === 'windows') {
      normalizedLocalBinPath = localBinPath.split(win32.sep).join(posix.sep)
    }

    // Check if ~/.local/bin is in PATH (handle both expanded and unexpanded forms)
    // Also handle trailing slashes that users may have in their PATH
    const localBinInPath = pathDirectories.some(dir => {
      let normalizedDir = dir
      if (getPlatform() === 'windows') {
        normalizedDir = dir.split(win32.sep).join(posix.sep)
      }
      // Remove trailing slashes for comparison (handles paths like /home/user/.local/bin/)
      const trimmedDir = normalizedDir.replace(/\/+$/, '')
      const trimmedRawDir = dir.replace(/[/\\]+$/, '')
      return (
        trimmedDir === normalizedLocalBinPath ||
        trimmedRawDir === '~/.local/bin' ||
        trimmedRawDir === '$HOME/.local/bin'
      )
    })

    if (!localBinInPath) {
      const isWindows = getPlatform() === 'windows'
      if (isWindows) {
        // Windows-specific PATH instructions
        const windowsLocalBinPath = localBinPath
          .split(posix.sep)
          .join(win32.sep)
        warnings.push({
          issue: `Native installation exists but ${windowsLocalBinPath} is not in your PATH`,
          fix: `Add it by opening: System Properties → Environment Variables → Edit User PATH → New → Add the path above. Then restart your terminal.`,
        })
      } else {
        // Unix-style PATH instructions
        const shellType = getShellType()
        const configPaths = getShellConfigPaths()
        const configFile = configPaths[shellType as keyof typeof configPaths]
        const displayPath = configFile
          ? configFile.replace(homedir(), '~')
          : 'your shell config file'

        warnings.push({
          issue:
            'Native installation exists but ~/.local/bin is not in your PATH',
          fix: `Run: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${displayPath} then open a new terminal or run: source ${displayPath}`,
        })
      }
    }
  }

  // Check for configuration mismatches
  // Skip these checks if DISABLE_INSTALLATION_CHECKS is set (e.g., in HFI)
  if (!isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
    if (type === 'npm-local' && config.installMethod !== 'local') {
      warnings.push({
        issue: `Running from local installation but config install method is '${config.installMethod}'`,
        fix: `Consider using native installation: ${getCliBinaryName()} install`,
      })
    }

    if (type === 'native' && config.installMethod !== 'native') {
      warnings.push({
        issue: `Running native installation but config install method is '${config.installMethod}'`,
        fix: `Run ${getCliBinaryName()} install to update configuration`,
      })
    }
  }

  if (type === 'npm-global' && (await localInstallationExists())) {
    warnings.push({
      issue: 'Local installation exists but not being used',
      fix: `Consider using native installation: ${getCliBinaryName()} install`,
    })
  }

  const existingAlias = await findAgenCAlias()
  const validAlias = await findValidAgenCAlias()

  // Check if running local installation but it's not in PATH
  if (type === 'npm-local') {
    // Check if agenc is already accessible via PATH
    const whichResult = await which(getCliBinaryName())
    const agencInPath = !!whichResult

    // Only show warning if agenc is NOT in PATH AND no valid alias exists
    if (!agencInPath && !validAlias) {
      if (existingAlias) {
        // Alias exists but points to invalid target
        warnings.push({
          issue: 'Local installation not accessible',
          fix: `Alias exists but points to invalid target: ${existingAlias}. Update alias: alias ${getCliBinaryName()}="~/.agenc/local/${getCliBinaryName()}"`,
        })
      } else {
        // No alias exists and not in PATH
        warnings.push({
          issue: 'Local installation not accessible',
          fix: `Create alias: alias ${getCliBinaryName()}="~/.agenc/local/${getCliBinaryName()}"`,
        })
      }
    }
  }

  return warnings
}

export function detectLinuxGlobPatternWarnings(): Array<{
  issue: string
  fix: string
}> {
  if (getPlatform() !== 'linux') {
    return []
  }

  const warnings: Array<{ issue: string; fix: string }> = []
  const globPatterns = SandboxManager.getLinuxGlobPatternWarnings()

  if (globPatterns.length > 0) {
    // Show first 3 patterns, then indicate if there are more
    const displayPatterns = globPatterns.slice(0, 3).join(', ')
    const remaining = globPatterns.length - 3
    const patternList =
      remaining > 0 ? `${displayPatterns} (${remaining} more)` : displayPatterns

    warnings.push({
      issue: `Glob patterns in sandbox permission rules are not fully supported on Linux`,
      fix: `Found ${globPatterns.length} pattern(s): ${patternList}. On Linux, glob patterns in Edit/Read rules will be ignored.`,
    })
  }

  return warnings
}

/**
 * Build an actionable warning when ripgrep can't be started. No rg binary is
 * bundled, so on a clean machine without system rg the `Glob` tool hard-fails
 * and `Grep` drops to a slower pure-JS fallback. Surface the install command
 * here (`agenc doctor` gates its exit code on warnings) instead of leaving the
 * status line as the only signal. Pure so it can be unit-tested directly.
 */
export function buildRipgrepWarning(
  status: { working: boolean; mode: 'system' | 'builtin' | 'embedded' },
  platform: NodeJS.Platform = process.platform,
): { issue: string; fix: string } | null {
  if (status.working) {
    return null
  }
  return {
    issue:
      'ripgrep (rg) could not be started — Glob will fail and Grep falls back to a slower pure-JS search',
    fix: getRipgrepInstallHint(platform),
  }
}

/**
 * Short-timeout reachability probe for the transaction-guard endpoint.
 * Any HTTP response (even 404/405) proves the endpoint is reachable;
 * only network errors / timeouts report unreachable. Never throws.
 */
export async function probeTransactionGuardEndpoint(
  endpoint: string,
  timeoutMs = 1_500,
): Promise<boolean> {
  let target: URL
  try {
    target = new URL(endpoint)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return false
  }
  try {
    await fetch(target, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the effective transaction-guard status for `agenc doctor`:
 * the `[transaction_guard]` config block merged with env overrides
 * (env > config > defaults), plus an endpoint reachability probe when
 * the guard is enabled.
 *
 * `opts.config` short-circuits the disk load for tests (`null` = "no
 * config block on disk"); `opts.probe` injects the reachability check.
 */
export async function getTransactionGuardDoctorStatus(opts?: {
  config?: TransactionGuardConfig | null
  env?: NodeJS.ProcessEnv
  probe?: (endpoint: string) => Promise<boolean>
}): Promise<TransactionGuardDoctorStatus> {
  const env = opts?.env ?? process.env
  let guardConfig: TransactionGuardConfig | undefined =
    opts?.config === null ? undefined : opts?.config
  if (guardConfig === undefined && opts?.config === undefined) {
    try {
      const loaded = await loadConfig({ onWarn: () => {} })
      guardConfig = loaded.config.transaction_guard
    } catch {
      // No resolvable AGENC home / unreadable config — env-only status.
    }
  }
  const { policy, sources } = resolveTransactionGuardPolicy(guardConfig, env)
  const probe = opts?.probe ?? probeTransactionGuardEndpoint
  let endpointReachable: boolean | null = null
  if (policy.enabled) {
    try {
      endpointReachable = await probe(policy.ollamaUrl)
    } catch {
      // The doctor path never throws on probe failure.
      endpointReachable = false
    }
  }
  return {
    enabled: policy.enabled,
    source: sources.enabled,
    model: policy.model,
    endpoint: policy.ollamaUrl,
    failMode: policy.failClosed ? 'closed' : 'open',
    endpointReachable,
  }
}

/**
 * Actionable warning when the guard is enabled but its endpoint is down.
 * Pure so it can be unit-tested directly (same shape as
 * {@link buildRipgrepWarning}).
 */
export function buildTransactionGuardWarning(
  status: TransactionGuardDoctorStatus,
): { issue: string; fix: string } | null {
  if (!status.enabled || status.endpointReachable !== false) {
    return null
  }
  const consequence =
    status.failMode === 'closed'
      ? 'fail mode is "closed", so guarded transaction-like tool calls are blocked until it is reachable'
      : 'fail mode is "open", so guarded transaction-like tool calls currently run WITHOUT the SLM guard'
  return {
    issue: `transaction guard is enabled but its endpoint ${status.endpoint} is unreachable — ${consequence}`,
    fix: `Start the Ollama endpoint (e.g. \`ollama serve\` and \`ollama pull ${status.model}\`) or point [transaction_guard].endpoint / AGENC_TRANSACTION_GUARD_OLLAMA_URL at a reachable host`,
  }
}

export async function getSandboxDoctorStatus(opts?: {
  config?: Pick<Awaited<ReturnType<typeof loadConfig>>['config'], 'sandbox_mode' | 'sandbox'> | null
  env?: NodeJS.ProcessEnv
  cwd?: string
  probe?: ConstructorParameters<typeof SandboxExecutionBroker>[0]['probe']
}): Promise<SandboxExecutionStatus> {
  const env = opts?.env ?? process.env
  let config = opts?.config === null ? undefined : opts?.config
  if (config === undefined && opts?.config === undefined) {
    try {
      config = (await loadConfig({ onWarn: () => {} })).config
    } catch {
      // Defaults remain fail-closed when config is unreadable.
    }
  }
  const rawMode = config?.sandbox_mode
  const mode = rawMode === 'read-only'
    ? 'read_only'
    : rawMode === 'danger-full-access'
      ? 'danger_full_access'
      : 'workspace_write'
  return new SandboxExecutionBroker({
    mode,
    cwd: opts?.cwd ?? getCwd() ?? process.cwd(),
    env,
    allowGpu: config?.sandbox?.allow_gpu === true,
    ...(opts?.probe !== undefined ? { probe: opts.probe } : {}),
  }).status()
}

export function buildSandboxWarning(
  status: SandboxExecutionStatus,
): { issue: string; fix: string } | null {
  if (status.kind !== 'unavailable') return null
  return {
    issue: `[sandbox_required_unavailable] ${status.reason ?? 'required platform sandbox is unavailable'}`,
    fix: status.remediation ??
      'Install the required platform sandbox support or select danger-full-access explicitly.',
  }
}

export async function getDoctorDiagnostic(): Promise<DiagnosticInfo> {
  const installationType = await getCurrentInstallationType()
  // The bundler substitutes `MACRO.VERSION` (property access) with a string
  // literal at build time, but never defines the bare `MACRO` identifier — so a
  // `typeof MACRO !== 'undefined'` guard always reports the global as undefined
  // under the built binary and falls through to 'unknown'. Read `MACRO.VERSION`
  // directly, the same canonical build-time source the `--version` path uses.
  const version = MACRO.VERSION || 'unknown'
  const installationPath = await getInstallationPath()
  const invokedBinary = getInvokedBinary()
  const multipleInstallations = await detectMultipleInstallations()
  const warnings = await detectConfigurationIssues(installationType)

  // Add glob pattern warnings for Linux sandboxing
  warnings.push(...detectLinuxGlobPatternWarnings())

  // Add warnings for leftover npm installations when running native
  if (installationType === 'native') {
    const npmInstalls = multipleInstallations.filter(
      i =>
        i.type === 'npm-global' ||
        i.type === 'npm-global-orphan' ||
        i.type === 'npm-local',
    )

    const isWindows = getPlatform() === 'windows'

    for (const install of npmInstalls) {
      if (install.type === 'npm-global') {
        let uninstallCmd = 'npm -g uninstall @tetsuo-ai/runtime'
        if (
          MACRO.PACKAGE_URL &&
          MACRO.PACKAGE_URL !== '@tetsuo-ai/runtime'
        ) {
          uninstallCmd += ` && npm -g uninstall ${MACRO.PACKAGE_URL}`
        }
        warnings.push({
          issue: `Leftover npm global installation at ${install.path}`,
          fix: `Run: ${uninstallCmd}`,
        })
      } else if (install.type === 'npm-global-orphan') {
        warnings.push({
          issue: `Orphaned npm global package at ${install.path}`,
          fix: isWindows
            ? `Run: rmdir /s /q "${install.path}"`
            : `Run: rm -rf ${install.path}`,
        })
      } else if (install.type === 'npm-local') {
        warnings.push({
          issue: `Leftover npm local installation at ${install.path}`,
          fix: isWindows
            ? `Run: rmdir /s /q "${install.path}"`
            : `Run: rm -rf ${install.path}`,
        })
      }
    }
  }

  const config = getGlobalConfig()

  // Get config values for display
  const configInstallMethod = config.installMethod || 'not set'

  // Check permissions for global installations
  let hasUpdatePermissions: boolean | null = null
  if (installationType === 'npm-global') {
    const permCheck = await checkGlobalInstallPermissions()
    hasUpdatePermissions = permCheck.hasPermissions

    // Add warning if no permissions
    if (!hasUpdatePermissions && !getAutoUpdaterDisabledReason()) {
      warnings.push({
        issue: 'Insufficient permissions for auto-updates',
        fix: `Do one of: (1) Re-install node without sudo, or (2) Use \`${getCliBinaryName()} install\` for native installation`,
      })
    }
  }

  // Get ripgrep status and configuration. The lazy first-use probe never runs
  // in the doctor path, so actively probe here to report a truthful status (and
  // an actionable warning) on a clean machine with no system rg.
  const ripgrepStatusRaw = getRipgrepStatus()
  const ripgrepWorking =
    ripgrepStatusRaw.working ?? (await probeRipgrepAvailable())

  // Provide simple ripgrep status info
  const ripgrepStatus = {
    working: ripgrepWorking,
    mode: ripgrepStatusRaw.mode,
    systemPath:
      ripgrepStatusRaw.mode === 'system' ? ripgrepStatusRaw.path : null,
  }

  const ripgrepWarning = buildRipgrepWarning(ripgrepStatus)
  if (ripgrepWarning) {
    warnings.push(ripgrepWarning)
  }

  // Transaction-guard status (config + env merged) with a short-timeout
  // endpoint probe when enabled. Unreachable-but-enabled gets a warning.
  const transactionGuard = await getTransactionGuardDoctorStatus()
  const transactionGuardWarning = buildTransactionGuardWarning(transactionGuard)
  if (transactionGuardWarning) {
    warnings.push(transactionGuardWarning)
  }
  const sandbox = await getSandboxDoctorStatus()
  const sandboxWarning = buildSandboxWarning(sandbox)
  if (sandboxWarning) {
    warnings.push(sandboxWarning)
  }

  // Get package manager info if running from package manager
  const packageManager =
    installationType === 'package-manager'
      ? await getPackageManager()
      : undefined

  const diagnostic: DiagnosticInfo = {
    installationType,
    version,
    installationPath,
    invokedBinary,
    configInstallMethod,
    autoUpdates: (() => {
      const reason = getAutoUpdaterDisabledReason()
      return reason
        ? `disabled (${formatAutoUpdaterDisabledReason(reason)})`
        : 'enabled'
    })(),
    hasUpdatePermissions,
    multipleInstallations,
    warnings,
    packageManager,
    ripgrepStatus,
    transactionGuard,
    sandbox,
  }

  return diagnostic
}
