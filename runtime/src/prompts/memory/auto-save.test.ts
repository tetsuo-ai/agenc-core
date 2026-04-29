import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_SAVE_MIN_TOKEN_GROWTH,
  AUTO_SAVE_MIN_TOOL_CALLS,
  _resetAutoSaveStateForTest,
  isMemoryWorthy,
  maybeAutoSaveMemory,
  shouldExtract,
  upsertIndexEntry,
  writeMemoryFile,
  type AutoSaveSession,
  type MemoryCandidate,
  type TurnState,
} from "./auto-save.js";
import {
  _clearMemoryWriteLocksForTest,
  getMemoryWriteLock,
} from "./loader.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  _clearMemoryWriteLocksForTest();
});

async function makeSession(): Promise<AutoSaveSession> {
  tempDir = await mkdtemp(join(tmpdir(), "agenc-autosave-"));
  return {
    memoryDir: tempDir,
    memoryMdPath: join(tempDir, "MEMORY.md"),
  };
}

function candidate(
  session: AutoSaveSession,
  overrides?: Partial<MemoryCandidate>,
): MemoryCandidate {
  return {
    filePath: join(session.memoryDir, "topic.md"),
    frontmatter: {
      name: "topic-one",
      description: "a concrete topic",
      type: "feedback",
      extra: {},
    },
    body:
      "This is the extracted memory body. It is long enough to pass isMemoryWorthy.",
    ...overrides,
  };
}

describe("shouldExtract (pure threshold predicate)", () => {
  const emptyState = {
    tokensAtLastExtraction: 0,
    toolCallsAtLastExtraction: 0,
    inFlight: null,
  } as const;

  test("returns true on token growth + tool-call burst", () => {
    const ts: TurnState = {
      tokensConsumed: AUTO_SAVE_MIN_TOKEN_GROWTH,
      toolCallsIssued: AUTO_SAVE_MIN_TOOL_CALLS,
      lastTurnHadNoTools: false,
    };
    expect(shouldExtract({ ...emptyState }, ts)).toBe(true);
  });

  test("returns true on token growth + natural break (no tools this turn)", () => {
    const ts: TurnState = {
      tokensConsumed: AUTO_SAVE_MIN_TOKEN_GROWTH,
      toolCallsIssued: 0,
      lastTurnHadNoTools: true,
    };
    expect(shouldExtract({ ...emptyState }, ts)).toBe(true);
  });

  test("returns false below token growth floor", () => {
    const ts: TurnState = {
      tokensConsumed: AUTO_SAVE_MIN_TOKEN_GROWTH - 1,
      toolCallsIssued: AUTO_SAVE_MIN_TOOL_CALLS,
      lastTurnHadNoTools: true,
    };
    expect(shouldExtract({ ...emptyState }, ts)).toBe(false);
  });

  test("returns false with growth but mid-tool-use and too few calls", () => {
    const ts: TurnState = {
      tokensConsumed: AUTO_SAVE_MIN_TOKEN_GROWTH,
      toolCallsIssued: AUTO_SAVE_MIN_TOOL_CALLS - 1,
      lastTurnHadNoTools: false,
    };
    expect(shouldExtract({ ...emptyState }, ts)).toBe(false);
  });

  test("returns false when zero token growth blocks both branches", () => {
    // T10 A+ Fix-α residual #4: even when the tool-call burst threshold
    // is met AND the natural-break flag would otherwise qualify, a zero
    // token growth must block extraction. Both `shouldExtract` branches
    // require `hasGrowth`.
    const ts: TurnState = {
      tokensConsumed: 0,
      toolCallsIssued: AUTO_SAVE_MIN_TOOL_CALLS,
      lastTurnHadNoTools: false,
    };
    expect(shouldExtract({ ...emptyState }, ts)).toBe(false);
  });
});

describe("isMemoryWorthy", () => {
  test("rejects candidates with too-short body", () => {
    expect(
      isMemoryWorthy({
        filePath: "/t.md",
        frontmatter: { name: "x", type: "user", extra: {} },
        body: "tiny",
      }),
    ).toBe(false);
  });

  test("rejects candidates missing a name or type", () => {
    expect(
      isMemoryWorthy({
        filePath: "/t.md",
        frontmatter: { extra: {} },
        body: "Body is long enough to pass length check.",
      }),
    ).toBe(false);
  });

  test("accepts a valid candidate", () => {
    expect(
      isMemoryWorthy({
        filePath: "/t.md",
        frontmatter: { name: "n", type: "user", extra: {} },
        body: "Body is long enough to pass length check.",
      }),
    ).toBe(true);
  });

  test("rejects extraction-instruction artifacts", () => {
    expect(
      isMemoryWorthy({
        filePath: "/t.md",
        frontmatter: {
          name: "agenc-durable-memories-extraction-task",
          type: "project",
          extra: {},
        },
        body:
          "This records the memory extraction subagent task and says to output ONLY a single JSON array.",
      }),
    ).toBe(false);
  });

  test("rejects ephemeral current-task status artifacts", () => {
    expect(
      isMemoryWorthy({
        filePath: "/t.md",
        frontmatter: {
          name: "agenc-m5-step1-shellstate-inprogress",
          description:
            "M5 Step 1 ShellState extensions in progress, creating include/agenc/vars.h for dynamic scope stack per approved plan",
          type: "project",
          extra: {},
        },
        body:
          "Current task status: Step 1 is in-progress and positioned for next step after creating include/agenc/vars.h.",
      }),
    ).toBe(false);
  });
});

