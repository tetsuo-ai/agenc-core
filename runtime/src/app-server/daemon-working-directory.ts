/**
 * The daemon outlives the shell or CLI that spawned it, so it must not keep
 * that caller's working directory. An eval workspace, a scratch directory or
 * a project that is later renamed all disappear while the daemon keeps
 * running, and from then on every child it spawns (the Keychain helper, git,
 * a tool) fails with ENOENT because the kernel cannot resolve the dead cwd
 * (#2149). The daemon home exists for exactly as long as the daemon does, so
 * the daemon works from there.
 *
 * @module
 */

export interface DaemonWorkingDirectoryIo {
  readonly stderr: { write(text: string): unknown };
}

/**
 * Enter `daemonHome`; returns false (and says why on stderr) when the
 * directory cannot be entered, in which case the daemon keeps the caller's
 * directory rather than refusing to start.
 */
export function enterDaemonWorkingDirectory(
  daemonHome: string,
  io: DaemonWorkingDirectoryIo,
  chdir: (path: string) => void = (path) => process.chdir(path),
): boolean {
  try {
    chdir(daemonHome);
    return true;
  } catch (error) {
    io.stderr.write(
      `agenc: daemon keeps the caller's working directory; could not enter ${daemonHome}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  }
}
