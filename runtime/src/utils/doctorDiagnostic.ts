import { realpath } from 'fs/promises'
import { homedir } from 'os'
import {
  delimiter,
  dirname,
  join,
  normalize,
  posix,
  resolve,
  win32,
} from 'path'
import { checkGlobalInstallPermissions } from './autoUpdater.js'
import { isInBundledMode } from './bundledMode.js'
import {
  formatAutoUpdaterDisabledReason,
  getAutoUpdaterDisabledReason,
  getRuntimeState,
  type InstallMethod,
} from './config.js'
import {
  loadCanonicalConfig,
  type ConfigScope,
} from '../config/repository.js'
import type { ConfigStoreAuthority } from '../config/store.js'
import type { RuntimeStateRepository } from '../config/runtime-state-repository.js'
import type { TransactionGuardConfig } from '../config/schema.js'
import {
  resolveTransactionGuardPolicy,
} from '../transaction-guard/config.js'
import { selectPinnedRipgrepPath } from '../tools/system/pinned-ripgrep.js'
import { getCwd } from './cwd.js'
import { isEnvTruthy } from './envUtils.js'
import {
  execFileNoThrow,
  execFileNoThrowWithCwd,
} from './execFileNoThrow.js'
import { findExecutableOnCapturedPath } from './findExecutable.js'
import { getFsImplementation } from './fsOperations.js'
import {
  GENERATED_WRAPPER_MAX_BYTES,
  parseGeneratedWrapperContent,
  type GeneratedWrapper,
} from './generated-wrapper.js'
import {
  getDetectedLocalInstallDir,
  getShellType,
  isRunningFromLocalInstallation,
  localInstallationExists,
} from './localInstaller.js'
import {
  detectHomebrew,
  getPackageManager,
  getPackageManagerForIngress,
  type PackageManager,
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
import { probeLandlock } from '../sandbox/landlock-run.js'
import {
  findAgenCAlias,
  findValidAgenCAlias,
  getShellConfigPaths,
} from './shellConfig.js'
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
    grepPinnedWorking: boolean
    mode: 'system' | 'builtin' | 'embedded'
    systemPath: string | null
  }
  transactionGuard: TransactionGuardDoctorStatus
  sandbox: SandboxExecutionStatus
}

export type TransactionGuardDoctorStatus = {
  enabled: boolean
  /** Where the enabled/disabled decision came from. */
  source: ConfigScope | 'resolved-config'
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

export type ActiveGeneratedWrapperOptions = {
  readonly invokedPath?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly cwd?: string
  /**
   * Explicit command path for deterministic callers/tests. `undefined` looks
   * up `agenc` on PATH; `null` deliberately skips wrapper discovery.
   */
  readonly commandPath?: string | null
}

/**
 * Prove that the `agenc` command on PATH is a canonical standalone-installer
 * wrapper for the exact runtime script executing Doctor.
 */
export async function findActiveGeneratedWrapper(
  options: ActiveGeneratedWrapperOptions = {},
): Promise<GeneratedWrapper | null> {
  const invokedPath = options.invokedPath ?? process.argv[1] ?? ''
  if (invokedPath.length === 0) return null

  let commandPath = options.commandPath
  if (commandPath === undefined) {
    try {
      commandPath = options.environment === undefined
        ? await which(getCliBinaryName())
        : await findExecutableOnCapturedPath(
            getCliBinaryName(),
            options.environment,
            options.cwd ?? getCwd() ?? process.cwd(),
          )
    } catch {
      return null
    }
  }
  if (commandPath === null || commandPath.length === 0) return null

  const wrapperPath = resolve(commandPath)
  const fs = getFsImplementation()
  try {
    const before = fs.lstatSync(wrapperPath)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > GENERATED_WRAPPER_MAX_BYTES
    ) {
      return null
    }
    const bytes = await fs.readFileBytes(
      wrapperPath,
      GENERATED_WRAPPER_MAX_BYTES + 1,
    )
    if (bytes.length > GENERATED_WRAPPER_MAX_BYTES) return null
    const after = fs.lstatSync(wrapperPath)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      return null
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const wrapper = parseGeneratedWrapperContent(wrapperPath, content)
    if (wrapper === null) return null
    const [activeRuntime, declaredRuntime] = await Promise.all([
      realpath(resolve(invokedPath)),
      realpath(wrapper.runtimeBin),
    ])
    return activeRuntime === declaredRuntime ? wrapper : null
  } catch {
    return null
  }
}

