/**
 * Tests for the relevant durable-memory attachment producer.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import { sideQuery } from "../../utils/sideQuery.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { relevantMemoriesProducer } from "./relevant-memories.js";

vi.mock("../../utils/sideQuery.js", () => ({
  sideQuery: vi.fn(),
}));

let root: string;
let cwd: string;
let agencHome: string;
let savedAgencHome: string | undefined;
let savedDisableAutoMemory: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-relevant-memory-"));
  cwd = join(root, "repo");
  agencHome = join(root, "home");
  mkdirSync(join(agencHome, "memory"), { recursive: true });
  mkdirSync(join(cwd, ".agenc", "memory"), { recursive: true });
  savedAgencHome = process.env.AGENC_HOME;
  savedDisableAutoMemory = process.env.AGENC_DISABLE_AUTO_MEMORY;
  process.env.AGENC_HOME = agencHome;
  delete process.env.AGENC_DISABLE_AUTO_MEMORY;
  vi.mocked(sideQuery).mockReset();
});

afterEach(() => {
  if (savedAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = savedAgencHome;
  }
  if (savedDisableAutoMemory === undefined) {
    delete process.env.AGENC_DISABLE_AUTO_MEMORY;
  } else {
    process.env.AGENC_DISABLE_AUTO_MEMORY = savedDisableAutoMemory;
  }
  rmSync(root, { recursive: true, force: true });
});

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: "use browser automation",
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd,
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome,
    ...partial,
  };
}

function writeMemory(
  dir: string,
  name: string,
  description: string,
  content: string,
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    ["---", `description: ${description}`, "type: usage", "---", "", content]
      .join("\n"),
    "utf8",
  );
  return path;
}

function selectMemory(name: string): void {
  vi.mocked(sideQuery).mockResolvedValue({
    content: [
      {
        type: "text",
        text: JSON.stringify({ selected_memories: [name] }),
      },
    ],
  } as never);
}

describe("relevantMemoriesProducer", () => {
  test("skips without an AgenC home", async () => {
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(
      makeOpts({ agencHome: undefined }),
      trackingState,
    );
    expect(out).toEqual([]);
    expect(sideQuery).not.toHaveBeenCalled();
  });

  test("skips one-word prompts that cannot drive useful recall", async () => {
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(
      makeOpts({ userInput: "browser" }),
      trackingState,
    );
    expect(out).toEqual([]);
    expect(sideQuery).not.toHaveBeenCalled();
  });

  test("skips when auto-memory is disabled", async () => {
    process.env.AGENC_DISABLE_AUTO_MEMORY = "1";
    const trackingState = getAttachmentTrackingState({});
    const out = await relevantMemoriesProducer(makeOpts(), trackingState);
    expect(out).toEqual([]);
    expect(sideQuery).not.toHaveBeenCalled();
  });

  test("surfaces selected durable memory with bounded content and citation metadata", async () => {
    const memoryDir = join(agencHome, "memory");
    const memoryPath = writeMemory(
      memoryDir,
      "browser.md",
      "Browser automation guidance",
      "Use the browser automation workflow.",
    );
    selectMemory("browser.md");
    const trackingState = getAttachmentTrackingState({});

    const out = await relevantMemoriesProducer(makeOpts(), trackingState);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("relevant_memories");
    if (out[0]?.kind !== "relevant_memories") {
      throw new Error("expected relevant_memories");
    }
    expect(out[0].memories).toHaveLength(1);
    expect(out[0].memories[0]?.path).toBe(memoryPath);
    expect(out[0].memories[0]?.content).toContain(
      "Use the browser automation workflow.",
    );
    expect(out[0].memories[0]?.header).toContain("Memory");
    expect(out[0].memories[0]?.citation?.path).toBe(memoryPath);
    expect(trackingState.surfacedRelevantMemoryPaths.has(memoryPath)).toBe(true);
    expect(trackingState.surfacedRelevantMemoryBytes).toBeGreaterThan(0);
  });

  test("dedupes memories already surfaced in the session", async () => {
    const memoryDir = join(agencHome, "memory");
    const memoryPath = writeMemory(
      memoryDir,
      "browser.md",
      "Browser automation guidance",
      "Use the browser automation workflow.",
    );
    selectMemory("browser.md");
    const trackingState = getAttachmentTrackingState({});
    trackingState.surfacedRelevantMemoryPaths.add(memoryPath);

    const out = await relevantMemoriesProducer(makeOpts(), trackingState);

    expect(out).toEqual([]);
    const query = vi.mocked(sideQuery).mock.calls[0]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    if (query !== undefined) {
      expect(query.messages[0]?.content).not.toContain("browser.md");
    }
  });

  test("truncates large selected memories before attachment emission", async () => {
    const memoryDir = join(agencHome, "memory");
    writeMemory(
      memoryDir,
      "large.md",
      "Large browser guidance",
      Array.from({ length: 260 }, (_, i) => `line ${i} ${"x".repeat(40)}`)
        .join("\n"),
    );
    selectMemory("large.md");
    const trackingState = getAttachmentTrackingState({});

    const out = await relevantMemoriesProducer(makeOpts(), trackingState);

    expect(out[0]?.kind).toBe("relevant_memories");
    if (out[0]?.kind !== "relevant_memories") {
      throw new Error("expected relevant_memories");
    }
    expect(out[0].memories[0]?.content).toContain(
      "This memory file was truncated",
    );
    expect(out[0].memories[0]?.limit).toBeTypeOf("number");
    expect(
      Buffer.byteLength(out[0].memories[0]?.content ?? "", "utf8"),
    ).toBeLessThan(5000);
  });
});
