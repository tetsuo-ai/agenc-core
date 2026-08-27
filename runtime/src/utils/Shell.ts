import { spawn } from "child_process";
import { constants as fsConstants, readFileSync, unlinkSync } from "fs";
import { type FileHandle, mkdir, open, stat } from "fs/promises";
import memoize from "lodash-es/memoize.js";
import { isAbsolute, join, resolve } from "path";
import { join as posixJoin } from "path/posix";
import {
  getOriginalCwd,
  getSessionId,
  setCwdState,
} from "../bootstrap/state.js";
import { generateTaskId } from "../tasks/Task.js";
import { pwd } from "./cwd.js";
import { logForDebugging } from "src/utils/debug.js";
import { errorMessage, isENOENT } from "./errors.js";
import { getFsImplementation } from "./fsOperations.js";
import { logError } from "./log.js";
import {
  createAbortedCommand,
  createFailedCommand,
  type ShellCommand,
  wrapSpawn,
} from "./ShellCommand.js";
import { getTaskOutputDir } from "./task/diskOutput.js";
import { TaskOutput } from "./task/TaskOutput.js";

export type { ExecResult } from "./ShellCommand.js";

import { onCwdChangedForHooks } from "./hooks/cwdChangedHooks.js";
import { getPlatform } from "./platform.js";
import { SandboxManager } from "./sandbox/sandbox-runtime.js";
import { invalidateSessionEnvCache } from "./sessionEnvironment.js";
import { createBashShellProvider } from "./shell/bashProvider.js";
import { getCachedPowerShellPath } from "./shell/powershellDetection.js";
import { createPowerShellProvider } from "./shell/powershellProvider.js";
import type { ShellProvider, ShellType } from "./shell/shellProvider.js";
import {
  isExecutableShellPath,
  isSupportedPosixShellPath,
  supportedPosixShellKind,
} from "./shell/posixShellPath.js";
import { subprocessEnv } from "./subprocessEnv.js";
import { posixPathToWindowsPath } from "./windowsPaths.js";
import type {
  SandboxExecutionBrokerLike,
  SandboxPreparedSpawn,
  SandboxSpawnCommand,
  SandboxExecutionSurface,
} from "../sandbox/execution-broker.js";
import { SandboxExecutionLeaseCleanupError } from "../sandbox/execution-broker.js";
import {
  hasCurrentWorkspaceOperationLifetime,
  retainCurrentWorkspaceOperation,
} from "../workspace/tool-operation-lifetime.js";
import {
  spawnContainedProcess,
  terminateProcessTreeAndWait,
} from "./supervisedProcess.js";
import {
  peekAmbientRuntimeSession,
  requireCurrentRuntimeSession,
} from "../session/current-session.js";
import {
  getSessionTempNamespaceName,
  resolveSessionTempRoot,
  type AgentRuntimeOptions,
} from "../session/runtime-options.js";

export type ShellConfig = {
  provider: ShellProvider;
};

/**
 * Determines the best available shell to use.
 */
export async function findSuitableShell(
  runtimeOptions?: AgentRuntimeOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const ambientSession = peekAmbientRuntimeSession();
  const childEnvironment = subprocessEnv(environment);
  const resolvedOptions =
    runtimeOptions ?? ambientSession?.services?.runtimeOptions;
  // Check the immutable per-session override first.
  const shellOverride = resolvedOptions?.posixShellPath;
  if (shellOverride) {
    if (!isSupportedPosixShellPath(shellOverride)) {
      throw new Error(
        `Configured shell ${JSON.stringify(shellOverride)} must name a bash or zsh executable`,
      );
    }
    if (!isExecutableShellPath(shellOverride, childEnvironment)) {
      throw new Error(
        `Configured shell ${JSON.stringify(shellOverride)} is not executable`,
      );
    }
    logForDebugging(`Using shell override: ${shellOverride}`);
    return shellOverride;
  }

  // Check user's preferred shell from environment
  const env_shell =
    runtimeOptions === undefined
      ? ambientSession?.services.userShell.path ?? environment.SHELL
      : environment.SHELL;
  // Only consider SHELL if it's bash or zsh
  const envShellKind = env_shell === undefined
    ? undefined
    : supportedPosixShellKind(env_shell);
  const preferBash = envShellKind === "bash";

  const platformIsWindows = getPlatform() === "windows";
  // Automatic discovery is restricted to fixed platform locations. Client
  // PATH is not executable authority; use AGENC_SHELL for non-standard paths.
  const shellPaths = platformIsWindows
    ? [
        "C:\\Program Files\\Git\\bin",
        "C:\\Program Files (x86)\\Git\\bin",
      ]
    : ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

  // Order shells based on user preference
  const shellOrder = preferBash ? ["bash", "zsh"] : ["zsh", "bash"];
  const executableName = (shell: string): string =>
    platformIsWindows ? `${shell}.exe` : shell;
  const supportedShells = [
    ...shellOrder.flatMap((shell) =>
      shellPaths.map((path) => join(path, executableName(shell))),
    ),
  ];

  // Always prioritize SHELL env variable if it's a supported shell type
  if (
    env_shell !== undefined &&
    envShellKind !== undefined &&
    isExecutableShellPath(env_shell, childEnvironment)
  ) {
    supportedShells.unshift(env_shell);
  }

  const shellPath = supportedShells.find(
    (shell) => shell && isExecutableShellPath(shell, childEnvironment),
  );

  // If no valid shell found, throw a helpful error
  if (!shellPath) {
    const errorMsg =
      "No suitable shell found. AgenC CLI requires a Posix shell environment. " +
      "Install bash or zsh, or set AGENC_SHELL to its absolute executable path.";
    logError(new Error(errorMsg));
    throw new Error(errorMsg);
  }

  return shellPath;
}

