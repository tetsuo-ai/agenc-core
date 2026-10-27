import { spawn } from "node:child_process";
import { close, constants, fstat, open } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { hasSupportedFileIdentity } from "../session/session-store.js";

const openAsync = promisify(open);
const closeAsync = promisify(close);
const fstatAsync = promisify(fstat);

export const STARTUP_RESUME_CWD_TIMEOUT_MS = 10_000;

export class StartupResumeCwdPermissionError extends Error {
  constructor() {
    super("macOS is asking for permission to open the folder; answer the dialog, then resume the session");
    this.name = "StartupResumeCwdPermissionError";
  }
}

export interface StartupResumeCwd {
  readonly fd: number;
  readonly identity: { readonly dev: string; readonly ino: string };
}

/**
 * Workspace syscalls can wait for macOS privacy consent or a remote mount.
 * On macOS first open the directory in a disposable process. A privacy prompt
 * must never occupy a daemon worker. The deadline covers probe and pinning;
 * native pin operations cannot be cancelled, so late descriptors still close.
 */
export async function openStartupResumeCwd(
  cwd: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly platformForTestingOnly?: NodeJS.Platform;
    readonly afterOpenForTestingOnly?: (cwd: string, fd: number) => void;
  } = {},
): Promise<StartupResumeCwd> {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error("canonical startup resume cwd is not absolute and normalized");
  }
  let probing = (options.platformForTestingOnly ?? process.platform) === "darwin";
  const deadline = new AbortController();
  const signal =
    options.signal === undefined
      ? deadline.signal
      : AbortSignal.any([deadline.signal, options.signal]);
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? STARTUP_RESUME_CWD_TIMEOUT_MS;
  const timer = setTimeout(() => {
    deadline.abort(
      probing
        ? new StartupResumeCwdPermissionError()
        : new Error(`startup resume workspace timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);
  timer.unref?.();
  try {
    if (probing) {
      await probeWorkspace(cwd, signal);
      signal.throwIfAborted();
      probing = false;
    }
    return await new Promise<StartupResumeCwd>((resolveProof, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      void pinCwd(cwd, signal, options.afterOpenForTestingOnly).then(
        (proof) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            // The abort can win between pinCwd returning and this callback.
            void closeAsync(proof.fd).catch(() => {});
            reject(signal.reason);
          } else {
            resolveProof(proof);
          }
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  } finally {
    clearTimeout(timer);
  }
}

async function pinCwd(
  cwd: string,
  signal: AbortSignal,
  afterOpenForTestingOnly?: (cwd: string, fd: number) => void,
): Promise<StartupResumeCwd> {
  const before = await lstat(cwd, { bigint: true });
  signal.throwIfAborted();
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !hasSupportedFileIdentity(before) ||
    (await realpath(cwd)) !== cwd
  ) {
    throw new Error("canonical startup resume cwd is not a supported non-symlink directory");
  }
  signal.throwIfAborted();
  const fd = await openAsync(
    cwd,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  );
  try {
    signal.throwIfAborted();
    const opened = await fstatAsync(fd, { bigint: true });
    signal.throwIfAborted();
    afterOpenForTestingOnly?.(cwd, fd);
    const after = await lstat(cwd, { bigint: true });
    signal.throwIfAborted();
    if (
      !opened.isDirectory() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !hasSupportedFileIdentity(opened) ||
      !hasSupportedFileIdentity(after) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      (await realpath(cwd)) !== cwd
    ) {
      throw new Error("canonical startup resume cwd changed while pinned");
    }
    signal.throwIfAborted();
    return {
      fd,
      identity: { dev: opened.dev.toString(10), ino: opened.ino.toString(10) },
    };
  } catch (error) {
    await closeAsync(fd);
    throw error;
  }
}

async function probeWorkspace(cwd: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  // stat/access do not trigger the same TCC check as opening the directory.
  // Pass the path as an argument so quotes and shell syntax remain literal.
  const child = spawn("/bin/sh", ["-c", 'exec 3< "$1"', "sh", cwd], {
    cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: "ignore",
  });
  await new Promise<void>((resolveProbe, reject) => {
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolveProbe();
      else reject(new Error(`startup workspace open probe failed (${exitSignal ?? code})`));
    });
    // Also cover cancellation between spawning and installing the listener.
    if (signal.aborted) onAbort();
  });
}
