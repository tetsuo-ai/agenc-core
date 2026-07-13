import type { ChildProcess, ExecFileException } from 'child_process'
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { isInBundledMode } from './bundledMode.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'

const __filename = fileURLToPath(import.meta.url)
// we use node:path.join instead of node:url.resolve because the former doesn't encode spaces
const __dirname = path.join(
  __filename,
  process.env.NODE_ENV === 'test' ? '../../../' : '../',
)

type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded'
  command: string
  args: string[]
  argv0?: string
}

type RipgrepErrorLike = Pick<NodeJS.ErrnoException, 'code' | 'message'>

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

type ResolveRipgrepConfigArgs = {
  userWantsSystemRipgrep: boolean
  bundledMode: boolean
  builtinCommand: string
  builtinExists: boolean
  systemExecutablePath: string
  processExecPath?: string
}

export function resolveRipgrepConfig({
  userWantsSystemRipgrep,
  bundledMode,
  builtinCommand,
  builtinExists,
  systemExecutablePath,
  processExecPath = process.execPath,
}: ResolveRipgrepConfigArgs): RipgrepConfig {
  if (userWantsSystemRipgrep && systemExecutablePath !== 'rg') {
    // SECURITY: Use command name 'rg' instead of systemExecutablePath to prevent PATH hijacking
    return { mode: 'system', command: 'rg', args: [] }
  }

  if (bundledMode) {
    return {
      mode: 'embedded',
      command: processExecPath,
      args: ['--no-config'],
      argv0: 'rg',
    }
  }

  if (builtinExists) {
    return { mode: 'builtin', command: builtinCommand, args: [] }
  }

  if (systemExecutablePath !== 'rg') {
    return { mode: 'system', command: 'rg', args: [] }
  }

  return { mode: 'builtin', command: builtinCommand, args: [] }
}

const getRipgrepConfig = memoize((): RipgrepConfig => {
  const userWantsSystemRipgrep = isEnvDefinedFalsy(
    process.env.USE_BUILTIN_RIPGREP,
  )
  const bundledMode = isInBundledMode()
  const rgRoot = path.resolve(__dirname, 'vendor', 'ripgrep')
  const builtinCommand =
    process.platform === 'win32'
      ? path.resolve(rgRoot, `${process.arch}-win32`, 'rg.exe')
      : path.resolve(rgRoot, `${process.arch}-${process.platform}`, 'rg')
  const builtinExists = existsSync(builtinCommand)
  const { cmd: systemExecutablePath } = findExecutable('rg', [])

  return resolveRipgrepConfig({
    userWantsSystemRipgrep,
    bundledMode,
    builtinCommand,
    builtinExists,
    systemExecutablePath,
  })
})

export function ripgrepCommand(): {
  rgPath: string
  rgArgs: string[]
  argv0?: string
} {
  const config = getRipgrepConfig()
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  }
}

const MAX_BUFFER_SIZE = 20_000_000 // 20MB; large monorepos can have 200k+ files

/**
 * Check if an error is EAGAIN (resource temporarily unavailable).
 * This happens in resource-constrained environments (Docker, CI) when
 * ripgrep tries to spawn too many threads.
 */
function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  )
}

