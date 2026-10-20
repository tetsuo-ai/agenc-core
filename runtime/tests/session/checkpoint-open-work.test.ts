/**
 * Opening a session validates every durable checkpoint against the history
 * before it. That work must grow with the history, not with the history
 * times the number of checkpoints, and must not commit (and fsync) once per
 * checkpoint, while every refusal stays where it was.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLegacyDurableCheckpointUpgrade } from "../../src/session/durable-checkpoint-upgrade.js";
import type { TurnCheckpointV4Event } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../src/state/tool-pair-projection.js";
import {
  CountingProjection,
  RUN_ID,
  checkpoint,
  longSession,
  rolloutItems,
  writerCheckpoints,
} from "./fixtures/long-checkpoint-session.js";

let agencHome: string;
let cwd: string;
let driver: StateSqliteDriver;
let projection: StateToolPairProjection;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-checkpoint-open-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-checkpoint-open-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome });
  projection = new StateToolPairProjection(driver, { discardOnTerminal: true });
});

afterEach(() => {
  driver.close();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function projectionRuns(): Array<{ readonly projection_id: string; readonly status: string }> {
  return driver.state
    .prepare("SELECT projection_id, status FROM tool_pair_projection_runs ORDER BY projection_id")
    .all() as Array<{ readonly projection_id: string; readonly status: string }>;
}

describe("opening a long session", () => {
  it("validates every checkpoint with work linear in the history and one commit", () => {
    const windows = 150;
    const history = longSession(windows);
    // run-turn also checkpoints an unchanged prefix before the next sample.
    const checkpoints = writerCheckpoints(history)
      .flatMap((event) => event.boundary === "iteration" ? [event, event] : [event])
      .map((event, index) => checkpoint(history, event.persistedMessageCount,
        event.boundary as "postAssistant" | "iteration", index + 1));
    const counting = new CountingProjection(projection);
    const outcome = planLegacyDurableCheckpointUpgrade({
      items: rolloutItems(history, checkpoints),
      runId: RUN_ID,
      projection: counting,
      projectionId: "open-long-session",
      sourceKey: "open-long-session",
    });
    expect(outcome).toMatchObject({
      status: "planned",
      plan: { changed: false, checkpointsValidated: checkpoints.length },
    });
    // Every call and result enters the exact projection once, not once per
    // checkpoint that covers it (a full re-validation inserts ~3/2 n^2).
    expect(counting.inserts).toBe(windows + 1);
    expect(counting.resolves).toBe(windows + 1);
    // One commit for the whole plan instead of one durable commit per checkpoint.
    expect(counting.transactions).toBe(1);
    expect(projectionRuns()).toEqual([]);
  });

  it.each([
    // A tampered seal is refused where the result is read, before any checkpoint.
    ["tampered result body", 41, "tool_result_integrity_invalid", "persisted_body_digest_mismatch"],
    ["tampered arguments", 40, "checkpoint_invalid", "checkpoint_prefix_digest_mismatch"],
  ] as const)("still refuses a rollout with %s where the full validation refused it", (_name, index, code, cause) => {
    const history = longSession(60);
    const checkpoints = writerCheckpoints(history);
    const items = rolloutItems(history, checkpoints);
    const responseIndex = items.findIndex((item) => item.type === "response_item" && item.payload === history[index]);
    const target = history[index]!;
    items[responseIndex] = {
      type: "response_item",
      payload: target.role === "tool"
        ? { ...target, content: "tampered" }
        : { ...target, toolCalls: [{ ...target.toolCalls![0]!, arguments: "{}" }] },
    } as RolloutItem;
    const firstCovering = items.findIndex((item) => item.type === "event_msg" &&
      item.payload.msg.type === "turn_checkpoint" &&
      (item.payload.msg.payload as TurnCheckpointV4Event).persistedMessageCount > index);
    const outcome = planLegacyDurableCheckpointUpgrade({
      items,
      runId: RUN_ID,
      projection,
      projectionId: "open-tampered",
      sourceKey: "open-tampered",
    });
    expect(outcome).toMatchObject({
      status: "invalid",
      failure: { code, itemIndex: code === "checkpoint_invalid" ? firstCovering : responseIndex, cause: { code: cause } },
    });
    expect(projectionRuns()).toEqual([]);
  });

  it("charges the open-time work bound for what an incremental validation traverses", () => {
    const history = longSession(60);
    const checkpoints = writerCheckpoints(history);
    const items = rolloutItems(history, checkpoints);
    const plan = (maxHistoryDerivationWork: number, projectionId: string) => planLegacyDurableCheckpointUpgrade({
      items, runId: RUN_ID, projection, projectionId, sourceKey: projectionId, maxHistoryDerivationWork,
    });
    // Full re-validation of every checkpoint would charge 13 visits per
    // message of every prefix (13 x 7,320 = 95,160); the incremental pass
    // charges 13 per message once plus two prefix scans per checkpoint.
    const prefixVisits = checkpoints.reduce((sum, event) => sum + event.persistedMessageCount, 0);
    expect(13 * prefixVisits).toBeGreaterThan(90_000);
    expect(plan(50_000, "bound-incremental")).toMatchObject({
      status: "planned",
      plan: { checkpointsValidated: checkpoints.length },
    });
    // The bound still holds for the work actually done.
    expect(plan(10_000, "bound-exceeded")).toMatchObject({
      status: "deferred",
      failure: { code: "history_derivation_work_limit" },
    });
    expect(projectionRuns()).toEqual([]);
  });
});

