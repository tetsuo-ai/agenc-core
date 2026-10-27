import { realpathSync } from "node:fs";
import type { Platform } from "../platform.js";

export const HOMEBREW_UPDATE_COMMAND = "brew upgrade tetsuo-ai/agenc/agenc";

type HomebrewDetectionOptions = {
  readonly platform?: Platform
  readonly executablePaths?: readonly string[]
}

function homebrewAgenCPathKind(path: string): 'cask' | 'formula' | null {
  let resolvedPath: string
  try { resolvedPath = realpathSync(path) } catch { resolvedPath = path }
  const normalized = resolvedPath.replaceAll('\\', '/')
  if (normalized.includes('/Caskroom/')) {
    return 'cask'
  }
  if (
    /\/(?:Cellar\/agenc\/[^/]+|opt\/agenc)\/(?:bin\/agenc|libexec\/node_modules\/(?:\.agenc-node\/bin\/node|@tetsuo-ai\/runtime\/(?:bin\/agenc|dist\/bin\/agenc\.js)))$/.test(
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
 * Resolve symlinks first, including prefix/bin launchers and opt links.
 * Matching the complete AgenC-owned suffix keeps a Node or npm installation
 * that merely came from Homebrew from being misclassified as the AgenC
 * formula.
 */
export function detectHomebrew(
  options: HomebrewDetectionOptions = {},
): boolean {
  const platform = options.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform)

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
      return true
    }
  }

  return false
}