export type InstallationDetectionOptions = ActiveGeneratedWrapperOptions & {
  readonly activeGeneratedWrapper?: GeneratedWrapper | null
  readonly environment?: NodeJS.ProcessEnv
  readonly packageManager?: PackageManager
}

export type PrivateNodeRuntimeDetectionOptions = {
  readonly nodePath?: string
  readonly runtimePath?: string
}

/**
 * Prove the canonical modern release layout even when its generated wrapper is
 * not on PATH (for example, an operator directly invokes the private runtime).
 * False positives only suppress legacy mutation; they never grant ownership.
 */
export function isRunningFromPrivateNodeRuntime(
  options: PrivateNodeRuntimeDetectionOptions = {},
): boolean {
  const nodePath = options.nodePath ?? process.execPath
  const runtimePath = options.runtimePath ?? process.argv[1] ?? ''
  if (nodePath.length === 0 || runtimePath.length === 0) return false

  const runtimeRoot = resolve(dirname(runtimePath), '..', '..', '..', '..')
  const expectedRuntimePath = join(
    runtimeRoot,
    'node_modules',
    '@tetsuo-ai',
    'runtime',
    'bin',
    'agenc',
  )
  const expectedNodePath =
    getPlatform() === 'windows'
      ? join(runtimeRoot, 'node_modules', '.agenc-node', 'node.exe')
      : join(runtimeRoot, 'node_modules', '.agenc-node', 'bin', 'node')
  const comparable = (path: string): string => {
    const absolute = normalize(resolve(path))
    return getPlatform() === 'windows' ? absolute.toLowerCase() : absolute
  }
  return (
    comparable(runtimePath) === comparable(expectedRuntimePath) &&
    comparable(nodePath) === comparable(expectedNodePath)
  )
}

