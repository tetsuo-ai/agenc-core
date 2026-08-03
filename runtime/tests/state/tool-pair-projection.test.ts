import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OPEN_TOOL_CALLS_PER_RUN,
  MAX_TOOL_CALL_IDS_PER_RUN,
  validateToolPairSequence,
  type ToolPairMessage,
} from "../../src/session/tool-pair-validator.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../src/state/tool-pair-projection.js";

let agencHome: string;
let cwd: string;
let driver: StateSqliteDriver;
let projection: StateToolPairProjection;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-tool-pair-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-tool-pair-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome });
  projection = new StateToolPairProjection(driver);
});

afterEach(() => {
  if (driver.state.open) driver.close();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function validate(
  messages: Iterable<ToolPairMessage>,
  overrides: Partial<Parameters<typeof validateToolPairSequence>[2]> = {},
) {
  return validateToolPairSequence(messages, projection, {
    projectionId: "projection-1",
    sourceKey: "/rollouts/session.jsonl",
    ...overrides,
  });
}

describe("StateToolPairProjection", () => {
  it("validates ordered many-call turns and persists exact resolution rows", () => {
    const outcome = validate([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-a", name: "read" },
          { id: "call-b", name: "grep" },
        ],
      },
      { role: "tool", content: "b", toolCallId: "call-b", toolName: "grep" },
      { role: "tool", content: "a", toolCallId: "call-a", toolName: "read" },
      { role: "assistant", content: "done" },
    ]);

    expect(outcome).toMatchObject({
      status: "valid",
      summary: {
        callCount: 2,
        resolvedCount: 2,
        openCallCount: 0,
        maximumOpenCallCount: 2,
      },
    });
    expect(projection.find("projection-1", "call-a")).toEqual({
      callId: "call-a",
      toolName: "read",
      assistantIndex: 0,
      resultIndex: 2,
    });
    expect(
      driver
        .prepareState<[string], { status: string; call_count: number }>(
          `SELECT status, call_count
           FROM tool_pair_projection_runs WHERE projection_id = ?`,
        )
        .get("projection-1"),
    ).toEqual({ status: "valid", call_count: 2 });
  });

  it("discards private offline staging rows before validation commits", () => {
    const stagingProjection = new StateToolPairProjection(driver, {
      discardOnTerminal: true,
    });
    const outcome = validateToolPairSequence(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "offline-call", name: "read" }],
        },
        { role: "tool", content: "ok", toolCallId: "offline-call" },
      ],
      stagingProjection,
      {
        projectionId: "offline-staging",
        sourceKey: "/rollouts/offline.jsonl",
      },
    );

    expect(outcome.status).toBe("valid");
    expect(stagingProjection.find("offline-staging", "offline-call")).toBeUndefined();
    expect(
      driver
        .prepareState<[string], { readonly found: number }>(
          `SELECT 1 AS found FROM tool_pair_projection_runs
           WHERE projection_id = ?`,
        )
        .get("offline-staging"),
    ).toBeUndefined();
  });

  it("distinguishes duplicate, orphan, unknown, and ordering failures", () => {
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-a", name: "read" }],
        },
        { role: "tool", content: "a", toolCallId: "call-a" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-a", name: "read" }],
        },
      ]),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "assistant_tool_call_id_duplicate" },
    });
    expect(
      validate([{ role: "tool", content: "a", toolCallId: "call-a" }]),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_result_without_call" },
    });
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-a", name: "read" }],
        },
        { role: "tool", content: "b", toolCallId: "call-b" },
      ]),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_result_unknown_id" },
    });
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-a", name: "read" }],
        },
        { role: "user", content: "interleaved" },
      ]),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_result_missing" },
    });
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-dangling", name: "read" }],
        },
      ]),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_result_missing", index: null },
      summary: { openCallCount: 1 },
    });
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-a", name: "read" }],
        },
        { role: "tool", content: "a", toolCallId: "call-a" },
        { role: "tool", content: "a", toolCallId: "call-a" },
      ]),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_result_duplicate" },
    });
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-a", name: "read" }],
        },
        {
          role: "tool",
          content: "a",
          toolCallId: "call-a",
          toolName: "write",
        },
      ]),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_result_name_mismatch" },
    });
  });

  it("returns typed operational deferrals for every configured bound", () => {
    expect(
      validate(
        [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "abcdef", name: "read" }],
          },
        ],
        { maxToolCallIdBytes: 5 },
      ),
    ).toMatchObject({
      status: "deferred",
      failure: { code: "tool_call_id_limit" },
    });

    const tooManyOpen = Array.from(
      { length: MAX_OPEN_TOOL_CALLS_PER_RUN + 1 },
      (_, index) => ({ id: `call-${index}`, name: "read" }),
    );
    expect(
      validate([
        { role: "assistant", content: "", toolCalls: tooManyOpen },
      ]),
    ).toMatchObject({
      status: "deferred",
      failure: { code: "tool_pair_open_call_limit" },
    });

    expect(
      validate(
        [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-a", name: "read" }],
          },
        ],
        { maxIndexBytes: 4 },
      ),
    ).toMatchObject({
      status: "deferred",
      failure: { code: "tool_pair_index_byte_limit" },
    });

    expect(
      validate(
        [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-a", name: "read" }],
          },
          { role: "tool", content: "a", toolCallId: "call-a" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-b", name: "read" }],
          },
        ],
        { maxToolCalls: 1 },
      ),
    ).toMatchObject({
      status: "deferred",
      failure: { code: "tool_pair_call_limit" },
    });
  });

  it("keeps the derived projection separate and restart-readable", () => {
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-restart", name: "read" }],
        },
        { role: "tool", content: "ok", toolCallId: "call-restart" },
      ]).status,
    ).toBe("valid");
    const tableNames = driver
      .prepareState<[], { name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('in_flight_tool_calls', 'tool_pair_projection_entries')
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tableNames).toContain("in_flight_tool_calls");
    expect(tableNames).toContain("tool_pair_projection_entries");

    driver.close();
    driver = openStateDatabases({ cwd, agencHome });
    projection = new StateToolPairProjection(driver);
    expect(projection.find("projection-1", "call-restart")).toMatchObject({
      callId: "call-restart",
      resultIndex: 1,
    });
  });

  it("rolls back a failed rebuild without destroying the last valid projection", () => {
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-stable", name: "read" }],
        },
        { role: "tool", content: "ok", toolCallId: "call-stable" },
      ]).status,
    ).toBe("valid");
    driver.state.exec(`
      CREATE TEMP TRIGGER reject_tool_pair_insert
      BEFORE INSERT ON tool_pair_projection_entries
      BEGIN
        SELECT RAISE(ABORT, 'forced projection failure');
      END;
    `);

    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-replacement", name: "grep" }],
        },
        { role: "tool", content: "new", toolCallId: "call-replacement" },
      ]),
    ).toMatchObject({
      status: "deferred",
      failure: { code: "tool_pair_projection_unavailable" },
    });
    expect(projection.find("projection-1", "call-stable")).toMatchObject({
      callId: "call-stable",
      resultIndex: 1,
    });
    expect(projection.find("projection-1", "call-replacement")).toBeUndefined();
    expect(
      driver
        .prepareState<[string], { status: string }>(
          "SELECT status FROM tool_pair_projection_runs WHERE projection_id = ?",
        )
        .get("projection-1"),
    ).toEqual({ status: "valid" });
  });

  it("enforces terminal-status and failure-kind consistency in SQLite", () => {
    expect(
      validate([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-valid", name: "read" }],
        },
        { role: "tool", content: "ok", toolCallId: "call-valid" },
      ]).status,
    ).toBe("valid");

    expect(() =>
      driver
        .prepareState<[string]>(
          `UPDATE tool_pair_projection_runs
           SET status = 'invalid', failure_kind = 'operational_deferral',
               failure_code = 'wrong-kind', failure_reason = 'wrong kind'
           WHERE projection_id = ?`,
        )
        .run("projection-1"),
    ).toThrow();
  });

  it(
    "finds an exact duplicate separated by one million resolved calls",
    () => {
      const outcome = validate(millionResolvedCallsThenDuplicate());

      expect(outcome).toMatchObject({
        status: "invalid",
        failure: { code: "assistant_tool_call_id_duplicate" },
        summary: {
          callCount: MAX_TOOL_CALL_IDS_PER_RUN,
          resolvedCount: MAX_TOOL_CALL_IDS_PER_RUN,
          openCallCount: 0,
        },
      });
    },
    180_000,
  );
});

function* millionResolvedCallsThenDuplicate(): Iterable<ToolPairMessage> {
  for (let index = 0; index < MAX_TOOL_CALL_IDS_PER_RUN; index += 1) {
    const callId = `call-${String(index).padStart(6, "0")}`;
    yield {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: "read" }],
    };
    yield { role: "tool", content: "ok", toolCallId: callId };
  }
  yield {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-000000", name: "read" }],
  };
}
