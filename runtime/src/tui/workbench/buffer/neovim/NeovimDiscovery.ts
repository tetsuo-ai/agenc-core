import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  spawnContainedProcess,
  terminateProcessTreeAndWait,
} from "../../../../utils/supervisedProcess.js";
import { which } from "../../../../utils/which.js";

export type NeovimDiscoveryConfig = {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly useUserInit?: boolean;
  readonly minVersion?: readonly [number, number, number];
};

export type NeovimVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
};

export type NeovimDiscoveryResult =
  | {
      readonly usable: true;
      readonly executable: string;
      readonly version: NeovimVersion;
      readonly args: readonly string[];
      readonly useUserInit: boolean;
      readonly fallback?: {
        readonly args: readonly string[];
        readonly useUserInit: boolean;
      };
    }
  | {
      readonly usable: false;
      readonly reasonCode:
        | "missing-binary"
        | "probe-failed"
        | "probe-timeout"
        | "unsupported-version";
      readonly reason: string;
      readonly executable: string | null;
      readonly version?: NeovimVersion;
    };

// The precompiled Job Object broker removes Windows' former runtime C#
// compilation cost. Retain modest cold endpoint-protection headroom without
// turning a broken executable into a long startup stall.
const DEFAULT_TIMEOUT_MS = process.platform === "win32" ? 5_000 : 1200;
const DEFAULT_MIN_VERSION = [0, 9, 0] as const;
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

export async function discoverNeovim(
  config: NeovimDiscoveryConfig = {},
): Promise<NeovimDiscoveryResult> {
  const executable = await resolveNeovimExecutable(config.executable);
  if (!executable) {
    return {
      usable: false,
      reasonCode: "missing-binary",
      reason: "Embedded Neovim is unavailable because no usable nvim executable was found.",
      executable: null,
    };
  }

  const probe = await probeNeovimVersion(executable, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (probe.type === "timeout") {
    return {
      usable: false,
      reasonCode: "probe-timeout",
      reason: `Embedded Neovim is unavailable because ${executable} did not answer the version probe in time.`,
      executable,
    };
  }
  if (probe.type === "failed") {
    return {
      usable: false,
      reasonCode: "probe-failed",
      reason: `Embedded Neovim is unavailable because ${executable} failed the version probe: ${probe.message}`,
      executable,
    };
  }

  const minVersion = config.minVersion ?? DEFAULT_MIN_VERSION;
  if (compareVersions(probe.version, minVersion) < 0) {
    return {
      usable: false,
      reasonCode: "unsupported-version",
      reason: `Embedded Neovim requires nvim ${minVersion.join(".")} or newer; found ${probe.version.raw}.`,
      executable,
      version: probe.version,
    };
  }

  // Do not launch a disposable `nvim --embed` here. In user-init mode that
  // would execute plugins and autocommands twice before the editor appears.
  // The provider performs exactly one real startup and, for auto mode only,
  // retries that same contained lifecycle with a clean init if it fails.
  const [primary, fallback] = embedArgCandidates(config.useUserInit);
  if (!primary) {
    throw new Error("Neovim discovery produced no startup candidate");
  }
  return {
    usable: true,
    executable,
    version: probe.version,
    useUserInit: primary.useUserInit,
    args: primary.args,
    ...(fallback ? { fallback } : {}),
  };
}

export async function resolveNeovimExecutable(configuredExecutable?: string): Promise<string | null> {
  const configured = configuredExecutable?.trim();
  if (configured) {
    if (isAbsolute(configured)) return configured;
    if (isSafeExecutableName(configured)) {
      const configuredPath = await which(configured);
      if (configuredPath) return configuredPath;
    }
  }
  return which("nvim");
}

export function buildNeovimEmbedArgs(useUserInit: boolean): readonly string[] {
  return useUserInit
    ? ["--embed"]
    : ["--embed", "--clean"];
}

function embedArgCandidates(useUserInit: boolean | undefined): readonly {
  readonly useUserInit: boolean;
  readonly args: readonly string[];
}[] {
  if (useUserInit === true) {
    return [{ useUserInit: true, args: buildNeovimEmbedArgs(true) }];
  }
  if (useUserInit === false) {
    return [{ useUserInit: false, args: buildNeovimEmbedArgs(false) }];
  }
  return [
    { useUserInit: true, args: buildNeovimEmbedArgs(true) },
    { useUserInit: false, args: buildNeovimEmbedArgs(false) },
  ];
}

export function parseNeovimVersion(output: string): NeovimVersion | null {
  const match = output.match(/NVIM\s+v?(\d+)\.(\d+)\.(\d+)[^\r\n]*/u);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: match[0].trim(),
  };
}