export async function getCurrentInstallationType(
  options: InstallationDetectionOptions = {},
): Promise<InstallationType> {
  const environment = options.environment ?? process.env
  if (environment.NODE_ENV === 'development') {
    return 'development'
  }

  const [invokedPath] = getNormalizedPaths()

  // Check if running in bundled mode first
  if (isInBundledMode()) {
    // Check if this bundled instance was installed by a package manager
    const packageManager = options.packageManager ??
      (options.environment === undefined
        ? await getPackageManager()
        : await getPackageManagerForIngress({
            environment,
            cwd: options.cwd ?? getCwd() ?? process.cwd(),
          }))
    if (packageManager !== 'unknown') {
      return 'package-manager'
    }
    return 'native'
  }

  const activeGeneratedWrapper = Object.hasOwn(
    options,
    'activeGeneratedWrapper',
  )
    ? (options.activeGeneratedWrapper ?? null)
    : await findActiveGeneratedWrapper(options)
  if (activeGeneratedWrapper !== null) {
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

  const cwd = options.cwd ?? getCwd() ?? process.cwd()
  const npmPath = await findExecutableOnCapturedPath('npm', environment, cwd)
  if (npmPath === null) return 'unknown'
  const npmConfigResult = await execFileNoThrowWithCwd(
    npmPath,
    ['config', 'get', 'prefix'],
    { env: environment, cwd },
  )
  const globalPrefix =
    npmConfigResult.code === 0 ? npmConfigResult.stdout.trim() : null

  if (globalPrefix && invokedPath.startsWith(globalPrefix)) {
    return 'npm-global'
  }

  // If we can't determine, return unknown
  return 'unknown'
}

export async function getInstallationPath(
  options: {
    readonly installationType?: InstallationType
    readonly activeGeneratedWrapper?: GeneratedWrapper | null
    readonly environment?: NodeJS.ProcessEnv
    readonly cwd?: string
  } = {},
): Promise<string> {
  const environment = options.environment ?? process.env
  const cwd = options.cwd ?? getCwd() ?? process.cwd()
  if (environment.NODE_ENV === 'development') {
    return cwd
  }

  const activeGeneratedWrapper = Object.hasOwn(
    options,
    'activeGeneratedWrapper',
  )
    ? (options.activeGeneratedWrapper ?? null)
    : await findActiveGeneratedWrapper()
  const installationType =
    options.installationType ??
    (await getCurrentInstallationType({
      activeGeneratedWrapper,
      environment,
    }))
  if (installationType === 'native' && activeGeneratedWrapper !== null) {
    return activeGeneratedWrapper.path
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
      const path = await findExecutableOnCapturedPath(
        getCliBinaryName(),
        environment,
        cwd,
      )
      if (path) {
        return path
      }
    } catch {
      // This function doesn't expect errors
    }

    // If we can't find it, check common locations
    const platformHome =
      getCapturedPlatformHome(environment) ??
      (options.environment === undefined ? homedir() : undefined)
    if (platformHome !== undefined) {
      try {
        const nativeBinaryPath = join(
          platformHome,
          '.local',
          'bin',
          getCliBinaryName(),
        )
        await getFsImplementation().stat(nativeBinaryPath)
        return nativeBinaryPath
      } catch {
        // Not found
      }
    }
    return 'native'
  }

  // For script-based npm/unknown installations, show the invoked CLI script
  // rather than the Node interpreter that happened to execute it.
  try {
    return process.argv[1] || process.argv[0] || 'unknown'
  } catch {
    return 'unknown'
  }
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function getCapturedPlatformHome(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return (
    nonEmptyEnvironmentValue(environment.HOME) ??
    nonEmptyEnvironmentValue(environment.USERPROFILE)
  )
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

export function retainOnlyMultipleInstallations(
  installations: ReadonlyArray<{ type: string; path: string }>,
): Array<{ type: string; path: string }> {
  const unique = new Map<string, { type: string; path: string }>()
  for (const installation of installations) {
    let key = normalize(resolve(installation.path))
    if (getPlatform() === 'windows') key = key.toLowerCase()
    // A later, more specific detector (notably a verified native wrapper)
    // replaces an earlier heuristic classification of the same path.
    unique.set(key, installation)
  }
  const result = [...unique.values()]
  return result.length > 1 ? result : []
}

export async function detectMultipleInstallations(
  activeGeneratedWrapper: GeneratedWrapper | null,
  stateRepository: RuntimeStateRepository,
  environment: NodeJS.ProcessEnv,
  configHomeDir: string,
  cwd: string,
): Promise<Array<{ type: string; path: string }>> {
  const fs = getFsImplementation()
  const installations: Array<{ type: string; path: string }> = []

  // Check for local installation
  const localPath = await getDetectedLocalInstallDir({ configHomeDir })
  if (localPath) {
    installations.push({ type: 'npm-local', path: localPath })
  }

  // Check for global npm installation
  const packagesToCheck = ['@tetsuo-ai/runtime']
  if (MACRO.PACKAGE_URL && MACRO.PACKAGE_URL !== '@tetsuo-ai/runtime') {
    packagesToCheck.push(MACRO.PACKAGE_URL)
  }
  const npmPath = await findExecutableOnCapturedPath('npm', environment, cwd)
  const npmResult = npmPath === null
    ? { code: 1, stdout: '', stderr: '' }
    : await execFileNoThrowWithCwd(
        npmPath,
        ['-g', 'config', 'get', 'prefix'],
        {
          cwd: getCapturedPlatformHome(environment) ?? cwd,
          env: environment,
        },
      )
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

        // Skip a Homebrew cask or restored formula only when it is the same
        // Homebrew installation currently running. Otherwise a Homebrew npm
        // prefix can make the formula's bin/agenc symlink look npm-global.
        if (detectHomebrew({ executablePaths: [realPath] })) {
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

  if (activeGeneratedWrapper !== null) {
    installations.push({
      type: 'native',
      path: activeGeneratedWrapper.path,
    })
  }

  // Check common native installation paths
  const platformHome = getCapturedPlatformHome(environment)
  if (platformHome !== undefined) {
    const nativeBinPath = join(platformHome, '.local', 'bin', getCliBinaryName())
    try {
      await fs.stat(nativeBinPath)
      installations.push({ type: 'native', path: nativeBinPath })
    } catch {
      // Not found
    }
  }

  // Also check if config indicates native installation
  const config = getRuntimeState(stateRepository)
  if (config.installMethod === 'native' && platformHome !== undefined) {
    const nativeDataPath = join(
      platformHome,
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

  return retainOnlyMultipleInstallations(installations)
}

export async function detectConfigurationIssues(
  type: InstallationType,
  stateRepository: RuntimeStateRepository,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  configHomeDir: string,
): Promise<Array<{ issue: string; fix: string }>> {
  const warnings: Array<{ issue: string; fix: string }> = []

  const config = getRuntimeState(stateRepository)
  // Skip most warnings for development mode
  if (type === 'development') {
    return warnings
  }

  // Check if ~/.local/bin is in PATH for native installations
  const platformHome = getCapturedPlatformHome(environment)
  if (type === 'native' && platformHome !== undefined) {
    const path = environment.PATH ?? environment.Path ?? ''
    const pathDirectories = path.split(delimiter)
    const localBinPath = join(platformHome, '.local', 'bin')

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
        const shellType = getShellType(environment)
        const configPaths = getShellConfigPaths({
          env: environment,
          homedir: platformHome,
        })
        const configFile = configPaths[shellType as keyof typeof configPaths]
        const displayPath = configFile
          ? configFile.replace(platformHome, '~')
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
  if (!isEnvTruthy(environment.DISABLE_INSTALLATION_CHECKS)) {
    if (type === 'npm-local' && config.installMethod !== 'local') {
      warnings.push({
        issue: `Running from local installation but config install method is '${config.installMethod}'`,
        fix: `Consider using native installation: ${getCliBinaryName()} install`,
      })
    }

    if (
      type === 'native' &&
      config.installMethod !== undefined &&
      config.installMethod !== 'unknown' &&
      config.installMethod !== 'native'
    ) {
      warnings.push({
        issue: `Running native installation but config install method is '${config.installMethod}'`,
        fix: `Run ${getCliBinaryName()} install to update configuration`,
      })
    }
  }

  if (
    type === 'npm-global' &&
    (await localInstallationExists({ configHomeDir }))
  ) {
    warnings.push({
      issue: 'Local installation exists but not being used',
      fix: `Consider using native installation: ${getCliBinaryName()} install`,
    })
  }

  const shellConfigOptions = platformHome === undefined
    ? null
    : { env: environment, homedir: platformHome }
  const existingAlias = shellConfigOptions === null
    ? null
    : await findAgenCAlias(shellConfigOptions)
  const validAlias = shellConfigOptions === null
    ? null
    : await findValidAgenCAlias(shellConfigOptions)

  // Check if running local installation but it's not in PATH
  if (type === 'npm-local') {
    // Check if agenc is already accessible via PATH
    const agencInPath =
      (await findExecutableOnCapturedPath(
        getCliBinaryName(),
        environment,
        cwd,
      )) !== null
    const localAliasTarget = join(
      configHomeDir,
      'local',
      getCliBinaryName(),
    )

    // Only show warning if agenc is NOT in PATH AND no valid alias exists
    if (!agencInPath && !validAlias) {
      if (existingAlias) {
        // Alias exists but points to invalid target
        warnings.push({
          issue: 'Local installation not accessible',
          fix: `Alias exists but points to invalid target: ${existingAlias}. Update alias: alias ${getCliBinaryName()}="${localAliasTarget}"`,
        })
      } else {
        // No alias exists and not in PATH
        warnings.push({
          issue: 'Local installation not accessible',
          fix: `Create alias: alias ${getCliBinaryName()}="${localAliasTarget}"`,
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

/** Build the configured-ripgrep warning used by the interactive runtime. */
export function buildRipgrepWarning(
  status: { working: boolean; mode: 'system' | 'builtin' | 'embedded' },
  platform: NodeJS.Platform = process.platform,
): { issue: string; fix: string } | null {
  if (status.working) {
    return null
  }
  return {
    issue:
      'configured ripgrep (rg) could not be started — interactive search requires this configured search runtime',
    fix: getRipgrepInstallHint(platform),
  }
}

/**
 * Build the independent warning for the lockfile-pinned tool search runtime.
 * A PATH executable is deliberately not a substitute for this trust boundary.
 */
export function buildPinnedGrepWarning(status: {
  grepPinnedWorking: boolean
}): { issue: string; fix: string } | null {
  if (status.grepPinnedWorking) {
    return null
  }
  return {
    issue:
      "Grep, Glob, and Orient could not start AgenC's packaged pinned binary and have no JavaScript fallback",
    fix:
      'Run `agenc doctor` and `agenc --version`, then reinstall that same AgenC version to restore its packaged ripgrep binary. A PATH-installed `rg` does not repair Grep, Glob, or Orient.',
  }
}

/** Pure diagnostic seam keeping configured and packaged probes separate. */
export function buildRipgrepWarnings(
  status: {
    working: boolean
    grepPinnedWorking: boolean
    mode: 'system' | 'builtin' | 'embedded'
  },
  platform: NodeJS.Platform = process.platform,
): Array<{ issue: string; fix: string }> {
  const warnings = [
    buildRipgrepWarning(status, platform),
    buildPinnedGrepWarning(status),
  ]
  return warnings.filter(
    (warning): warning is { issue: string; fix: string } => warning !== null,
  )
}

/** Build the public status and warnings from the two independent probes. */
export function buildRipgrepDiagnostic(
  configured: {
    working: boolean
    mode: 'system' | 'builtin' | 'embedded'
    systemPath: string | null
  },
  grepPinnedWorking: boolean,
  platform: NodeJS.Platform = process.platform,
): {
  ripgrepStatus: DiagnosticInfo['ripgrepStatus']
  warnings: Array<{ issue: string; fix: string }>
} {
  const ripgrepStatus = { ...configured, grepPinnedWorking }
  return {
    ripgrepStatus,
    warnings: buildRipgrepWarnings(ripgrepStatus, platform),
  }
}

export async function probePinnedGrepAvailable(): Promise<boolean> {
  const ripgrepPath = selectPinnedRipgrepPath()
  if (ripgrepPath === undefined) return false
  const result = await execFileNoThrow(
    ripgrepPath,
    ['--no-config', '--version'],
    {
      timeout: 5_000,
      preserveOutputOnError: false,
      useCwd: false,
      stdin: 'ignore',
    },
  )
  return result.code === 0
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
 * the already-layered canonical `[transaction_guard]` snapshot, plus an
 * endpoint reachability probe when the guard is enabled.
 *
 * `opts.config` short-circuits the disk load for tests (`null` = "no
 * config block on disk"); `opts.probe` injects the reachability check.
 */
export async function getTransactionGuardDoctorStatus(opts?: {
  config?: TransactionGuardConfig | null
  env?: NodeJS.ProcessEnv
  source?: ConfigScope | 'resolved-config'
  probe?: (endpoint: string) => Promise<boolean>
}): Promise<TransactionGuardDoctorStatus> {
  const env = opts?.env ?? process.env
  let guardConfig: TransactionGuardConfig | undefined =
    opts?.config === null ? undefined : opts?.config
  let source: ConfigScope | 'resolved-config' =
    opts?.source ?? 'resolved-config'
  if (guardConfig === undefined && opts?.config === undefined) {
    try {
      const loaded = await loadCanonicalConfig({ env, onWarn: () => {} })
      guardConfig = loaded.config.transaction_guard
      source =
        loaded.provenance['transaction_guard.enabled']?.scope ?? 'default'
    } catch {
      // No resolvable AgenC home / unreadable config — report defaults.
      source = 'default'
    }
  }
  const policy = resolveTransactionGuardPolicy(guardConfig)
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
    source,
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
  config?: Pick<Awaited<ReturnType<typeof loadCanonicalConfig>>['config'], 'sandbox_mode' | 'sandbox'> | null
  env?: NodeJS.ProcessEnv
  cwd?: string
  probe?: ConstructorParameters<typeof SandboxExecutionBroker>[0]['probe']
}): Promise<SandboxExecutionStatus> {
  const env = opts?.env ?? process.env
  let config = opts?.config === null ? undefined : opts?.config
  if (config === undefined && opts?.config === undefined) {
    try {
      config = (await loadCanonicalConfig({ onWarn: () => {} })).config
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
  const status = await new SandboxExecutionBroker({
    mode,
    cwd: opts?.cwd ?? getCwd() ?? process.cwd(),
    env,
    allowGpu: config?.sandbox?.allow_gpu === true,
    ...(opts?.probe !== undefined ? { probe: opts.probe } : {}),
  }).status()
  if (process.platform !== 'linux') return status
  // Report the Landlock rung alongside the bubblewrap status: on hosts where
  // the user namespace is restricted, this is the confinement the kernel can
  // still enforce without any profile or privilege.
  return { ...status, landlock: probeLandlock() }
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

/**
 * Ready-via-Landlock-fallback is degraded readiness: the fallback cannot
 * express sandbox policies that protect .git/.agenc inside writable project
 * roots, so shell in git projects and MCP stdio servers are refused
 * per-spawn even though the probe reports ready. Surface that loudly with
 * the cause-correct bubblewrap remedy computed at probe time.
 */
export function buildLandlockFallbackWarning(
  status: SandboxExecutionStatus,
): { issue: string; fix: string } | null {
  if (status.kind !== 'ready' || status.landlockFallback === undefined) {
    return null
  }
  return {
    issue:
      `[sandbox_landlock_fallback] bubblewrap is unusable (${status.landlockFallback.reason}); ` +
      'the Landlock fallback cannot run sandbox policies that protect .git/.agenc inside ' +
      'writable project roots (shell in git projects, MCP stdio servers)',
    fix: status.landlockFallback.remediation,
  }
}

export async function getDoctorDiagnostic(
  authority: ConfigStoreAuthority,
  ingress: {
    readonly environment: NodeJS.ProcessEnv
    readonly cwd: string
  },
): Promise<DiagnosticInfo> {
  const operatorConfig = authority.current()
  const detectedPackageManager = isInBundledMode()
    ? await getPackageManagerForIngress({
        environment: ingress.environment,
        cwd: ingress.cwd,
      })
    : undefined
  const activeGeneratedWrapper = await findActiveGeneratedWrapper({
    environment: ingress.environment,
    cwd: ingress.cwd,
  })
  const installationType = await getCurrentInstallationType({
    activeGeneratedWrapper,
    environment: ingress.environment,
    cwd: ingress.cwd,
    packageManager: detectedPackageManager,
  })
  // The bundler substitutes `MACRO.VERSION` (property access) with a string
  // literal at build time, but never defines the bare `MACRO` identifier — so a
  // `typeof MACRO !== 'undefined'` guard always reports the global as undefined
  // under the built binary and falls through to 'unknown'. Read `MACRO.VERSION`
  // directly, the same canonical build-time source the `--version` path uses.
  const version = MACRO.VERSION || 'unknown'
  const installationPath = await getInstallationPath({
    installationType,
    activeGeneratedWrapper,
    environment: ingress.environment,
    cwd: ingress.cwd,
  })
  const invokedBinary = getInvokedBinary()
  const multipleInstallations = await detectMultipleInstallations(
    activeGeneratedWrapper,
    authority.stateRepository,
    ingress.environment,
    authority.homeContext.path,
    ingress.cwd,
  )
  const warnings = await detectConfigurationIssues(
    installationType,
    authority.stateRepository,
    ingress.environment,
    ingress.cwd,
    authority.homeContext.path,
  )

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

  const config = getRuntimeState(authority.stateRepository)

  // Get config values for display
  const configInstallMethod = config.installMethod || 'not set'

  // Check permissions for global installations
  let hasUpdatePermissions: boolean | null = null
  if (installationType === 'npm-global') {
    const permCheck = await checkGlobalInstallPermissions({
      environment: ingress.environment,
      cwd:
        getCapturedPlatformHome(ingress.environment) ??
        authority.homeContext.path,
    })
    hasUpdatePermissions = permCheck.hasPermissions

    // Add warning if no permissions
    if (
      !hasUpdatePermissions &&
      !getAutoUpdaterDisabledReason(operatorConfig)
    ) {
      warnings.push({
        issue: 'Insufficient permissions for auto-updates',
        fix: `Do one of: (1) Re-install node without sudo, or (2) Use \`${getCliBinaryName()} install\` for native installation`,
      })
    }
  }

  // Get ripgrep status and configuration. The lazy first-use probe never runs
  // in the doctor path, so actively probe here to report a truthful status (and
  // an actionable warning) on a clean machine with no system rg.
  const capturedRipgrepPath = await findExecutableOnCapturedPath(
    'rg',
    ingress.environment,
    ingress.cwd,
  )
  const ripgrepIngress = {
    environment: ingress.environment,
    systemExecutablePath: capturedRipgrepPath ?? 'rg',
  }
  const ripgrepStatusRaw = getRipgrepStatus(ripgrepIngress)
  const configuredRipgrepWorking =
    ripgrepStatusRaw.working ?? (await probeRipgrepAvailable(ripgrepIngress))
  const grepPinnedWorking = await probePinnedGrepAvailable()

  const ripgrepDiagnostic = buildRipgrepDiagnostic(
    {
      working: configuredRipgrepWorking,
      mode: ripgrepStatusRaw.mode,
      systemPath:
        ripgrepStatusRaw.mode === 'system' ? ripgrepStatusRaw.path : null,
    },
    grepPinnedWorking,
  )
  const { ripgrepStatus } = ripgrepDiagnostic
  warnings.push(...ripgrepDiagnostic.warnings)

  // Transaction-guard status (config + env merged) with a short-timeout
  // endpoint probe when enabled. Unreachable-but-enabled gets a warning.
  const transactionGuard = await getTransactionGuardDoctorStatus({
    config: operatorConfig.transaction_guard ?? null,
    env: ingress.environment,
    source:
      authority.provenance('transaction_guard.enabled')?.scope ??
      'default',
  })
  const transactionGuardWarning = buildTransactionGuardWarning(transactionGuard)
  if (transactionGuardWarning) {
    warnings.push(transactionGuardWarning)
  }
  const sandbox = await getSandboxDoctorStatus({
    config: operatorConfig,
    env: ingress.environment,
    cwd: ingress.cwd,
  })
  const sandboxWarning = buildSandboxWarning(sandbox)
  if (sandboxWarning) {
    warnings.push(sandboxWarning)
  }
  const landlockFallbackWarning = buildLandlockFallbackWarning(sandbox)
  if (landlockFallbackWarning) {
    warnings.push(landlockFallbackWarning)
  }

  // Get package manager info if running from package manager
  const packageManager =
    installationType === 'package-manager'
      ? detectedPackageManager
      : undefined

  const diagnostic: DiagnosticInfo = {
    installationType,
    version,
    installationPath,
    invokedBinary,
    configInstallMethod,
    autoUpdates: (() => {
      const reason = getAutoUpdaterDisabledReason(operatorConfig)
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
