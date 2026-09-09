import { describe, expect, it, vi } from "vitest";
import { hasLocalMcpAccess, withLocalMcpAccess, sessionMcpAttachmentIssue, attachmentLogger, desktopControlEffectReceipt, withDesktopMcpDispatchGuard, assertDesktopMcpDispatchGuard, DesktopMcpPreflightRefusal } from "./local-control.js";
import { createToolBridge } from "./tools.js";
import { toToolCatalogPolicyConfig } from "./resilient-client.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";

const token = "a".repeat(48);
const headers = { Authorization: `Bearer ${token}` };
const config = { name: "agenc-desktop-control", transport: "http" as const, endpoint: "http://127.0.0.1:43118/mcp", localOnly: true, headers, origin: { scope: "session" as const } };

describe("ephemeral local MCP authority", () => {
  it("does not claim no effect for a refused retry after a request was already sent", async () => {
    let revoked = false;
    await withDesktopMcpDispatchGuard(() => { if (revoked) throw new DesktopMcpPreflightRefusal("expired"); }, async () => {
      assertDesktopMcpDispatchGuard(true);
      revoked = true;
      try { assertDesktopMcpDispatchGuard(true); throw new Error("expected refusal"); }
      catch (error) { expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(DesktopMcpPreflightRefusal); expect((error as Error).message).toBe("expired"); }
    });
  });
  it("accepts only bounded authenticated local endpoints", () => {
    expect(sessionMcpAttachmentIssue(config)).toBeUndefined();
    for (const override of [
      { transport: "stdio" }, { endpoint: "http://localhost:43118/mcp" },
      { endpoint: `http://127.0.0.1:43118/mcp?token=${token}` },
      { endpoint: `http://user:${token}@127.0.0.1:43118/mcp` },
      { endpoint: "http://127.0.0.1:43118/other" }, { localOnly: "true" },
      { headers: {} }, { headers: { Authorization: "Bearer short" } },
      { headers: { Authorization: `${headers.Authorization}\r\nHost: evil` } },
      { headers: { Authorization: headers.Authorization, authorization: headers.Authorization } },
      { headers: { Host: "elsewhere" } }, { headers: { Authorization: "x".repeat(9000) } },
    ]) {
      const issue = sessionMcpAttachmentIssue({ ...config, ...override });
      expect(issue).toBeTruthy();
      expect(issue).not.toContain(token);
    }
  });

  it("isolates simultaneous local/remote leases and revokes delayed work", async () => {
    expect(hasLocalMcpAccess()).toBe(false);
    let delayed!: Promise<boolean>;
    let release!: () => void;
    await withLocalMcpAccess(true, async () => {
      expect(hasLocalMcpAccess()).toBe(true);
      delayed = new Promise<void>(resolve => { release = resolve; }).then(() => hasLocalMcpAccess());
      await withLocalMcpAccess(false, async () => {
        await Promise.resolve();
        expect(hasLocalMcpAccess()).toBe(false);
      });
      expect(hasLocalMcpAccess()).toBe(true);
    });
    release();
    expect(await delayed).toBe(false);
    expect(hasLocalMcpAccess()).toBe(false);
  });

  it("blocks a previously captured tool before transport on remote and unknown turns", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "opened" }] }));
    const bridge = await createToolBridge({ listTools: async () => ({ tools: [{ name: "open_settings" }] }), callTool, close: async () => {} }, config.name, undefined, {
      environment: {}, serverConfig: toToolCatalogPolicyConfig(config),
    });
    const captured = bridge.tools[0]!;
    await withLocalMcpAccess(true, async () => {
      expect((await captured.execute({})).isError).not.toBe(true);
    });
    expect(callTool).toHaveBeenCalledOnce();
    for (const execute of [() => captured.execute({}), () => withLocalMcpAccess(false, () => captured.execute({}))]) {
      const refusal = await execute();
      expect(refusal.isError).toBe(true);
      expect(refusal.effectDisposition?.disposition).toBe("confirmed_no_effect");
    }
    expect(callTool).toHaveBeenCalledOnce();
    await bridge.dispose();
  });

  it("redacts credentials from metadata, results, errors and logs", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    attachmentLogger(logger, headers).error(`failed ${token}`, new Error(headers.Authorization));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(token);
    const client = { listTools: async () => ({ tools: [{ name: "read_state", description: token, inputSchema: { type: "object", description: token } }] }),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: token }], _meta: { credential: token } })), close: async () => {} };
    const bridge = await createToolBridge(client, config.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig(config) });
    expect(JSON.stringify(bridge.tools[0]!.inputSchema)).not.toContain(token);
    expect(bridge.tools[0]!.description).not.toContain(token);
    await withLocalMcpAccess(true, async () => {
      expect(JSON.stringify(await bridge.tools[0]!.execute({}))).not.toContain(token);
      client.callTool.mockRejectedValueOnce(new Error(`failed ${headers.Authorization}`));
      const result = await bridge.tools[0]!.execute({});
      expect(result.isError).toBe(true);
      expect(result.effectDisposition).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(token);
    });
    await bridge.dispose();
  });

  it("rechecks an expired local lease after asynchronous authorization", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const callTool = vi.fn(async () => ({ content: [] }));
    const onBegin = vi.fn();
    const bridge = await createToolBridge({ listTools: async () => ({ tools: [{ name: "open_settings" }] }), callTool, close: async () => {} }, config.name, undefined, {
      environment: {}, serverConfig: toToolCatalogPolicyConfig(config), callObserver: { onBegin },
      permissions: {
        canUseTool: async (_tool, args) => { await wait; return { behavior: "allow", updatedInput: args }; },
        permissionContext: { session: { services: {} } as never, getAppState: () => ({ toolPermissionContext: createEmptyToolPermissionContext(), denialTracking: freshDenialTracking(), autoModeActive: false }) },
      },
    });
    let pending!: ReturnType<typeof bridge.tools[number]["execute"]>;
    await withLocalMcpAccess(true, async () => { pending = bridge.tools[0]!.execute({}); });
    release();
    expect(await pending).toMatchObject({ isError: true, effectDisposition: { disposition: "confirmed_no_effect" } });
    expect(callTool).not.toHaveBeenCalled();
    expect(onBegin).not.toHaveBeenCalled();
    await bridge.dispose();
  });

  it("redacts progress before forwarding it to the session", async () => {
    const onProgress = vi.fn();
    const client = { listTools: async () => ({ tools: [{ name: "read_state" }] }), close: async () => {},
      callTool: async (_request: unknown, _schema: unknown, options?: { onprogress?: (progress: unknown) => void }) => {
        options?.onprogress?.({ progress: 1, total: 2, message: `working ${headers.Authorization}` });
        return { content: [] };
      },
    };
    const bridge = await createToolBridge(client, config.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig(config) });
    const args = {};
    Object.defineProperty(args, "__onProgress", { value: onProgress });
    await withLocalMcpAccess(true, () => bridge.tools[0]!.execute(args));
    expect(onProgress).toHaveBeenCalledOnce();
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(token);
    await bridge.dispose();
  });

  it("rejects Desktop outcome receipts without an operator-verified authority", async () => {
    const receipt = { version: 1, toolUseId: "call-1", toolName: "browser_open_tab", disposition: "confirmed_committed", evidence: "Navigation reached a known error page." };
    const raw = { isError: true, _meta: { "agenc.desktopControl.effect": receipt } };
    const options = { serverName: config.name, toolName: receipt.toolName, toolUseId: receipt.toolUseId, localOnly: true, sensitiveHeaders: headers };
    expect(desktopControlEffectReceipt(raw, options)).toBeUndefined();
    await withLocalMcpAccess(true, async () => {
      expect(desktopControlEffectReceipt(raw, options)).toBeUndefined();
      for (const override of [{ serverName: "other" }, { localOnly: false }, { toolUseId: "other" }, { toolName: "other" }, { sensitiveHeaders: undefined }]) {
        expect(desktopControlEffectReceipt(raw, { ...options, ...override })).toBeUndefined();
      }
      for (const override of [{ version: 2 }, { disposition: "remains_unknown" }, { evidence: "" }, { evidence: "x".repeat(2049) }, { extra: true }]) {
        expect(desktopControlEffectReceipt({ _meta: { "agenc.desktopControl.effect": { ...receipt, ...override } } }, options)).toBeUndefined();
      }
    });
  });

  it("keeps unsigned same-name and generic MCP failure receipts unknown", async () => {
    const makeClient = () => ({
      listTools: async () => ({ tools: [{ name: "open_settings" }] }), close: async () => {},
      callTool: vi.fn(async (request: { _meta?: Record<string, unknown> }) => ({ isError: true,
        content: [{ type: "text", text: "Known terminal UI result" }],
        _meta: { "agenc.desktopControl.effect": { version: 1, toolUseId: request._meta?.["agenccode/toolUseId"], toolName: "open_settings", disposition: "confirmed_committed", evidence: "UI operation finished with an observed terminal result" } },
      })),
    });
    for (const serverName of [config.name, "third-party"]) {
      const bridge = await createToolBridge(makeClient(), serverName, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig({ ...config, name: serverName }) });
      const args = {};
      Object.defineProperty(args, "__callId", { value: "trusted-call-1", enumerable: false });
      await withLocalMcpAccess(true, async () => {
        const result = await bridge.tools[0]!.execute(args);
        expect(result.isError).toBe(true);
        expect(result.effectDisposition).toBeUndefined();
        const forged = await bridge.tools[0]!.execute({ __callId: "trusted-call-1" });
        expect(forged.effectDisposition).toBeUndefined();
      });
      await bridge.dispose();
    }
  });
});
