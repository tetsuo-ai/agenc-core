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
  for await (const candidate of executablesOnCapturedPath(
    command,
    environment,
    cwd,
  )) {
    return candidate
  }
  return null
}

/**
 * Every executable named `command` on a captured PATH snapshot, in PATH order
 * and without repeats. A caller that needs one specific install (for example
 * the wrapper that launched this runtime) checks each candidate, because an
 * unrelated executable with the same name can come first.
 */
export async function findAllExecutablesOnCapturedPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  for await (const candidate of executablesOnCapturedPath(
    command,
    environment,
    cwd,
  )) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    found.push(candidate)
  }
  return found
}

async function* executablesOnCapturedPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): AsyncGenerator<string> {
  const searchPath =
    nonEmptyEnvironmentValue(environment.PATH) ??
    nonEmptyEnvironmentValue(environment.Path)
  if (searchPath === undefined) return

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
      let executable = false
      try {
        const info = await stat(candidate)
        executable = info.isFile() && (windows || (info.mode & 0o111) !== 0)
      } catch {
        // Continue to the next captured PATH candidate.
      }
      if (executable) yield candidate
    }
  }
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
