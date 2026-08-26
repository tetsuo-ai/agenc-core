import { feature } from 'bun:bundle'
import { access } from 'fs/promises'
import { join as nativeJoin } from 'path'
import { join as posixJoin } from 'path/posix'
import { rearrangePipeCommand } from '../bash/bashPipeCommand.js'
import { createAndSaveSnapshot } from '../bash/ShellSnapshot.js'
import { formatShellWrapperCommand } from '../bash/shellPrefix.js'
import { quote } from '../bash/shellQuote.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from '../bash/shellQuoting.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getPlatform } from '../platform.js'
import { getSessionEnvironmentScript } from '../sessionEnvironment.js'
import {
  ensureSocketInitialized,
  getAgenCTmuxEnv,
  hasTmuxToolBeenUsed,
} from '../tmuxSocket.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import type { PreparedShellCommand, ShellProvider } from './shellProvider.js'

/**
 * Returns a shell command to disable extended glob patterns for security.
 * Extended globs (bash extglob, zsh EXTENDED_GLOB) can be exploited via
 * malicious filenames that expand after our security validation.
 *
 * When AGENC_SHELL_PREFIX is set, the actual executing shell may differ
 * from shellPath (e.g., shellPath is zsh but the wrapper runs bash). In this
 * case, we include commands for BOTH shells. We redirect both stdout and stderr
 * to /dev/null because zsh's command_not_found_handler writes to STDOUT.
 *
 * When no shell prefix is set, we use the appropriate command for the detected shell.
 */
function getDisableExtglobCommand(
  shellPath: string,
  hasCommandWrapper: boolean,
): string | null {
  // When AGENC_SHELL_PREFIX is set, the wrapper may use a different shell
  // than shellPath, so we include both bash and zsh commands
  if (hasCommandWrapper) {
    // Redirect both stdout and stderr because zsh's command_not_found_handler
    // writes to stdout instead of stderr
    return '{ shopt -u extglob || setopt NO_EXTENDED_GLOB; } >/dev/null 2>&1 || true'
  }

  // No shell prefix - use shell-specific command
  if (shellPath.includes('bash')) {
    return 'shopt -u extglob 2>/dev/null || true'
  } else if (shellPath.includes('zsh')) {
    return 'setopt NO_EXTENDED_GLOB 2>/dev/null || true'
  }
  // Unknown shell - do nothing, we don't know the right command
  return null
}

