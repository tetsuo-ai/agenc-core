/**
 * Utilities for handling local installation
 */

import { access, chmod, writeFile } from 'fs/promises'
import { join } from 'path'
import { type ReleaseChannel, updateRuntimeState } from './config.js'
import { getAgenCHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

// Resolve lazily so each call observes the current session's canonical home;
// module-scope capture would leak one session's authority into another.
function getLocalInstallDir(): string {
  return join(getAgenCHomeDir(), 'local')
}

export type LocalInstallationProbeOptions = {
  readonly configHomeDir?: string
}

export function getCandidateLocalInstallDirs(
  options?: LocalInstallationProbeOptions,
): string[] {
  const configHomeDir = options?.configHomeDir ?? getAgenCHomeDir()
  return [join(configHomeDir, 'local')]
}

function getCandidateLocalBinaryPaths(localInstallDir: string): string[] {
  return [
    join(localInstallDir, 'node_modules', '.bin', 'agenc'),
  ]
}

export function isManagedLocalInstallationPath(execPath: string): boolean {
  const normalizedExecPath = execPath.replace(/\\+/g, '/')
  return (
    normalizedExecPath.includes('/.agenc/local/node_modules/') ||
    normalizedExecPath.includes('/.agenc/local/node_modules/')
  )
}

export function getLocalAgenCPath(): string {
  return join(getLocalInstallDir(), 'agenc')
}

/**
 * Check if we're running from our managed local installation
 */
export function isRunningFromLocalInstallation(): boolean {
  return isManagedLocalInstallationPath(process.argv[1] || '')
}

/**
 * Write `content` to `path` only if the file does not already exist.
 * Uses O_EXCL ('wx') for atomic create-if-missing.
 */
async function writeIfMissing(
  path: string,
  content: string,
  mode?: number,
): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode })
    return true
  } catch (e) {
    if (getErrnoCode(e) === 'EEXIST') return false
    throw e
  }
}

/**
 * Ensure the local package environment is set up
 * Creates the directory, package.json, and wrapper script
 */
export async function ensureLocalPackageEnvironment(): Promise<boolean> {
  try {
    const localInstallDir = getLocalInstallDir()

    // Create installation directory (recursive, idempotent)
    await getFsImplementation().mkdir(localInstallDir)

    // Create package.json if it doesn't exist
    await writeIfMissing(
      join(localInstallDir, 'package.json'),
      jsonStringify(
        { name: 'agenc-local', version: '0.0.1', private: true },
        null,
        2,
      ),
    )

    // Create the wrapper script if it doesn't exist
    const wrapperPath = getLocalAgenCPath()
    const created = await writeIfMissing(
      wrapperPath,
      `#!/bin/sh\nexec "${localInstallDir}/node_modules/.bin/agenc" "$@"`,
      0o755,
    )
    if (created) {
      // Mode in writeFile is masked by umask; chmod to ensure executable bit.
      await chmod(wrapperPath, 0o755)
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}

/**
 * Install or update AgenC CLI package in the local directory
 * @param channel - Release channel to use (latest or stable)
 * @param specificVersion - Optional specific version to install (overrides channel)
 */
export async function installOrUpdateAgenCPackage(
  channel: ReleaseChannel,
  specificVersion?: string | null,
): Promise<'in_progress' | 'success' | 'install_failed'> {
  try {
    // First ensure the environment is set up
    if (!(await ensureLocalPackageEnvironment())) {
      return 'install_failed'
    }

    // Use specific version if provided, otherwise use channel tag
    const versionSpec = specificVersion
      ? specificVersion
      : channel === 'stable'
        ? 'stable'
        : 'latest'
    const result = await execFileNoThrowWithCwd(
      'npm',
      ['install', `${MACRO.PACKAGE_URL}@${versionSpec}`],
      { cwd: getLocalInstallDir(), maxBuffer: 1000000 },
    )

    if (result.code !== 0) {
      const error = new Error(
        `Failed to install AgenC CLI package: ${result.stderr}`,
      )
      logError(error)
      return result.code === 190 ? 'in_progress' : 'install_failed'
    }

    // Set installMethod to 'local' to prevent npm permission warnings
    updateRuntimeState(current => ({
      ...current,
      installMethod: 'local',
    }))

    return 'success'
  } catch (error) {
    logError(error)
    return 'install_failed'
  }
}

/**
 * Check if local installation exists.
 * Pure existence probe — callers use this to choose update path / UI hints.
 */
export async function localInstallationExists(
  options?: LocalInstallationProbeOptions,
): Promise<boolean> {
  for (const localInstallDir of getCandidateLocalInstallDirs(options)) {
    for (const binaryPath of getCandidateLocalBinaryPaths(localInstallDir)) {
      try {
        await access(binaryPath)
        return true
      } catch {
        // Try next candidate
      }
    }
  }
  return false
}

export async function getDetectedLocalInstallDir(
  options?: LocalInstallationProbeOptions,
): Promise<string | null> {
  for (const localInstallDir of getCandidateLocalInstallDirs(options)) {
    for (const binaryPath of getCandidateLocalBinaryPaths(localInstallDir)) {
      try {
        await access(binaryPath)
        return localInstallDir
      } catch {
        // Try next candidate
      }
    }
  }
  return null
}

/**
 * Get shell type to determine appropriate path setup
 */
export function getShellType(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const shellPath = environment.SHELL || ''
  if (shellPath.includes('zsh')) return 'zsh'
  if (shellPath.includes('bash')) return 'bash'
  if (shellPath.includes('fish')) return 'fish'
  return 'unknown'
}
