import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromRuntime = createRequire(import.meta.url);

const PLATFORM_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "@vscode/ripgrep-darwin-arm64",
  "darwin-x64": "@vscode/ripgrep-darwin-x64",
  "linux-arm": "@vscode/ripgrep-linux-arm",
  "linux-arm64": "@vscode/ripgrep-linux-arm64",
  "linux-ia32": "@vscode/ripgrep-linux-ia32",
  "linux-ppc64": "@vscode/ripgrep-linux-ppc64",
  "linux-riscv64": "@vscode/ripgrep-linux-riscv64",
  "linux-s390x": "@vscode/ripgrep-linux-s390x",
  "linux-x64": "@vscode/ripgrep-linux-x64",
  "win32-arm64": "@vscode/ripgrep-win32-arm64",
  "win32-ia32": "@vscode/ripgrep-win32-ia32",
  "win32-x64": "@vscode/ripgrep-win32-x64",
});

export interface ResolvePinnedRipgrepOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly resolveModule?: (specifier: string) => string;
}

/**
 * Resolve only the exact lockfile-pinned platform package. Resolution failure
 * is an availability result, never an import-time exception or a PATH lookup.
 */
export function resolvePinnedRipgrepPath(
  options: ResolvePinnedRipgrepOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformPackage = PLATFORM_PACKAGES[`${platform}-${arch}`];
  if (platformPackage === undefined) return undefined;

  const binaryName = platform === "win32" ? "rg.exe" : "rg";
  try {
    const resolved = (options.resolveModule ?? requireFromRuntime.resolve)(
      `${platformPackage}/bin/${binaryName}`,
    );
    return isAbsolute(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

const resolvedPinnedRipgrepPath = resolvePinnedRipgrepPath();

/** True only when the exact optional platform package resolved. */
export const PINNED_RIPGREP_AVAILABLE = resolvedPinnedRipgrepPath !== undefined;

/**
 * Absolute fail-closed sentinel used when the optional package is absent.
 * Callers may safely attempt to spawn it and receive ENOENT; it can never
 * select an operator-controlled `rg` from PATH.
 */
export const PINNED_RIPGREP_PATH =
  resolvedPinnedRipgrepPath ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    `.agenc-missing-pinned-ripgrep-${process.platform}-${process.arch}`,
  );
