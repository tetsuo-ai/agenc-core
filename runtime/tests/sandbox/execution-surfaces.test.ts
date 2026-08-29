import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCCommandExecService } from "../../src/app-server/command-exec.js";
import { runHookCommand } from "../../src/hooks/engine/command-runner.js";
import { AgenCStdioClientTransport } from "../../src/mcp-client/transports/stdio.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { attachSandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { registerSandboxExecutionLifecycleParticipant } from "../../src/sandbox/execution-lifecycle.js";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { CanonicalBashTool } from "../../src/tools/canonicalToolSurface.js";
import { createMonitorTool } from "../../src/tools/system/monitor.js";

const roots: string[] = [];
const testRuntimeOptions = resolveAgentRuntimeOptions({});
const testUserShell = Object.freeze({
  path: "/bin/sh",
  commandWrapperArgv: Object.freeze([]),
  childEnvironment: Object.freeze({
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: tmpdir(),
  }),
  deriveExecArgs: (input: string) => ["-c", input],
});
const legacyTestSession = {
  conversationId: "sandbox-surface-test-session",
  services: {
    admissionRequired: false,
    runtimeOptions: testRuntimeOptions,
    userShell: testUserShell,
  },
} as never;

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function unavailableBroker(cwd: string): SandboxExecutionBroker {
  return new SandboxExecutionBroker({
    mode: "workspace_write",
    cwd,
    probe: () => ({
      kind: "unavailable",
      mode: "workspace_write",
      platform: process.platform,
      reason: "probe: injected namespace failure",
      remediation: "repair sandbox support",
    }),
  });
}

beforeEach(() => setCurrentRuntimeSession(legacyTestSession));

afterEach(() => {
  clearCurrentRuntimeSession(legacyTestSession);
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("fail-closed process surfaces", () => {
  it("blocks configured hooks before host spawn", async () => {
    const root = tempRoot("agenc-sandbox-hook-");
    const marker = join(root, "hook-escaped");

    await expect(
      runHookCommand({
        command: `${process.execPath} -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')"`,
        cwd: root,
        env: process.env,
        shellPath: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        stdin: "{}\n",
        timeoutMs: 5_000,
        sandboxExecutionBroker: unavailableBroker(root),
      }),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "hook",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks MCP stdio before host spawn", async () => {
    const root = tempRoot("agenc-sandbox-mcp-");
    const marker = join(root, "mcp-escaped");
    const broker = unavailableBroker(root);
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "mcp-manager",
      spawnSurfaces: ["mcp_stdio"],
      quiesce: async () => {},
      resume: async () => {},
    });
    const transport = new AgenCStdioClientTransport(
      {
        command: process.execPath,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
        cwd: root,
        env: { ...process.env } as Record<string, string>,
      },
      undefined,
      broker,
    );

    await expect(transport.start()).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "mcp_stdio",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects MCP stdio when no sandbox boundary was supplied", async () => {
    const root = tempRoot("agenc-sandbox-mcp-uncovered-");
    const marker = join(root, "mcp-uncovered");
    const transport = new AgenCStdioClientTransport({
      command: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
      cwd: root,
      env: {},
    });

    await expect(transport.start()).rejects.toThrow("sandbox_surface_uncovered");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects daemon commandExec requests that omit an explicit policy", async () => {
    const root = tempRoot("agenc-sandbox-command-exec-");
    const marker = join(root, "command-exec-escaped");
    const service = new AgenCCommandExecService();

    await expect(
      service.start(
        {
          command: [
            process.execPath,
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
          ],
          cwd: root,
        },
        { connectionId: "sandbox-contract" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("sandbox_surface_uncovered"),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["interactive", {}, {}],
    ["print", {}, { options: { isNonInteractiveSession: true } }],
    ["background", { run_in_background: true }, {}],
    ["child_agent", {}, { agentId: "child-test" }],
  ] as const)("blocks %s canonical Bash before host spawn", async (
    surface,
    inputExtension,
    contextExtension,
  ) => {
    const root = tempRoot(`agenc-sandbox-${surface}-`);
    const marker = join(root, `${surface}-escaped`);

    const result = await CanonicalBashTool.call(
        {
          command: process.execPath,
          args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
          cwd: root,
          ...inputExtension,
        },
        {
          abortController: new AbortController(),
          services: { sandboxExecutionBroker: unavailableBroker(root) },
          ...contextExtension,
        } as never,
        undefined,
        undefined,
      );
    expect(result).toMatchObject({
      data: {
        isError: true,
        content: expect.stringContaining(
          `[sandbox_probe_failed] required sandbox blocked ${surface}`,
        ),
      },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("uses the authenticated broker from the active model-turn session", async () => {
    const root = tempRoot("agenc-sandbox-active-turn-");
    const marker = join(root, "active-turn-escaped");
    const broker = unavailableBroker(root);

    const result = await runWithCurrentRuntimeSession(
      {
        conversationId: "sandbox-active-turn-session",
        services: {
          admissionRequired: false,
          runtimeOptions: testRuntimeOptions,
          sandboxExecutionBroker: broker,
          userShell: testUserShell,
        },
      } as never,
      () => CanonicalBashTool.call(
        {
          command: process.execPath,
          args: [
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
          ],
          cwd: root,
        },
        { abortController: new AbortController() } as never,
        undefined,
        undefined,
      ),
    );

    expect(result).toMatchObject({
      data: {
        isError: true,
        content: expect.stringContaining("sandbox_probe_failed"),
      },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks system Monitor before unified exec", async () => {
    const root = tempRoot("agenc-sandbox-monitor-");
    const marker = join(root, "monitor-escaped");
    const execCommand = vi.fn();
    const tool = createMonitorTool({
      cwd: root,
      unifiedExecManager: { execCommand } as never,
    });
    const args: Record<string, unknown> = {
      command: `${process.execPath} -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')"`,
      description: "attempt host escape",
    };
    attachSandboxExecutionBroker(args, unavailableBroker(root), "background");

    await expect(tool.execute(args)).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("sandbox_probe_failed"),
    });
    expect(execCommand).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });
});
