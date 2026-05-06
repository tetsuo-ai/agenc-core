import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { platform, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  addMessageToTurn,
  addToolCallToTurn,
  createMultiTurnContextManager,
  createMultiTurnTracker,
  getCurrentTurn,
  getMultiTurnStats,
  getRecentTurns,
  getTurnHistory,
  getTurnState,
  resetMultiTurnState,
  setTurnState,
  startNewTurn,
  type MultiTurnMessage,
} from "./multi-turn-context.js";
import { resolveSessionMemoryPath } from "../services/SessionMemory/sessionMemoryUtils.js";

const POSIX = platform() !== "win32";
const posixTest = POSIX ? test : test.skip;

function makeWorkspace(name = "agenc-multi-turn-"): string {
  return mkdtempSync(join(tmpdir(), name));
}

function message(content: string): MultiTurnMessage {
  return {
    message: {
      role: "user",
      content,
    },
  };
}

describe("multi-turn context donor parity wrappers", () => {
  beforeEach(() => {
    resetMultiTurnState();
  });

  test("tracks turns, messages, tool calls, state, and stats", () => {
    const turn = startNewTurn();

    expect(turn.turnId).toContain("turn_1");
    expect(turn.messages).toEqual([]);

    addMessageToTurn(message("Hello from the user"));
    addToolCallToTurn({
      id: "call_1",
      name: "read_file",
      input: { path: "README.md" },
      timestamp: 11,
    });
    setTurnState("phase", "tools");

    const current = getCurrentTurn();
    expect(current?.messages).toHaveLength(1);
    expect(current?.toolCalls).toHaveLength(1);
    expect(getTurnState("phase")).toBe("tools");
    expect(getTurnHistory()).toHaveLength(1);
    expect(getRecentTurns(1)[0]?.turnId).toBe(current?.turnId);
    expect(getMultiTurnStats()).toMatchObject({
      totalTurns: 1,
    });
    expect(getMultiTurnStats().totalTokens).toBeGreaterThan(0);
  });

  test("tracker factory keeps donor method names and max-turn trimming", () => {
    const tracker = createMultiTurnTracker({ maxTurns: 2 });

    tracker.startTurn();
    tracker.startTurn();
    tracker.startTurn();
    tracker.addMessage(message("third turn"));

    expect(tracker.getHistory()).toHaveLength(2);
    expect(tracker.getHistory()[0]?.turnId).toContain("turn_2");
    expect(tracker.getStats().totalTokens).toBeGreaterThan(0);

    tracker.reset();
    expect(tracker.getHistory()).toEqual([]);
  });
});

