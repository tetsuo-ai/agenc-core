import { memoizeWithLRU } from './memoize.js'
import { convertWindowsPathToPosix } from './windows-path-conversion.js'

function memoizeWindowsPathConverter(convert: (path: string) => string) {
  let memoized: ReturnType<typeof memoizeWithLRU<[string], string>> | undefined
  function getMemoized() {
    return memoized ??= memoizeWithLRU(convert, (path: string) => path, 500)
  }
  const result = (path: string) => getMemoized()(path)
  // Observing an empty cache must not allocate it. Keep this facade stable
  // before and after the first conversion, including non-promoting get().
  result.cache = {
    clear: () => { memoized?.cache.clear() },
    size: () => memoized?.cache.size() ?? 0,
    delete: (key: string) => memoized?.cache.delete(key) ?? false,
    get: (key: string) => memoized?.cache.get(key),
    has: (key: string) => memoized?.cache.has(key) ?? false,
  }
  return result
}

/** Convert a Windows path to a POSIX path using pure JS. */
export const windowsPathToPosixPath = memoizeWindowsPathConverter(
  convertWindowsPathToPosix,
)

/** Convert a POSIX path to a Windows path using pure JS. */
export const posixPathToWindowsPath = memoizeWindowsPathConverter(
  (posixPath: string): string => {
    // Handle UNC paths: //server/share -> \\server\share
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\')
    }
    // Handle /cygdrive/c/... format
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Handle /c/... format (MSYS2/Git Bash)
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/)
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(2)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Already Windows or relative — just flip slashes
    return posixPath.replace(/\//g, '\\')
  },
)
