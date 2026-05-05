import { runLinuxSandboxMain, type LinuxSandboxRunDeps } from "./linux-run-main.js";

export interface LinuxSandboxEntrypointResult {
  readonly exitCode: number;
  readonly stderr: readonly string[];
}

export async function runLinuxSandboxEntrypoint(
  argv: readonly string[],
  deps: Omit<LinuxSandboxRunDeps, "onStderr"> & {
    readonly onStderr?: (line: string) => void;
  } = {},
): Promise<LinuxSandboxEntrypointResult> {
  const stderr: string[] = [];
  const exitCode = await runLinuxSandboxMain(argv, {
    ...deps,
    onStderr(line) {
      stderr.push(line);
      deps.onStderr?.(line);
    },
  });
  return { exitCode, stderr };
}

export function isLauncherUsageFailure(result: LinuxSandboxEntrypointResult): boolean {
  return result.exitCode === 2 && result.stderr.length > 0;
}

export function formatLauncherFailure(
  result: LinuxSandboxEntrypointResult,
): string {
  return result.stderr.join("\n");
}