describe("MultiTurnContextManager", () => {
  let tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  function tempRoot(name?: string): string {
    const root = makeWorkspace(name);
    tempRoots.push(root);
    return root;
  }

  test("isolates history, state, and options per manager", () => {
    const one = createMultiTurnContextManager(
      { maxTurns: 1 },
      { now: () => 100 },
    );
    const two = createMultiTurnContextManager(
      { maxTurns: 3 },
      { now: () => 200 },
    );

    one.startNewTurn();
    one.setTurnState("owner", "one");
    one.startNewTurn();
    two.startNewTurn();
    two.startNewTurn();

    expect(one.getTurnHistory()).toHaveLength(1);
    expect(two.getTurnHistory()).toHaveLength(2);
    expect(one.getTurnState("owner")).toBe("one");
    expect(two.getTurnState("owner")).toBeUndefined();
    expect(one.getTurnHistory()[0]?.turnId).toContain("_100");
    expect(two.getTurnHistory()[0]?.turnId).toContain("_200");
  });

  test("preserves or clears state across turns based on options", () => {
    const preserving = createMultiTurnContextManager({ preserveState: true });
    preserving.startNewTurn();
    preserving.setTurnState("cwd", "/repo");
    preserving.startNewTurn();
    expect(preserving.getTurnState("cwd")).toBe("/repo");

    const clearing = createMultiTurnContextManager({ preserveState: false });
    clearing.startNewTurn();
    clearing.setTurnState("cwd", "/repo");
    clearing.startNewTurn();
    expect(clearing.getTurnState("cwd")).toBeUndefined();
  });

  test("returns snapshot arrays for history and recent turns", () => {
    const manager = createMultiTurnContextManager();
    manager.startNewTurn();

    const history = manager.getTurnHistory();
    const recent = manager.getRecentTurns(1);
    history.push(history[0]!);
    recent.push(recent[0]!);

    expect(manager.getTurnHistory()).toHaveLength(1);
    expect(manager.getRecentTurns(1)).toHaveLength(1);
  });

  test("returns deep-cloned message and attachment snapshots", async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, "note.txt"), "original attachment");
    const manager = createMultiTurnContextManager();
    manager.addMessageToTurn(message("original message"));
    await manager.attachFileMentions("read @note.txt", { cwd });

    const snapshot = manager.getTurnHistory()[0]!;
    (snapshot.messages[0] as { message: { content: string } }).message.content =
      "mutated message";
    (snapshot.attachments[0] as { expandedPrompt: string }).expandedPrompt =
      "mutated attachment";

    const fresh = manager.getTurnHistory()[0]!;
    expect(
      (fresh.messages[0] as { message: { content: string } }).message.content,
    ).toBe("original message");
    expect(
      (fresh.attachments[0] as { expandedPrompt: string }).expandedPrompt,
    ).toContain("original attachment");
  });

  test("deep-clones caller-owned records on ingest", async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, "note.txt"), "original attachment");
    const manager = createMultiTurnContextManager();
    const mutableMessage = message("original message") as {
      message: { content: string };
    };
    const mutableInput = { nested: { path: "original path" } };

    manager.addMessageToTurn(mutableMessage);
    manager.addToolCallToTurn({
      id: "call_1",
      name: "read_file",
      input: mutableInput,
      timestamp: 1,
    });
    const returnedAttachment = await manager.attachFileMentions("read @note.txt", {
      cwd,
    });

    mutableMessage.message.content = "mutated message";
    mutableInput.nested.path = "mutated path";
    (returnedAttachment.attachments[0] as { content: string }).content =
      "mutated attachment";

    const turn = manager.getCurrentTurn()!;
    expect(
      (turn.messages[0] as { message: { content: string } }).message.content,
    ).toBe("original message");
    expect(
      (turn.toolCalls[0]?.input as { nested: { path: string } }).nested.path,
    ).toBe("original path");
    expect(
      (turn.attachments[0] as { attachments: readonly { content: string }[] })
        .attachments[0]?.content,
    ).toBe("original attachment");
  });

  test("handles cyclic and prototype-polluting payloads while cloning", () => {
    const manager = createMultiTurnContextManager();
    const cyclic = message("cyclic message") as MultiTurnMessage & {
      self?: unknown;
    };
    cyclic.self = cyclic;
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as
      Record<string, unknown>;

    manager.addMessageToTurn(cyclic);
    manager.addToolCallToTurn({
      id: "call_1",
      name: "unsafe_shape",
      input: polluted,
      timestamp: 1,
    });

    expect(() => manager.getTurnHistory()).not.toThrow();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(
      (manager.getTurnHistory()[0]?.toolCalls[0]?.input as { safe: number }).safe,
    ).toBe(1);
  });

  test("reports compaction status from message tokens and thresholds", () => {
    const manager = createMultiTurnContextManager({
      contextWindowTokens: 20,
      maxTokensPerTurn: 1_000,
    });

    manager.addMessageToTurn(message("x".repeat(120)));

    const status = manager.getCompactionStatus();
    expect(status.autoCompactThresholdTokens).toBe(16);
    expect(status.exceedsAutoCompactThreshold).toBe(true);
    expect(status.shouldCompact).toBe(true);
  });

  test("uses aggregate recent-turn tokens for default compaction triggers", () => {
    const manager = createMultiTurnContextManager({
      contextWindowTokens: 20,
      maxTokensPerTurn: 1_000,
    });

    for (let i = 0; i < 4; i += 1) {
      manager.startNewTurn();
      manager.addMessageToTurn(message("x".repeat(20)));
      expect(manager.getCurrentTurnCompactionStatus().shouldCompact).toBe(false);
    }

    const aggregateStatus = manager.getCompactionStatus();
    const trigger = manager.getCompactionTrigger();
    expect(aggregateStatus.currentTokens).toBe(20);
    expect(aggregateStatus.shouldCompact).toBe(true);
    expect(trigger.shouldCompact).toBe(true);
    expect(trigger.reason).toBe("auto_compact_threshold");
    expect(trigger.context.turnIds).toHaveLength(4);
    expect(trigger.context.compactableMessages).toHaveLength(4);
  });

  test("honors auto-compact disable switches while keeping max-token limits", () => {
    const previous = process.env.AGENC_DISABLE_AUTO_COMPACT;
    process.env.AGENC_DISABLE_AUTO_COMPACT = "1";
    try {
      const belowHardLimit = createMultiTurnContextManager({
        contextWindowTokens: 20,
        maxTokensPerTurn: 1_000,
      });
      belowHardLimit.addMessageToTurn(message("x".repeat(120)));
      expect(belowHardLimit.getCompactionStatus()).toMatchObject({
        exceedsAutoCompactThreshold: false,
        shouldCompact: false,
      });

      const overHardLimit = createMultiTurnContextManager({
        contextWindowTokens: 20,
        maxTokensPerTurn: 5,
      });
      overHardLimit.addMessageToTurn(message("x".repeat(120)));
      expect(overHardLimit.getCompactionStatus()).toMatchObject({
        exceedsMaxTokensPerTurn: true,
        shouldCompact: true,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AGENC_DISABLE_AUTO_COMPACT;
      } else {
        process.env.AGENC_DISABLE_AUTO_COMPACT = previous;
      }
    }
  });

  test("handles just-below and equal compaction thresholds", () => {
    const below = createMultiTurnContextManager({
      autoCompactThresholdTokens: 5,
      maxTokensPerTurn: 1_000,
    });
    below.addMessageToTurn(message("x".repeat(16)));
    expect(below.getCompactionStatus()).toMatchObject({
      currentTokens: 4,
      shouldCompact: false,
      remainingTokensUntilCompact: 1,
    });

    const equal = createMultiTurnContextManager({
      autoCompactThresholdTokens: 5,
      maxTokensPerTurn: 1_000,
    });
    equal.addMessageToTurn(message("x".repeat(20)));
    expect(equal.getCompactionStatus()).toMatchObject({
      currentTokens: 5,
      shouldCompact: true,
      remainingTokensUntilCompact: 0,
    });
  });

  test("ignores invalid token estimator values", () => {
    const manager = createMultiTurnContextManager(
      {},
      {
        estimateMessageTokens: () => Number.NaN,
        estimateContentTokens: () => Number.NaN,
      },
    );

    manager.addMessageToTurn(message("message"));
    expect(manager.getCurrentTurn()?.tokens).toBe(0);
    expect(manager.getCompactionStatus().currentTokens).toBe(0);
  });

  test("uses recorded message token counts in active context payloads", () => {
    let tokenEstimate = 1;
    const manager = createMultiTurnContextManager(
      {},
      {
        estimateMessageTokens: () => tokenEstimate,
      },
    );

    manager.addMessageToTurn(message("stable count"));
    tokenEstimate = 99;

    const payload = manager.getActiveContextPayload();
    expect(payload.messageTokens).toBe(1);
    expect(payload.compactableMessages[0]?.tokens).toBe(1);
  });

  test("records file mention rejections through the wrapper", async () => {
    const cwd = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "secret.txt"), "secret");
    const manager = createMultiTurnContextManager();

    const attachment = await manager.attachFileMentions(
      `read @${join(outside, "secret.txt")}`,
      { cwd },
    );

    expect(attachment.attachments).toEqual([]);
    expect(attachment.rejected[0]?.reason).toBe("outside_workspace");
    expect(manager.getCurrentTurn()?.attachments).toHaveLength(1);
    expect(manager.getActiveContextPayload().attachmentBlocks).toEqual([]);
    expect(
      manager
        .getActiveContextPayload()
        .compactableMessages.filter((entry) => entry.kind === "attachment"),
    ).toEqual([]);
  });

  test("allows file mentions inside explicit allowed roots", async () => {
    const cwd = tempRoot();
    const shared = tempRoot();
    writeFileSync(join(shared, "shared.txt"), "shared context");
    const manager = createMultiTurnContextManager();

    const attachment = await manager.attachFileMentions(
      `read @${join(shared, "shared.txt")}`,
      { cwd, allowedRoots: [shared] },
    );

    expect(attachment.rejected).toEqual([]);
    expect(attachment.attachments[0]?.content).toBe("shared context");
  });

  posixTest("rejects file mention symlink escapes through the wrapper", async () => {
    const cwd = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(cwd, "linked-secret.txt"));
    const manager = createMultiTurnContextManager();

    const attachment = await manager.attachFileMentions("read @linked-secret.txt", {
      cwd,
    });

    expect(attachment.attachments).toEqual([]);
    expect(attachment.rejected[0]?.reason).toBe("outside_workspace");
  });

  test("counts file mention attachment tokens toward compaction", async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, "big.txt"), "x".repeat(200));
    const manager = createMultiTurnContextManager({
      contextWindowTokens: 20,
      maxTokensPerTurn: 1_000,
    });

    const attachment = await manager.attachFileMentions("inspect @big.txt", {
      cwd,
    });

    expect(attachment.attachments).toHaveLength(1);
    expect(attachment.attachmentBlock).toContain("<attached_files>");
    expect(attachment.attachmentBlock).not.toContain("<user_message>");
    expect(attachment.tokens).toBeGreaterThan(16);
    expect(manager.getCompactionStatus().attachmentTokens).toBe(attachment.tokens);
    expect(manager.shouldCompactCurrentTurn()).toBe(true);
  });

  test("attaches AGENC.md instructions and session memory with token accounting", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const repo = join(root, "repo");
    const configHome = join(root, "config");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}");
    writeFileSync(join(repo, "AGENC.md"), "Project instruction sentinel.");
    writeFileSync(join(repo, "note.txt"), "Mentioned file sentinel.");
    const memoryPath = resolveSessionMemoryPath({
      cwd: repo,
      sessionId: "session-1",
      configHomeDir: configHome,
    });
    mkdirSync(dirname(memoryPath), { recursive: true });
    writeFileSync(memoryPath, "Remember this session decision.", "utf8");
    const manager = createMultiTurnContextManager();

    const mention = await manager.attachFileMentions("read @note.txt", {
      cwd: repo,
    });
    const instructions = await manager.attachAgenCInstructions({
      cwd: repo,
      homeDir: home,
      managedPath: join(root, "missing-managed.md"),
    });
    const memory = await manager.attachSessionMemory({
      cwd: repo,
      sessionId: "session-1",
      configHomeDir: configHome,
    });
    const payload = manager.getActiveContextPayload();

    expect(mention.expandedPrompt).toContain("Mentioned file sentinel.");
    expect(instructions?.content).toContain("Project instruction sentinel.");
    expect(instructions?.tokens).toBeGreaterThan(0);
    expect(memory?.content).toContain("Remember this session decision.");
    expect(memory?.tokens).toBeGreaterThan(0);
    expect(manager.getCurrentTurn()?.attachments.map((entry) => entry.type)).toEqual([
      "file_mentions",
      "agenc_instructions",
      "session_memory",
    ]);
    expect(payload.attachmentBlocks.map((entry) => entry.type)).toEqual([
      "file_mentions",
      "agenc_instructions",
      "session_memory",
    ]);
    expect(payload.compactableMessages.filter((entry) => entry.kind === "attachment"))
      .toHaveLength(3);
    expect(payload.attachmentBlocks.map((entry) => entry.content).join("\n"))
      .toContain("Mentioned file sentinel.");
    expect(payload.attachmentBlocks[0]?.content).not.toContain("<user_message>");
    expect(payload.attachmentBlocks.map((entry) => entry.content).join("\n"))
      .toContain("Project instruction sentinel.");
    expect(payload.attachmentBlocks.map((entry) => entry.content).join("\n"))
      .toContain("Remember this session decision.");
    expect(manager.getCompactionStatus().attachmentTokens).toBe(
      mention.tokens + (instructions?.tokens ?? 0) + (memory?.tokens ?? 0),
    );
  });

  test("propagates helper errors while keeping recorded attachment metadata", async () => {
    const manager = createMultiTurnContextManager(
      {},
      {
        getSessionMemoryContent: async () => "existing memory",
        loadTieredInstructions: async () => {
          throw new Error("instruction helper failed");
        },
        expandFileMentions: async () => {
          throw new Error("mention helper failed");
        },
      },
    );

    await manager.attachSessionMemory("ignored");
    await expect(
      manager.attachAgenCInstructions({ cwd: tempRoot() }),
    ).rejects.toThrow("instruction helper failed");
    await expect(
      manager.attachFileMentions("read @x.txt", { cwd: tempRoot() }),
    ).rejects.toThrow("mention helper failed");

    expect(manager.getCurrentTurn()?.attachments).toHaveLength(1);
    expect(manager.getCurrentTurn()?.attachments[0]?.type).toBe("session_memory");
  });

  test("propagates session memory helper errors", async () => {
    const manager = createMultiTurnContextManager(
      {},
      {
        getSessionMemoryContent: async () => {
          throw new Error("memory helper failed");
        },
      },
    );

    await expect(manager.attachSessionMemory("ignored")).rejects.toThrow(
      "memory helper failed",
    );
  });
});
