import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'

type ProjectPathPlatform = 'posix' | 'win32'
const nativePlatform: ProjectPathPlatform = process.platform === 'win32' ? 'win32' : 'posix'

function isWindowsAbsolute(path: string): boolean {
  return /^[a-z]:[/\\]/iu.test(path) || path.startsWith('\\\\')
}

function canonicalWindowsPath(path: string): string {
  let normalized = win32.normalize(path)
  if (/^\\\\\?\\[a-z]:\\/iu.test(normalized)) {
    normalized = normalized.slice(4)
  } else if (/^\\\\\?\\UNC\\/iu.test(normalized)) {
    normalized = `\\\\${normalized.slice(8)}`
  }
  normalized = normalized.replace(/^[a-z]:/iu, drive => drive.toUpperCase())
  const root = win32.parse(normalized).root
  return normalized.length > root.length
    ? normalized.replace(/\\+$/u, '')
    : normalized
}

function canonicalForeignProjectPath(projectPath: string, platform: ProjectPathPlatform): string {
  if (platform === 'win32' && isWindowsAbsolute(projectPath)) {
    return canonicalWindowsPath(projectPath)
  }
  if (platform === 'posix' && posix.isAbsolute(projectPath)) {
    const normalized = posix.normalize(projectPath)
    return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized
  }
  throw new Error('Foreign project paths must be absolute')
}

function canonicalNativeProjectPath(projectPath: string): string {
  const absolutePath = resolve(projectPath)
  const missingSegments: string[] = []
  let existingPath = absolutePath
  while (true) {
    try {
      const canonical = join(realpathSync.native(existingPath), ...missingSegments)
      return process.platform === 'win32'
        ? canonicalWindowsPath(canonical)
        : canonical
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = dirname(existingPath)
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === existingPath) {
        return process.platform === 'win32'
          ? canonicalWindowsPath(absolutePath)
          : absolutePath
      }
      missingSegments.unshift(basename(existingPath))
      existingPath = parent
    }
  }
}

export function canonicalProjectPath(
  projectPath: string,
  platform: ProjectPathPlatform = nativePlatform,
): string {
  if (
    !projectPath ||
    projectPath.includes('\0') ||
    Buffer.from(projectPath, 'utf8').toString('utf8') !== projectPath
  ) {
    throw new Error('Project path must be nonempty, well-formed text without NUL')
  }
  return platform === nativePlatform
    ? canonicalNativeProjectPath(projectPath)
    : canonicalForeignProjectPath(projectPath, platform)
}

export function projectStorageKey(
  projectPath: string,
  platform: ProjectPathPlatform = nativePlatform,
): string {
  const canonical = canonicalProjectPath(projectPath, platform)
  const digest = createHash('sha256')
    .update(`${platform}\0${canonical}`)
    .digest('hex')
  const prefix = canonical.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 64)
  return `v2-${prefix}-${digest}`
}
