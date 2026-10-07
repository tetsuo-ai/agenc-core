import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("checkpoint projection proof ownership", () => {
  it("allows source and returned graphs to collect while the populated projector remains live", () => {
    const cacheUrl = new URL("../../src/session/checkpoint-projection-cache.ts", import.meta.url).href;
    const conversionUrl = new URL("../../src/session/message-history-conversion.ts", import.meta.url).href;
    const integrityUrl = new URL("../../src/session/tool-result-integrity.ts", import.meta.url).href;
    const script = `
      const { withCheckpointProjectionCache } = await import(${JSON.stringify(cacheUrl)});
      const { llmMessageToCheckpointResponseItem } = await import(${JSON.stringify(conversionUrl)});
      const { createToolResultIntegrity } = await import(${JSON.stringify(integrityUrl)});
      let fullCalls = 0;
      const project = withCheckpointProjectionCache((message) => {
        fullCalls += 1;
        return llmMessageToCheckpointResponseItem(message);
      });
      // Keep an explicit live reference independent of optimizer liveness.
      globalThis.retainedCheckpointProjector = project;
      function seedAndRelease() {
        const content = "ordinary echo output";
        const message = { role: "tool", content, toolCallId: "call-one", toolName: "exec_command",
          runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({
            runId: "test-run", toolCallId: "call-one", content,
          }) } };
        const first = project(message);
        const hit = project(message);
        if (fullCalls !== 1) throw new Error("fixture did not populate and hit the cache");
        const sourceTree = { bytes: new Uint8Array(1024 * 1024) };
        const nestedTree = { bytes: new Uint8Array(1024 * 1024) };
        message.addedAfterCaching = sourceTree;
        message.runtimeOnly.toolResultIntegrity.original.addedAfterCaching = nestedTree;
        // Do not invoke the cache again: collection must not require it to
        // discover these changed shapes and evict the old proof first.
        return [message, message.runtimeOnly, message.runtimeOnly.toolResultIntegrity,
          message.runtimeOnly.toolResultIntegrity.original,
          message.runtimeOnly.toolResultIntegrity.persisted,
          first, first.toolResultIntegrity, hit, hit.toolResultIntegrity,
          sourceTree, nestedTree].map((value) => new WeakRef(value));
      }
      const probes = seedAndRelease();
      for (let round = 0; round < 16; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        globalThis.gc();
      }
      // No dereference during collection rounds: deref itself keeps an object
      // alive for the rest of its job and would invalidate this observation.
      const collected = probes.map((probe) => probe.deref() === undefined);
      const stillUsable = globalThis.retainedCheckpointProjector({ role: "user", content: "after GC" });
      process.stdout.write(JSON.stringify({ gcType: typeof globalThis.gc, collected,
        fullCalls, stillUsable: stillUsable.content === "after GC" }));
    `;
    const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      // Preserve the test runner's credential isolation and network tripwire.
      env: process.env,
      timeout: 45_000,
    });
    const diagnostics = `status=${child.status}\nsignal=${child.signal}\nerror=${child.error?.stack ?? "none"}\nstdout=${child.stdout}\nstderr=${child.stderr}`;
    expect(child.error, diagnostics).toBeUndefined();
    expect(child.signal, diagnostics).toBeNull();
    expect(child.status, diagnostics).toBe(0);
    const result = JSON.parse(child.stdout) as { gcType: string; collected: boolean[]; fullCalls: number; stillUsable: boolean };
    expect(result.gcType).toBe("function");
    expect(result.collected).toEqual(Array.from({ length: 11 }, () => true));
    expect(result.fullCalls).toBe(2);
    expect(result.stillUsable).toBe(true);
  }, 60_000);
});
