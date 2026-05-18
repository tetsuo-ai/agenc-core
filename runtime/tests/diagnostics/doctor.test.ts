import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderAvailabilityReport } from "../llm/discovery/provider-discovery.js";
import {
  collectDoctorReport,
  formatDoctorReport,
  type DoctorContext,
} from "./doctor.js";

const providerReport: ProviderAvailabilityReport = {
  entries: [{
    provider: "grok",
    model: "grok-4",
    status: "usable",
    usable: true,
    keyStatus: "present",
    keyEnvVar: "XAI_API_KEY",
    localStatus: "n/a",
    detail: "BYOK credential found via XAI_API_KEY",
  }],
};

function fakeContext(
  cwd: string,
  services: Record<string, unknown> = {},
): DoctorContext {
  return {
    cwd,
    home: cwd,
    agencHome: path.join(cwd, ".agenc"),
    session: {
      conversationId: "session-1",
      state: {
        unsafePeek: () => ({
          sessionConfiguration: {
            provider: { slug: "xai" },
            collaborationMode: { model: "grok-4" },
          },
        }),
      },
      services: {
        mcpManager: {
          effectiveServers: async () => new Map(),
          getConnectedServers: () => [],
        },
        ...services,
      },
    },
  };
}

async function makeRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agenc-runtime-root-"));
  for (const dir of [
    "bin",
    "dist/bin",
    "dist/policies",
    "dist/sandbox/linux-launcher",
    "dist/sandbox/linux-launcher/policies",
    "dist/tui",
  ]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@tetsuo-ai/runtime",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      bin: {
        agenc: "bin/agenc",
        "agenc-linux-sandbox": "bin/agenc-linux-sandbox",
      },
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
    }),
  );
  for (const rel of [
    "bin/agenc",
    "bin/agenc-linux-sandbox",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/bin/agenc.js",
    "dist/policies/restricted_read_only_platform_defaults.sbpl",
    "dist/policies/seatbelt_base_policy.sbpl",
    "dist/policies/seatbelt_network_policy.sbpl",
    "dist/sandbox/linux-launcher/main.js",
    "dist/sandbox/linux-launcher/policies/restricted_read_only_platform_defaults.sbpl",
    "dist/sandbox/linux-launcher/policies/seatbelt_base_policy.sbpl",
    "dist/sandbox/linux-launcher/policies/seatbelt_network_policy.sbpl",
    "dist/tui/main.js",
  ]) {
    await writeFile(path.join(root, rel), "#!/usr/bin/env node\n");
  }
  await chmod(path.join(root, "bin/agenc"), 0o700);
  await chmod(path.join(root, "bin/agenc-linux-sandbox"), 0o700);
  await writeFile(
    path.join(root, "dist/VERSION"),
    JSON.stringify({
      commit: "abc123def456",
      shortCommit: "abc123",
      buildTime: "2026-05-06T00:00:00.000Z",
      runtimeVersion: "0.2.0",
    }),
  );
  return root;
}

type TestPathStat = NonNullable<ReturnType<typeof fileStat>>;

function statOverride(overrides: Record<string, Partial<TestPathStat>>): (target: string) => TestPathStat | null {
  return (target) => {
    for (const [suffix, value] of Object.entries(overrides)) {
      if (target.endsWith(suffix)) {
        const fallback = {
          exists: false,
          isFile: false,
          isDirectory: false,
          isSocket: false,
          mode: 0,
        };
        return {
          ...fallback,
          ...(fileStat(target) ?? {}),
          exists: true,
          ...value,
        };
      }
    }
    return fileStat(target);
  };
}

function fileStat(target: string): {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSocket: boolean;
  readonly mode: number;
} | null {
  try {
    const stat = statSync(target);
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSocket: stat.isSocket(),
      mode: stat.mode,
    };
  } catch {
    return null;
  }
}

