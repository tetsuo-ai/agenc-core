import { execFile } from "node:child_process";

export interface AutoUpdateCheckOptions {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly distTag?: string;
  readonly npmBin?: string;
  readonly timeoutMs?: number;
}

export interface AutoUpdateCheckResult {
  readonly updateAvailable: boolean;
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly packageName: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function parseNpmVersion(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return trimmed.replace(/^["']|["']$/gu, "");
  }
}

export async function checkNpmUpdate(
  options: AutoUpdateCheckOptions,
): Promise<AutoUpdateCheckResult> {
  const npm = options.npmBin ?? "npm";
  const distTag = options.distTag ?? "latest";
  const latestVersion = await new Promise<string | undefined>((resolve, reject) => {
    execFile(
      npm,
      ["view", `${options.packageName}@${distTag}`, "version", "--json"],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr.toString().trim() ||
                error.message ||
                "failed to check npm update",
            ),
          );
          return;
        }
        resolve(parseNpmVersion(stdout.toString()));
      },
    );
  });
  return {
    packageName: options.packageName,
    currentVersion: options.currentVersion,
    ...(latestVersion !== undefined ? { latestVersion } : {}),
    updateAvailable:
      latestVersion !== undefined &&
      compareSemver(latestVersion, options.currentVersion) > 0,
  };
}

export async function installNpmUpdate(options: {
  readonly packageName: string;
  readonly version?: string;
  readonly npmBin?: string;
  readonly timeoutMs?: number;
}): Promise<void> {
  const target =
    options.version !== undefined
      ? `${options.packageName}@${options.version}`
      : options.packageName;
  await new Promise<void>((resolve, reject) => {
    execFile(
      options.npmBin ?? "npm",
      ["install", "-g", target],
      {
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr.toString().trim() ||
                error.message ||
                "failed to install npm update",
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}