async function getShellConfigImpl(
  userShell: ReturnType<
    typeof requireCurrentRuntimeSession
  >["services"]["userShell"],
): Promise<ShellConfig> {
  const binShell = userShell.path;
  const provider = await createBashShellProvider(binShell, {
    commandWrapperArgv: userShell.commandWrapperArgv,
    childEnvironment: userShell.childEnvironment,
  });
  return { provider };
}

const shellConfigs = new WeakMap<object, Promise<ShellConfig>>();

/** Cache by immutable session shell policy, never by daemon-global state. */
export function getShellConfig(): Promise<ShellConfig> {
  const session = requireCurrentRuntimeSession("shell command execution");
  let pending = shellConfigs.get(session);
  if (pending === undefined) {
    pending = getShellConfigImpl(session.services.userShell);
    shellConfigs.set(session, pending);
  }
  return pending;
}

export const getPsProvider = memoize(async (): Promise<ShellProvider> => {
  const psPath = await getCachedPowerShellPath();
  if (!psPath) {
    throw new Error("PowerShell is not available");
  }
  return createPowerShellProvider(psPath);
});

const resolveProvider: Record<ShellType, () => Promise<ShellProvider>> = {
  bash: async () => (await getShellConfig()).provider,
  powershell: getPsProvider,
};

export type ExecOptions = {
  timeout?: number;
  onProgress?: (
    lastLines: string,
    allLines: string,
    totalLines: number,
    totalBytes: number,
    isIncomplete: boolean,
  ) => void;
  preventCwdChanges?: boolean;
  shouldUseSandbox?: boolean;
  shouldAutoBackground?: boolean;
  /** When provided, stdout is piped (not sent to file) and this callback fires on each data chunk. */
  onStdout?: (data: string) => void;
  sandboxExecutionBroker?: SandboxExecutionBrokerLike;
  sandboxExecutionSurface?: SandboxExecutionSurface;
};

/**
 * Execute a shell command using the environment snapshot
 * Creates a new shell process for each command execution
 */
