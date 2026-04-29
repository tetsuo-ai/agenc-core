import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMockMemoryBackend } from "../../../src/memory/test-utils.js";
import { createSessionToolHandler } from "../../../src/gateway/tool-handler-factory.js";
import { PipelineExecutor } from "../../../src/workflow/pipeline.js";
import { EffectLedger } from "../../../src/workflow/effect-ledger.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("effect ledger integration", () => {
  it("reuses a single effect record across deterministic pipeline retries", async () => {
    const workspace = createTempDir("agenc-effect-retry-");
    const targetPath = join(workspace, "AGENC.md");
    const backend = createMockMemoryBackend();
    const ledger = EffectLedger.fromMemoryBackend(backend);
    let attempts = 0;
    const handler = createSessionToolHandler({
      sessionId: "pipeline-session",
      baseHandler: vi.fn(async (_toolName, args) => {
        attempts += 1;
        if (attempts === 1) {
          return JSON.stringify({ error: "transient failure", exitCode: 1 });
        }
        writeFileSync(String(args.path), String(args.content), "utf8");
        return JSON.stringify({ path: args.path, written: true });
      }),
      routerId: "router-a",
      send: vi.fn(),
      effectLedger: ledger,
      effectChannel: "test",
    });

    const executor = new PipelineExecutor({
      toolHandler: handler,
      memoryBackend: backend,
      effectLedger: ledger,
    });

    const result = await executor.execute({
      id: "pipeline:effect-retry",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [
        {
          name: "write_agenc",
          tool: "system.writeFile",
          args: { path: targetPath, content: "final content" },
          onError: "retry",
          maxRetries: 1,
        },
      ],
    });

    expect(result.status).toBe("completed");
    const effects = await ledger.listSessionEffects("pipeline-session");
    expect(effects).toHaveLength(1);
    expect(effects[0]?.attempts).toHaveLength(2);
    expect(effects[0]?.idempotencyKey).toBe(
      "pipeline:pipeline:effect-retry:step:0:write_agenc",
    );
    expect(readFileSync(targetPath, "utf8")).toBe("final content");

    rmSync(workspace, { recursive: true, force: true });
  });

  it("restores the original file during compensation after a forced downstream failure", async () => {
    const workspace = createTempDir("agenc-effect-compensation-");
    const targetPath = join(workspace, "AGENC.md");
    writeFileSync(targetPath, "baseline", "utf8");
    const ledger = EffectLedger.fromMemoryBackend(createMockMemoryBackend());
    const handler = createSessionToolHandler({
      sessionId: "compensation-session",
      baseHandler: vi.fn(async (_toolName, args) => {
        writeFileSync(String(args.path), String(args.content), "utf8");
        return JSON.stringify({ path: args.path, written: true });
      }),
      routerId: "router-a",
      send: vi.fn(),
      effectLedger: ledger,
      effectChannel: "test",
    });

    await handler("system.writeFile", {
      path: targetPath,
      content: "mutated",
    });
    expect(readFileSync(targetPath, "utf8")).toBe("mutated");

    const [effect] = await ledger.listSessionEffects("compensation-session");
    expect(effect?.compensation.status).toBe("available");

    const compensated = await ledger.compensateEffect({
      effectId: effect!.id,
    });
    expect(compensated?.status).toBe("compensated");
    expect(readFileSync(targetPath, "utf8")).toBe("baseline");

    rmSync(workspace, { recursive: true, force: true });
  });
});

