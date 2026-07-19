import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  hitM4DurabilityFailpoint,
  M4DurabilityFailpointError,
  M4_DURABILITY_FAILPOINTS,
} from "../../src/durability/failpoints.js";

describe("M4 durability failpoints", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is inert without the child-process capability token", () => {
    expect(() =>
      hitM4DurabilityFailpoint("before_event_publish", {
        AGENC_TEST_DURABILITY_FAILPOINT: "before_event_publish",
        AGENC_TEST_DURABILITY_FAILPOINT_ACTION: "throw",
      }),
    ).not.toThrow();
  });

  it("writes a durable marker and throws at the exact requested boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-m4-failpoint-"));
    dirs.push(dir);
    const marker = join(dir, "reached.jsonl");

    expect(() =>
      hitM4DurabilityFailpoint("after_terminal_commit", {
        AGENC_TEST_DURABILITY_FAILPOINT: "after_terminal_commit",
        AGENC_TEST_DURABILITY_FAILPOINT_TOKEN: "m4-durability-child",
        AGENC_TEST_DURABILITY_FAILPOINT_ACTION: "throw",
        AGENC_TEST_DURABILITY_FAILPOINT_MARKER: marker,
      }),
    ).toThrow(M4DurabilityFailpointError);

    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      failpoint: "after_terminal_commit",
    });
  });

  it("publishes the complete before/after acceptance matrix", () => {
    expect(M4_DURABILITY_FAILPOINTS).toEqual([
      "after_admission_sqlite_commit_before_canonical_append",
      "before_reservation_commit",
      "after_reservation_commit",
      "before_model_response_commit",
      "after_model_response_commit",
      "before_tool_spawn",
      "after_tool_spawn",
      "before_tool_ack_commit",
      "after_tool_ack_commit",
      "before_artifact_commit",
      "after_artifact_commit",
      "before_event_publish",
      "after_event_publish",
      "before_terminal_commit",
      "after_terminal_commit",
    ]);
  });
});