describe("doctor diagnostics", () => {
  it("formats concrete runtime, provider, sandbox, daemon, and MCP findings", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-"));
    const runtimeRoot = await makeRuntimeRoot();
    const report = await collectDoctorReport(fakeContext(cwd), {
      runtimeRoot,
      processVersion: "v25.4.0",
      platform: "linux",
      agencLinuxSandboxExe: path.join(runtimeRoot, "bin/agenc-linux-sandbox"),
      systemBwrapWarning: null,
      providerAvailabilityReport: providerReport,
      daemonPid: null,
      now: () => new Date("2026-05-06T00:00:00.000Z"),
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "provider",
          severity: "ok",
          detail: expect.stringContaining("xai / grok-4"),
        }),
        expect.objectContaining({
          category: "sandbox",
          code: "linux-transform",
          severity: "ok",
        }),
        expect.objectContaining({
          category: "daemon",
          severity: "warn",
          detail: expect.stringContaining("not running"),
        }),
        expect.objectContaining({
          category: "mcp",
          severity: "ok",
          detail: "none configured",
        }),
      ]),
    );

    const text = formatDoctorReport(report);
    expect(text).toContain("AgenC doctor");
    expect(text).toContain("Summary:");
    expect(text).toContain("fix: run `agenc daemon start`");
    expect(text).toContain("provider: xai / grok-4");
    expect(text).toContain(`working directory: ${cwd}`);
    expect(text).toContain("sandbox runtime: linux_seccomp command builds");
  });

  it("only reports daemon ok after a socket health ping succeeds", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-daemon-"));
    const runtimeRoot = await makeRuntimeRoot();
    const baseOptions = {
      runtimeRoot,
      processVersion: "v25.4.0",
      platform: "linux" as const,
      agencLinuxSandboxExe: path.join(runtimeRoot, "bin/agenc-linux-sandbox"),
      systemBwrapWarning: null,
      providerAvailabilityReport: providerReport,
      daemonPid: 1234,
      isDaemonPidRunning: () => true,
      statPath: statOverride({
        "daemon.sock": { isSocket: true, isFile: false, mode: 0o600 },
        "daemon.cookie": { isFile: true, mode: 0o600 },
      }),
    };

    const okReport = await collectDoctorReport(fakeContext(cwd), {
      ...baseOptions,
      pingDaemon: async () => ({ ok: true, detail: "ok at now" }),
    });
    expect(okReport.findings).toContainEqual(
      expect.objectContaining({
        category: "daemon",
        code: "daemon-running",
        severity: "ok",
        detail: expect.stringContaining("answered health.ping"),
      }),
    );

    const failedReport = await collectDoctorReport(fakeContext(cwd), {
      ...baseOptions,
      pingDaemon: async () => ({ ok: false, detail: "initialize rejected" }),
    });
    expect(failedReport.findings).toContainEqual(
      expect.objectContaining({
        category: "daemon",
        code: "daemon-running",
        severity: "warn",
        detail: expect.stringContaining("reachability was not verified"),
      }),
    );
  });

  it("distinguishes stale daemon pids, bad socket paths, and broad cookie permissions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-daemon-bad-"));
    const runtimeRoot = await makeRuntimeRoot();
    const common = {
      runtimeRoot,
      processVersion: "v25.4.0",
      platform: "linux" as const,
      agencLinuxSandboxExe: path.join(runtimeRoot, "bin/agenc-linux-sandbox"),
      systemBwrapWarning: null,
      providerAvailabilityReport: providerReport,
      daemonPid: 4567,
    };

    const stale = await collectDoctorReport(fakeContext(cwd), {
      ...common,
      isDaemonPidRunning: () => false,
    });
    expect(stale.findings).toContainEqual(
      expect.objectContaining({
        category: "daemon",
        severity: "warn",
        detail: expect.stringContaining("stale pid"),
      }),
    );

    const badSocket = await collectDoctorReport(fakeContext(cwd), {
      ...common,
      isDaemonPidRunning: () => true,
      statPath: statOverride({
        "daemon.sock": { isSocket: false, isFile: true, mode: 0o600 },
        "daemon.cookie": { isFile: true, mode: 0o644 },
      }),
    });
    expect(badSocket.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "daemon",
          code: "daemon-running",
          severity: "error",
          detail: expect.stringContaining("not a socket"),
        }),
        expect.objectContaining({
          category: "daemon",
          code: "daemon-cookie",
          severity: "error",
          detail: expect.stringContaining("too broad"),
        }),
      ]),
    );
  });

  it("reports provider, subscription, and auth failures without throwing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-provider-"));
    const runtimeRoot = await makeRuntimeRoot();
    const report = await collectDoctorReport(
      fakeContext(cwd, {
        authBackend: {
          kind: "remote",
          whoami: async () => ({ authenticated: false, provider: "remote" }),
          login: async () => ({ authenticated: true }),
          logout: async () => ({ authenticated: false }),
          vendKey: async () => {
            throw new Error("no key");
          },
          inferAgencModel: async () => ({ provider: "grok", model: "grok-4" }),
          getSubscriptionTier: async () => "free",
        },
      }),
      {
        runtimeRoot,
        processVersion: "v25.4.0",
        platform: "linux",
        agencLinuxSandboxExe: path.join(runtimeRoot, "bin/agenc-linux-sandbox"),
        systemBwrapWarning: null,
        providerAvailabilityReport: {
          subscriptionError: "subscription endpoint unavailable",
          entries: [{
            provider: "grok",
            model: "grok-4",
            status: "unusable",
            usable: false,
            keyStatus: "missing",
            keyEnvVar: "XAI_API_KEY",
            localStatus: "n/a",
            detail: "set XAI_API_KEY",
          }],
        },
        daemonPid: null,
      },
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "provider", code: "active-provider", severity: "error" }),
        expect.objectContaining({ category: "provider", code: "auth-subscription", severity: "warn" }),
        expect.objectContaining({ category: "provider", code: "auth-backend", severity: "warn" }),
      ]),
    );
  });

  it("redacts sensitive MCP targets and covers connected, optional, and disabled states", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-mcp-states-"));
    const runtimeRoot = await makeRuntimeRoot();
    const report = await collectDoctorReport(
      fakeContext(cwd, {
        mcpManager: {
          effectiveServers: async () =>
            new Map([
              [
                "secure",
                {
                  enabled: true,
                  required: false,
                  url: "https://user:password@localhost:3000/mcp?token=abcdefghijklmnopqrstuvwxyz123456&safe=1",
                },
              ],
              [
                "optional",
                {
                  enabled: true,
                  required: false,
                  command: "node server.js --token abcdefghijklmnopqrstuvwxyz123456",
                },
              ],
              ["disabled", { enabled: false, required: false, command: "node disabled.js" }],
            ]),
          getConnectedServers: () => ["secure"],
        },
      }),
      {
        runtimeRoot,
        processVersion: "v25.4.0",
        platform: "linux",
        agencLinuxSandboxExe: path.join(runtimeRoot, "bin/agenc-linux-sandbox"),
        systemBwrapWarning: null,
        providerAvailabilityReport: providerReport,
        daemonPid: null,
      },
    );

    const text = formatDoctorReport(report);
    expect(text).toContain("MCP secure: connected");
    expect(text).toContain("MCP optional: disconnected");
    expect(text).toContain("MCP disabled: disabled");
    expect(text).not.toContain("password");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("covers macOS and Windows sandbox reporting branches", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-platforms-"));
    const runtimeRoot = await makeRuntimeRoot();
    const mac = await collectDoctorReport(fakeContext(cwd), {
      runtimeRoot,
      processVersion: "v25.4.0",
      platform: "darwin",
      providerAvailabilityReport: providerReport,
      daemonPid: null,
      statPath: statOverride({
        "/usr/bin/sandbox-exec": { exists: true, isFile: true, mode: 0o755 },
      }),
    });
    expect(mac.findings).toContainEqual(
      expect.objectContaining({
        category: "sandbox",
        code: "seatbelt-transform",
        severity: "ok",
      }),
    );

    const windows = await collectDoctorReport(fakeContext(cwd), {
      runtimeRoot,
      processVersion: "v25.4.0",
      platform: "win32",
      providerAvailabilityReport: providerReport,
      daemonPid: null,
    });
    expect(windows.findings).toContainEqual(
      expect.objectContaining({
        category: "sandbox",
        code: "sandbox-platform",
        severity: "info",
      }),
    );
  });

  it("escalates required MCP servers that are configured but disconnected", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-mcp-"));
    const runtimeRoot = await makeRuntimeRoot();
    const report = await collectDoctorReport(
      fakeContext(cwd, {
        mcpManager: {
          effectiveServers: async () =>
            new Map([[
              "github",
              { enabled: true, required: true, command: "npx mcp-server" },
            ]]),
          getConnectedServers: () => [],
        },
      }),
      {
        runtimeRoot,
        processVersion: "v25.4.0",
        platform: "linux",
        agencLinuxSandboxExe: path.join(runtimeRoot, "bin/agenc-linux-sandbox"),
        systemBwrapWarning: null,
        providerAvailabilityReport: providerReport,
        daemonPid: null,
      },
    );

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        category: "mcp",
        code: "mcp-server-disconnected",
        severity: "error",
        title: "MCP github",
      }),
    );
  });

  it("reports missing runtime artifacts without hiding the specific file list", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-artifacts-"));
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "agenc-runtime-empty-"));
    await writeFile(
      path.join(runtimeRoot, "package.json"),
      JSON.stringify({ name: "@tetsuo-ai/runtime" }),
    );

    const report = await collectDoctorReport(fakeContext(cwd), {
      runtimeRoot,
      processVersion: "v25.4.0",
      platform: "linux",
      agencLinuxSandboxExe: "/missing/agenc-linux-sandbox",
      systemBwrapWarning: null,
      providerAvailabilityReport: providerReport,
      daemonPid: null,
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        category: "runtime",
        code: "runtime-artifacts",
        severity: "warn",
        detail: expect.stringContaining("dist/index.js"),
      }),
    );
  });

  it("reports present but invalid runtime artifacts as integrity errors", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agenc-doctor-artifact-bad-"));
    const runtimeRoot = await makeRuntimeRoot();
    await chmod(path.join(runtimeRoot, "bin/agenc"), 0o600);
    await writeFile(path.join(runtimeRoot, "dist/VERSION"), "{}");

    const report = await collectDoctorReport(fakeContext(cwd), {
      runtimeRoot,
      processVersion: "v25.4.0",
      platform: "linux",
      agencLinuxSandboxExe: path.join(runtimeRoot, "bin/agenc-linux-sandbox"),
      systemBwrapWarning: null,
      providerAvailabilityReport: providerReport,
      daemonPid: null,
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        category: "runtime",
        code: "runtime-artifacts",
        severity: "error",
        detail: expect.stringContaining("bin/agenc is not executable"),
      }),
    );
    expect(formatDoctorReport(report)).toContain("dist/VERSION missing commit");
  });
});
