import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ trust: vi.fn(), ready: vi.fn(), connect: vi.fn(), continuation: vi.fn() }));
vi.mock("../../src/bin/project-trust-preflight.js", () => ({ requireProjectTrustForTui: mocks.trust }));
vi.mock("../../src/bin/agenc-main.js", () => { throw new Error("fresh print loaded the full dispatcher"); });
vi.mock("../../src/app-server-client/index.js", () => { throw new Error("fresh print loaded the TUI client shell"); });
vi.mock("../../src/bin/daemon-one-shot-continue.js", () => ({ runDaemonOneShotContinue: mocks.continuation }));
vi.mock("../../src/app-server/agent-cli.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/app-server/agent-cli.js")>(),
  defaultEnsureDaemonReady: () => mocks.ready,
  createConnectedAgenCJsonLineDaemonTuiClient: mocks.connect,
}));
import { oneShotCLI } from "../../src/bin/daemon-one-shot-cli.js";
let home: string, workspace: string;
const originalArgv = process.argv;
let writes: string[];
const request = vi.fn(), close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), "thin-print-")); workspace = join(home, "repo"); mkdirSync(workspace);
  vi.stubEnv("AGENC_HOME", home); vi.stubEnv("AGENC_WORKSPACE", workspace);
  process.argv = ["node", "agenc", "-p", "--light", "hello"];
  mocks.trust.mockResolvedValue(true); mocks.ready.mockResolvedValue(undefined); mocks.continuation.mockResolvedValue(23);
  writes = []; vi.spyOn(process.stdout, "write").mockImplementation(chunk => { writes.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  request.mockImplementation(async method => {
    if (method === "agent.create") return { agentId: "agent", sessionId: "session" };
    if (method === "agent.attach") return { sessionIds: ["session"] };
    return {};
  });
  close.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({ request, close,
    subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, callback: (event: unknown) => void) => {
      queueMicrotask(() => {
        callback({ method: "event.message_chunk", params: { sessionId: "session", delta: "pong" } });
        callback({ method: "event.agent_status", params: { sessionId: "session", status: "idle", runStatus: "completed" } });
      });
      return () => {};
    },
  });
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it("uses the authenticated client contract and preserves prompt, permission and cleanup without the dispatcher", async () => {
  const prompt = "  indented\n";
  expect(await oneShotCLI(prompt, [], { lightMode: true, permissionMode: "acceptEdits" })).toBe(0);
  expect(mocks.trust).toHaveBeenCalledOnce(); expect(mocks.ready).toHaveBeenCalledOnce(); expect(mocks.connect).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]).toEqual(["agent.create", expect.objectContaining({
    objective: prompt, instructions: prompt, initialContent: prompt, cwd: workspace,
    permissionMode: "acceptEdits", runtimeOptions: expect.objectContaining({ nonInteractive: true, relaxedOneShot: true }),
    metadata: { source: "agenc.prompt", mode: "one-shot" },
  }), expect.objectContaining({ signal: expect.any(AbortSignal) })]);
  expect(writes.join("")).toBe("pong\n");
  expect(request).toHaveBeenCalledWith("agent.stop", { agentId: "agent", reason: "one_shot_complete" });
  expect(close).toHaveBeenCalledOnce(); expect(mocks.continuation).not.toHaveBeenCalled();
});

it("refuses trust before connecting or creating a session", async () => {
  mocks.trust.mockResolvedValue(false);
  expect(await oneShotCLI("hello")).toBe(1);
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});

it("loads continuation only for the existing resume selector and forwards its exact prepared inputs", async () => {
  const selector = { kind: "latest" as const };
  expect(await oneShotCLI("next turn", [], { permissionMode: "plan", model: "explicit-model" }, selector)).toBe(23);
  expect(mocks.continuation).toHaveBeenCalledWith(expect.objectContaining({
    continueSession: selector, prompt: "next turn", initialContent: "next turn", permissionMode: "plan", model: "explicit-model",
    runtimeOptions: expect.objectContaining({ relaxedOneShot: false }),
  }));
  expect(mocks.connect).not.toHaveBeenCalled();
});
