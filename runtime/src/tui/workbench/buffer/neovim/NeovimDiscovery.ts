import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

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

const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_MIN_VERSION = [0, 9, 0] as const;

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

  let failedEmbedMessage: string | null = null;
  for (const candidate of embedArgCandidates(config.useUserInit)) {
    const embedProbe = await probeNeovimEmbed(executable, candidate.args, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (embedProbe.type === "ok") {
      return {
        usable: true,
        executable,
        version: probe.version,
        useUserInit: candidate.useUserInit,
        args: candidate.args,
      };
    }
    failedEmbedMessage = embedProbe.message;
  }

  return {
    usable: false,
    reasonCode: "probe-failed",
    reason: `Embedded Neovim is unavailable because ${executable} failed the embedded mode probe: ${failedEmbedMessage ?? "embedded mode did not start"}`,
    executable,
    version: probe.version,
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
    : ["--embed", "--clean", "-n"];
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
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(executable, ["--version"], {
      detached,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProbeProcess(child, detached);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ type: "timeout" });
    }, Math.max(1, timeoutMs));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ type: "failed", message: error.message });
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

type EmbedProbeResult =
  | { readonly type: "ok" }
  | { readonly type: "failed"; readonly message: string };

function probeNeovimEmbed(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<EmbedProbeResult> {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(executable, [...args], {
      detached,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let failedExit: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    } | null = null;
    let settled = false;
    const finish = (result: EmbedProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProbeProcess(child, detached);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (failedExit !== null) {
        finish({
          type: "failed",
          message: stderr.trim() || failedExit.signal || `exit ${failedExit.code}`,
        });
        return;
      }
      finish({ type: "ok" });
    }, Math.max(1, Math.min(timeoutMs, 200)));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.resume();
    child.on("error", (error) => {
      finish({ type: "failed", message: error.message });
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish({ type: "ok" });
        return;
      }
      failedExit = { code, signal };
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish({ type: "ok" });
        return;
      }
      finish({ type: "failed", message: stderr.trim() || signal || `exit ${code}` });
    });
  });
}

function killProbeProcess(child: ChildProcess, detached: boolean): void {
  const pid = child.pid;
  // The leader may already be gone while jobs it started still occupy the
  // owned group, so group cleanup must not depend on the leader's exit state.
  if (detached && process.platform !== "win32" && pid !== undefined && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch (error) {
      if (isMissingProcessError(error)) return;
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Spawn failures and concurrent exits can make the direct fallback unavailable.
  }
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function isSafeExecutableName(value: string): boolean {
  return /^[A-Za-z0-9._+-]+$/u.test(value);
}
