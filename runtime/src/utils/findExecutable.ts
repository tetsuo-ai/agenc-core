import { stat } from 'node:fs/promises'
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'

import { getPlatform } from './platform.js'
import { whichSync } from './which.js'

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

/** Resolve one executable exclusively through a captured PATH snapshot. */
export async function findExecutableOnCapturedPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  const searchPath =
    nonEmptyEnvironmentValue(environment.PATH) ??
    nonEmptyEnvironmentValue(environment.Path)
  if (searchPath === undefined) return null

  const windows = getPlatform() === 'windows'
  const extensions =
    windows && extname(command).length === 0
      ? (nonEmptyEnvironmentValue(environment.PATHEXT) ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map(extension => extension.trim())
          .filter(Boolean)
      : ['']
  for (const rawDirectory of searchPath.split(delimiter)) {
    const unquoted = rawDirectory.length >= 2 &&
      rawDirectory.startsWith('"') &&
      rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory
    const directory = unquoted.length === 0
      ? cwd
      : isAbsolute(unquoted)
        ? unquoted
        : resolve(cwd, unquoted)
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      try {
        const info = await stat(candidate)
        if (info.isFile() && (windows || (info.mode & 0o111) !== 0)) {
          return candidate
        }
      } catch {
        // Continue to the next captured PATH candidate.
      }
    }
  }
  return null
}

/**
 * Find an executable by searching PATH, similar to `which`.
 * Replaces spawn-rx's findActualExecutable to avoid pulling in rxjs (~313 KB).
 *
 * Returns { cmd, args } to match the spawn-rx API shape.
 * `cmd` is the resolved path if found, or the original name if not.
 * `args` is always the pass-through of the input args.
 */
export function findExecutable(
  exe: string,
  args: string[],
): { cmd: string; args: string[] } {
  const resolved = whichSync(exe)
  return { cmd: resolved ?? exe, args }
}
