import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { BrowserManager } from "../../src/browser/manager.js";
import {
  attachSandboxExecutionBroker,
  SandboxExecutionBroker,
  type SandboxPreparedSpawn,
} from "../../src/sandbox/execution-broker.js";
import { disposeSandboxExecutionBroker } from "../../src/sandbox/execution-lifecycle.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import { createBrowserTool } from "../../src/tools/BrowserTool/tool.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

// Real CDP pipes and process cleanup, with a Node child standing in for Chromium.
// Record received commands so the failure stage is observable independently of
// the tool's disposition. No external network or installed browser is needed.
it.each(["spawn", "crash", "pipe_closed", "navigate", "click", "type", "evaluate"] as const)(
  "settles a browser %s failure at the correct effect boundary",
  async (stage) => {
    const root = mkdtempSync(join(tmpdir(), "agenc-browser-settlement-"));
    const commandsPath = join(root, "commands.jsonl");
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: root });
    const failureMethod = {
      spawn: undefined, crash: undefined, pipe_closed: "Browser.getVersion",
      navigate: "Page.navigate", click: "Input.dispatchMouseEvent",
      type: "Input.insertText", evaluate: "Runtime.evaluate",
    }[stage];
    const worker = `
const fs = require("node:fs");
const stage = ${JSON.stringify(stage)};
if (stage === "crash") process.exit(23);
setInterval(() => {}, 1000);
let buffer = "";
fs.createReadStream(null, { fd: 3 }).on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\0")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    fs.appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(request.method) + "\\n");
    if (request.method === ${JSON.stringify(failureMethod)}) {
      fs.closeSync(4);
      continue;
    }
    const result = request.method === "Target.createTarget" ? { targetId: "target-1" }
      : request.method === "Target.attachToTarget" ? { sessionId: "page-1" }
      : request.method === "Accessibility.getFullAXTree" ? {
          nodes: [{ nodeId: "1", role: { value: "textbox" }, backendDOMNodeId: 1 }],
        }
      : request.method === "DOM.getContentQuads" ? { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] } : {};
    fs.writeSync(4, JSON.stringify({ id: request.id, result }) + "\\0");
  }
});
`;
    const prepareSpawn = vi.spyOn(broker, "prepareSpawn").mockImplementation((_surface, command) => {
      if (stage === "spawn") throw new Error("injected pre-spawn failure");
      const transformed = { program: process.execPath, args: ["-e", worker], cwd: root, env: command.env };
      const signal = new AbortController().signal;
      return {
        run: operation => operation(transformed, signal),
        start: operation => operation(transformed, signal).value,
        runSync: operation => operation(transformed),
        spawnLifecycleParticipant: (_name, operation) => operation(transformed),
      } satisfies SandboxPreparedSpawn;
    });
    const manager = new BrowserManager({
      policy: {
        executablePath: process.execPath, headless: true, noSandbox: false,
        allowPrivateNetwork: false, navigationTimeoutMs: 1_000,
      },
      sandboxExecutionBroker: broker,
    });
    const tool = createBrowserTool({ manager });
    const sampled = vi.fn();
    const { session, events } = mkSession({
      cwd: root, provider: mkProvider({}, { onChatStream: sampled }),
    });
    const store = new RolloutStore({
      cwd: root, agencHome: join(root, "home"), sessionId: session.conversationId,
      agencVersion: "0.19.2", sessionTempRoot: root,
    });
    store.open({
      sessionId: session.conversationId, cwd: root, timestamp: new Date().toISOString(),
      originator: "agenc", agencVersion: "0.19.2",
    });
    session.rolloutStore = store;
    const args: Record<string, unknown> = stage === "evaluate"
      ? { action: "new_tab" }
      : stage === "click" || stage === "type" ? { action: stage, ref: "e1", text: "hello" }
      : { action: "navigate", url: "https://example.com/" };
    attachSandboxExecutionBroker(args, broker, "browser");
    try {
      if (stage === "click" || stage === "type") {
        await manager.newTab();
        await (await manager.page()).snapshot();
      }
      const result = await runAdmittedToolCall({
        session, tool, args, turnId: "browser-turn", callId: "browser-failure",
        invoke: async ({ crossEffectBoundary }) => {
          crossEffectBoundary();
          return tool.execute(args);
        },
      });
      expect(result.isError).toBe(true);
      expect(prepareSpawn).toHaveBeenCalledOnce();
      const postDispatch = stage === "navigate" || stage === "evaluate" || stage === "click" || stage === "type";
      const commands: string[] = existsSync(commandsPath)
        ? readFileSync(commandsPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      if (stage === "spawn") expect(result.content).toContain("injected pre-spawn failure");
      else expect(result.content).toContain("CDP");
      if (stage !== "spawn" && stage !== "crash") expect(commands).toContain("Browser.getVersion");
      if (stage === "pipe_closed") expect(result.content).toContain("CDP pipe closed");
      const nextPrompt = async () => {
        for await (const _phase of runTurn(session, mkCtx({ cwd: root }), "continue")) { /* drain */ }
      };
      if (postDispatch) {
        expect(commands).toContain(failureMethod);
        expect(result.effectDisposition).toBeUndefined();
        expect(events).toContainEqual(expect.objectContaining({ msg: {
          type: "effect_unknown_outcome", payload: expect.objectContaining({ requiresReview: true }),
        } }));
        expect(store.hasPendingEffectReviews()).toBe(true);
        await expect(nextPrompt()).rejects.toThrow("requires effect review before model execution");
        expect(sampled).not.toHaveBeenCalled();
        const later = vi.fn();
        await expect(runAdmittedToolCall({
          session, tool, args, turnId: "next-turn", callId: "later-browser", invoke: later,
        })).rejects.toThrow("live effect settlement is unresolved");
        expect(later).not.toHaveBeenCalled();
      } else {
        expect(commands.every(method => method === "Browser.getVersion")).toBe(true);
        expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
        expect(events).toContainEqual(expect.objectContaining({ msg: {
          type: "effect_result", payload: expect.objectContaining({
            outcome: "failed",
            noEffectEvidence: expect.objectContaining({ evidenceKind: "boundary_not_crossed" }),
          }),
        } }));
        expect(events.some(event => event.msg.type === "effect_unknown_outcome")).toBe(false);
        expect(store.hasPendingEffectReviews()).toBe(false);
        await nextPrompt();
        expect(sampled).toHaveBeenCalledOnce();
        const later = vi.fn(async () => ({ content: "follow-up dispatched" }));
        await expect(runAdmittedToolCall({
          session, tool, args, turnId: "next-turn", callId: "later-browser",
          invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return later(); },
        })).resolves.toMatchObject({ content: "follow-up dispatched" });
        expect(later).toHaveBeenCalledOnce();
      }
    } finally {
      await disposeSandboxExecutionBroker(broker);
      await manager.closeAll();
      prepareSpawn.mockRestore();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
