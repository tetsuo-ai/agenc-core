/**
 * Vendored minimal execFile wrapper used by OSC 52 clipboard copy paths.
 * Upstream ships an allowlist/env-sanitizer/deprecation layer; the Ink core
 * only needs "run this external binary, capture output, never throw".
 */

import { execFile } from 'node:child_process'

export type ExecResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error: Error | null
}

export type ExecOptions = {
  input?: string
  cwd?: string
  timeout?: number
  env?: NodeJS.ProcessEnv
  preserveOutputOnError?: boolean
  /**
   * When true, inherit the current working directory from process.cwd().
   * Mirrors the upstream openclaude option used by OSC 52 clipboard paths
   * that need to run from the user's terminal cwd.
   */
  useCwd?: boolean
  /** Stdio routing for the child process (subset used by the OSC 52 path). */
  stdin?: 'ignore' | 'pipe' | 'inherit'
}

export function execFileNoThrow(
  file: string,
  args: string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === 'number'
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : error
              ? 1
              : 0
        const stdoutStr = stdout == null ? '' : String(stdout)
        const stderrStr = stderr == null ? '' : String(stderr)
        resolve({
          code,
          signal:
            error && (error as { signal?: NodeJS.Signals }).signal
              ? ((error as { signal?: NodeJS.Signals }).signal as NodeJS.Signals)
              : null,
          stdout: stdoutStr,
          stderr: stderrStr,
          error: error ?? null,
        })
      },
    )

    if (options.input !== undefined && child.stdin) {
      try {
        child.stdin.end(options.input)
      } catch {
        // Best-effort — stdin might already be closed.
      }
    }
  })
}

export function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  cwd: string,
  options: Omit<ExecOptions, 'cwd'> = {},
): Promise<ExecResult> {
  return execFileNoThrow(file, args, { ...options, cwd })
}
