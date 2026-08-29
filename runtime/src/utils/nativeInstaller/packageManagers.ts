/**
 * Package manager detection for AgenC CLI
 */

import { readFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from 'src/utils/debug.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { findExecutableOnCapturedPath } from '../findExecutable.js'
import { getPlatform } from '../platform.js'

export type PackageManager =
  | 'homebrew'
  | 'winget'
  | 'pacman'
  | 'deb'
  | 'rpm'
  | 'apk'
  | 'mise'
  | 'asdf'
  | 'unknown'

export type PackageManagerIngress = {
  readonly environment: NodeJS.ProcessEnv
  readonly cwd: string
}

/**
 * Parses /etc/os-release to extract the distro ID and ID_LIKE fields.
 * ID_LIKE identifies the distro family (e.g. Ubuntu has ID_LIKE=debian),
 * letting us skip package manager execs on distros that can't have them.
 * Returns null if the file is unreadable (pre-systemd or non-standard systems);
 * callers fall through to the exec in that case as a conservative fallback.
 */
export const getOsRelease = memoize(
  async (): Promise<{ id: string; idLike: string[] } | null> => {
    try {
      const content = await readFile('/etc/os-release', 'utf8')
      const idMatch = content.match(/^ID=["']?(\S+?)["']?\s*$/m)
      const idLikeMatch = content.match(/^ID_LIKE=["']?(.+?)["']?\s*$/m)
      return {
        id: idMatch?.[1] ?? '',
        idLike: idLikeMatch?.[1]?.split(' ') ?? [],
      }
    } catch {
      return null
    }
  },
)

function isDistroFamily(
  osRelease: { id: string; idLike: string[] },
  families: string[],
): boolean {
  return (
    families.includes(osRelease.id) ||
    osRelease.idLike.some(like => families.includes(like))
  )
}

/**
 * Detects if the currently running AgenC instance was installed via mise
 * (a polyglot tool version manager) by checking if the executable path
 * is within a mise installs directory.
 *
 * mise installs to: ~/.local/share/mise/installs/<tool>/<version>/
 */
export function detectMise(): boolean {
  const execPath = process.execPath || process.argv[0] || ''

  // Check if the executable is within a mise installs directory
  if (/[/\\]mise[/\\]installs[/\\]/i.test(execPath)) {
    logForDebugging(`Detected mise installation: ${execPath}`)
    return true
  }

  return false
}

/**
 * Detects if the currently running AgenC instance was installed via asdf
 * (another polyglot tool version manager) by checking if the executable path
 * is within an asdf installs directory.
 *
 * asdf installs to: ~/.asdf/installs/<tool>/<version>/
 */
export function detectAsdf(): boolean {
  const execPath = process.execPath || process.argv[0] || ''

  // Check if the executable is within an asdf installs directory
  if (/[/\\]\.?asdf[/\\]installs[/\\]/i.test(execPath)) {
    logForDebugging(`Detected asdf installation: ${execPath}`)
    return true
  }

  return false
}

type HomebrewDetectionOptions = {
  readonly platform?: ReturnType<typeof getPlatform>
  readonly executablePaths?: readonly string[]
}

function homebrewAgenCPathKind(path: string): 'cask' | 'formula' | null {
  const normalized = path.replaceAll('\\', '/')
  if (normalized.includes('/Caskroom/')) {
    return 'cask'
  }
  if (
    /\/(?:Cellar\/agenc\/[^/]+|opt\/agenc)\/(?:bin\/agenc|libexec\/node_modules\/(?:\.agenc-node\/bin\/node|@tetsuo-ai\/runtime\/bin\/agenc))$/.test(
      normalized,
    )
  ) {
    return 'formula'
  }
  return null
}

/**
 * Detects if the currently running AgenC instance was installed via Homebrew.
 *
 * The restored formula runs the runtime with its private Node from
 * `<prefix>/Cellar/agenc/<version>/libexec/node_modules/.agenc-node/bin/node`.
 * Matching the complete AgenC-owned suffix keeps a Node or npm installation
 * that merely came from Homebrew from being misclassified as the AgenC
 * formula.
 */
export function detectHomebrew(
  options: HomebrewDetectionOptions = {},
): boolean {
  const platform = options.platform ?? getPlatform()

  // Homebrew is only for macOS and Linux
  if (platform !== 'macos' && platform !== 'linux' && platform !== 'wsl') {
    return false
  }

  const executablePaths = options.executablePaths ?? [
    process.execPath || process.argv[0] || '',
    process.argv[1] || '',
  ]
  for (const path of executablePaths) {
    const kind = homebrewAgenCPathKind(path)
    if (kind !== null) {
      logForDebugging(`Detected Homebrew ${kind} installation: ${path}`)
      return true
    }
  }

  return false
}

/**
 * Detects if the currently running AgenC instance was installed via winget
 * by checking if the executable path is within a WinGet directory.
 *
 * Winget installs to:
 * - User: %LOCALAPPDATA%\Microsoft\WinGet\Packages
 * - System: C:\Program Files\WinGet\Packages
 * And creates links at: %LOCALAPPDATA%\Microsoft\WinGet\Links\
 */
export function detectWinget(): boolean {
  const platform = getPlatform()

  // Winget is only for Windows
  if (platform !== 'windows') {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  // Check for WinGet paths (handles both forward and backslashes)
  const wingetPatterns = [
    /Microsoft[/\\]WinGet[/\\]Packages/i,
    /Microsoft[/\\]WinGet[/\\]Links/i,
  ]

  for (const pattern of wingetPatterns) {
    if (pattern.test(execPath)) {
      logForDebugging(`Detected winget installation: ${execPath}`)
      return true
    }
  }

  return false
}

/**
 * Detects if the currently running AgenC instance was installed via pacman
 * by querying pacman's database for file ownership.
 *
 * We gate on the Arch distro family before invoking pacman. On other distros
 * like Ubuntu/Debian, 'pacman' in PATH may resolve to the pacman game
 * (/usr/games/pacman) rather than the Arch package manager.
 */
async function detectPacmanForEnvironment(
  ingress: PackageManagerIngress,
): Promise<boolean> {
  const platform = getPlatform()

  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  if (osRelease && !isDistroFamily(osRelease, ['arch'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  const executable = await findExecutableOnCapturedPath(
    'pacman',
    ingress.environment,
    ingress.cwd,
  )
  if (executable === null) return false
  const result = await execFileNoThrow(executable, ['-Qo', execPath], {
    timeout: 5000,
    useCwd: false,
    env: ingress.environment,
  })

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected pacman installation: ${result.stdout.trim()}`)
    return true
  }

  return false
}

export const detectPacman = memoize((): Promise<boolean> =>
  detectPacmanForEnvironment({ environment: process.env, cwd: process.cwd() }),
)

/**
 * Detects if the currently running AgenC instance was installed via a .deb package
 * by querying dpkg's database for file ownership.
 *
 * We use `dpkg -S <execPath>` to check if the executable is owned by a dpkg-managed package.
 */
async function detectDebForEnvironment(
  ingress: PackageManagerIngress,
): Promise<boolean> {
  const platform = getPlatform()

  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  if (osRelease && !isDistroFamily(osRelease, ['debian'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  const executable = await findExecutableOnCapturedPath(
    'dpkg',
    ingress.environment,
    ingress.cwd,
  )
  if (executable === null) return false
  const result = await execFileNoThrow(executable, ['-S', execPath], {
    timeout: 5000,
    useCwd: false,
    env: ingress.environment,
  })

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected deb installation: ${result.stdout.trim()}`)
    return true
  }

  return false
}

export const detectDeb = memoize((): Promise<boolean> =>
  detectDebForEnvironment({ environment: process.env, cwd: process.cwd() }),
)

/**
 * Detects if the currently running AgenC instance was installed via an RPM package
 * by querying the RPM database for file ownership.
 *
 * We use `rpm -qf <execPath>` to check if the executable is owned by an RPM package.
 */
async function detectRpmForEnvironment(
  ingress: PackageManagerIngress,
): Promise<boolean> {
  const platform = getPlatform()

  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  if (osRelease && !isDistroFamily(osRelease, ['fedora', 'rhel', 'suse'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  const executable = await findExecutableOnCapturedPath(
    'rpm',
    ingress.environment,
    ingress.cwd,
  )
  if (executable === null) return false
  const result = await execFileNoThrow(executable, ['-qf', execPath], {
    timeout: 5000,
    useCwd: false,
    env: ingress.environment,
  })

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected rpm installation: ${result.stdout.trim()}`)
    return true
  }

  return false
}

export const detectRpm = memoize((): Promise<boolean> =>
  detectRpmForEnvironment({ environment: process.env, cwd: process.cwd() }),
)

/**
 * Detects if the currently running AgenC instance was installed via Alpine APK
 * by querying apk's database for file ownership.
 *
 * We use `apk info --who-owns <execPath>` to check if the executable is owned
 * by an apk-managed package.
 */
async function detectApkForEnvironment(
  ingress: PackageManagerIngress,
): Promise<boolean> {
  const platform = getPlatform()

  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  if (osRelease && !isDistroFamily(osRelease, ['alpine'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  const executable = await findExecutableOnCapturedPath(
    'apk',
    ingress.environment,
    ingress.cwd,
  )
  if (executable === null) return false
  const result = await execFileNoThrow(
    executable,
    ['info', '--who-owns', execPath],
    {
      timeout: 5000,
      useCwd: false,
      env: ingress.environment,
    },
  )

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected apk installation: ${result.stdout.trim()}`)
    return true
  }

  return false
}

export const detectApk = memoize((): Promise<boolean> =>
  detectApkForEnvironment({ environment: process.env, cwd: process.cwd() }),
)

export async function getPackageManagerForIngress(
  ingress: PackageManagerIngress,
): Promise<PackageManager> {
  if (detectHomebrew()) return 'homebrew'
  if (detectWinget()) return 'winget'
  if (detectMise()) return 'mise'
  if (detectAsdf()) return 'asdf'
  if (await detectPacmanForEnvironment(ingress)) return 'pacman'
  if (await detectApkForEnvironment(ingress)) return 'apk'
  if (await detectDebForEnvironment(ingress)) return 'deb'
  if (await detectRpmForEnvironment(ingress)) return 'rpm'
  return 'unknown'
}

/**
 * Memoized function to detect which package manager installed AgenC
 * Returns 'unknown' if no package manager is detected
 */
export const getPackageManager = memoize(async (): Promise<PackageManager> => {
  return getPackageManagerForIngress({
    environment: process.env,
    cwd: process.cwd(),
  })
})
