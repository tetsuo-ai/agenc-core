import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
    JSON.stringify({ name: "@tetsuo-ai/runtime" }),
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
  await chmod(path.join(root, "bin/agenc-linux-sandbox"), 0o700);
  await writeFile(
    path.join(root, "dist/VERSION"),
    JSON.stringify({ runtimeVersion: "0.2.0", shortCommit: "abc123" }),
  );
  return root;
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
    expect(text).toContain("provider: xai / grok-4");
    expect(text).toContain(`working directory: ${cwd}`);
    expect(text).toContain("sandbox runtime: linux_seccomp command builds");
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
});
