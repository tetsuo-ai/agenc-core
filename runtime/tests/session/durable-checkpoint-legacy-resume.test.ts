/**
 * #2603: a session whose turn a daemon continued after a restart could not be
 * opened again: "durable checkpoint upgrade blocked ... checkpoint prefix
 * digest does not match persisted history".
 *
 * The fixture is the root rollout a real 0.18.0 daemon (core 082d222ac, the
 * last commit before #2701) wrote in a container. The turn spawned a child
 * and called wait_agent; the daemon was killed with SIGKILL while that call
 * was in flight. The next daemon closed the open call with a sealed recovery
 * result (dangling_tool_calls_closed), resumed the turn from checkpoint 4 and
 * kept that result out of its own history, so checkpoints 5 to 10 hash the
 * persisted history without it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { interruptedToolCallResultContent } from "../../src/conversation/thread-manager.js";
import {
  computeCheckpointPrefixHashV3,
  computeCheckpointPrefixHashV4,
} from "../../src/session/durable-checkpoint-reader.js";
import { planLegacyDurableCheckpointUpgrade } from "../../src/session/durable-checkpoint-upgrade.js";
import { resetBuildIdForTestingOnly } from "../../src/session/durable-turns.js";
import {
  parseRolloutLine,
  type RolloutItem,
  type ToolResultIntegrityResponseItem,
} from "../../src/session/rollout-item.js";
import {
  DurableCheckpointUpgradeBlockedError,
  RolloutStore,
} from "../../src/session/rollout-store.js";
import { rewriteAtomically } from "../../src/session/session-store.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../src/state/tool-pair-projection.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/legacy-resume-wait-agent-2603.jsonl", import.meta.url),
);
const RUN_ID = "conv-mvf312gk";
const RECOVERED_CALL = { id: "call_dr_2_0", name: "wait_agent" } as const;

let agencHome: string;
let cwd: string;
let originalAgencHome: string | undefined;
let driver: StateSqliteDriver;
let projection: StateToolPairProjection;
let planOrdinal = 0;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-2603-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-2603-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = agencHome;
  process.env.AGENC_BUILD_ID = "issue-2603-test-build";
  resetBuildIdForTestingOnly();
  driver = openStateDatabases({ cwd, agencHome });
  projection = new StateToolPairProjection(driver);
});

afterEach(() => {
  driver.close();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  delete process.env.AGENC_BUILD_ID;
  resetBuildIdForTestingOnly();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("#2603 a turn a pre-0.19 daemon continued after a restart", () => {
  it("records the recovery result the resumed checkpoints left out of their digest", () => {
    const items = fixtureItems();
    const placeholder = placeholderHistoryIndex(items);
    expect(placeholder).toBe(4);
    let history: ToolResultIntegrityResponseItem[] = [];
    let resumed = false;
    const verdicts: Array<[number, boolean, boolean]> = [];
    for (const item of items) {
      if (item.type === "response_item") history.push(item.payload);
      if (item.type !== "event_msg") continue;
      if (item.payload.msg.type === "turn_resumed") {
        expect(item.payload.msg.payload).toMatchObject({ fromCheckpointSeq: 4 });
        resumed = true;
      }
      if (item.payload.msg.type !== "turn_checkpoint") continue;
      const checkpoint = item.payload.msg.payload as {
        checkpointSeq: number;
        persistedMessageCount: number;
        prefixHash: string;
      };
      const count = checkpoint.persistedMessageCount;
      const persisted = computeCheckpointPrefixHashV3(history, count) === checkpoint.prefixHash;
      const withoutRecovery = history.filter((_, index) => index !== placeholder);
      const writerView = count <= withoutRecovery.length &&
        computeCheckpointPrefixHashV3(withoutRecovery, count) === checkpoint.prefixHash;
      verdicts.push([checkpoint.checkpointSeq, persisted, resumed ? writerView : persisted]);
    }
    // Checkpoints 1-4 verify against the persisted history. Every checkpoint
    // after the resume verifies only without the recovery result.
    expect(verdicts).toEqual([
      [1, true, true], [2, true, true], [3, true, true], [4, true, true],
      [5, false, true], [6, false, true], [7, false, true],
      [8, false, true], [9, false, true], [10, false, true],
    ]);
  });

  it("plans the open of the recorded wait_agent rollout", () => {
    const outcome = plan(fixtureItems());
    expect(outcome).toMatchObject({
      status: "planned",
      plan: { changed: false, checkpointsValidated: 10, checkpointsUpgraded: 0 },
    });
  });

  it("opens the recorded rollout through the rollout store without rewriting it", () => {
    // Move the recorded container workspace to this test's workspace in the
    // metadata and settings rows. Messages and checkpoints stay byte-exact.
    const bytes = readFileSync(FIXTURE, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const item = parseRolloutLine(line);
        const exact = item?.type === "response_item" ||
          (item?.type === "event_msg" && item.payload.msg.type === "turn_checkpoint");
        return exact ? line : line.replaceAll('"/case/ws"', JSON.stringify(cwd));
      })
      .join("\n") + "\n";
    const meta = {
      sessionId: RUN_ID,
      timestamp: "2026-10-19T09:59:06.174Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.19.11",
    } as const;
    const seed = new RolloutStore({
      cwd,
      sessionId: RUN_ID,
      agencVersion: meta.agencVersion,
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    seed.open(meta);
    const rolloutPath = seed.rolloutPath;
    seed.close();
    rewriteAtomically(rolloutPath, bytes);

    const store = new RolloutStore({
      cwd,
      sessionId: RUN_ID,
      agencVersion: meta.agencVersion,
      sessionTempRoot: tmpdir(),
      resume: true,
      autoStartScheduler: false,
    });
    try {
      store.open(meta);
      expect(store.readAll().filter((item) => item.type === "response_item")).toHaveLength(10);
      // The live tool-pair projection holds the recovery result for its call.
      expect(store.liveToolCallResolved(RECOVERED_CALL.id)).toBe(true);
      expect(store.liveHistoryBlockedReason()).toBeUndefined();
    } finally {
      store.close();
    }
    expect(readFileSync(rolloutPath, "utf8").startsWith(bytes)).toBe(true);
  });

  it("still refuses a message changed after the recovery result", () => {
    const items = mapHistoryItem(fixtureItems(), 5, (payload) => ({
      ...payload,
      toolCalls: payload.toolCalls?.map((call) => ({
        ...call,
        arguments: JSON.stringify({ file_path: "/case/ws/other.md" }),
      })),
    }));
    expectDigestRefused(plan(items));
  });

  it("still refuses a message changed before the recovery result", () => {
    const items = mapHistoryItem(fixtureItems(), 0, (payload) => ({
      ...payload,
      content: "DR_ROOT: a different request",
    }));
    expectDigestRefused(plan(items));
  });

  it("still refuses a history truncated under a later checkpoint", () => {
    const items = fixtureItems();
    const lastToolResult = items.findLastIndex(
      (item) => item.type === "response_item" && item.payload.role === "tool",
    );
    const truncated = items.filter((_, index) => index !== lastToolResult);
    expect(plan(truncated)).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_invalid" },
    });
  });

  it("still refuses when the recovery result was removed", () => {
    const items = fixtureItems();
    const row = rolloutIndexOfHistory(items, placeholderHistoryIndex(items));
    expect(plan(items.filter((_, index) => index !== row))).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_invalid" },
    });
  });

  it("still refuses a recovery result whose body was changed and resealed", () => {
    const items = fixtureItems();
    const changed = mapHistoryItem(items, placeholderHistoryIndex(items), (payload) =>
      resealed(payload, `${payload.content as string} `));
    expectDigestRefused(plan(changed));
  });

  it("still refuses a real tool result where the recovery result was", () => {
    const items = fixtureItems();
    const real = mapHistoryItem(items, placeholderHistoryIndex(items), (payload) =>
      resealed(payload, "wait_agent finished: DR_CHILD_DONE"));
    expectDigestRefused(plan(real));
  });

  it("still refuses without the turn_resumed that names the checkpoint", () => {
    const items = fixtureItems();
    expectDigestRefused(plan(items.filter((item) => !isTurnResumed(item))));
    expectDigestRefused(plan(items.map((item) => isTurnResumed(item) ? {
      ...item,
      payload: {
        ...item.payload,
        msg: {
          type: "turn_resumed",
          payload: { ...item.payload.msg.payload, fromCheckpointSeq: 3 },
        },
      },
    } as RolloutItem : item)));
  });

  it("opens the same shape under the current digest version", () => {
    // Builds up to 0.19.11 could still write it (a continuation interrupted
    // before its first checkpoint), with prefix hash version 4.
    expect(plan(rehashAsVersion4(fixtureItems(), "writer-view"))).toMatchObject({
      status: "planned",
    });
    expect(plan(rehashAsVersion4(fixtureItems(), "persisted"))).toMatchObject({
      status: "planned",
    });
    // A changed message is still refused under version 4.
    const tampered = mapHistoryItem(rehashAsVersion4(fixtureItems(), "writer-view"), 5, (payload) => ({
      ...payload,
      toolCalls: payload.toolCalls?.map((call) => ({ ...call, arguments: "{}" })),
    }));
    expectDigestRefused(plan(tampered));
  });
});

function fixtureItems(): RolloutItem[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseRolloutLine(line))
    .filter((item): item is RolloutItem => item !== null);
}

function plan(items: ReadonlyArray<RolloutItem>) {
  planOrdinal += 1;
  return planLegacyDurableCheckpointUpgrade({
    items,
    runId: RUN_ID,
    projection,
    projectionId: `issue-2603-${planOrdinal}`,
    sourceKey: "issue-2603",
  });
}

function expectDigestRefused(outcome: ReturnType<typeof plan>): void {
  expect(outcome).toMatchObject({
    status: "invalid",
    failure: {
      code: "checkpoint_invalid",
      reason: "checkpoint prefix digest does not match persisted history",
    },
  });
}

function historyBefore(
  items: ReadonlyArray<RolloutItem>,
  end: number,
): ToolResultIntegrityResponseItem[] {
  return items
    .slice(0, end)
    .flatMap((item) => item.type === "response_item" ? [item.payload] : []);
}

function placeholderHistoryIndex(items: ReadonlyArray<RolloutItem>): number {
  const history = historyBefore(items, items.length);
  const index = history.findIndex((item) =>
    item.role === "tool" && item.toolCallId !== undefined && item.toolName !== undefined &&
    item.content === interruptedToolCallResultContent({ id: item.toolCallId, name: item.toolName }));
  const item = history[index];
  expect(item?.toolCallId).toBe(RECOVERED_CALL.id);
  expect(item?.content).toBe(interruptedToolCallResultContent(RECOVERED_CALL));
  return index;
}

function rolloutIndexOfHistory(
  items: ReadonlyArray<RolloutItem>,
  historyIndex: number,
): number {
  let seen = -1;
  return items.findIndex((item) =>
    item.type === "response_item" && (seen += 1) === historyIndex);
}

function mapHistoryItem(
  items: ReadonlyArray<RolloutItem>,
  historyIndex: number,
  map: (payload: ToolResultIntegrityResponseItem) => ToolResultIntegrityResponseItem,
): RolloutItem[] {
  const row = rolloutIndexOfHistory(items, historyIndex);
  return items.map((item, index) =>
    index === row && item.type === "response_item"
      ? { ...item, payload: map(item.payload) }
      : item);
}

function resealed(
  payload: ToolResultIntegrityResponseItem,
  content: string,
): ToolResultIntegrityResponseItem {
  return {
    ...payload,
    content,
    toolResultIntegrity: createToolResultIntegrity({
      runId: RUN_ID,
      toolCallId: payload.toolCallId as string,
      content,
    }),
  };
}

function isTurnResumed(item: RolloutItem): item is Extract<RolloutItem, { type: "event_msg" }> {
  return item.type === "event_msg" && item.payload.msg.type === "turn_resumed";
}

/** Rehash every checkpoint as prefix hash version 4 over the chosen view. */
function rehashAsVersion4(
  items: ReadonlyArray<RolloutItem>,
  view: "persisted" | "writer-view",
): RolloutItem[] {
  const placeholder = placeholderHistoryIndex(items);
  let resumed = false;
  return items.map((item, index) => {
    if (isTurnResumed(item)) resumed = true;
    if (item.type !== "event_msg" || item.payload.msg.type !== "turn_checkpoint") return item;
    const written = item.payload.msg.payload as { readonly persistedMessageCount: number };
    let history = historyBefore(items, index);
    let count = written.persistedMessageCount;
    if (view === "writer-view" && resumed) {
      history = history.filter((_, historyIndex) => historyIndex !== placeholder);
    } else if (resumed) {
      // The persisted view of a resumed checkpoint counts the recovery result.
      count += 1;
    }
    return {
      ...item,
      payload: {
        ...item.payload,
        msg: {
          type: "turn_checkpoint",
          payload: {
            ...item.payload.msg.payload,
            persistedMessageCount: count,
            prefixHashVersion: 4,
            prefixHash: computeCheckpointPrefixHashV4(history, count),
          },
        },
      },
    } as RolloutItem;
  });
}
