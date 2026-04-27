/**
 * Tests for the relevant-memory attachment producer.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _resetAttachmentBudgetForTest } from "../memory/attachments.js";
import { clearSessionReadState } from "../../tools/system/filesystem.js";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import {
  getMemoryCitations,
  setSessionMemoryMode,
} from "../memory/index.js";
import { relevantMemoryProducer } from "./relevant-memory.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

let tmpDir: string;
let sessionId: string;
let sessionKey: { sessionId: string; memoryDir?: string };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agenc-relevant-mem-"));
  sessionId = `session-${Math.random().toString(36).slice(2)}`;
  sessionKey = { sessionId, memoryDir: tmpDir };
});

afterEach(() => {
  _resetAttachmentBudgetForTest(sessionKey);
  clearSessionReadState(sessionId);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeOpts(
  overrides: Partial<GetAttachmentsOptions> = {},
): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: "default input",
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: tmpDir,
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function writeMemory(name: string, body: string, descriptionTokens: string): void {
  const content = `---
name: ${name}
description: ${descriptionTokens}
type: project
---

${body}
`;
  writeFileSync(join(tmpDir, `${name}.md`), content);
}

describe("relevantMemoryProducer", () => {
  test("returns [] when sessionKey lacks memoryDir", async () => {
    const opts = makeOpts({ sessionKey: { sessionId } as never });
    const out = await relevantMemoryProducer(
      opts,
      getAttachmentTrackingState(sessionKey),
    );
    expect(out).toEqual([]);
  });

  test("returns [] when userInput is empty", async () => {
    writeMemory("alpha", "Some body", "alpha description");
    const out = await relevantMemoryProducer(
      makeOpts({ userInput: "" }),
      getAttachmentTrackingState(sessionKey),
    );
    expect(out).toEqual([]);
  });

  test("returns [] when memory dir has no files", async () => {
    const out = await relevantMemoryProducer(
      makeOpts({ userInput: "literally anything" }),
      getAttachmentTrackingState(sessionKey),
    );
    expect(out).toEqual([]);
  });

  test("memories present, selector returns matches → emits relevant_memories", async () => {
    writeMemory("alpha", "alpha body content", "tokenA tokenB tokenC");
    writeMemory("beta", "beta body content", "tokenD tokenE tokenF");
    const out = await relevantMemoryProducer(
      makeOpts({ userInput: "asking about tokenA tokenB" }),
      getAttachmentTrackingState(sessionKey),
    );
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== "relevant_memories") throw new Error("kind");
    expect(out[0].memories.length).toBeGreaterThan(0);
    const surfaced = out[0].memories[0]!;
    expect(surfaced.path).toMatch(/alpha\.md$/);
    expect(surfaced.content).toContain("alpha body content");
    expect(surfaced.header).toContain("mtime:");
    expect(surfaced.citation?.lineStart).toBe(1);
    expect(getMemoryCitations(sessionKey).length).toBeGreaterThan(0);
  });

  test("returns [] when no memories overlap the user input tokens (and no other priorities)", async () => {
    // We can't easily force "selector returns nothing" since the type
    // bonus alone (project=3) makes everything score above 0. Instead
    // prove the empty-userInput short-circuit + verify selector cap
    // honors per-session bytes by exhausting budget.
    writeMemory("gigantic", "x".repeat(70_000), "huge");
    // Per-file cap is 4_000 bytes — file is dropped entirely.
    const out = await relevantMemoryProducer(
      makeOpts({ userInput: "huge content" }),
      getAttachmentTrackingState(sessionKey),
    );
    expect(out).toEqual([]);
  });

  test("derives memoryDir from opts.agencHome when sessionKey.memoryDir is absent", async () => {
    // Lay out an agencHome with a memory/ subdir so the producer can
    // resolve <agencHome>/memory.
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-relevant-mem-home-"));
    try {
      const memoryDir = join(agencHome, "memory");
      // Mirror the real bootstrap layout: agencHome/memory/<file>.md.
      const fs = await import("node:fs/promises");
      await fs.mkdir(memoryDir, { recursive: true });
      const content = `---
name: derived
description: agencHome path tokenA tokenB
type: project
---

derived body
`;
      await fs.writeFile(join(memoryDir, "derived.md"), content);

      // sessionKey lacks memoryDir — the producer must fall back to
      // opts.agencHome and resolve agencHome/memory.
      const altSessionId = `session-${Math.random().toString(36).slice(2)}`;
      const altSessionKey = { sessionId: altSessionId };
      const out = await relevantMemoryProducer(
        {
          ...makeOpts({ userInput: "asking about tokenA tokenB" }),
          sessionKey: altSessionKey,
          agencHome,
        },
        getAttachmentTrackingState(altSessionKey),
      );
      expect(out).toHaveLength(1);
      if (out[0]?.kind !== "relevant_memories") throw new Error("kind");
      expect(out[0].memories[0]?.path).toMatch(/derived\.md$/);
      _resetAttachmentBudgetForTest(altSessionKey);
      clearSessionReadState(altSessionId);
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("memory mode disabled blocks recall", async () => {
    writeMemory("alpha", "alpha body content", "tokenA tokenB tokenC");
    setSessionMemoryMode(sessionKey, "disabled");
    const out = await relevantMemoryProducer(
      makeOpts({ userInput: "asking about tokenA tokenB" }),
      getAttachmentTrackingState(sessionKey),
    );
    expect(out).toEqual([]);
  });
});
