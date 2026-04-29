import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ReplayBackfillOutputSchema,
  ReplayCompareOutputSchema,
  ReplayIncidentOutputSchema,
  ReplayStatusOutputSchema,
  ReplayToolErrorSchema,
} from "./replay-types.js";

interface ReplayContractSnapshot {
  output?: {
    shape?: unknown;
  };
}

const fixturesDir = new URL("../../tests/fixtures/golden/", import.meta.url);

function readFixture(name: string): unknown {
  const snapshot = JSON.parse(
    readFileSync(new URL(name, fixturesDir), "utf8"),
  ) as ReplayContractSnapshot;
  return snapshot.output?.shape;
}

const backfillFixture = readFixture("mcp-replay-backfill-success.json") as Record<
  string,
  unknown
>;
const compareFixture = readFixture("mcp-replay-compare-success.json");
const incidentFixture = readFixture("mcp-replay-incident-success.json");
const statusFixture = readFixture("mcp-replay-status-success.json");
const errorFixture = readFixture("mcp-replay-backfill-error-slot-window.json");

test("schema contract: backfill fixture", () => {
  const result = ReplayBackfillOutputSchema.safeParse(backfillFixture);
  assert.equal(result.success, true);
});

test("schema contract: compare fixture", () => {
  const result = ReplayCompareOutputSchema.safeParse(compareFixture);
  assert.equal(result.success, true);
});

test("schema contract: incident fixture", () => {
  const result = ReplayIncidentOutputSchema.safeParse(incidentFixture);
  assert.equal(result.success, true);
});

test("schema contract: status fixture", () => {
  const result = ReplayStatusOutputSchema.safeParse(statusFixture);
  assert.equal(result.success, true);
});

test("schema contract: error fixture", () => {
  const result = ReplayToolErrorSchema.safeParse(errorFixture);
  assert.equal(result.success, true);
});

test("schema contract: backfill fixture has required fields", () => {
  assert.equal(backfillFixture.status, "ok");
  assert.equal(backfillFixture.schema, "replay.backfill.output.v1");

  const result = backfillFixture.result as { processed?: unknown } | undefined;
  assert.equal(typeof result?.processed, "number");
  assert.equal(typeof backfillFixture.truncated, "boolean");
});
