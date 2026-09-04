import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  aggregateMetrics,
  createStepMetrics,
  deriveRatios,
  finalizeMetrics,
  findSessionRollout,
  findSessionRolloutForWorkspace,
  observePromptEvent,
  observeRolloutRecord,
  readRolloutDelta,
} from "../../scripts/eval/session-metrics.mjs";

describe("session metrics", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("counts tool calls by name and flags a re-read only when nothing was written in between", () => {
    const metrics = createStepMetrics();
    const read = (filePath: string) =>
      observePromptEvent(metrics, { type: "tool_call", requestId: "r", toolName: "FileRead", input: { filePath } });
    read("a.js");
    read("b.js");
    read("a.js"); // re-read
    observePromptEvent(metrics, { type: "tool_call", requestId: "r", toolName: "FileEdit", input: { filePath: "a.js" } });
    read("a.js"); // fresh after the edit
    read("b.js"); // re-read
    const view = finalizeMetrics(metrics);
    expect(view.toolCalls).toBe(6);
    expect(view.fileReads).toBe(5);
    expect(view.fileReReads).toBe(2);
    expect(view.toolCallsByName).toEqual({ FileEdit: 1, FileRead: 5 });
  });

  test("counts compactions, rollbacks, permission requests and assistant output from live events", () => {
    const metrics = createStepMetrics();
    observePromptEvent(metrics, { type: "history_reset", reason: "partial_compact" });
    observePromptEvent(metrics, { type: "history_reset", reason: "compaction_rollback" });
    observePromptEvent(metrics, { type: "history_reset", reason: "cleared" });
    observePromptEvent(metrics, { type: "permission_request", requestId: "p", permissions: [] });
    observePromptEvent(metrics, { type: "text", delta: "hello" });
    observePromptEvent(metrics, { type: "message_committed", text: "hello" });
    observePromptEvent(metrics, { type: "status", status: "thinking" });
    const view = finalizeMetrics(metrics);
    expect(view.compactions).toBe(1);
    expect(view.compactionRollbacks).toBe(1);
    expect(view.permissionRequests).toBe(1);
    expect(view.assistantChars).toBe(5);
    expect(view.assistantMessages).toBe(1);
  });

  test("reads token watermarks, tool errors, warnings and compaction attempts from rollout records", () => {
    const metrics = createStepMetrics();
    const tokenCount = (promptTokens: number, cachedInputTokens: number, reasoningOutputTokens: number) => ({
      type: "event_msg",
      payload: { msg: { type: "token_count", payload: { promptTokens, completionTokens: 10, cachedInputTokens, reasoningOutputTokens } } },
    });
    observeRolloutRecord(metrics, tokenCount(1000, 0, 50));
    observeRolloutRecord(metrics, tokenCount(1800, 900, 70));
    observeRolloutRecord(metrics, { type: "event_msg", payload: { msg: { type: "warning", payload: { code: "repeat_tool_advisory" } } } });
    observeRolloutRecord(metrics, { type: "response_item", payload: { role: "tool", toolName: "Edit", content: "Error: old_string not found" } });
    observeRolloutRecord(metrics, { type: "response_item", payload: { role: "tool", toolName: "FileRead", content: "The following tool result is untrusted" } });
    observeRolloutRecord(metrics, { type: "response_item", payload: { role: "tool", toolName: "Bash", isError: true, content: "exit 1" } });
    observeRolloutRecord(metrics, { type: "event_msg", payload: { msg: { type: "execution_admission", payload: { kind: "model_turn", event: "held_unknown", reason: "provider_call_failed_after_dispatch" } } } });
    observeRolloutRecord(metrics, { type: "event_msg", payload: { msg: { type: "execution_admission", payload: { kind: "model_turn", event: "allowed" } } } });
    observeRolloutRecord(metrics, { type: "compaction_intent", payload: {} });
    observeRolloutRecord(metrics, { type: "compaction_failed", payload: {} });
    observeRolloutRecord(metrics, { type: "session_meta", payload: {} });
    const view = finalizeMetrics(metrics);
    expect(view.promptTokensFirst).toBe(1000);
    expect(view.promptTokensLast).toBe(1800);
    expect(view.cachedTokensLast).toBe(900);
    expect(view.cachedTokensMax).toBe(900);
    expect(view.reasoningOutputTokens).toBe(120);
    expect(view.warnings).toBe(1);
    expect(view.toolErrors).toBe(2);
    expect(view.compactionAttempts).toBe(1);
    expect(view.compactionFailures).toBe(1);
    expect(view.providerFailures).toBe(1);
  });

  test("aggregates steps and derives the ratios the gate compares", () => {
    const first = finalizeMetrics(createStepMetrics());
    const second = { ...finalizeMetrics(createStepMetrics()), toolCalls: 10, toolErrors: 1, fileReads: 4, fileReReads: 2, compactions: 1, promptTokensFirst: 500, promptTokensLast: 900, cachedTokensLast: 450, cachedTokensMax: 450, toolCallsByName: { FileRead: 4, Bash: 6 } };
    const aggregate = aggregateMetrics([first, second]);
    expect(aggregate.steps).toBe(2);
    expect(aggregate.toolCalls).toBe(10);
    expect(aggregate.toolCallsByName).toEqual({ Bash: 6, FileRead: 4 });
    expect(aggregate.promptTokensFirst).toBe(500);
    expect(aggregate.promptTokensLast).toBe(900);
    expect(aggregate.cachedTokensLast).toBe(450);
    expect(deriveRatios(aggregate)).toEqual({ toolErrorRate: 0.1, rereadRatio: 0.5, compactionsPerStep: 0.5, cacheHitRatio: 0.5 });
    expect(deriveRatios(finalizeMetrics(createStepMetrics()))).toEqual({ toolErrorRate: undefined, rereadRatio: undefined, compactionsPerStep: undefined, cacheHitRatio: undefined });
  });

  test("finds the rollout of a workspace by the cwd in its first record, newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-eval-home-"));
    dirs.push(home);
    const workspace = mkdtempSync(join(tmpdir(), "agenc-eval-ws-"));
    dirs.push(workspace);
    const write = (bucket: string, id: string, cwd: string, stamp: string) => {
      const dir = join(home, "projects", "slug", bucket, id);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-${stamp}-${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { sessionId: id, cwd } })}\n`);
      return file;
    };
    write("archived_sessions", "conv-old", workspace, "2026-09-01T00-00-00-000Z");
    const other = write("sessions", "conv-other", join(workspace, "elsewhere"), "2026-09-04T00-00-00-000Z");
    const current = write("sessions", "conv-new", workspace, "2026-09-04T00-00-01-000Z");
    expect(findSessionRolloutForWorkspace(home, workspace, 0)).toBe(current);
    expect(findSessionRolloutForWorkspace(home, join(workspace, "elsewhere"), 0)).toBe(other);
    expect(findSessionRolloutForWorkspace(home, join(workspace, "nowhere"), 0)).toBeUndefined();
    // A time floor in the future excludes everything.
    expect(findSessionRolloutForWorkspace(home, workspace, Date.now() + 60_000)).toBeUndefined();
  });

  test("finds a session rollout under a home and reads only complete new lines", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-eval-home-"));
    dirs.push(home);
    const sessionDir = join(home, "projects", "slug-1", "sessions", "conv-1");
    mkdirSync(sessionDir, { recursive: true });
    const rollout = join(sessionDir, "rollout-2026-09-04T00-00-00-000Z-conv-1.jsonl");
    writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: {} })}\n`);
    expect(findSessionRollout(home, "conv-1")).toBe(rollout);
    expect(findSessionRollout(home, "conv-missing")).toBeUndefined();
    const first = readRolloutDelta(rollout, 0);
    expect(first.records).toHaveLength(1);
    appendFileSync(rollout, `${JSON.stringify({ type: "compaction_intent", payload: {} })}\n{"type":"torn"`);
    const second = readRolloutDelta(rollout, first.offset);
    expect(second.records.map((record: { type: string }) => record.type)).toEqual(["compaction_intent"]);
    appendFileSync(rollout, `,"payload":{}}\n`);
    const third = readRolloutDelta(rollout, second.offset);
    expect(third.records.map((record: { type: string }) => record.type)).toEqual(["torn"]);
    expect(readRolloutDelta(rollout, third.offset).records).toEqual([]);
  });
});