/**
 * Custom error class for ripgrep timeouts.
 * This allows callers to distinguish between "no matches" and "timed out".
 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

export class RipgrepUnavailableError extends Error {
  code?: string | number

  constructor(
    message: string,
    public readonly config: Pick<RipgrepConfig, 'mode' | 'command'>,
    code?: string | number,
  ) {
    super(message)
    this.name = 'RipgrepUnavailableError'
    this.code = code
  }
}

export function getRipgrepInstallHint(platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'Install ripgrep and confirm `rg --version` works in the same terminal. Windows: `winget install BurntSushi.ripgrep.MSVC` or `choco install ripgrep`.'
    case 'darwin':
      return 'Install ripgrep and confirm `rg --version` works in the same terminal. macOS: `brew install ripgrep`.'
    default:
      return 'Install ripgrep and confirm `rg --version` works in the same terminal. Linux: use your distro package manager, for example `apt install ripgrep`.'
  }
}

export function wrapRipgrepUnavailableError(
  error: RipgrepErrorLike,
  config = getRipgrepConfig(),
  platform = process.platform,
): RipgrepUnavailableError {
  const modeExplanation =
    config.mode === 'builtin'
      ? 'This install could not locate its packaged ripgrep fallback.'
      : config.mode === 'system'
        ? 'A working system ripgrep binary was not found on PATH.'
        : 'The embedded ripgrep binary could not be started.'

  const originalMessage = error.message ? ` Original error: ${error.message}` : ''

  return new RipgrepUnavailableError(
    `ripgrep (rg) is required for file search but could not be started. ${modeExplanation} ${getRipgrepInstallHint(platform)}${originalMessage}`,
    config,
    error.code,
  )
}

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
): ChildProcess {
  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided

  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  // Use single-threaded mode only if explicitly requested for this call's retry
  const threadArgs = singleThread ? ['-j', '1'] : []
  const fullArgs = [...rgArgs, ...threadArgs, ...args, target]
  // Allow timeout to be configured via env var (in seconds), otherwise use platform defaults
  // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
  const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
  const parsedSeconds =
    parseInt(process.env.AGENC_GLOB_TIMEOUT_SECONDS || '', 10) || 0
  const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

  // For embedded ripgrep, use spawn with argv0 (execFile doesn't support argv0 properly)
  if (argv0) {
    const child = spawn(rgPath, fullArgs, {
      argv0,
      signal: abortSignal,
      // Prevent visible console window on Windows (no-op on other platforms)
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    child.stdout?.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        stdout += data.toString()
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE)
          stdoutTruncated = true
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        stderr += data.toString()
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE)
          stderrTruncated = true
        }
      }
    })

    // Set up timeout with SIGKILL escalation.
    // SIGTERM alone may not kill ripgrep if it's blocked in uninterruptible I/O
    // (e.g., deep filesystem traversal). If SIGTERM doesn't work within 5 seconds,
    // escalate to SIGKILL which cannot be caught or ignored.
    // On Windows, child.kill('SIGTERM') throws; use default signal.
    let killTimeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutId = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill()
      } else {
        child.kill('SIGTERM')
        killTimeoutId = setTimeout(c => c.kill('SIGKILL'), 5_000, child)
      }
    }, timeout)

    // On Windows, both 'close' and 'error' can fire for the same process
    // (e.g. when AbortSignal kills the child). Guard against double-callback.
    let settled = false
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      if (code === 0 || code === 1) {
        // 0 = matches found, 1 = no matches (both are success)
        callback(null, stdout, stderr)
      } else {
        const error: ExecFileException = new Error(
          `ripgrep exited with code ${code}`,
        )
        error.code = code ?? undefined
        error.signal = signal ?? undefined
        callback(error, stdout, stderr)
      }
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      const error: ExecFileException = err
      callback(error, stdout, stderr)
    })

    return child
  }

  // For non-embedded ripgrep, use execFile
  // Use SIGKILL as killSignal because SIGTERM may not terminate ripgrep
  // when it's blocked in uninterruptible filesystem I/O.
  // On Windows, SIGKILL throws; use default (undefined) which sends SIGTERM.
  return execFile(
    rgPath,
    fullArgs,
    {
      maxBuffer: MAX_BUFFER_SIZE,
      signal: abortSignal,
      timeout,
      killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
    },
    callback,
  )
}

/**
 * Stream lines from ripgrep as they arrive, calling `onLines` per stdout chunk.
 *
 * Unlike `ripGrep()` which buffers the entire stdout, this flushes complete
 * lines as soon as each chunk arrives — first results paint while rg is still
 * walking the tree (the fzf `change:reload` pattern). Partial trailing lines
 * are carried across chunk boundaries.
 *
 * Callers that want to stop early (e.g. after N matches) should abort the
 * signal — spawn's signal option kills rg. No EAGAIN retry, no internal
 * timeout, stderr is ignored; interactive callers own recovery.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  return new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const stripCR = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l)
    let remainder = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = remainder + chunk.toString()
      const lines = data.split('\n')
      remainder = lines.pop() ?? ''
      if (lines.length) onLines(lines.map(stripCR))
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      // Abort races close — don't flush a torn tail from a killed process.
      // Promise still settles: spawn's signal option fires 'error' with
      // AbortError → reject below.
      if (abortSignal.aborted) return
      settled = true
      if (code === 0 || code === 1) {
        if (remainder) onLines([stripCR(remainder)])
        resolve()
      } else {
        reject(new Error(`ripgrep exited with code ${code}`))
      }
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      reject(
        isErrnoException(err) && err.code === 'ENOENT'
          ? wrapRipgrepUnavailableError(err)
          : err,
      )
    })
  })
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  await codesignRipgrepIfNecessary()

  // Test ripgrep on first use and cache the result (fire and forget)
  void testRipgrepOnFirstUse().catch(error => {
    logError(error)
  })

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(
          stdout
            .trim()
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean),
        )
        return
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([])
        return
      }

      // Critical errors that indicate ripgrep is broken, not "no matches"
      // These should be surfaced to the user rather than silently returning empty results
      const CRITICAL_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM']
      if (CRITICAL_ERROR_CODES.includes(error.code as string)) {
        reject(
          isErrnoException(error) && error.code === 'ENOENT'
            ? wrapRipgrepUnavailableError(error)
            : error,
        )
        return
      }

      // If we hit EAGAIN and haven't retried yet, retry with single-threaded mode
      // Note: We only use -j 1 for this specific retry, not for future calls.
      // Persisting single-threaded mode globally caused timeouts on large repos
      // where EAGAIN was just a transient startup error.
      if (!isRetry && isEagainError(stderr)) {
        logForDebugging(
          `rg EAGAIN error detected, retrying with single-threaded mode (-j 1)`,
        )
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true)
          },
          true, // Force single-threaded mode for this retry only
        )
        return
      }

      // For all other errors, try to return partial results if available
      const hasOutput = stdout && stdout.trim().length > 0
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR'
      const isBufferOverflow =
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

      let lines: string[] = []
      if (hasOutput) {
        lines = stdout
          .trim()
          .split('\n')
          .map(line => line.replace(/\r$/, ''))
          .filter(Boolean)
        // Drop last line for timeouts and buffer overflow - it may be incomplete
        if (lines.length > 0 && (isTimeout || isBufferOverflow)) {
          lines = lines.slice(0, -1)
        }
      }

      logForDebugging(
        `rg error (signal=${error.signal}, code=${error.code}, stderr: ${stderr}), ${lines.length} results`,
      )

      // code 2 = ripgrep usage error (already handled); ABORT_ERR = caller
      // explicitly aborted (not an error, just a cancellation — interactive
      // callers may abort on every keystroke-after-debounce).
      if (error.code !== 2 && error.code !== 'ABORT_ERR') {
        logError(error)
      }

      // If we timed out with no results, throw an error so AgenC knows the search
      // didn't complete rather than thinking there were no matches
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${getPlatform() === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
            lines,
          ),
        )
        return
      }

      resolve(lines)
    }

    ripGrepRaw(args, target, abortSignal, (error, stdout, stderr) => {
      handleResult(error, stdout, stderr, false)
    })
  })
}

// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean
  lastTested: number
  config: RipgrepConfig
} | null = null

/**
 * Get ripgrep status and configuration info
 * Returns current configuration immediately, with working status if available
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'builtin' | 'embedded'
  path: string
  working: boolean | null // null if not yet tested
} {
  const config = getRipgrepConfig()
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
  }
}

/**
 * Actively probe whether the resolved ripgrep is runnable, returning the
 * boolean rather than caching it on the lazy first-use singleton. Used by
 * `agenc doctor` to report rg status with a fix hint on a clean machine where
 * no system rg is on PATH and no binary is bundled. Never throws.
 */