describe("maybeAutoSaveMemory", () => {
  test("skips when below threshold", async () => {
    const session = await makeSession();
    _resetAutoSaveStateForTest(session);
    let called = 0;
    await maybeAutoSaveMemory(
      session,
      {
        tokensConsumed: 100,
        toolCallsIssued: 0,
        lastTurnHadNoTools: true,
      },
      async () => {
        called++;
        return [];
      },
    );
    expect(called).toBe(0);
  });

  test("writes candidates through I-29 lock and updates MEMORY.md", async () => {
    const session = await makeSession();
    _resetAutoSaveStateForTest(session);
    const cand = candidate(session);
    await maybeAutoSaveMemory(
      session,
      {
        tokensConsumed: AUTO_SAVE_MIN_TOKEN_GROWTH,
        toolCallsIssued: AUTO_SAVE_MIN_TOOL_CALLS,
        lastTurnHadNoTools: false,
      },
      async () => [cand],
    );
    const written = await readFile(cand.filePath, "utf8");
    expect(written).toContain("name: topic-one");
    expect(written).toContain("type: feedback");
    const idx = await readFile(session.memoryMdPath, "utf8");
    expect(idx).toContain("(topic.md)");
    expect(idx).toContain("a concrete topic");
  });

  test("I-29 lock prevents interleaved writes to the same file", async () => {
    const session = await makeSession();
    _resetAutoSaveStateForTest(session);
    const cand = candidate(session);
    const lock = getMemoryWriteLock(cand.filePath);
    const order: string[] = [];
    // Hold the lock from outside, spawn the auto-save, then release.
    let releaseOuter: () => void = () => {};
    const outerHeld = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    const outerTask = lock.with(async () => {
      order.push("outer-start");
      await outerHeld;
      order.push("outer-end");
    });
    const autoTask = maybeAutoSaveMemory(
      session,
      {
        tokensConsumed: AUTO_SAVE_MIN_TOKEN_GROWTH,
        toolCallsIssued: AUTO_SAVE_MIN_TOOL_CALLS,
        lastTurnHadNoTools: false,
      },
      async () => {
        // The extractor runs before the write — it itself doesn't touch
        // the locked file, so it may race. What MUST NOT race is the
        // writeMemoryFile call inside maybeAutoSaveMemory, which takes
        // the same lock. We verify that by checking the file contents
        // can only be written after the outer lock is released.
        return [cand];
      },
    );
    // Yield so the auto-save can start and wait on the lock's write stage.
    await new Promise((r) => setTimeout(r, 10));
    // Outer still holds the lock → no file written yet.
    order.push("checking-before-release");
    const { access } = await import("node:fs/promises");
    let existedBeforeRelease = true;
    try {
      await access(cand.filePath);
    } catch {
      existedBeforeRelease = false;
    }
    expect(existedBeforeRelease).toBe(false);
    // Now release and let both drain.
    releaseOuter();
    await Promise.all([outerTask, autoTask]);
    // Outer-end must appear before the observation that no file existed.
    // Actually — observation ran before release, so check order:
    expect(order).toEqual([
      "outer-start",
      "checking-before-release",
      "outer-end",
    ]);
    const written = await readFile(cand.filePath, "utf8");
    expect(written).toContain("name: topic-one");
  });

  test("upsertIndexEntry is idempotent for same relative path", async () => {
    const session = await makeSession();
    const cand = candidate(session);
    await upsertIndexEntry(session.memoryMdPath, cand);
    await upsertIndexEntry(session.memoryMdPath, cand);
    const idx = await readFile(session.memoryMdPath, "utf8");
    const lines = idx.split("\n").filter((l) => l.includes("(topic.md)"));
    expect(lines.length).toBe(1);
  });

  test("upsertIndexEntry writes forward-slash relative paths regardless of host sep", async () => {
    const session = await makeSession();
    // Nested candidate path: `topics/sub/topic.md` relative to memoryDir.
    const cand = candidate(session, {
      filePath: join(session.memoryDir, "topics", "sub", "topic.md"),
      frontmatter: {
        name: "nested-topic",
        description: "nested hook",
        type: "feedback",
        extra: {},
      },
    });
    await upsertIndexEntry(session.memoryMdPath, cand);
    const idx = await readFile(session.memoryMdPath, "utf8");
    // Cross-platform invariant: the link target in MEMORY.md must use
    // forward slashes so the index file is portable. The host may write
    // files under \\ (Windows) but the index content is normalized.
    expect(idx).toContain("(topics/sub/topic.md)");
    expect(idx).not.toMatch(/\(topics\\sub\\topic\.md\)/);
  });
});

describe("writeMemoryFile", () => {
  test("writes a memory file atomically under the I-29 lock", async () => {
    const session = await makeSession();
    const cand = candidate(session);
    await writeMemoryFile(cand);
    const out = await readFile(cand.filePath, "utf8");
    expect(out).toContain("---");
    expect(out).toContain("type: feedback");
  });
});