export function compareVersions(
  version: NeovimVersion,
  minimum: readonly [number, number, number],
): number {
  const actual = [version.major, version.minor, version.patch] as const;
  for (let index = 0; index < minimum.length; index += 1) {
    const delta = actual[index] - minimum[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

type ProbeResult =
  | { readonly type: "ok"; readonly version: NeovimVersion }
  | { readonly type: "timeout" }
  | { readonly type: "failed"; readonly message: string };

function probeNeovimVersion(executable: string, timeoutMs: number): Promise<ProbeResult> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnContainedProcess(executable, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
    });
    child.stdin.end();
  } catch (error) {
    return Promise.resolve({
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let cleanupPromise: Promise<void> | null = null;
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = terminateProcessTreeAndWait(child, {
        terminateGraceMs: 50,
        // Cleanup verification is a separate bounded phase, not a second copy
        // of the probe deadline. Job Objects and the POSIX containment
        // boundaries fail closed if they cannot prove teardown in this grace.
        killGraceMs: 1_000,
        label: "Neovim version probe",
      });
      // An early leader exit begins cleanup before `close` drains the pipes.
      // Mark the promise handled now; `finish` still observes and reports the
      // same rejection once it has a probe result to settle.
      void cleanupPromise.catch(() => {});
      return cleanupPromise;
    };
    const retireProbeStreams = (): void => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // A Darwin descendant can outlive the leader after leaving the observed
      // PPID tree. Retire our pipe ends independently of tree discovery so an
      // inherited writer can neither keep this probe pending nor keep AgenC's
      // event loop alive after the configured deadline.
      retireProbeStreams();
      void cleanup().then(
        () => resolve(result),
        (error: unknown) => resolve({
          type: "failed",
          message:
            `version probe cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
        }),
      );
    };
    const appendOutput = (
      current: string,
      chunk: Buffer,
    ): string | null => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        finish({
          type: "failed",
          message: `probe output exceeded ${MAX_PROBE_OUTPUT_BYTES} bytes`,
        });
        return null;
      }
      return current + chunk.toString("utf8");
    };
    timer = setTimeout(() => {
      finish({ type: "timeout" });
    }, Math.max(1, timeoutMs));
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendOutput(stdout, chunk);
      if (next !== null) stdout = next;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendOutput(stderr, chunk);
      if (next !== null) stderr = next;
    });
    child.on("error", (error) => {
      finish({ type: "failed", message: error.message });
    });
    child.on("exit", () => {
      // `close` waits for every inherited pipe handle, including handles held
      // by descendants. Start contained-tree teardown as soon as the probe
      // leader exits, but retain the deadline until those pipes actually
      // settle. Darwin can only track descendants observed before they leave
      // the PPID tree, so leader exit alone is not proof that `close` will fire.
      void cleanup().catch(() => {
        // If teardown itself fails before the inherited pipes close, do not
        // leave discovery waiting forever for a `close` event that may never
        // arrive. `finish` reports the concrete cleanup failure.
        finish({ type: "failed", message: "version probe cleanup failed" });
      });
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish({ type: "failed", message: stderr.trim() || signal || `exit ${code}` });
        return;
      }
      const version = parseNeovimVersion(stdout);
      finish(
        version
          ? { type: "ok", version }
          : { type: "failed", message: "version output did not contain an NVIM version line" },
      );
    });
  });
}

function isSafeExecutableName(value: string): boolean {
  return /^[A-Za-z0-9._+-]+$/u.test(value);
}
