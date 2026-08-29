import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from 'src/utils/debug.js'
import { requireCurrentRuntimeSession } from '../session/current-session.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { getPlatform } from './platform.js'

export interface SessionEnvironmentAuthority {
  readonly homePath: string
  readonly sessionId: string
}

const sessionEnvironmentScripts = new Map<
  string,
  Promise<string | null>
>()

function currentSessionEnvironmentAuthority(): SessionEnvironmentAuthority {
  const session = requireCurrentRuntimeSession('session environment')
  const homePath = session.services?.configStore?.homeContext?.path
  if (homePath === undefined) {
    throw new Error(
      'Active runtime session has no canonical ConfigStore home authority',
    )
  }
  return { homePath, sessionId: String(session.conversationId) }
}

function authorityKey(authority: SessionEnvironmentAuthority): string {
  return `${authority.homePath}\u0000${authority.sessionId}`
}

export async function getSessionEnvDirPath(
  authority: SessionEnvironmentAuthority = currentSessionEnvironmentAuthority(),
): Promise<string> {
  const sessionEnvDir = join(
    authority.homePath,
    'session-env',
    authority.sessionId,
  )
  await mkdir(sessionEnvDir, { recursive: true })
  return sessionEnvDir
}

export async function getHookEnvFilePath(
  hookEvent: 'Setup' | 'SessionStart' | 'CwdChanged' | 'FileChanged',
  hookIndex: number,
  authority: SessionEnvironmentAuthority = currentSessionEnvironmentAuthority(),
): Promise<string> {
  const prefix = hookEvent.toLowerCase()
  return join(
    await getSessionEnvDirPath(authority),
    `${prefix}-hook-${hookIndex}.sh`,
  )
}

export async function clearCwdEnvFiles(
  authority: SessionEnvironmentAuthority = currentSessionEnvironmentAuthority(),
): Promise<void> {
  try {
    const dir = await getSessionEnvDirPath(authority)
    const files = await readdir(dir)
    await Promise.all(
      files
        .filter(
          f =>
            (f.startsWith('filechanged-hook-') ||
              f.startsWith('cwdchanged-hook-')) &&
            HOOK_ENV_REGEX.test(f),
        )
        .map(f => writeFile(join(dir, f), '')),
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(`Failed to clear cwd env files: ${errorMessage(e)}`)
    }
  }
}

export function invalidateSessionEnvCache(
  authority: SessionEnvironmentAuthority = currentSessionEnvironmentAuthority(),
): void {
  logForDebugging('Invalidating session environment cache')
  sessionEnvironmentScripts.delete(authorityKey(authority))
}

/** Release all cached shell state owned by a session during its shutdown. */
export function disposeSessionEnvironment(
  authority: SessionEnvironmentAuthority,
): void {
  invalidateSessionEnvCache(authority)
}

export function getSessionEnvironmentScript(
  authority: SessionEnvironmentAuthority = currentSessionEnvironmentAuthority(),
): Promise<string | null> {
  if (getPlatform() === 'windows') {
    logForDebugging('Session environment not yet supported on Windows')
    return Promise.resolve(null)
  }

  const key = authorityKey(authority)
  const cached = sessionEnvironmentScripts.get(key)
  if (cached !== undefined) return cached

  const loading = loadSessionEnvironmentScript(authority).catch(error => {
    sessionEnvironmentScripts.delete(key)
    throw error
  })
  sessionEnvironmentScripts.set(key, loading)
  return loading
}

async function loadSessionEnvironmentScript(
  authority: SessionEnvironmentAuthority,
): Promise<string | null> {
  const scripts: string[] = []

  // Load hook environment files from session directory
  const sessionEnvDir = await getSessionEnvDirPath(authority)
  try {
    const files = await readdir(sessionEnvDir)
    // We are sorting the hook env files by the order in which they are listed
    // in canonical config.toml so that the resulting env is deterministic
    const hookFiles = files
      .filter(f => HOOK_ENV_REGEX.test(f))
      .sort(sortHookEnvFiles)

    for (const file of hookFiles) {
      const filePath = join(sessionEnvDir, file)
      try {
        const content = (await readFile(filePath, 'utf8')).trim()
        if (content) {
          scripts.push(content)
        }
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          logForDebugging(
            `Failed to read hook file ${filePath}: ${errorMessage(e)}`,
          )
        }
      }
    }

    if (hookFiles.length > 0) {
      logForDebugging(
        `Session environment loaded from ${hookFiles.length} hook file(s)`,
      )
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(
        `Failed to load session environment from hooks: ${errorMessage(e)}`,
      )
    }
  }

  if (scripts.length === 0) {
    logForDebugging('No session environment scripts found')
    return null
  }

  const sessionEnvScript = scripts.join('\n')
  logForDebugging(
    `Session environment script ready (${sessionEnvScript.length} chars total)`,
  )
  return sessionEnvScript
}

const HOOK_ENV_PRIORITY: Record<string, number> = {
  setup: 0,
  sessionstart: 1,
  cwdchanged: 2,
  filechanged: 3,
}
const HOOK_ENV_REGEX =
  /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

function sortHookEnvFiles(a: string, b: string): number {
  const aMatch = a.match(HOOK_ENV_REGEX)
  const bMatch = b.match(HOOK_ENV_REGEX)
  const aType = aMatch?.[1] || ''
  const bType = bMatch?.[1] || ''
  if (aType !== bType) {
    return (HOOK_ENV_PRIORITY[aType] ?? 99) - (HOOK_ENV_PRIORITY[bType] ?? 99)
  }
  const aIndex = parseInt(aMatch?.[2] || '0', 10)
  const bIndex = parseInt(bMatch?.[2] || '0', 10)
  return aIndex - bIndex
}
