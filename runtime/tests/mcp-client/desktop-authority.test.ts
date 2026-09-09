import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink, realpath, rename } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { desktopAuthorityProofIssue, verifyDesktopAuthority, desktopToolClassification, hasDesktopAuthority, attestDesktopEndpoint, assertDesktopSocketBinding } from "./desktop-authority.js";
import { createToolBridge } from "./tools.js";
import { ResilientMCPBridge, toToolCatalogPolicyConfig } from "./resilient-client.js";
import { withLocalMcpAccess, desktopControlEffectReceipt } from "./local-control.js";
import { hasPermissionsToUseTool } from "../permissions/evaluator.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import { attachToolRuntimeContext, type ToolRuntimeAttemptContext } from "../tools/runtimes/context.js";
import { SandboxExecutionBroker, attachSandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { poisonLiveEffect } from "../../src/budget/effect-settlement-supervisor.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { recordInFlightToolCallUnknownOutcome } from "../../src/state/tool-output-rotation.js";
import { listUnresolvedUnknownOutcomeEffects } from "../../src/state/unknown-outcome-gate.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agenc-desktop-authority-")); roots.push(root);
  await chmod(root, 0o700);
  const directory = join(root, "desktop-control-authorities"); await mkdir(directory, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  const socketRoot = await mkdtemp(join(await realpath("/tmp"), "agenc-dc-")); roots.push(socketRoot); await chmod(socketRoot, 0o700);
  const socketPath = join(socketRoot, "control.sock");
  const socketServer = createServer(); servers.push(socketServer);
  await new Promise<void>((resolve, reject) => { socketServer.once("error", reject); socketServer.listen(socketPath, resolve); }); await chmod(socketPath, 0o600);
  const id = randomUUID(); const file = join(directory, `${id}.json`);
  const config = { name: "agenc-desktop-control", endpoint: "http://127.0.0.1:43219/mcp", transport: "http" as const, localOnly: true, headers: { Authorization: `Bearer ${"a".repeat(48)}` }, origin: { scope: "session" as const } };
  const payload = JSON.stringify([2, config.name, config.endpoint, createHash("sha256").update(config.headers.Authorization).digest("hex"), 1, socketPath]);
  const proof = { id, signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64") };
  const record = { version: 2, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }), expiresAt: Date.now() + 600_000, socketPath };
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  return { root, directory, file, record, keys, socketRoot, socketPath, config: { ...config, desktopAuthority: proof } };
}
describe("operator-bootstrapped Desktop control authority", () => {
  it("requires exact own proof and record keys without sorting protocol fields", async () => {
    const f = await fixture();
    const proof = f.config.desktopAuthority;
    expect(desktopAuthorityProofIssue({ signature: proof.signature, id: proof.id })).toBeUndefined();
    const inherited = Object.assign(Object.create(proof), { "id,signature": true });
    const hiddenExtra = Object.defineProperty({ ...proof }, "extra", { value: true });
    for (const malformed of [
      { id: proof.id }, { ...proof, extra: true },
      { "id,signature": proof.signature }, inherited, hiddenExtra,
      { ...proof, [Symbol("extra")]: true },
    ]) expect(desktopAuthorityProofIssue(malformed)).toBeTruthy();
    const reordered = { socketPath: f.record.socketPath, publicKey: f.record.publicKey, version: f.record.version, expiresAt: f.record.expiresAt };
    await writeFile(f.file, JSON.stringify(reordered));
    expect(hasDesktopAuthority(await verifyDesktopAuthority(f.config, f.root))).toBe(true);
    for (const missingKey of Object.keys(f.record)) {
      const missing: Record<string, unknown> = { ...f.record };
      delete missing[missingKey];
      await writeFile(f.file, JSON.stringify(missing));
      await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow("could not be verified");
    }
    await writeFile(f.file, JSON.stringify({ ...f.record, extra: true }));
    await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow("could not be verified");
  });

  it.each(["durable", "live"] as const)("allows only audited inspection through the %s unknown-outcome admission gate", async (gate) => {
    const f = await fixture();
    const grant = await verifyDesktopAuthority(f.config, f.root);
    const reads = ["desktop_state", "desktop_window_state", "browser_tabs", "browser_screenshot", "browser_downloads", "browser_console", "terminal_list", "terminal_read"];
    const gated = ["desktop_settings_open", "desktop_settings_update", "desktop_window", "desktop_session_open", "desktop_session_update", "desktop_project_select", "browser_open_tab", "browser_select_tab", "browser_close_tab", "browser_navigate", "browser_click", "browser_type", "browser_press_key", "browser_scroll", "browser_back", "browser_forward", "browser_reload", "browser_evaluate", "terminal_open", "terminal_run", "terminal_type", "terminal_close", "browser_snapshot", "browser_read_text", "browser_wait_for"];
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "inspection" }] }));
    const client = { listTools: async () => ({ tools: [...reads, ...gated].map(name => ({ name, annotations: { readOnlyHint: true, idempotentHint: true } })) }), callTool, close: async () => {} };
    const bridge = await createToolBridge(client, f.config.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig({ ...f.config, desktopAuthorityGrant: grant }) });
    const registry = buildToolRegistry({ workspaceRoot: f.root, agencHome: f.root, mcpToolsProvider: { getTools: () => bridge.tools } });
    const { session, events, acquire } = bindAdmittedToolHarness({ workspaceRoot: f.root, label: "desktop-inspection" });
    const driver = openStateDatabases({ cwd: f.root, agencHome: f.root });
    const prior = { sessionId: session.conversationId, toolCallId: "prior-browser-unknown", toolName: "Browser", recoveryCategory: "side-effecting" as const, observedAt: new Date(0).toISOString() };
    recordInFlightToolCallUnknownOutcome(driver, prior);
    const before = listUnresolvedUnknownOutcomeEffects(driver, session.conversationId);
    // Invoke the production RolloutStore gate over the real isolated database;
    // the lightweight harness supplies only admission/event-journal plumbing.
    Object.assign(session.rolloutStore!, { assertToolAdmissionAllowed: (category: NonNullable<Tool["recoveryCategory"]>) => RolloutStore.prototype.assertToolAdmissionAllowed.call({ stateDriver: driver, sessionId: session.conversationId } as never, category) });
    if (gate === "live") poisonLiveEffect(session, { runId: "prior-run", stepId: "prior-step", callId: prior.toolCallId, toolName: prior.toolName, recoveryCategory: prior.recoveryCategory });
    let call = 0;
    const admit = (tool: Tool, local = true) => withLocalMcpAccess(local, () => runAdmittedToolCall({
      session, turnId: "turn-desktop-inspection", callId: `inspect-${++call}`, tool, args: {},
      invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return tool.execute({}); },
    }));
    try {
      for (const name of reads) {
        const tool = registry.tools.find(tool => tool.name === `mcp.${f.config.name}.${name}`)!;
        expect(tool).toMatchObject({ isReadOnly: true, recoveryCategory: "idempotent" });
        expect((await admit(tool)).isError).not.toBe(true);
      }
      expect(callTool).toHaveBeenCalledTimes(reads.length);
      expect(acquire).toHaveBeenCalledTimes(reads.length);
      for (const name of gated) {
        const tool = registry.tools.find(tool => tool.name === `mcp.${f.config.name}.${name}`)!;
        expect(tool.recoveryCategory).toBe("side-effecting");
        await expect(admit(tool)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME_MUTATION_BLOCKED" });
      }
      const capturedRead = bridge.tools[0];
      expect((await admit(capturedRead, false)).isError).toBe(true);
      vi.spyOn(Date, "now").mockReturnValue(f.record.expiresAt + 1);
      expect((await admit(capturedRead)).isError).toBe(true);
      expect(callTool).toHaveBeenCalledTimes(reads.length);
      expect(listUnresolvedUnknownOutcomeEffects(driver, session.conversationId)).toEqual(before);
      expect(events.some(event => event.msg.type === "effect_review_resolved")).toBe(false);
      expect(events.filter(event => event.msg.type === "effect_intent").every(event => event.msg.type === "effect_intent" && event.msg.payload.recoveryCategory === "idempotent")).toBe(true);
    } finally { driver.close(); await bridge.dispose(); }
  });

  it("never grants inspection recovery to unsigned, forged, stale or nonlocal catalogs", async () => {
    const f = await fixture(); const grant = await verifyDesktopAuthority(f.config, f.root);
    const client = { listTools: async () => ({ tools: [{ name: "desktop_state", annotations: { readOnlyHint: true, idempotentHint: true } }] }), callTool: vi.fn(async () => ({ content: [] })), close: async () => {} };
    const config = { ...f.config, desktopAuthorityGrant: grant };
    const variants = [
      { ...config, desktopAuthorityGrant: undefined },
      { ...config, desktopAuthorityGrant: { ...grant! } },
      { ...config, localOnly: false },
      { ...config, name: "unrelated-server" },
    ];
    const { session, acquire } = bindAdmittedToolHarness({ workspaceRoot: f.root, label: "spoofed-inspection" });
    const driver = openStateDatabases({ cwd: f.root, agencHome: f.root });
    recordInFlightToolCallUnknownOutcome(driver, { sessionId: session.conversationId, toolCallId: "prior-browser-unknown", toolName: "Browser", recoveryCategory: "side-effecting", observedAt: new Date(0).toISOString() });
    Object.assign(session.rolloutStore!, { assertToolAdmissionAllowed: (category: NonNullable<Tool["recoveryCategory"]>) => RolloutStore.prototype.assertToolAdmissionAllowed.call({ stateDriver: driver, sessionId: session.conversationId } as never, category) });
    const assertGated = async (bridge: Awaited<ReturnType<typeof createToolBridge>>) => {
      expect(bridge.tools[0].recoveryCategory).toBeUndefined();
      expect(bridge.tools[0].isReadOnly).toBeUndefined();
      const registry = buildToolRegistry({ workspaceRoot: f.root, agencHome: f.root, mcpToolsProvider: { getTools: () => bridge.tools } });
      const tool = registry.tools.find(tool => tool.name === bridge.tools[0].name)!;
      expect(tool.recoveryCategory).toBe("side-effecting");
      await expect(withLocalMcpAccess(true, () => runAdmittedToolCall({ session, turnId: "turn-spoofed-inspection", callId: "spoofed-read", tool, args: {}, invoke: () => tool.execute({}) }))).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME_MUTATION_BLOCKED" });
    };
    try {
      for (const variant of variants) {
        const bridge = await createToolBridge(client, variant.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig(variant) });
        try { await assertGated(bridge); } finally { await bridge.dispose(); }
      }
      vi.spyOn(Date, "now").mockReturnValue(f.record.expiresAt + 1);
      const expired = await createToolBridge(client, config.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig(config) });
      try {
        await assertGated(expired);
        expect((await withLocalMcpAccess(true, () => expired.tools[0].execute({}))).isError).toBe(true);
      } finally { await expired.dispose(); }
      expect(acquire).not.toHaveBeenCalled();
      expect(client.callTool).not.toHaveBeenCalled();
      expect(listUnresolvedUnknownOutcomeEffects(driver, session.conversationId)).toHaveLength(1);
    } finally { driver.close(); }
  });

  it("requires a signed, private operator record bound to endpoint and credential", async () => {
    const f = await fixture();
    const grant = await verifyDesktopAuthority(f.config, f.root);
    expect(hasDesktopAuthority(grant)).toBe(true);
    await writeFile(f.file, JSON.stringify({ ...f.record, expiresAt: f.record.expiresAt + 60_000 }));
    const renewed = await verifyDesktopAuthority(f.config, f.root);
    expect(renewed?.expiresAt).toBe(f.record.expiresAt + 60_000);
    expect(renewed).not.toEqual(grant);
    expect(desktopToolClassification(grant, "desktop_state")).toBe("read");
    expect(desktopToolClassification(grant, "desktop_settings_open")).toBe("ui-mutation");
    expect(desktopToolClassification({ ...grant! }, "desktop_state")).toBeUndefined();
    for (const name of ["terminal_open", "terminal_run", "terminal_type", "terminal_close", "browser_download", "desktop_evil"]) expect(desktopToolClassification(grant, name)).toBeUndefined();
    for (const override of [{ endpoint: "http://127.0.0.1:43220/mcp" }, { name: "other" }, { localOnly: false }, { headers: { Authorization: `Bearer ${"b".repeat(48)}` } }, { desktopAuthority: { ...f.config.desktopAuthority, signature: Buffer.alloc(64).toString("base64") } }]) {
      await expect(verifyDesktopAuthority({ ...f.config, ...override }, f.root)).rejects.toThrow("could not be verified");
    }
    expect(await verifyDesktopAuthority({ ...f.config, desktopAuthority: undefined }, undefined)).toBeUndefined();
    await expect(verifyDesktopAuthority(f.config, undefined)).rejects.toThrow("could not be verified");
  });
  it("accepts only call-bound outcomes from a live verified Desktop authority", async () => {
    const f = await fixture(); const grant = await verifyDesktopAuthority(f.config, f.root);
    const receipt = { version: 1, toolUseId: "call-1", toolName: "browser_open_tab", disposition: "confirmed_committed", evidence: "Navigation reached a known error page." };
    const raw = { isError: true, _meta: { "agenc.desktopControl.effect": receipt } };
    const options = { serverName: f.config.name, toolName: receipt.toolName, toolUseId: receipt.toolUseId, localOnly: true, sensitiveHeaders: f.config.headers, desktopAuthorityGrant: grant };
    await withLocalMcpAccess(true, async () => {
      expect(desktopControlEffectReceipt(raw, options)).toMatchObject({ disposition: "confirmed_committed", evidenceKind: "provider_receipt" });
      for (const override of [{ serverName: "other" }, { localOnly: false }, { toolUseId: "other" }, { toolName: "other" }, { sensitiveHeaders: undefined }, { desktopAuthorityGrant: undefined }, { desktopAuthorityGrant: { ...grant! } }]) expect(desktopControlEffectReceipt(raw, { ...options, ...override })).toBeUndefined();
      for (const override of [{ version: 2 }, { disposition: "remains_unknown" }, { evidence: "" }, { evidence: "x".repeat(2049) }, { extra: true }]) expect(desktopControlEffectReceipt({ _meta: { "agenc.desktopControl.effect": { ...receipt, ...override } } }, options)).toBeUndefined();
    });
  });
  it("requires fresh live proof without sending Authorization to a fake rebound port", async () => {
    const f = await fixture(); const grant = await verifyDesktopAuthority(f.config, f.root);
    const config = { ...f.config, desktopAuthorityGrant: grant };
    const requests: RequestInit[] = [];
    const live: typeof fetch = async (_url, init) => {
      requests.push(init!);
      const body = JSON.parse(String(init?.body));
      const material = JSON.stringify([3, config.name, config.endpoint, body.authorizationHash, body.nonce, f.socketPath]);
      return new Response(JSON.stringify({ signature: sign(null, Buffer.from(material), f.keys.privateKey).toString("base64") }));
    };
    await attestDesktopEndpoint(config, live);
    await attestDesktopEndpoint(config, live);
    expect(requests[0].body).not.toBe(requests[1].body);
    for (const request of requests) {
      expect(new Headers(request.headers).has("authorization")).toBe(false);
      expect(String(request.body)).not.toContain(config.headers.Authorization);
    }
    const rebound = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ signature: Buffer.alloc(64).toString("base64") })));
    await expect(attestDesktopEndpoint(config, rebound)).rejects.toThrow("Live Desktop");
    expect(rebound).toHaveBeenCalledOnce();
    expect(new Headers(rebound.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
    const extraField: typeof fetch = async (url, init) => {
      const valid = await live(url, init);
      return new Response(JSON.stringify({ ...await valid.json(), extra: true }));
    };
    await expect(attestDesktopEndpoint(config, extraField)).rejects.toThrow("Live Desktop");
    const oversized: typeof fetch = async () => new Response(" ".repeat(1025));
    await expect(attestDesktopEndpoint(config, oversized)).rejects.toThrow("Live Desktop");
  });
  it("fails closed on expired records, unsafe modes, symlinks and malformed proof", async () => {
    const f = await fixture();
    for (const value of [null, {}, { id: "../escape", signature: f.config.desktopAuthority.signature }, { ...f.config.desktopAuthority, extra: true }]) expect(desktopAuthorityProofIssue(value)).toBeTruthy();
    await chmod(f.file, 0o644); await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow();
    await chmod(f.file, 0o600);
    await chmod(f.directory, 0o755); await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow();
    await chmod(f.directory, 0o700);
    await writeFile(f.file, JSON.stringify({ ...f.record, expiresAt: Date.now() - 1 })); await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow();
    await rm(f.file); await symlink(join(f.root, "outside"), f.file); await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow();
  });
  it("pins a private Unix socket identity and rejects unsafe or replaced endpoints", async () => {
    const f = await fixture(); const grant = (await verifyDesktopAuthority(f.config, f.root))!;
    await expect(assertDesktopSocketBinding(grant)).resolves.toBeUndefined();
    await chmod(f.socketPath, 0o666); await expect(assertDesktopSocketBinding(grant)).rejects.toThrow("private socket authority");
    await chmod(f.socketPath, 0o600);
    await chmod(f.socketRoot, 0o755); await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow();
    await chmod(f.socketRoot, 0o700);
    await rename(f.socketPath, join(f.socketRoot, "old.sock"));
    const replacement = createServer(); servers.push(replacement);
    await new Promise<void>(resolve => replacement.listen(f.socketPath, resolve)); await chmod(f.socketPath, 0o600);
    await expect(assertDesktopSocketBinding(grant)).rejects.toThrow("private socket authority");
    const next = await verifyDesktopAuthority(f.config, f.root);
    expect(next?.socketIdentity).not.toBe(grant.socketIdentity);
    await writeFile(f.file, JSON.stringify({ ...f.record, version: 1 }));
    await expect(verifyDesktopAuthority(f.config, f.root)).rejects.toThrow();
  });
  it("classifies only verified operations, retains approvals and revokes expired proxies", async () => {
    const f = await fixture();
    const grant = await verifyDesktopAuthority(f.config, f.root);
    const callTool = vi.fn(async () => ({ content: [] }));
    const client = { listTools: async () => ({ tools: ["desktop_state", "desktop_settings_open", "terminal_run"].map(name => ({ name, annotations: { readOnlyHint: true } })) }), callTool, close: async () => {} };
    const config = { ...f.config, desktopAuthorityGrant: grant };
    const bridge = await createToolBridge(client, config.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig(config) });
    const resilient = new ResilientMCPBridge(config, bridge);
    expect(resilient.tools[0]).toMatchObject({ isReadOnly: true, metadata: { mutating: false } });
    expect(resilient.tools[1]).toMatchObject({ requiresApproval: true, metadata: { mutating: true, virtualNoFsWrites: true } });
    expect(resilient.tools[2].isReadOnly).toBeUndefined(); expect(resilient.tools[2].metadata?.virtualNoFsWrites).toBeUndefined();
    for (const mode of ["default", "plan"] as const) {
      const context = { session: { services: {} } as never, getAppState: () => ({ toolPermissionContext: { ...createEmptyToolPermissionContext(), mode }, denialTracking: freshDenialTracking(), autoModeActive: false }) };
      expect((await hasPermissionsToUseTool(resilient.tools[0], {}, context)).behavior).toBe("allow");
      expect((await hasPermissionsToUseTool(resilient.tools[1], {}, context)).behavior).toBe(mode === "plan" ? "deny" : "ask");
    }
    vi.useFakeTimers(); vi.setSystemTime(f.record.expiresAt + 1);
    const refused = await withLocalMcpAccess(true, () => resilient.tools[0].execute({}));
    expect(refused).toMatchObject({ isError: true, effectDisposition: { disposition: "confirmed_no_effect" } });
    expect(callTool).not.toHaveBeenCalled();
    await resilient.dispose();
    const unsigned = await createToolBridge(client, f.config.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig(f.config) });
    expect(unsigned.tools[0].isReadOnly).toBeUndefined(); expect(unsigned.tools[1].metadata?.virtualNoFsWrites).toBeUndefined();
    await unsigned.dispose();
  });
  it("reuses only an exact runtime-approved Desktop invocation, never forged or stale context", async () => {
    const f = await fixture();
    const grant = await verifyDesktopAuthority(f.config, f.root);
    const session = { services: {} } as never;
    const canUseTool = vi.fn(async () => ({ behavior: "deny" as const, message: "unapproved" }));
    const callTool = vi.fn(async () => ({ content: [] }));
    const toolName = "mcp.agenc-desktop-control.desktop_settings_open";
    const bridge = await createToolBridge({ listTools: async () => ({ tools: [{ name: "desktop_settings_open" }] }), callTool, close: async () => {} }, f.config.name, undefined, {
      environment: {}, serverConfig: toToolCatalogPolicyConfig({ ...f.config, desktopAuthorityGrant: grant }),
      permissions: { session, getActiveTurnId: () => "turn-1", canUseTool,
        permissionContext: { session, getAppState: () => ({ toolPermissionContext: createEmptyToolPermissionContext(), denialTracking: freshDenialTracking(), autoModeActive: false }) } },
    });
    const invoke = async (override: Partial<ToolRuntimeAttemptContext> = {}, forge = false, local = true) => {
      const args = { section: "appearance" };
      Object.defineProperty(args, "__callId", { value: "call-1" });
      const context = { callId: "call-1", toolName, approvalResolved: true, sandboxMode: "workspace_write", rawArgs: JSON.stringify(args), invocation: { callId: "call-1", session, turn: { subId: "turn-1" } }, ...override } as ToolRuntimeAttemptContext;
      if (forge) Object.defineProperty(args, "__toolRuntimeContext", { value: context });
      else attachToolRuntimeContext(args, context);
      return withLocalMcpAccess(local, () => bridge.tools[0].execute(args));
    };
    expect((await invoke()).isError).not.toBe(true);
    expect(canUseTool).not.toHaveBeenCalled(); expect(callTool).toHaveBeenCalledOnce();
    for (const override of [{ callId: "other" }, { toolName: "other" }, { approvalResolved: false }, { rawArgs: '{}' }, { invocation: { callId: "call-1", session, turn: { subId: "old" } } as never }, { invocation: { callId: "call-1", session: {} as never, turn: { subId: "turn-1" } } as never }]) expect((await invoke(override)).isError).toBe(true);
    expect((await invoke({}, true)).isError).toBe(true);
    expect((await invoke({}, false, false)).isError).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    await bridge.dispose();
  });
  it("never upgrades native PTY authority with ordinary approvals or one-shot escalation", async () => {
    const f = await fixture(); const grant = await verifyDesktopAuthority(f.config, f.root);
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: f.root });
    const session = { services: { sandboxExecutionBroker: broker } } as never;
    const callTool = vi.fn(async () => ({ content: [] }));
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    const bridge = await createToolBridge({ listTools: async () => ({ tools: ["terminal_open", "terminal_run", "terminal_type", "terminal_close"].map(name => ({ name })) }), callTool, close: async () => {} }, f.config.name, undefined, {
      environment: {}, serverConfig: toToolCatalogPolicyConfig({ ...f.config, desktopAuthorityGrant: grant }), permissions: { session, getActiveTurnId: () => "turn-1", canUseTool,
        permissionContext: { session, getAppState: () => ({ toolPermissionContext: createEmptyToolPermissionContext(), denialTracking: freshDenialTracking(), autoModeActive: false }) } },
    });
    for (const tool of bridge.tools) {
      expect(tool.metadata?.virtualNoFsWrites).toBeUndefined(); expect(tool.requiresApproval).toBe(true);
      for (const requestedMode of ["workspace_write", "read_only", "external_sandbox", "danger_full_access"] as const) {
        const args = {}; Object.defineProperty(args, "__callId", { value: "terminal-1" });
        attachToolRuntimeContext(args, { callId: "terminal-1", toolName: tool.name, approvalResolved: true, requestedSandboxMode: requestedMode, sandboxMode: "danger_full_access", rawArgs: "{}", invocation: { callId: "terminal-1", session, turn: { subId: "turn-1" } } } as ToolRuntimeAttemptContext);
        attachSandboxExecutionBroker(args, broker);
        const result = await withLocalMcpAccess(true, () => tool.execute(args));
        if (requestedMode === "danger_full_access") expect(result.isError).not.toBe(true);
        else expect(result).toMatchObject({ isError: true, effectDisposition: { disposition: "confirmed_no_effect" } });
      }
      expect((await withLocalMcpAccess(true, () => tool.execute({ __callId: "terminal-1", __toolRuntimeContext: { approvalResolved: true, sandboxMode: "danger_full_access" } }))).isError).toBe(true);
    }
    expect(callTool).toHaveBeenCalledTimes(4);
    expect(canUseTool).not.toHaveBeenCalled();
    await bridge.dispose();
  });
});