export async function probeRipgrepAvailable(): Promise<boolean> {
  const config = getRipgrepConfig()
  try {
    if (config.argv0) {
      // Embedded ripgrep is only reachable under a Bun-compiled binary, which
      // always ships rg; treat it as available without spawning here.
      return true
    }
    const test = await execFileNoThrow(
      config.command,
      [...config.args, '--version'],
      { timeout: 5000 },
    )
    return test.code === 0 && test.stdout.startsWith('ripgrep ')
  } catch {
    return false
  }
}

/**
 * Test ripgrep availability on first use and cache the result
 */
const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // Already tested
  if (ripgrepStatus !== null) {
    return
  }

  const config = getRipgrepConfig()

  try {
    let test: { code: number; stdout: string }

    // For embedded ripgrep, use Bun.spawn with argv0
    if (config.argv0) {
      // Only Bun embeds ripgrep.
      // eslint-disable-next-line custom-rules/require-bun-typeof-guard
      const proc = Bun.spawn([config.command, '--version'], {
        argv0: config.argv0,
        stderr: 'ignore',
        stdout: 'pipe',
      })

      const [stdout, code] = await Promise.all([
        proc.stdout.text(),
        proc.exited,
      ])
      test = {
        code,
        stdout,
      }
    } else {
      test = await execFileNoThrow(
        config.command,
        [...config.args, '--version'],
        {
          timeout: 5000,
        },
      )
    }

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ')

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
    }

    logForDebugging(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    )
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
    }
    logError(error)
  }
})

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return
  }
  const builtinPath = config.command

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ])

    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ])

    if (quarantineResult.code !== 0) {
      logError(
        new Error(
          `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
        ),
      )
    }
  } catch (e) {
    logError(e)
  }
}
