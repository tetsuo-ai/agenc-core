import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

import {
  dispatchSlashCommand,
  parseSlashCommand,
} from "../commands/dispatcher.js";
import { buildDefaultRegistry } from "../commands/registry.js";
import type { SlashCommandContext } from "../commands/types.js";
import {
  createAgenCDaemonOnlyTuiContext,
  findAgenCDaemonAgentBySessionId,
  listAgenCDaemonAgents,
} from "./index.js";

function createListClient(
  pages: Array<{
    readonly agents: readonly {
      readonly agentId: string;
      readonly status: "idle" | "running" | "stopping" | "stopped" | "error";
      readonly createdAt: string;
      readonly activeSessionIds?: readonly string[];
    }[];
    readonly nextCursor?: string;
  }>,
) {
  let index = 0;
  return {
    request: vi.fn(async () => pages[Math.min(index++, pages.length - 1)]),
    subscribeToSessionEvents: vi.fn(() => () => undefined),
    getConnectionState: vi.fn(() => ({ status: "connected" })),
    subscribeToConnectionState: vi.fn(() => () => undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("app-server-client daemon helpers", () => {
  it("collects daemon agent pages until the cursor ends", async () => {
    const client = createListClient([
      {
        agents: [
          {
            agentId: "agent_1",
            status: "running",
            createdAt: "2026-05-06T00:00:00.000Z",
          },
        ],
        nextCursor: "page_2",
      },
      {
        agents: [
          {
            agentId: "agent_2",
            status: "idle",
            createdAt: "2026-05-06T00:00:01.000Z",
          },
        ],
      },
    ]);

    await expect(listAgenCDaemonAgents(client as never)).resolves.toEqual([
      expect.objectContaining({ agentId: "agent_1" }),
      expect.objectContaining({ agentId: "agent_2" }),
    ]);
    expect(client.request).toHaveBeenNthCalledWith(1, "agent.list", {
      limit: 100,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "agent.list", {
      limit: 100,
      cursor: "page_2",
    });
  });

  it("rejects repeated cursors instead of looping forever", async () => {
    const client = createListClient([
      { agents: [], nextCursor: "same" },
      { agents: [], nextCursor: "same" },
    ]);

    await expect(listAgenCDaemonAgents(client as never)).rejects.toThrow(
      "repeated agent list cursor",
    );
  });

  it("caps daemon agent pagination", async () => {
    const client = createListClient([
      { agents: [], nextCursor: "page_2" },
      { agents: [], nextCursor: "page_3" },
    ]);

    await expect(
      listAgenCDaemonAgents(client as never, { maxPages: 1 }),
    ).rejects.toThrow("exceeded pagination limit");
  });

  it("rejects ambiguous daemon session matches", async () => {
    const client = createListClient([
      {
        agents: [
          {
            agentId: "agent_1",
            status: "running",
            createdAt: "2026-05-06T00:00:00.000Z",
            activeSessionIds: ["session_shared"],
          },
          {
            agentId: "agent_2",
            status: "running",
            createdAt: "2026-05-06T00:00:01.000Z",
            activeSessionIds: ["session_shared"],
          },
        ],
      },
    ]);

    await expect(
      findAgenCDaemonAgentBySessionId(client as never, "session_shared"),
    ).rejects.toThrow("matches multiple agents");
  });

  it("passes startup multimodal content through agent.create", async () => {
    vi.resetModules();
    const createAgent = vi.fn(async (params: unknown) => ({
      agentId: "agent_image",
      objective: "describe this",
      status: "running" as const,
      createdAt: "2026-05-06T00:00:00.000Z",
      sessionId: "session_image",
      params,
    }));
    const request = vi.fn();
    const close = vi.fn();
    vi.doMock("../app-server/agent-cli.js", async (importActual) => {
      const actual =
        await importActual<typeof import("../app-server/agent-cli.js")>();
      return {
        ...actual,
        defaultEnsureDaemonReady: vi.fn(() => vi.fn(async () => {})),
        createAgenCJsonLineDaemonClient: vi.fn(() => ({ createAgent })),
        createConnectedAgenCJsonLineDaemonTuiClient: vi.fn(async () => ({
          request,
          close,
        })),
      };
    });

    try {
      const { startAgenCDaemonPromptAgent } = await import("./index.js");
      await startAgenCDaemonPromptAgent({
        prompt: "describe this",
        cwd: "/workspace",
        provider: "grok",
        model: "grok-4.3",
        profile: "fast",
        initialContent: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/cat.png" },
          },
        ],
      });

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          objective: "describe this",
          instructions: "describe this",
          cwd: "/workspace",
          provider: "grok",
          model: "grok-4.3",
          profile: "fast",
          initialContent: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/cat.png" },
            },
          ],
        }),
      );
      expect(request).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../app-server/agent-cli.js");
      vi.resetModules();
    }
  });

  it("passes daemon prompt MCP env overrides through agent.create", async () => {
    vi.resetModules();
    const createAgent = vi.fn(async (params: unknown) => ({
      agentId: "agent_mcp_env",
      objective: "use MCP",
      status: "running" as const,
      createdAt: "2026-05-06T00:00:00.000Z",
      sessionId: "session_mcp_env",
      params,
    }));
    vi.doMock("../app-server/agent-cli.js", async (importActual) => {
      const actual =
        await importActual<typeof import("../app-server/agent-cli.js")>();
      return {
        ...actual,
        defaultEnsureDaemonReady: vi.fn(() => vi.fn(async () => {})),
        createAgenCJsonLineDaemonClient: vi.fn(() => ({ createAgent })),
      };
    });

    try {
      const mcpServers = JSON.stringify([
        { name: "audit-ping", command: "node", args: [".agenc/mcp/audit.mjs"] },
      ]);
      const { startAgenCDaemonPromptAgent } = await import("./index.js");
      await startAgenCDaemonPromptAgent({
        prompt: "use MCP",
        cwd: "/workspace",
        env: {
          ...process.env,
          AGENC_MCP_SERVERS: mcpServers,
          XAI_API_KEY: "rotated-key",
          PATH: "/custom/bin:/usr/bin",
          AGENC_WORKSPACE: "/should/not/forward",
          SHOULD_NOT_FORWARD: "ignored",
        },
      });

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          envOverrides: expect.objectContaining({
            AGENC_MCP_SERVERS: mcpServers,
            XAI_API_KEY: "rotated-key",
            PATH: "/custom/bin:/usr/bin",
          }),
        }),
      );
      const createParams = createAgent.mock.calls[0]?.[0] as {
        readonly envOverrides?: Record<string, string>;
      };
      // Workspace must come from the cwd param, never ambient env; and
      // non-allowlisted keys must not leak to the daemon.
      expect(createParams.envOverrides).not.toHaveProperty("AGENC_WORKSPACE");
      expect(createParams.envOverrides).not.toHaveProperty(
        "SHOULD_NOT_FORWARD",
      );
    } finally {
      vi.doUnmock("../app-server/agent-cli.js");
      vi.resetModules();
    }
  });

  it("seeds daemon-only TUI context with bypass permissions for yolo launch", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-yolo-tui-context-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-yolo-tui-workspace-"));
    let context: Awaited<ReturnType<typeof createAgenCDaemonOnlyTuiContext>> | null =
      null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd: workspace,
        conversationId: "agenc-tui-idle-test",
        permissionMode: "bypassPermissions",
      });

      const permissionContext =
        context.baseSession.services.permissionModeRegistry.current();
      expect(permissionContext.mode).toBe("bypassPermissions");
      expect(permissionContext.isBypassPermissionsModeAvailable).toBe(true);
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("applies daemon-only TUI provider and model startup overrides", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-model-tui-context-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-model-tui-workspace-"));
    let context: Awaited<ReturnType<typeof createAgenCDaemonOnlyTuiContext>> | null =
      null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: {
          ...process.env,
          AGENC_HOME: agencHome,
          HOME: agencHome,
          XAI_API_KEY: "test-key",
        },
        cwd: workspace,
        conversationId: "agenc-tui-model-test",
        provider: "grok",
        model: "grok-4.3",
      });

      expect(context.model).toBe("grok-4.3");
      expect(context.configStore.current()).toMatchObject({
        model_provider: "grok",
        model: "grok-4.3",
      });
      expect(context.baseSession.sessionConfiguration).toMatchObject({
        provider: { slug: "grok" },
        collaborationMode: { model: "grok-4.3" },
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("dispatches daemon-only TUI slash commands without local session services", async () => {
    // `/provider grok` must clear the BYOK subscription gate (which reads
    // process.env directly, not the context env) to reach the daemon-mode
    // "not yet supported" branch asserted below. Set an explicit test key:
    // the hermetic suite setup (vitest.setup.ts, TODO task 30) strips
    // ambient provider keys, and this assertion previously depended on a
    // developer's real XAI_API_KEY.
    const previousXaiKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-key";
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-daemon-slash-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-daemon-slash-cwd-"));
    const pidFile = join(agencHome, "mcp", "audit-ping.pid");
    const fixture = join(
      process.cwd(),
      "src/mcp-client/test-fixtures/stdio-pid-server.cjs",
    );
    mkdirSync(join(cwd, ".agenc/skills/python-game"), { recursive: true });
    writeFileSync(
      join(cwd, ".agenc/skills/python-game/SKILL.md"),
      "---\nname: python-game\ndescription: Help with the Python game.\n---\n",
      "utf8",
    );
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "audit-ping": {
            type: "stdio",
            command: process.execPath,
            args: [fixture, pidFile],
          },
        },
      }),
      "utf8",
    );
    let context: Awaited<ReturnType<typeof createAgenCDaemonOnlyTuiContext>> | null =
      null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd,
        conversationId: "agenc-tui-daemon-slash-test",
        permissionMode: "bypassPermissions",
      });
      const registry = buildDefaultRegistry();
      const run = async (input: string) => {
        const parsed = parseSlashCommand(input);
        expect(parsed).not.toBeNull();
        return dispatchSlashCommand(
          parsed!,
          {
            session: context.baseSession as SlashCommandContext["session"],
            argsRaw: parsed!.argsRaw,
            cwd,
            home: agencHome,
            agencHome,
            configStore: context.configStore as SlashCommandContext["configStore"],
            commandRegistry: registry,
            appState: {
              getAppState: () => ({ mcp: { commands: [] } }),
            },
          },
          registry,
        );
      };

      await expect(run("/config")).resolves.toMatchObject({
        result: { kind: "text" },
      });
      await expect(run("/settings")).resolves.toMatchObject({
        result: { kind: "text" },
      });
      await expect(run("/provider grok")).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.stringContaining(
            "not yet supported when running against the daemon",
          ),
        },
      });
      await expect(run("/mcp")).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.stringContaining("audit-ping: connected"),
        },
      });
      await expect(run("/mcp tools")).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.stringContaining("mcp.audit-ping.ping"),
        },
      });
      await expect(run("/skills")).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.stringContaining("python-game"),
        },
      });
    } finally {
      if (previousXaiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previousXaiKey;
      }
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refreshes project skills created during the same daemon-only TUI session", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-daemon-skills-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-daemon-skills-cwd-"));
    let context: Awaited<ReturnType<typeof createAgenCDaemonOnlyTuiContext>> | null =
      null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd,
        conversationId: "agenc-tui-live-skills-test",
        permissionMode: "bypassPermissions",
      });
      const registry = buildDefaultRegistry();
      const runSkills = async () => {
        const parsed = parseSlashCommand("/skills");
        expect(parsed).not.toBeNull();
        return dispatchSlashCommand(
          parsed!,
          {
            session: context!.baseSession as SlashCommandContext["session"],
            argsRaw: parsed!.argsRaw,
            cwd,
            home: agencHome,
            agencHome,
            configStore: context!.configStore as SlashCommandContext["configStore"],
            commandRegistry: registry,
            appState: {
              getAppState: () => ({ mcp: { commands: [] } }),
            },
          },
          registry,
        );
      };

      await expect(runSkills()).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.not.stringContaining("late-python-game"),
        },
      });

      mkdirSync(join(cwd, ".agenc/skills/late-python-game"), { recursive: true });
      writeFileSync(
        join(cwd, ".agenc/skills/late-python-game/SKILL.md"),
        "---\nname: late-python-game\ndescription: Late skill.\n---\n",
        "utf8",
      );

      await expect(runSkills()).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.stringContaining("late-python-game"),
        },
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("dispatches daemon-only TUI plan and agents commands", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-daemon-plan-agents-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-daemon-plan-agents-cwd-"));
    let context: Awaited<ReturnType<typeof createAgenCDaemonOnlyTuiContext>> | null =
      null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd,
        conversationId: "agenc-tui-plan-agents-test",
        permissionMode: "default",
      });
      const registry = buildDefaultRegistry();
      let toolJSX: unknown = null;
      const run = async (input: string) => {
        const parsed = parseSlashCommand(input);
        expect(parsed).not.toBeNull();
        return dispatchSlashCommand(
          parsed!,
          {
            session: context.baseSession as SlashCommandContext["session"],
            argsRaw: parsed!.argsRaw,
            cwd,
            home: agencHome,
            agencHome,
            configStore: context.configStore as SlashCommandContext["configStore"],
            commandRegistry: registry,
            appState: {
              getAppState: () => ({
                toolPermissionContext:
                  context.baseSession.services.permissionModeRegistry.current(),
                mcp: { commands: [] },
              }),
              setToolJSX: (next) => {
                toolJSX = next;
              },
              tools: [],
            },
          },
          registry,
        );
      };

      await expect(run("/plan")).resolves.toMatchObject({
        result: { kind: "skip" },
      });
      expect(context.baseSession.services.permissionModeRegistry.current().mode).toBe(
        "plan",
      );
      expect(toolJSX).toMatchObject({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      });
      (toolJSX as { jsx: { props: { onDone: () => void } } }).jsx.props.onDone();
      expect(toolJSX).toMatchObject({
        clearLocalJSX: true,
        jsx: null,
      });

      await expect(run("/agents")).resolves.toMatchObject({
        result: { kind: "skip" },
      });
      expect(toolJSX).toMatchObject({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      });
      (toolJSX as { jsx: { props: { onDone: () => void } } }).jsx.props.onDone();
      expect(toolJSX).toMatchObject({
        clearLocalJSX: true,
        jsx: null,
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