export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options?: ExecOptions,
): Promise<ShellCommand> {
  const session = requireCurrentRuntimeSession("shell command execution");
  const commandAuthority = session.services.userShell;
  const {
    timeout,
    onProgress,
    preventCwdChanges,
    shouldUseSandbox,
    shouldAutoBackground,
    onStdout,
    sandboxExecutionBroker,
    sandboxExecutionSurface,
  } = options ?? {};
  const commandTimeout =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
      ? timeout
      : null;

  const provider = await resolveProvider[shellType]();

  const id = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");

  // Sandbox temp directory - use per-user directory name to prevent multi-user permission conflicts
  const tempRoot = resolveSessionTempRoot();
  const sandboxTmpDir = posixJoin(tempRoot, getSessionTempNamespaceName());

  const preparedCommand = await provider.prepareExecCommand(command, {
    id,
    tempRoot,
    sandboxTmpDir:
      shouldUseSandbox && sandboxExecutionBroker === undefined
        ? sandboxTmpDir
        : undefined,
    useSandbox:
      sandboxExecutionBroker === undefined && (shouldUseSandbox ?? false),
  });
  const { commandString: builtCommand, cwdFilePath } = preparedCommand;

  let commandString = builtCommand;

  let cwd = pwd();

  // Recover if the current working directory no longer exists on disk,
  // or was replaced by a non-directory (e.g., the path was renamed and a file
  // was created in its place). realpath() succeeds on any existing path
  // regardless of type, so we must also verify it's a directory — otherwise
  // spawn would fail later with ENOTDIR / exit 126.
  let cwdIsValidDir = false;
  try {
    cwdIsValidDir = (await stat(cwd)).isDirectory();
  } catch {
    cwdIsValidDir = false;
  }
  if (!cwdIsValidDir) {
    const fallback = getOriginalCwd();
    logForDebugging(
      `Shell CWD "${cwd}" is not a valid directory, recovering to "${fallback}"`,
    );
    let fallbackIsValidDir = false;
    try {
      fallbackIsValidDir = (await stat(fallback)).isDirectory();
    } catch {
      fallbackIsValidDir = false;
    }
    if (fallbackIsValidDir) {
      setCwdState(fallback);
      cwd = fallback;
    } else {
      return createFailedCommand(
        `Working directory "${cwd}" is no longer a valid directory. Please restart AgenC from an existing directory.`,
      );
    }
  }

  // If already aborted, don't spawn the process at all
  if (abortSignal.aborted) {
    return createAbortedCommand();
  }

  const binShell = provider.shellPath;

  // Sandboxed PowerShell: wrapWithSandbox hardcodes `<binShell> -c '<cmd>'` —
  // using pwsh there would lose -NoProfile -NonInteractive (profile load
  // inside sandbox → delays, stray output, may hang on prompts). Instead:
  //   • powershellProvider.prepareExecCommand (useSandbox) pre-wraps as
  //     `pwsh -NoProfile -NonInteractive -EncodedCommand <base64>` — base64
  //     survives the runtime's shellquote.quote() layer
  //   • pass /bin/sh as the sandbox's inner shell to exec that invocation
  //   • outer spawn is also /bin/sh -c to parse the runtime's POSIX output
  // /bin/sh exists on every platform where sandbox is supported.
  const isSandboxedPowerShell =
    sandboxExecutionBroker === undefined &&
    shouldUseSandbox === true &&
    shellType === "powershell";
  const sandboxBinShell = isSandboxedPowerShell ? "/bin/sh" : binShell;

  if (shouldUseSandbox && sandboxExecutionBroker === undefined) {
    commandString = await SandboxManager.wrapWithSandbox(
      commandString,
      sandboxBinShell,
      undefined,
      abortSignal,
    );
    // Create sandbox temp directory for sandboxed processes with secure permissions
    try {
      const fs = getFsImplementation();
      await fs.mkdir(sandboxTmpDir, { mode: 0o700 });
    } catch (error) {
      logForDebugging(`Failed to create ${sandboxTmpDir} directory: ${error}`);
    }
  }

  const spawnBinary = isSandboxedPowerShell ? "/bin/sh" : binShell;
  const shellArgs = isSandboxedPowerShell
    ? ["-c", commandString]
    : preparedCommand.spawnArgs(commandString);
  const envOverrides = preparedCommand.environmentOverrides;
  const spawnEnv = {
    ...commandAuthority.childEnvironment,
    ...(shellType === "bash" ? { SHELL: binShell } : {}),
    GIT_EDITOR: "true",
    AGENCCODE: "1",
    ...envOverrides,
    ...(commandAuthority.childEnvironment.USER_TYPE === "ant"
      ? { AGENC_SESSION_ID: getSessionId() }
      : {}),
  };
  const unsandboxedSpawnCommand: SandboxSpawnCommand = {
    program: spawnBinary,
    args: shellArgs,
    cwd,
    env: Object.fromEntries(
      Object.entries(spawnEnv).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
  const preparedSpawn: SandboxPreparedSpawn | undefined =
    sandboxExecutionBroker?.prepareSpawn(
        sandboxExecutionSurface ?? "tool",
        unsandboxedSpawnCommand,
      );

  // When onStdout is provided, use pipe mode: stdout flows through
  // StreamWrapper → TaskOutput in-memory buffer instead of a file fd.
  // This lets callers receive real-time stdout callbacks.
  const containWorkspaceDescendants = hasCurrentWorkspaceOperationLifetime();
  const usePipeMode =
    !!onStdout || containWorkspaceDescendants || preparedSpawn !== undefined;
  const taskId = generateTaskId("local_bash");
  const taskOutput = new TaskOutput(taskId, onProgress ?? null, !usePipeMode);
  await mkdir(getTaskOutputDir(), { recursive: true });

  // In file mode, both stdout and stderr go to the same file fd.
  // On POSIX, O_APPEND makes each write atomic (seek-to-end + write), so
  // stdout and stderr are interleaved chronologically without tearing.
  // On Windows, 'a' mode strips FILE_WRITE_DATA (only grants FILE_APPEND_DATA)
  // via libuv's fs__open. MSYS2/Cygwin probes inherited handles with
  // NtQueryInformationFile(FileAccessInformation) and treats handles without
  // FILE_WRITE_DATA as read-only, silently discarding all output. Using 'w'
  // grants FILE_GENERIC_WRITE. Atomicity is preserved because duplicated
  // handles share the same FILE_OBJECT with FILE_SYNCHRONOUS_IO_NONALERT,
  // which serializes all I/O through a single kernel lock.
  // SECURITY: O_NOFOLLOW prevents symlink-following attacks from the sandbox.
  // On Windows, use string flags — numeric flags can produce EINVAL through libuv.
  let outputHandle: FileHandle | undefined;
  if (!usePipeMode) {
    const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
    outputHandle = await open(
      taskOutput.path,
      process.platform === "win32"
        ? "w"
        : fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_APPEND |
            O_NOFOLLOW,
    );
  }

  try {
    const startShell = (
      spawnCommand: SandboxSpawnCommand,
      lifecycleSignal?: AbortSignal,
    ) => {
      const containProcessTree =
        preparedSpawn !== undefined || containWorkspaceDescendants;
      const childProcess = containProcessTree
        ? spawnContainedProcess(spawnCommand.program, spawnCommand.args, {
            env: spawnCommand.env,
            cwd: spawnCommand.cwd,
            ...(spawnCommand.argv0 !== undefined
              ? { argv0: spawnCommand.argv0 }
              : {}),
          })
        : spawn(spawnCommand.program, [...spawnCommand.args], {
            env: spawnCommand.env,
            cwd: spawnCommand.cwd,
            stdio: usePipeMode
              ? ["pipe", "pipe", "pipe"]
              : ["pipe", outputHandle?.fd, outputHandle?.fd],
            detached: provider.detached,
            windowsHide: true,
            ...(spawnCommand.argv0 !== undefined
              ? { argv0: spawnCommand.argv0 }
              : {}),
          });
      if (containProcessTree && childProcess.stdin) {
        childProcess.stdin.end();
      }
      const effectiveAbortSignal = lifecycleSignal === undefined
        ? abortSignal
        : AbortSignal.any([abortSignal, lifecycleSignal]);
      const shellCommand = wrapSpawn(
        childProcess,
        effectiveAbortSignal,
        commandTimeout,
        taskOutput,
        shouldAutoBackground,
      );
      const releaseWorkspaceOperation = retainCurrentWorkspaceOperation();
      const completion = shellCommand.result.then(
        async () => {
          if (containProcessTree) {
            try {
              await terminateProcessTreeAndWait(childProcess, {
                label: `Shell command ${command}`,
              });
            } catch (error) {
              logError(error);
              throw new SandboxExecutionLeaseCleanupError(
                `Shell command process-tree cleanup failed: ${errorMessage(error)}`,
                { cause: error },
              );
            }
          }
          releaseWorkspaceOperation();
        },
        async (error) => {
          if (containProcessTree) {
            try {
              await terminateProcessTreeAndWait(childProcess, {
                label: `Shell command ${command}`,
              });
            } catch (cleanupError) {
              logError(cleanupError);
              throw new SandboxExecutionLeaseCleanupError(
                `Shell command process-tree cleanup failed: ${errorMessage(cleanupError)}`,
                { cause: cleanupError },
              );
            }
          }
          releaseWorkspaceOperation();
          throw error;
        },
      );
      return { childProcess, shellCommand, completion };
    };
    const started = preparedSpawn === undefined
      ? startShell(unsandboxedSpawnCommand)
      : preparedSpawn.start((spawnCommand, lifecycleSignal) => {
          const startedShell = startShell(spawnCommand, lifecycleSignal);
          return {
            value: startedShell,
            completion: startedShell.completion,
          };
        });
    const { childProcess, shellCommand } = started;
    // The raw path is used only when no canonical broker exists. Retain its
    // existing workspace-operation cleanup tracking explicitly.
    if (preparedSpawn === undefined) void started.completion.catch(() => {});

    // Close our copy of the fd — the child has its own dup.
    // Must happen after wrapSpawn attaches 'error' listener, since the await
    // yields and the child's ENOENT 'error' event can fire in that window.
    // Wrapped in its own try/catch so a close failure (e.g. EIO) doesn't fall
    // through to the spawn-failure catch block, which would orphan the child.
    if (outputHandle !== undefined) {
      try {
        await outputHandle.close();
      } catch {
        // fd may already be closed by the child; safe to ignore
      }
    }

    // In pipe mode, attach the caller's callbacks alongside StreamWrapper.
    // Both listeners receive the same data chunks (Node.js ReadableStream supports
    // multiple 'data' listeners). StreamWrapper feeds TaskOutput for persistence;
    // these callbacks give the caller real-time access.
    if (childProcess.stdout && onStdout) {
      childProcess.stdout.on("data", (chunk: string | Buffer) => {
        onStdout(typeof chunk === "string" ? chunk : chunk.toString());
      });
    }

    // Attach cleanup to the command result
    // NOTE: readFileSync/unlinkSync are intentional here — these must complete
    // synchronously within the .then() microtask so that callers who
    // `await shellCommand.result` see the updated cwd immediately after.
    // Using async readFile would introduce a microtask boundary, causing
    // a race where cwd hasn't been updated yet when the caller continues.

    // On Windows, cwdFilePath is a POSIX path (for bash's `pwd -P >| $path`),
    // but Node.js needs a native Windows path for readFileSync/unlinkSync.
    // Similarly, `pwd -P` outputs a POSIX path that must be converted before setCwd.
    const nativeCwdFilePath =
      getPlatform() === "windows"
        ? posixPathToWindowsPath(cwdFilePath)
        : cwdFilePath;

    void shellCommand.result.then(async (result) => {
      // On Linux, bwrap creates 0-byte mount-point files on the host to deny
      // writes to non-existent paths (.bashrc, HEAD, etc.). These persist after
      // bwrap exits as ghost dotfiles in cwd. Cleanup is synchronous and a no-op
      // on macOS. Keep before any await so callers awaiting .result see a clean
      // working tree in the same microtask.
      if (shouldUseSandbox) {
        SandboxManager.cleanupAfterCommand();
      }
      // Only foreground tasks update the cwd
      if (result && !preventCwdChanges && !result.backgroundTaskId) {
        try {
          let newCwd = readFileSync(nativeCwdFilePath, {
            encoding: "utf8",
          }).trim();
          if (getPlatform() === "windows") {
            newCwd = posixPathToWindowsPath(newCwd);
          }
          // cwd is NFC-normalized (setCwdState); newCwd from `pwd -P` may be
          // NFD on macOS APFS. Normalize before comparing so Unicode paths
          // don't false-positive as "changed" on every command.
          if (newCwd.normalize("NFC") !== cwd) {
            setCwd(newCwd, cwd);
            invalidateSessionEnvCache();
            void onCwdChangedForHooks(cwd, newCwd);
          }
        } catch {
          // cwd tracking failed — non-fatal
        }
      }
      // Clean up the temp file used for cwd tracking
      try {
        unlinkSync(nativeCwdFilePath);
      } catch {
        // File may not exist if command failed before pwd -P ran
      }
    });

    return shellCommand;
  } catch (error) {
    // Close the fd if spawn failed (child never got its dup)
    if (outputHandle !== undefined) {
      try {
        await outputHandle.close();
      } catch {
        // May already be closed
      }
    }
    taskOutput.clear();

    logForDebugging(`Shell exec error: ${errorMessage(error)}`);

    return createAbortedCommand(undefined, {
      code: 126, // Standard Unix code for execution errors
      stderr: errorMessage(error),
    });
  }
}

/**
 * Set the current working directory
 */
export function setCwd(path: string, relativeTo?: string): void {
  const resolved = isAbsolute(path)
    ? path
    : resolve(relativeTo || getFsImplementation().cwd(), path);
  // Resolve symlinks to match the behavior of pwd -P.
  // realpathSync throws ENOENT if the path doesn't exist - convert to a
  // friendlier error message instead of a separate existsSync pre-check (TOCTOU).
  let physicalPath: string;
  try {
    physicalPath = getFsImplementation().realpathSync(resolved);
  } catch (e) {
    if (isENOENT(e)) {
      throw new Error(`Path "${resolved}" does not exist`);
    }
    throw e;
  }

  setCwdState(physicalPath);
}