export async function createBashShellProvider(
  shellPath: string,
  options: {
    skipSnapshot?: boolean
    commandWrapperArgv?: readonly string[]
    childEnvironment: Readonly<NodeJS.ProcessEnv>
  },
): Promise<ShellProvider> {
  const snapshotPromise: Promise<string | undefined> = options.skipSnapshot
    ? Promise.resolve(undefined)
    : createAndSaveSnapshot(shellPath, options.childEnvironment).catch(error => {
        logForDebugging(`Failed to create shell snapshot: ${error}`)
        return undefined
      })
  return {
    type: 'bash',
    shellPath,
    detached: true,

    async prepareExecCommand(
      command: string,
      opts: {
        id: number | string
        sandboxTmpDir?: string
        tempRoot: string
        useSandbox: boolean
      },
    ): Promise<PreparedShellCommand> {
      let snapshotFilePath = await snapshotPromise
      // This access() check is NOT pure TOCTOU — it decides whether this
      // invocation needs login-shell initialization. When the snapshot
      // disappears mid-session, the prepared argv adds -l. Without this check,
      // `source ... || true` silently fails and commands run with NO shell
      // init (neither snapshot env nor login profile). The `|| true` on source
      // still guards the race between this check and the spawned shell.
      if (snapshotFilePath) {
        try {
          await access(snapshotFilePath)
        } catch {
          logForDebugging(
            `Snapshot file missing, falling back to login shell: ${snapshotFilePath}`,
          )
          snapshotFilePath = undefined
        }
      }
      const tmpdir = opts.tempRoot
      const isWindows = getPlatform() === 'windows'
      const shellTmpdir = isWindows ? windowsPathToPosixPath(tmpdir) : tmpdir

      // shellCwdFilePath: POSIX path used inside the bash command (pwd -P >| ...)
      // cwdFilePath: native OS path used by Node.js for readFileSync/unlinkSync
      // On non-Windows these are identical; on Windows, Git Bash needs POSIX paths
      // but Node.js needs native Windows paths for file operations.
      const shellCwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : posixJoin(shellTmpdir, `agenc-${opts.id}-cwd`)
      const cwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : nativeJoin(tmpdir, `agenc-${opts.id}-cwd`)

      // Defensive rewrite: the model sometimes emits Windows CMD-style `2>nul`
      // redirects. In POSIX bash (including Git Bash on Windows), this creates a
      // literal file named `nul` — a reserved device name that breaks git.
      // See tetsuo-ai/agenc-core#4928.
      const normalizedCommand = rewriteWindowsNullRedirect(command)
      const addStdinRedirect = shouldAddStdinRedirect(normalizedCommand)
      let quotedCommand = quoteShellCommand(normalizedCommand, addStdinRedirect)

      // Debug logging for heredoc/multiline commands to trace trailer handling
      // Only log when commit attribution is enabled to avoid noise
      if (
        feature('COMMIT_ATTRIBUTION') &&
        (command.includes('<<') || command.includes('\n'))
      ) {
        logForDebugging(
          `Shell: Command before quoting (first 500 chars):\n${command.slice(0, 500)}`,
        )
        logForDebugging(
          `Shell: Quoted command (first 500 chars):\n${quotedCommand.slice(0, 500)}`,
        )
      }

      // Special handling for pipes: move stdin redirect after first command
      // This ensures the redirect applies to the first command, not to eval itself.
      // Without this, `eval 'rg foo | wc -l' \< /dev/null` becomes
      // `rg foo | wc -l < /dev/null` — wc reads /dev/null and outputs 0, and
      // rg (with no path arg) waits on the open spawn stdin pipe forever.
      // Applies to sandbox mode too: sandbox wraps the assembled commandString,
      // not the raw command (since PR #9189).
      if (normalizedCommand.includes('|') && addStdinRedirect) {
        quotedCommand = rearrangePipeCommand(normalizedCommand)
      }

      const commandParts: string[] = []

      // Source the snapshot file. The `|| true` guards the race between the
      // access() check above and the spawned shell's `source` — if the file
      // vanishes in that window, the `&&` chain still continues.
      if (snapshotFilePath) {
        const finalPath =
          getPlatform() === 'windows'
            ? windowsPathToPosixPath(snapshotFilePath)
            : snapshotFilePath
        commandParts.push(`source ${quote([finalPath])} 2>/dev/null || true`)
      }

      // Source session environment variables captured from session start hooks
      const sessionEnvScript = await getSessionEnvironmentScript()
      if (sessionEnvScript) {
        commandParts.push(sessionEnvScript)
      }

      // Disable extended glob patterns for security (after sourcing user config to override)
      const disableExtglobCmd = getDisableExtglobCommand(
        shellPath,
        (options?.commandWrapperArgv?.length ?? 0) > 0,
      )
      if (disableExtglobCmd) {
        commandParts.push(disableExtglobCmd)
      }

      // When sourcing a file with aliases, they won't be expanded in the same command line
      // because the shell parses the entire line before execution. Using eval after
      // sourcing causes a second parsing pass where aliases are now available for expansion.
      commandParts.push(`eval ${quotedCommand}`)
      // Use `pwd -P` to get the physical path of the current working directory for consistency with `process.cwd()`
      commandParts.push(`pwd -P >| ${quote([shellCwdFilePath])}`)
      let commandString = commandParts.join(' && ')

      if ((options?.commandWrapperArgv?.length ?? 0) > 0) {
        commandString = formatShellWrapperCommand(
          options.commandWrapperArgv!,
          commandString,
        )
      }

      // TMUX SOCKET ISOLATION (DEFERRED):
      // We initialize AgenC's tmux socket ONLY AFTER the Tmux tool has been used
      // at least once, OR if the current command appears to use tmux.
      // This defers the startup cost until tmux is actually needed.
      //
      // Once the Tmux tool is used (or a tmux command runs), all subsequent Bash
      // commands will use AgenC's isolated socket via the TMUX env var override.
      //
      // See tmuxSocket.ts for the full isolation architecture documentation.
      const commandUsesTmux = command.includes('tmux')
      if (
        options.childEnvironment.USER_TYPE === 'ant' &&
        (hasTmuxToolBeenUsed() || commandUsesTmux)
      ) {
        await ensureSocketInitialized()
      }
      const agencTmuxEnv = getAgenCTmuxEnv()
      const env: Record<string, string> = {}
      // CRITICAL: Override TMUX to isolate ALL tmux commands to AgenC's socket.
      // This is NOT the user's TMUX value - it points to AgenC's isolated socket.
      // When null (before socket initializes), user's TMUX is preserved.
      if (agencTmuxEnv) {
        env.TMUX = agencTmuxEnv
      }
      if (opts.sandboxTmpDir) {
        let posixTmpDir = opts.sandboxTmpDir
        if (getPlatform() === 'windows') {
          posixTmpDir = windowsPathToPosixPath(posixTmpDir)
        }
        env.TMPDIR = posixTmpDir
        env.AGENC_TMPDIR = posixTmpDir
        // Zsh uses TMPPREFIX (default /tmp/zsh) for heredoc temp files,
        // not TMPDIR. Set it to a path inside the sandbox tmp dir so
        // heredocs work in sandboxed zsh commands.
        // Safe to set unconditionally — non-zsh shells ignore TMPPREFIX.
        env.TMPPREFIX = posixJoin(posixTmpDir, 'zsh')
      }
      const skipLoginShell = snapshotFilePath !== undefined
      return Object.freeze({
        commandString,
        cwdFilePath,
        spawnArgs: (finalCommandString: string): readonly string[] => {
          if (skipLoginShell) {
            logForDebugging('Spawning shell without login (-l flag skipped)')
          }
          return ['-c', ...(skipLoginShell ? [] : ['-l']), finalCommandString]
        },
        environmentOverrides: Object.freeze(env),
      })
    },
  }
}
