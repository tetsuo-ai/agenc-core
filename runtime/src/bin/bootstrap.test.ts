import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapLocalRuntimeSession } from "./bootstrap.js";
import type { Tool } from "../tools/types.js";
import { Session } from "../session/session.js";
import { getCurrentRuntimeSession } from "../utils/currentRuntimeSession.js";

describe("bootstrapLocalRuntimeSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the shared local bootstrap contract and forwards registry customizations", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const extraTool: Tool = {
      name: "system.test.extra",
      description: "test helper",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    };

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    const startMcpSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
        cwd: "/ignored-by-env",
        toolRegistryOptions: {
          extraTools: [extraTool],
        },
      });
      shutdown = boot.shutdown;

      expect(boot.agencHome).toBe(home);
      expect(boot.workspaceRoot).toBe(workspace);
      expect(boot.resolvedProvider).toBe("grok");
      expect(boot.model).toBe("grok-4-fast");
      expect(boot.registry.tools.some((tool) => tool.name === extraTool.name)).toBe(
        true,
      );
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "test-key",
          model: "grok-4-fast",
          tools: expect.any(Array),
        }),
      );
      expect(boot.initialState.sessionConfiguration.cwd).toBe(workspace);
      expect(boot.initialState.sessionConfiguration.sessionSource).toBe(
        "cli_main",
      );
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to the explicit cwd when no workspace override is configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "agenc-bootstrap-cwd-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    const startMcpSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          HOME: home,
        },
        cwd,
      });
      shutdown = boot.shutdown;
      expect(boot.workspaceRoot).toBe(cwd);
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("hydrates the live MCP manager from AGENC_MCP_SERVERS before session startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    const startMcpSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_MCP_SERVERS: JSON.stringify([
            { name: "github", command: "github-mcp" },
          ]),
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.mcpManager.getConfiguredServers()).toEqual([
        expect.objectContaining({ name: "github", command: "github-mcp" }),
      ]);
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("wires the session-facing MCP service to the live manager readiness surface", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      const mcpService = (
        boot.session as unknown as { services: { mcpManager: { isConnected?: unknown } } }
      ).services.mcpManager;

      expect(typeof mcpService.isConnected).toBe("function");
      expect(mcpService.isConnected?.("missing-server")).toBe(false);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("owns live session bring-up and teardown for rollout, sidecars, and current-session state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(getCurrentRuntimeSession()).toBe(boot.session);
      expect(boot.sidecarManager.getSidecarNames()).toEqual(
        expect.arrayContaining([
          "file-history",
          "error-log",
          "cost",
          "memory-auto-save",
        ]),
      );
      expect(boot.rolloutStore.rolloutPath).toContain(boot.conversationId);
      expect(boot.ctx.turnMetadataState.conversationId).toBe(
        boot.conversationId,
      );
      boot.rolloutStore.flushDurable();
      expect(
        boot.rolloutStore.readAll().some(
          (item) =>
            item.type === "event_msg" &&
            item.payload.msg.type === "session_configured",
        ),
      ).toBe(true);

      await boot.shutdown();
      await boot.shutdown();

      expect(getCurrentRuntimeSession()).toBeNull();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
